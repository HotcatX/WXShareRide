// 云函数：updateCarpoolRequestStatus（只更新 CarpoolRequest，时间 + passengerCount）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const PUBLIC_STATS_COLLECTION = 'PublicStats'
const PUBLIC_STATS_DOC_ID = 'home'
const MAX_SERVED_DELTA = 5
const TRIP_TIME_ZONE = 'America/New_York'

function getZonedParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TRIP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date)

  const map = {}
  parts.forEach(part => {
    if (part.type !== 'literal') map[part.type] = Number(part.value)
  })

  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
    minute: map.minute,
    second: map.second
  }
}

function getTimeZoneOffsetMs(date) {
  const p = getZonedParts(date)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second || 0) - date.getTime()
}

function parseTripTimeMs(dateStr, timeStr) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim())
  const timeMatch = /^(\d{1,2}):(\d{2})/.exec(String(timeStr || '').trim())
  if (!dateMatch || !timeMatch) return null

  const y = Number(dateMatch[1])
  const m = Number(dateMatch[2])
  const d = Number(dateMatch[3])
  const hh = Number(timeMatch[1])
  const mm = Number(timeMatch[2])
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null

  const localAsUtcMs = Date.UTC(y, m - 1, d, hh, mm, 0)
  let utcMs = localAsUtcMs - getTimeZoneOffsetMs(new Date(localAsUtcMs))
  utcMs = localAsUtcMs - getTimeZoneOffsetMs(new Date(utcMs))
  return Number.isFinite(utcMs) ? utcMs : null
}

function buildDepartureMeta(departures = []) {
  const parsed = (Array.isArray(departures) ? departures : [])
    .map(item => {
      const ms = parseTripTimeMs(item && item.date, item && item.time)
      return ms ? {
        ms,
        date: String(item.date || ''),
        time: String(item.time || '')
      } : null
    })
    .filter(Boolean)
    .sort((a, b) => a.ms - b.ms)

  if (!parsed.length) return {}
  const first = parsed[0]
  const latest = parsed[parsed.length - 1]
  return {
    departureAtMs: first.ms,
    latestDepartureAtMs: latest.ms,
    firstDepartureDate: first.date,
    firstDepartureTime: first.time
  }
}

function getLatestDeparture(doc = {}) {
  const savedMs = Number(doc.latestDepartureAtMs || doc.departureAtMs)
  if (Number.isFinite(savedMs) && savedMs > 0) return new Date(savedMs)

  const meta = buildDepartureMeta(doc.departures || [])
  const metaMs = Number(meta.latestDepartureAtMs || meta.departureAtMs)
  return Number.isFinite(metaMs) && metaMs > 0 ? new Date(metaMs) : null
}

function normalizeIds(ids) {
  if (!Array.isArray(ids)) return []

  const out = []
  const seen = new Set()
  ids.forEach(id => {
    const value = String(id || '').trim()
    if (!value || seen.has(value)) return
    seen.add(value)
    out.push(value)
  })

  return out.slice(0, 100)
}

function getTargetIds(event = {}) {
  const values = []
  if (Array.isArray(event.ids)) values.push(...event.ids)
  if (event.id) values.push(event.id)
  if (event.tripId) values.push(event.tripId)
  if (event.requestId) values.push(event.requestId)

  return normalizeIds(values)
}

function normalizeTripStatus(status) {
  const value = String(status || 'open').toLowerCase()
  return value === 'close' || value === 'closed' ? 'past' : value
}

function normalizeServedDelta(amount) {
  const n = Number(amount)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(MAX_SERVED_DELTA, Math.max(1, Math.floor(n)))
}

function getCarpoolRequestServedPeople(doc = {}) {
  const passengerIds = Array.isArray(doc.passengerID)
    ? Array.from(new Set(doc.passengerID.filter(Boolean)))
    : []
  const passengerCount = Number(doc.passengerCount)
  const passengerTotal = Math.max(
    passengerIds.length,
    Number.isFinite(passengerCount) ? passengerCount : 0,
    doc._openid ? 1 : 0
  )
  const hasDriver = !!(doc.driverOpenid || doc.driverID || doc.driverId)
  return hasDriver ? normalizeServedDelta(passengerTotal + 1) : 0
}

async function bumpServedTrips(delta, source, tripId, collection) {
  const amount = normalizeServedDelta(delta)
  if (amount <= 0) return false

  const now = db.serverDate()
  const data = {
    servedTrips: _.inc(amount),
    servedTripsLastDelta: amount,
    servedTripsLastSource: source,
    servedTripsLastTripId: tripId,
    servedTripsLastCollection: collection,
    lastServedAt: now,
    updatedAt: now
  }

  try {
    await db.collection(PUBLIC_STATS_COLLECTION).doc(PUBLIC_STATS_DOC_ID).update({ data })
    return true
  } catch (e) {
    try {
      await db.collection(PUBLIC_STATS_COLLECTION).add({
        data: {
          _id: PUBLIC_STATS_DOC_ID,
          servedTrips: amount,
          servedTripsLastDelta: amount,
          servedTripsLastSource: source,
          servedTripsLastTripId: tripId,
          servedTripsLastCollection: collection,
          coverageText: 'NY / NJ',
          lastServedAt: now,
          createdAt: now,
          updatedAt: now
        }
      })
      return true
    } catch (addErr) {
      try {
        await db.collection(PUBLIC_STATS_COLLECTION).doc(PUBLIC_STATS_DOC_ID).update({ data })
        return true
      } catch (retryErr) {
        console.warn('[bumpServedTrips] 统计自增失败:', retryErr)
        return false
      }
    }
  }
}

async function updatePastAndCount(collection, id, doc, updateData, source) {
  const delta = getCarpoolRequestServedPeople(doc)
  const countedAt = db.serverDate()
  const data = {
    ...updateData,
    servedStatsCounted: true,
    servedStatsDelta: delta,
    servedStatsSource: source,
    servedStatsCountedAt: countedAt
  }

  const res = await db.collection(collection)
    .where({ _id: id, servedStatsCounted: _.neq(true) })
    .update({ data })

  const updated = Number((res && res.stats && res.stats.updated) || (res && res.updated) || 0)
  if (updated > 0) {
    const counted = await bumpServedTrips(delta, source, id, collection)
    return { updated: true, counted, delta }
  }

  const fresh = await db.collection(collection).doc(id).get().catch(() => null)
  if (fresh && fresh.data && normalizeTripStatus(fresh.data.status) !== 'past') {
    await db.collection(collection).doc(id).update({ data: updateData })
    return { updated: true, counted: false, delta: 0 }
  }

  return { updated: false, counted: false, delta: 0 }
}

// CarpoolRequest 状态计算：时间优先，其次人数 passengerCount
// 规则：
// - diffMs > 0  => past （不管原来 open/full）
// - diffMs <= 0 => 未到发车时间：passengerCount >= 4 => full，否则 open
function computeCarpoolRequestStatus(doc, now) {
  const latest = getLatestDeparture(doc)
  if (!latest) return { ok: false, reason: 'no-valid-time', latest: null, newStatus: null }

  const diffMs = now.getTime() - latest.getTime()
  const oldStatus = normalizeTripStatus(doc.status)
  let newStatus = oldStatus

  if (diffMs > 0) {
    newStatus = 'past'
  } else {
    const passengerCount = Number(doc.passengerCount || 0)
    newStatus = (passengerCount >= 4) ? 'full' : 'open'
  }

  return { ok: true, latest, diffMs, oldStatus, newStatus }
}

async function updateCarpoolRequestDocs(list, now) {
  const collName = 'CarpoolRequest'
  let totalUpdated = 0
  const debug = []

  const updateTasks = []

  list.forEach(doc => {
    const _id = doc._id
    const departureMeta = buildDepartureMeta(doc.departures || [])
    const result = computeCarpoolRequestStatus(doc, now)

    if (!result.ok) {
      debug.push({
        coll: collName,
        id: _id,
        reason: result.reason,
        departures: doc.departures || []
      })
      return
    }

    const { latest, diffMs, oldStatus, newStatus } = result
    debug.push({
      coll: collName,
      id: _id,
      now: now.toISOString(),
      latest: latest.toISOString(),
      diffMs,
      diffHour: diffMs / (1000 * 60 * 60),
      passengerCount: doc.passengerCount,
      oldStatus,
      newStatus
    })

    const shouldUpdateMeta = Object.keys(departureMeta).some(key => doc[key] !== departureMeta[key])
    const shouldUpdateStatus = doc.status !== newStatus
    if (!shouldUpdateStatus && !shouldUpdateMeta) return

    const updateData = {
      ...departureMeta,
      updatedAt: now
    }
    if (shouldUpdateStatus) updateData.status = newStatus
    const shouldCountPast = oldStatus !== 'past' && newStatus === 'past'
    updateTasks.push(
      shouldCountPast
        ? updatePastAndCount(collName, _id, doc, updateData, 'updateCarpoolRequestStatus')
        : db.collection(collName).doc(_id).update({ data: updateData }).then(() => ({ updated: true }))
    )
  })

  const updateRes = await Promise.all(updateTasks)
  totalUpdated += updateRes.filter(x => x && x.updated !== false).length

  return { totalUpdated, debug }
}

async function scanAndUpdateCarpoolRequest(now, ids = [], allowFullScan = false) {
  const collName = 'CarpoolRequest'
  const pageSize = 100

  if (ids.length > 0) {
    const res = await db.collection(collName)
      .where({ _id: _.in(ids) })
      .limit(ids.length)
      .get()

    return updateCarpoolRequestDocs(res.data || [], now)
  }

  if (!allowFullScan) {
    return {
      totalUpdated: 0,
      debug: [],
      skipped: true,
      reason: 'ids-required'
    }
  }

  // Only scheduled/admin maintenance should opt into this branch with fullScan: true.
  // User-facing pages must pass ids and should never trigger a full collection scan.
  let skip = 0
  let totalUpdated = 0
  const debug = []

  while (true) {
    const res = await db.collection(collName).skip(skip).limit(pageSize).get()
    const list = res.data || []
    if (!list.length) break

    const result = await updateCarpoolRequestDocs(list, now)
    totalUpdated += result.totalUpdated
    debug.push(...(result.debug || []))
    skip += pageSize
  }

  return { totalUpdated, debug }
}

exports.main = async (event, context) => {
  const now = new Date()
  const ids = getTargetIds(event || {})
  const allowFullScan = !!(event && event.fullScan === true)

  const res = await scanAndUpdateCarpoolRequest(now, ids, allowFullScan)

  return {
    ok: true,
    now: now.toISOString(),
    scope: ids.length > 0 ? 'ids' : (allowFullScan ? 'full' : 'none'),
    skipped: !!res.skipped,
    reason: res.reason || '',
    totalUpdatedCarpoolRequest: res.totalUpdated,
    debugCarpoolRequest: (res.debug || []).slice(0, 30)
  }
}
