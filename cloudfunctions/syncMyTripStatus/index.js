const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const { appendBusinessEvent, nextVersion } = require('./businessLedger')
const { createRideCompletionCounter } = require('./rideCompletion')
const ensureRideCompletion = createRideCompletionCounter({ db: cloud.database({ throwOnNotFound: false }) })

const PERSONAL_SUM_FIELDS = ['countedUsers', 'countedDriverTrips', 'countedPassengerTrips', 'alreadyCountedUsers', 'missingUsers', 'duplicateUsers', 'legacyUsers']
function newPersonalStats() {
  return Object.fromEntries(['processedTrips', 'eligibleTrips', 'skippedTrips'].concat(PERSONAL_SUM_FIELDS).map(key => [key, 0]))
}
function collectPersonalStats(target, result) {
  target.processedTrips += 1
  target[result.eligible ? 'eligibleTrips' : 'skippedTrips'] += 1
  PERSONAL_SUM_FIELDS.forEach(key => { target[key] += Number(result[key] || 0) })
}
function isCancelledOrUnsupported(doc) {
  const status = String(doc.status || 'open').toLowerCase()
  if (!['open', 'full', 'past', 'close'].includes(status)) return true
  return ['isDeleted', 'deleted', 'isCancelled', 'isCanceled', 'cancelled', 'canceled', 'deletedAt', 'cancelledAt', 'canceledAt'].some(key => !!doc[key])
}

const PUBLIC_STATS_COLLECTION = 'PublicStats'
const PUBLIC_STATS_DOC_ID = 'home'
const MAX_SERVED_DELTA = 5
const TRIP_TIME_ZONE = 'America/New_York'
const IN_CHUNK_SIZE = 50
const HISTORY_AFTER_MS = 6 * 60 * 60 * 1000

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)))
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

function normalizeTripStatus(status) {
  const value = String(status || 'open').toLowerCase()
  return value
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
  ;(Array.isArray(doc && doc.passengers) ? doc.passengers : []).forEach(p => addId(passengers, p && p._openid))
  ;(Array.isArray(doc && doc.passengerID) ? doc.passengerID : []).forEach(id => addId(passengers, id))

  const capacity = Number(doc && doc.passengerCount)
  const left = Number(doc && doc.availSeatNum)
  const joinedBySeat = Number.isFinite(capacity) && Number.isFinite(left)
    ? Math.max(0, capacity - left)
    : 0
  const passengerSignals = Math.max(passengers.size, joinedBySeat)
  const hasDriver = drivers.size > 0
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
  const hasDriver = !!(doc && doc.driverOpenid)
  return hasDriver ? normalizeServedDelta(passengerTotal + 1) : 0
}

function computeStatus(type, doc, now) {
  const latest = getLatestDeparture(doc)
  if (!latest) return { ok: false, expired: false }

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

  return { ok: true, latest, diffMs, oldStatus, newStatus, expired: diffMs > 0 }
}

async function updateStatusAndLedger(type, id, now) {
  const collection = type === 'request' ? 'CarpoolRequest' : 'Carpool'
  const source = 'syncMyTripStatus:' + type
  return db.runTransaction(async transaction => {
    const ref = transaction.collection(collection).doc(id)
    const fresh = await ref.get()
    const doc = fresh && fresh.data
    if (!doc || isCancelledOrUnsupported(doc) || ['past', 'close'].includes(normalizeTripStatus(doc.status))) return { updated: false }
    const result = computeStatus(type, doc, now)
    if (!result.ok) return { updated: false }
    const meta = buildDepartureMeta(doc.departures || [])
    if (doc.status === result.newStatus && Object.keys(meta).every(key => doc[key] === meta[key])) return { updated: false }
    const patch = { ...meta, status: result.newStatus, updatedAt: now, businessVersion: nextVersion(doc) }
    if (result.newStatus === 'past' && !doc.servedStatsCounted) {
      const delta = type === 'request' ? getRequestServedPeople(doc) : getCarpoolServedPeople(doc)
      Object.assign(patch, { servedStatsCounted: true, servedStatsDelta: delta, servedStatsSource: source, servedStatsCountedAt: db.serverDate() })
      if (delta > 0) {
        const statsRef = transaction.collection(PUBLIC_STATS_COLLECTION).doc(PUBLIC_STATS_DOC_ID)
        let current
        try { current = await statsRef.get() } catch (error) {
          // Cloud databases configured to throw on a missing document report -1.
          // Do not reinterpret other failures as absence.
          if (!error || !/does not exist|not found|DOCUMENT_NOT_EXIST/i.test(String(error.errMsg || error.message || ''))) throw error
        }
        const data = { servedTrips: Number(current && current.data && current.data.servedTrips || 0) + delta,
          servedTripsLastDelta: delta, servedTripsLastSource: source, servedTripsLastTripId: id,
          servedTripsLastCollection: collection, lastServedAt: db.serverDate(), updatedAt: db.serverDate() }
        if (current && current.data) await statsRef.update({ data })
        else await transaction.collection(PUBLIC_STATS_COLLECTION).add({ data: { _id: PUBLIC_STATS_DOC_ID, ...data, coverageText: 'NY / NJ', createdAt: db.serverDate() } })
      }
    }
    await ref.update({ data: patch })
    await appendBusinessEvent(transaction, db, { type, tripId: id, action: 'status', actorOpenid: '', before: doc, after: { ...doc, ...patch }, now: now.getTime() })
    return { updated: true }
  })
}

async function updateDocs(type, docs, now, personalStats) {
  let updated = 0
  const processedIds = new Set()
  const list = (docs || []).filter(doc => doc && doc._id && !isCancelledOrUnsupported(doc))
  // Bound concurrent transactions: several trips can belong to the same driver.
  for (let offset = 0; offset < list.length; offset += 2) {
    const results = await Promise.all(list.slice(offset, offset + 2).map(async doc => {
      const oldStatus = normalizeTripStatus(doc.status)
      let changed = false
      if (!['past', 'close'].includes(oldStatus)) {
        const meta = buildDepartureMeta(doc.departures || [])
        const result = computeStatus(type, doc, now)
        if (!result.ok) return false
        const shouldUpdateMeta = Object.keys(meta).some(key => doc[key] !== meta[key])
        const shouldUpdateStatus = doc.status !== result.newStatus
        if (shouldUpdateMeta || shouldUpdateStatus) {
          const outcome = await updateStatusAndLedger(type, doc._id, now)
          changed = outcome.updated !== false
        }
        if (result.newStatus !== 'past') return changed
      }
      // Personal completion is independent of PublicStats and status transitions.
      // Re-reading inside the transaction makes existing past records retryable.
      const counted = await ensureRideCompletion({ type, id: doc._id })
      collectPersonalStats(personalStats, counted)
      // The completion helper re-reads the trip. A changed departure or a
      // cancelled/deleted trip must not migrate on the earlier snapshot.
      if (counted.ok && !['not_due', 'not_completed', 'invalid_trip'].includes(counted.reason)) {
        processedIds.add(doc._id)
      }
      return changed
    }))
    updated += results.filter(Boolean).length
  }
  return { updated, processedIds }
}

async function fetchMap(collection, ids) {
  const map = new Map()
  for (const part of chunk(uniq(ids), IN_CHUNK_SIZE)) {
    const res = await db.collection(collection).where({ _id: _.in(part) }).get()
    ;(res.data || []).forEach(doc => {
      if (doc && doc._id) map.set(doc._id, doc)
    })
  }
  return map
}

function splitByExpiry(ids, resolveDoc, now) {
  const moved = []
  const expiredCarpoolIds = []
  const expiredRequestIds = []

  ;(ids || []).forEach(id => {
    if (!id) return
    const resolved = resolveDoc(id)
    const doc = resolved && resolved.doc
    const type = resolved && resolved.type
    const latest = getLatestDeparture(doc)

    if (!latest) return

    const diffMs = now.getTime() - latest.getTime()
    if (diffMs > 0) {
      if (type === 'request') expiredRequestIds.push(id)
      else if (type === 'carpool') expiredCarpoolIds.push(id)
    }

    if (diffMs > HISTORY_AFTER_MS) moved.push(id)
  })

  return { moved, expiredCarpoolIds, expiredRequestIds }
}

async function moveProcessedTripsToHistory(userId, openid, candidates, now) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await db.runTransaction(async transaction => {
        const ref = transaction.collection('userInfo').doc(userId)
        const snapshot = await ref.get()
        const current = snapshot && snapshot.data
        if (!current || current._openid !== openid) throw new Error('用户资料已变更，请重试')
        const data = {}
        const moved = {}
        // Never write arrays derived from the initial query. Every transaction
        // attempt merges only this run's processed IDs into the current record,
        // preserving concurrent joins, removals and other history migrations.
        for (const [field, ids] of Object.entries(candidates)) {
          const eligible = new Set(ids)
          const active = Array.isArray(current[field]) ? current[field] : []
          const moving = uniq(active.filter(id => eligible.has(id)))
          moved[field] = moving.length
          if (!moving.length) continue
          const historyField = field + 'History'
          data[field] = active.filter(id => !eligible.has(id))
          data[historyField] = uniq((Array.isArray(current[historyField]) ? current[historyField] : []).concat(moving))
        }
        if (Object.keys(data).length) await ref.update({ data: { ...data, updateTime: now } })
        return moved
      })
      // Match both wx-server-sdk transaction result formats.
      return result && result.result ? result.result : result
    } catch (error) {
      const conflict = error && (error.code === 'DATABASE_TRANSACTION_CONFLICT' ||
        error.errCode === 'DATABASE_TRANSACTION_CONFLICT' ||
        [error.message, error.errMsg].some(value => typeof value === 'string' && /\bDATABASE_TRANSACTION_CONFLICT\b/.test(value)))
      if (!conflict || attempt === 2) throw error
    }
  }
}

exports.main = async () => {
  const { OPENID: openid } = cloud.getWXContext()
  if (!openid) return { ok: false, success: false, errorMsg: '未获取到 openid' }

  const now = new Date()

  try {
    const userRes = await db.collection('userInfo')
      .where({ _openid: openid })
      .field({
        _id: true,
        tripDriver: true,
        tripDriverJoin: true,
        tripPassenger: true,
        tripPassengerCreate: true
      })
      .limit(1)
      .get()

    if (!userRes.data || !userRes.data.length) {
      return {
        ok: true,
        success: true,
        moved: 0,
        movedTotal: 0,
        requestUpdated: 0,
        carpoolUpdated: 0
      }
    }

    const personalStats = newPersonalStats()
    const user = userRes.data[0]
    const tripDriver = Array.isArray(user.tripDriver) ? user.tripDriver : []
    const tripDriverJoin = Array.isArray(user.tripDriverJoin) ? user.tripDriverJoin : []
    const tripPassenger = Array.isArray(user.tripPassenger) ? user.tripPassenger : []
    const tripPassengerCreate = Array.isArray(user.tripPassengerCreate) ? user.tripPassengerCreate : []

    const carpoolMap = await fetchMap('Carpool', tripDriver.concat(tripPassenger))
    const requestMap = await fetchMap('CarpoolRequest', tripDriverJoin.concat(tripPassengerCreate).concat(tripPassenger))

    const driver = splitByExpiry(tripDriver, id => ({ type: 'carpool', doc: carpoolMap.get(id) }), now)
    const driverJoin = splitByExpiry(tripDriverJoin, id => ({ type: 'request', doc: requestMap.get(id) }), now)
    const passenger = splitByExpiry(tripPassenger, id => {
      if (carpoolMap.has(id)) return { type: 'carpool', doc: carpoolMap.get(id) }
      return { type: 'request', doc: requestMap.get(id) }
    }, now)
    const passengerCreate = splitByExpiry(tripPassengerCreate, id => ({ type: 'request', doc: requestMap.get(id) }), now)

    const expiredCarpoolIds = uniq(driver.expiredCarpoolIds.concat(passenger.expiredCarpoolIds))
    const expiredRequestIds = uniq(driverJoin.expiredRequestIds.concat(passenger.expiredRequestIds).concat(passengerCreate.expiredRequestIds))

    const carpoolDocs = expiredCarpoolIds.map(id => carpoolMap.get(id)).filter(Boolean)
    const requestDocs = expiredRequestIds.map(id => requestMap.get(id)).filter(Boolean)

    const carpoolResult = await updateDocs('carpool', carpoolDocs, now, personalStats)
    const requestResult = await updateDocs('request', requestDocs, now, personalStats)
    const carpoolUpdated = carpoolResult.updated
    const requestUpdated = requestResult.updated
    const candidates = {
      tripDriver: driver.moved.filter(id => carpoolResult.processedIds.has(id)),
      tripDriverJoin: driverJoin.moved.filter(id => requestResult.processedIds.has(id)),
      tripPassenger: passenger.moved.filter(id => (carpoolMap.has(id) ? carpoolResult : requestResult).processedIds.has(id)),
      tripPassengerCreate: passengerCreate.moved.filter(id => requestResult.processedIds.has(id))
    }

    // Keep active IDs retryable if status or personal counting fails.
    const moved = Object.values(candidates).some(ids => ids.length)
      ? await moveProcessedTripsToHistory(user._id, openid, candidates, now)
      : { tripDriver: 0, tripDriverJoin: 0, tripPassenger: 0, tripPassengerCreate: 0 }
    const movedTotal = Object.values(moved).reduce((sum, count) => sum + count, 0)

    return {
      ok: true,
      success: true,
      moved: movedTotal,
      movedTotal,
      movedTripDriver: moved.tripDriver,
      movedTripDriverJoin: moved.tripDriverJoin,
      movedTripPassenger: moved.tripPassenger,
      movedTripPassengerCreate: moved.tripPassengerCreate,
      requestUpdated,
      carpoolUpdated,
      totalUpdatedCarpool: carpoolUpdated,
      totalUpdatedCarpoolRequest: requestUpdated,
      personalStats
    }
  } catch (e) {
    console.error('syncMyTripStatus error:', e)
    return {
      ok: false,
      success: false,
      errorMsg: e && (e.errMsg || e.message) ? String(e.errMsg || e.message) : '同步我的行程状态失败'
    }
  }
}
