const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const PUBLIC_STATS_COLLECTION = 'PublicStats'
const PUBLIC_STATS_DOC_ID = 'home'
const MAX_SERVED_DELTA = 5
const TRIP_TIME_ZONE = 'America/New_York'
const PAGE_SIZE = 100

const TYPE_CONFIG = {
  carpool: {
    collection: 'Carpool',
    totalKey: 'totalUpdatedCarpool',
    source: 'syncTripStatus:carpool'
  },
  request: {
    collection: 'CarpoolRequest',
    totalKey: 'totalUpdatedCarpoolRequest',
    source: 'syncTripStatus:request'
  }
}

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

function buildDepartureMeta(departures) {
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

function getLatestDeparture(doc) {
  const savedMs = Number(doc && (doc.latestDepartureAtMs || doc.departureAtMs))
  if (Number.isFinite(savedMs) && savedMs > 0) return new Date(savedMs)

  const meta = buildDepartureMeta(doc && doc.departures)
  const metaMs = Number(meta.latestDepartureAtMs || meta.departureAtMs)
  return Number.isFinite(metaMs) && metaMs > 0 ? new Date(metaMs) : null
}

function normalizeIds(ids) {
  if (!Array.isArray(ids)) return []
  const seen = new Set()
  const out = []
  ids.forEach(id => {
    const value = String(id || '').trim()
    if (!value || seen.has(value)) return
    seen.add(value)
    out.push(value)
  })
  return out.slice(0, 100)
}

function getType(event) {
  const value = String((event && (event.type || event.kind || event.routeType)) || '').toLowerCase()
  if (value === 'carpool' || value === 'trip') return 'carpool'
  if (value === 'request' || value === 'carpoolrequest') return 'request'
  return 'all'
}

function getIdsForType(event, type) {
  const values = []
  if (type === 'carpool') {
    if (Array.isArray(event && event.carpoolIds)) values.push.apply(values, event.carpoolIds)
    if (event && event.tripId) values.push(event.tripId)
  }
  if (type === 'request') {
    if (Array.isArray(event && event.requestIds)) values.push.apply(values, event.requestIds)
    if (event && event.requestId) values.push(event.requestId)
  }
  if (Array.isArray(event && event.ids)) values.push.apply(values, event.ids)
  if (event && event.id) values.push(event.id)
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

function addId(set, value) {
  const id = String(value || '').trim()
  if (id) set.add(id)
}

function getCarpoolServedPeople(doc) {
  const drivers = new Set()
  const passengers = new Set()
  addId(drivers, doc && doc._openid)
  addId(drivers, doc && doc.driverOpenid)

  ;(Array.isArray(doc && doc.passengers) ? doc.passengers : []).forEach(p => {
    addId(passengers, p && p._openid)
  })
  ;(Array.isArray(doc && doc.passengerID) ? doc.passengerID : []).forEach(id => addId(passengers, id))

  const capacity = Number(doc && doc.passengerCount)
  const left = Number(doc && doc.availSeatNum)
  const joinedBySeat = Number.isFinite(capacity) && Number.isFinite(left)
    ? Math.max(0, capacity - left)
    : 0
  const passengerSignals = Math.max(passengers.size, joinedBySeat)
  const hasDriver = drivers.size > 0 || !!(doc && (doc.driverID || doc.driverId))
  return normalizeServedDelta((hasDriver ? 1 : 0) + passengerSignals)
}

function getRequestServedPeople(doc) {
  const passengerIds = Array.isArray(doc && doc.passengerID)
    ? Array.from(new Set(doc.passengerID.filter(Boolean)))
    : []
  const passengerCount = Number(doc && doc.passengerCount)
  const passengerTotal = Math.max(
    passengerIds.length,
    Number.isFinite(passengerCount) ? passengerCount : 0,
    doc && doc._openid ? 1 : 0
  )
  const hasDriver = !!(doc && (doc.driverOpenid || doc.driverID || doc.driverId))
  return hasDriver ? normalizeServedDelta(passengerTotal + 1) : 0
}

function getServedPeople(type, doc) {
  return type === 'request' ? getRequestServedPeople(doc) : getCarpoolServedPeople(doc)
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
      await db.collection(PUBLIC_STATS_COLLECTION).doc(PUBLIC_STATS_DOC_ID).update({ data })
      return true
    }
  }
}

async function updatePastAndCount(type, id, doc, updateData) {
  const config = TYPE_CONFIG[type]
  const delta = getServedPeople(type, doc)
  const data = Object.assign({}, updateData, {
    servedStatsCounted: true,
    servedStatsDelta: delta,
    servedStatsSource: config.source,
    servedStatsCountedAt: db.serverDate()
  })

  const res = await db.collection(config.collection)
    .where({ _id: id, servedStatsCounted: _.neq(true) })
    .update({ data })

  const updated = Number((res && res.stats && res.stats.updated) || (res && res.updated) || 0)
  if (updated > 0) {
    const counted = await bumpServedTrips(delta, config.source, id, config.collection)
    return { updated: true, counted, delta }
  }

  const fresh = await db.collection(config.collection).doc(id).get().catch(() => null)
  if (fresh && fresh.data && normalizeTripStatus(fresh.data.status) !== 'past') {
    await db.collection(config.collection).doc(id).update({ data: updateData })
    return { updated: true, counted: false, delta: 0 }
  }

  return { updated: false, counted: false, delta: 0 }
}

function computeStatus(type, doc, now) {
  const latest = getLatestDeparture(doc)
  if (!latest) return { ok: false }

  const diffMs = now.getTime() - latest.getTime()
  const oldStatus = normalizeTripStatus(doc && doc.status)
  let newStatus = oldStatus

  if (diffMs > 0) {
    newStatus = 'past'
  } else if (type === 'request') {
    const passengerCount = Number((doc && doc.passengerCount) || 0)
    newStatus = passengerCount >= 4 ? 'full' : 'open'
  } else {
    const availSeatNum = Number((doc && doc.availSeatNum) || 0)
    newStatus = availSeatNum <= 0 ? 'full' : 'open'
  }

  return { ok: true, oldStatus, newStatus }
}

async function updateDocs(type, list, now) {
  const config = TYPE_CONFIG[type]
  const tasks = []

  ;(list || []).forEach(doc => {
    if (!doc || !doc._id) return
    const departureMeta = buildDepartureMeta(doc.departures || [])
    const result = computeStatus(type, doc, now)
    if (!result.ok) return

    const shouldUpdateMeta = Object.keys(departureMeta).some(key => doc[key] !== departureMeta[key])
    const shouldUpdateStatus = doc.status !== result.newStatus
    if (!shouldUpdateStatus && !shouldUpdateMeta) return

    const updateData = Object.assign({}, departureMeta, { updatedAt: now })
    if (shouldUpdateStatus) updateData.status = result.newStatus
    const shouldCountPast = result.oldStatus !== 'past' && result.newStatus === 'past'

    tasks.push(
      shouldCountPast
        ? updatePastAndCount(type, doc._id, doc, updateData)
        : db.collection(config.collection).doc(doc._id).update({ data: updateData }).then(() => ({ updated: true }))
    )
  })

  const results = await Promise.all(tasks)
  return results.filter(item => item && item.updated !== false).length
}

async function fetchByIds(collection, ids) {
  if (!ids.length) return []
  const rows = []
  for (let i = 0; i < ids.length; i += PAGE_SIZE) {
    const chunk = ids.slice(i, i + PAGE_SIZE)
    const res = await db.collection(collection).where({ _id: _.in(chunk) }).limit(chunk.length).get()
    rows.push.apply(rows, res.data || [])
  }
  return rows
}

async function scanAndUpdate(type, ids, allowFullScan, now) {
  const config = TYPE_CONFIG[type]
  if (ids.length) {
    const rows = await fetchByIds(config.collection, ids)
    return updateDocs(type, rows, now)
  }

  if (!allowFullScan) return 0

  let skip = 0
  let updated = 0
  while (true) {
    const res = await db.collection(config.collection).skip(skip).limit(PAGE_SIZE).get()
    const list = res.data || []
    if (!list.length) break
    updated += await updateDocs(type, list, now)
    skip += PAGE_SIZE
  }
  return updated
}

exports.main = async (event = {}) => {
  const now = new Date()
  const selectedType = getType(event)
  const allowFullScan = !!(event && event.fullScan === true)
  const types = selectedType === 'all' ? ['carpool', 'request'] : [selectedType]

  try {
    const output = {
      ok: true,
      success: true,
      now: now.toISOString(),
      totalUpdated: 0,
      totalUpdatedCarpool: 0,
      totalUpdatedCarpoolRequest: 0
    }

    for (const type of types) {
      const ids = getIdsForType(event, type)
      const total = await scanAndUpdate(type, ids, allowFullScan, now)
      output[TYPE_CONFIG[type].totalKey] = total
      output.totalUpdated += total
    }

    return output
  } catch (e) {
    console.error('syncTripStatus error:', e)
    return {
      ok: false,
      success: false,
      errorMsg: e && (e.errMsg || e.message) ? String(e.errMsg || e.message) : '同步路线状态失败'
    }
  }
}
