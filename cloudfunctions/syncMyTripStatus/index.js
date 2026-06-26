const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

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

async function updatePastAndCount(type, id, doc, updateData, source) {
  const collection = type === 'request' ? 'CarpoolRequest' : 'Carpool'
  const delta = type === 'request' ? getRequestServedPeople(doc) : getCarpoolServedPeople(doc)
  const data = Object.assign({}, updateData, {
    servedStatsCounted: true,
    servedStatsDelta: delta,
    servedStatsSource: source,
    servedStatsCountedAt: db.serverDate()
  })

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

async function updateDocs(type, docs, now) {
  const collection = type === 'request' ? 'CarpoolRequest' : 'Carpool'
  const source = type === 'request' ? 'syncMyTripStatus:request' : 'syncMyTripStatus:carpool'
  const tasks = []

  ;(docs || []).forEach(doc => {
    if (!doc || !doc._id) return
    const meta = buildDepartureMeta(doc.departures || [])
    const result = computeStatus(type, doc, now)
    if (!result.ok) return

    const shouldUpdateMeta = Object.keys(meta).some(key => doc[key] !== meta[key])
    const shouldUpdateStatus = doc.status !== result.newStatus
    if (!shouldUpdateMeta && !shouldUpdateStatus) return

    const updateData = Object.assign({}, meta, { updatedAt: now })
    if (shouldUpdateStatus) updateData.status = result.newStatus
    const shouldCountPast = result.oldStatus !== 'past' && result.newStatus === 'past'
    tasks.push(
      shouldCountPast
        ? updatePastAndCount(type, doc._id, doc, updateData, source)
        : db.collection(collection).doc(doc._id).update({ data: updateData }).then(() => ({ updated: true }))
    )
  })

  const res = await Promise.all(tasks)
  return res.filter(item => item && item.updated !== false).length
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
  const active = []
  const moved = []
  const expiredCarpoolIds = []
  const expiredRequestIds = []

  ;(ids || []).forEach(id => {
    if (!id) return
    const resolved = resolveDoc(id)
    const doc = resolved && resolved.doc
    const type = resolved && resolved.type
    const latest = getLatestDeparture(doc)

    if (!latest) {
      active.push(id)
      return
    }

    const diffMs = now.getTime() - latest.getTime()
    if (diffMs > 0) {
      if (type === 'request') expiredRequestIds.push(id)
      else if (type === 'carpool') expiredCarpoolIds.push(id)
    }

    if (diffMs > HISTORY_AFTER_MS) moved.push(id)
    else active.push(id)
  })

  return { active, moved, expiredCarpoolIds, expiredRequestIds }
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
        tripPassengerCreate: true,
        tripDriverHistory: true,
        tripDriverJoinHistory: true,
        tripPassengerHistory: true,
        tripPassengerCreateHistory: true
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

    const movedTotal =
      driver.moved.length +
      driverJoin.moved.length +
      passenger.moved.length +
      passengerCreate.moved.length

    if (movedTotal > 0) {
      await db.collection('userInfo').doc(user._id).update({
        data: {
          tripDriver: driver.active,
          tripDriverJoin: driverJoin.active,
          tripPassenger: passenger.active,
          tripPassengerCreate: passengerCreate.active,
          tripDriverHistory: uniq((Array.isArray(user.tripDriverHistory) ? user.tripDriverHistory : []).concat(driver.moved)),
          tripDriverJoinHistory: uniq((Array.isArray(user.tripDriverJoinHistory) ? user.tripDriverJoinHistory : []).concat(driverJoin.moved)),
          tripPassengerHistory: uniq((Array.isArray(user.tripPassengerHistory) ? user.tripPassengerHistory : []).concat(passenger.moved)),
          tripPassengerCreateHistory: uniq((Array.isArray(user.tripPassengerCreateHistory) ? user.tripPassengerCreateHistory : []).concat(passengerCreate.moved)),
          updateTime: now
        }
      })
    }

    const expiredCarpoolIds = uniq(driver.expiredCarpoolIds.concat(passenger.expiredCarpoolIds))
    const expiredRequestIds = uniq(driverJoin.expiredRequestIds.concat(passenger.expiredRequestIds).concat(passengerCreate.expiredRequestIds))

    const carpoolDocs = expiredCarpoolIds.map(id => carpoolMap.get(id)).filter(Boolean)
    const requestDocs = expiredRequestIds.map(id => requestMap.get(id)).filter(Boolean)

    const carpoolUpdated = await updateDocs('carpool', carpoolDocs, now)
    const requestUpdated = await updateDocs('request', requestDocs, now)

    return {
      ok: true,
      success: true,
      moved: movedTotal,
      movedTotal,
      movedTripDriver: driver.moved.length,
      movedTripDriverJoin: driverJoin.moved.length,
      movedTripPassenger: passenger.moved.length,
      movedTripPassengerCreate: passengerCreate.moved.length,
      requestUpdated,
      carpoolUpdated,
      totalUpdatedCarpool: carpoolUpdated,
      totalUpdatedCarpoolRequest: requestUpdated
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
