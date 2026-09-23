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
  const value = String((event && event.type) || '').toLowerCase()
  if (value === 'carpool') return 'carpool'
  if (value === 'request') return 'request'
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

function getServedPeople(type, doc) {
  return type === 'request' ? getRequestServedPeople(doc) : getCarpoolServedPeople(doc)
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

async function updateStatusAndLedger(type, id, now) {
  const collection = type === 'request' ? 'CarpoolRequest' : 'Carpool'
  const source = 'syncTripStatus:' + type
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
  const collection = TYPE_CONFIG[type].collection
  let updated = 0
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
      return changed
    }))
    updated += results.filter(Boolean).length
  }
  return updated
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

async function scanAndUpdate(type, ids, allowFullScan, now, personalStats) {
  const config = TYPE_CONFIG[type]
  if (ids.length) {
    const rows = await fetchByIds(config.collection, ids)
    return updateDocs(type, rows, now, personalStats)
  }

  if (!allowFullScan) return 0

  let skip = 0
  let updated = 0
  while (true) {
    const res = await db.collection(config.collection).skip(skip).limit(PAGE_SIZE).get()
    const list = res.data || []
    if (!list.length) break
    updated += await updateDocs(type, list, now, personalStats)
    skip += PAGE_SIZE
  }
  return updated
}


exports.main = async (event = {}) => {
  // Maintenance actions are retired; reject old scripts before normal sync.
  if (event && event.action != null) return { ok: false, success: false, errorMsg: '不支持的操作' }

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
      totalUpdatedCarpoolRequest: 0,
      personalStats: newPersonalStats()
    }

    for (const type of types) {
      const ids = getIdsForType(event, type)
      const total = await scanAndUpdate(type, ids, allowFullScan, now, output.personalStats)
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
