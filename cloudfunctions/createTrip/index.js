const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const TRIP_TIME_ZONE = 'America/New_York'
const RIDE_SERVICE_CITY_KEY = 'ny_nj'
const RIDE_SERVICE_CITY_LABEL = '纽约/新泽西'
const RIDE_SERVICE_CITY_KEYS = new Set([RIDE_SERVICE_CITY_KEY, 'ny', 'nj'])

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

function normalizeType(value) {
  const type = String(value || '').toLowerCase()
  if (type === 'request') return 'request'
  return 'carpool'
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function normalizeCityKey(value) {
  const key = cleanText(value)
  if (!key) return RIDE_SERVICE_CITY_KEY
  if (RIDE_SERVICE_CITY_KEYS.has(key)) return RIDE_SERVICE_CITY_KEY
  const err = new Error('unsupported_city')
  err.code = 'unsupported_city'
  throw err
}

function normalizeCityLabel() {
  return RIDE_SERVICE_CITY_LABEL
}

function buildCustomPriceUpdate(customPrice) {
  const data = {}
  if (!customPrice || typeof customPrice !== 'object') return data
  if (customPrice.fortLeeCore !== undefined) data['customPrice.fortLeeCore'] = customPrice.fortLeeCore
  if (customPrice.fortLeeNonCore !== undefined) data['customPrice.fortLeeNonCore'] = customPrice.fortLeeNonCore
  return data
}

async function upsertDriverUser(transaction, openid, tripId, event) {
  const userRes = await transaction.collection('userInfo').where({ _openid: openid }).limit(1).get()
  const now = new Date()

  if (!userRes.data.length) {
    const data = {
      _openid: openid,
      role: 'driver',
      carNumber: event.carNumber || '',
      carBrand: event.carBrand || '',
      carModel: event.carModel || '',
      customPrice: event.customPrice || {
        fortLeeNonCore: '',
        fortLeeCore: ''
      },
      status: 'normal',
      profileCompleted: false,
      tripDriver: [tripId],
      tripPassenger: [],
      tripDriverHistory: [],
      tripPassengerHistory: [],
      createdTime: now,
      updateTime: now
    }
    await transaction.collection('userInfo').add({ data })
    return
  }

  const doc = userRes.data[0]
  const data = Object.assign({
    role: 'driver',
    tripDriver: _.addToSet(tripId),
    updateTime: now
  }, buildCustomPriceUpdate(event.customPrice))

  if (typeof event.carNumber === 'string') data.carNumber = event.carNumber
  if (typeof event.carBrand === 'string') data.carBrand = event.carBrand
  if (typeof event.carModel === 'string') data.carModel = event.carModel
  if (!Array.isArray(doc.tripPassenger)) data.tripPassenger = []
  if (!Array.isArray(doc.tripDriverHistory)) data.tripDriverHistory = []
  if (!Array.isArray(doc.tripPassengerHistory)) data.tripPassengerHistory = []

  await transaction.collection('userInfo').doc(doc._id).update({ data })
}

async function upsertPassengerCreator(transaction, openid, requestId) {
  const userRes = await transaction.collection('userInfo').where({ _openid: openid }).limit(1).get()
  const now = new Date()

  if (!userRes.data.length) {
    await transaction.collection('userInfo').add({
      data: {
        _openid: openid,
        role: 'passenger',
        status: 'normal',
        profileCompleted: false,
        tripDriver: [],
        tripPassenger: [],
        tripDriverHistory: [],
        tripPassengerHistory: [],
        tripPassengerCreate: [requestId],
        createdTime: now,
        updateTime: now
      }
    })
    return
  }

  const doc = userRes.data[0]
  const data = {
    role: 'passenger',
    tripPassengerCreate: _.addToSet(requestId),
    updateTime: now
  }
  if (!Array.isArray(doc.tripPassenger)) data.tripPassenger = []
  if (!Array.isArray(doc.tripDriver)) data.tripDriver = []
  if (!Array.isArray(doc.tripDriverHistory)) data.tripDriverHistory = []
  if (!Array.isArray(doc.tripPassengerHistory)) data.tripPassengerHistory = []

  await transaction.collection('userInfo').doc(doc._id).update({ data })
}

async function createCarpool(event, openid) {
  const transaction = await db.startTransaction()

  try {
    const departureMeta = buildDepartureMeta(event.departures)
    const cityKey = normalizeCityKey(event.cityKey)
    const addRes = await transaction.collection('Carpool').add({
      data: {
        cityKey,
        cityLabel: normalizeCityLabel(),
        departures: event.departures || [],
        destinations: event.destinations || [],
        passengerCount: event.passengerCount || 1,
        availSeatNum: event.availSeatNum || event.passengerCount || 1,
        status: event.status || 'open',
        passengers: Array.isArray(event.passengers) ? event.passengers : [],
        referencePrice: event.referencePrice || '',
        comment: event.comment || '',
        zelle: event.zelle || 'no',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
        _openid: openid,
        ...departureMeta
      }
    })

    await upsertDriverUser(transaction, openid, addRes._id, event)
    await transaction.commit()
    return { ok: true, success: true, id: addRes._id, type: 'carpool' }
  } catch (e) {
    await transaction.rollback()
    throw e
  }
}

async function createRequest(event, openid) {
  const transaction = await db.startTransaction()

  try {
    const departureMeta = buildDepartureMeta(event.departures)
    const cityKey = normalizeCityKey(event.cityKey)
    const addRes = await transaction.collection('CarpoolRequest').add({
      data: {
        _openid: openid,
        passengerID: [openid],
        cityKey,
        cityLabel: normalizeCityLabel(),
        departures: event.departures || [],
        destinations: event.destinations || [],
        passengerCount: event.passengerCount || 1,
        largeLuggageCount: event.largeLuggageCount || 0,
        status: event.status || 'open',
        referencePrice: event.referencePrice || '',
        comment: event.comment || '',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
        ...departureMeta
      }
    })

    await upsertPassengerCreator(transaction, openid, addRes._id)
    await transaction.commit()
    return { ok: true, success: true, id: addRes._id, type: 'request' }
  } catch (e) {
    await transaction.rollback()
    throw e
  }
}

exports.main = async (event = {}) => {
  const { OPENID: openid } = cloud.getWXContext()
  if (!openid) return { ok: false, success: false, errorMsg: '未获取到 openid' }

  try {
    const type = normalizeType(event.type)
    return type === 'request'
      ? await createRequest(event, openid)
      : await createCarpool(event, openid)
  } catch (e) {
    console.error('createTrip error:', e)
    return {
      ok: false,
      success: false,
      errorMsg: e && (e.errMsg || e.message) ? String(e.errMsg || e.message) : '创建路线失败'
    }
  }
}
