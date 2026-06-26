const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const IN_CHUNK_SIZE = 50

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)))
}

function getWeekdayCN(dateStr) {
  if (!dateStr) return ''
  const parts = String(dateStr).split('-')
  if (parts.length !== 3) return ''
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (!y || !m || !d) return ''
  const dt = new Date(y, m - 1, d)
  const map = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return map[dt.getDay()] || ''
}

function formatDateCNNoYear(dateStr) {
  if (!dateStr) return ''
  const parts = String(dateStr).split('-')
  if (parts.length !== 3) return ''
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (!m || !d) return ''
  return `${m}月${d}日`
}

function normalizeTripStatus(status) {
  const value = String(status || 'open').toLowerCase()
  return value
}

function getStatuses(event) {
  if (Array.isArray(event && event.statuses) && event.statuses.length) {
    return event.statuses.map(s => normalizeTripStatus(String(s).trim())).filter(Boolean)
  }
  return ['open', 'full', 'past']
}

function isVisibleDoc(doc, statuses) {
  if (!doc) return false
  return statuses.includes(normalizeTripStatus(doc.status))
}

function normalizeTripData(raw, source) {
  const doc = raw || {}
  const isRequest = source === 'request'
  const dep0 = Array.isArray(doc.departures) && doc.departures.length ? doc.departures[0] : {}
  const dest0 = Array.isArray(doc.destinations) && doc.destinations.length ? doc.destinations[0] : {}

  const fromAddress = dep0.address || ''
  const toAddress = dest0.address || ''
  const date = dep0.date || ''
  const time = dep0.time || ''

  const dateCN = formatDateCNNoYear(date)
  const weekday = getWeekdayCN(date)
  const timeLabel =
    doc._timeLabel ||
    ((dateCN && weekday && time) ? `${dateCN} ${weekday} ${time}`
      : (dateCN && weekday) ? `${dateCN} ${weekday}`
        : (dateCN || time || ''))

  const statusText = doc.statusText || doc.status || (isRequest ? 'request' : '')

  return Object.assign({}, doc, {
    status: normalizeTripStatus(doc.status),
    _fromAddress: doc._fromAddress || fromAddress,
    _toAddress: doc._toAddress || toAddress,
    _timeLabel: timeLabel,
    statusText,
    _isRequest: isRequest
  })
}

async function fetchMap(collection, ids) {
  const map = new Map()
  const values = uniq(ids)
  for (const part of chunk(values, IN_CHUNK_SIZE)) {
    const res = await db.collection(collection)
      .where({ _id: _.in(part) })
      .get()
    ;(res.data || []).forEach(doc => {
      if (doc && doc._id) map.set(doc._id, doc)
    })
  }
  return map
}

function buildList(ids, map, statuses, role, source) {
  const out = []
  ;(ids || []).forEach(id => {
    const doc = map.get(id)
    if (!isVisibleDoc(doc, statuses)) return
    out.push({
      _id: id,
      role,
      from: source,
      tripData: normalizeTripData(doc, source)
    })
  })
  return out
}

async function readUser(openid) {
  const res = await db.collection('userInfo')
    .where({ _openid: openid })
    .field({
      _id: true,
      tripDriver: true,
      tripDriverJoin: true,
      tripPassengerCreate: true,
      tripPassenger: true
    })
    .limit(1)
    .get()
  return res.data && res.data[0] ? res.data[0] : null
}

exports.main = async (event = {}) => {
  const { OPENID: openid } = cloud.getWXContext()
  if (!openid) return { ok: false, success: false, errorMsg: '未获取到 openid' }

  try {
    const statuses = getStatuses(event)
    const user = await readUser(openid)
    if (!user) {
      return {
        ok: true,
        success: true,
        statuses,
        data: {
          driver: { createList: [], joinList: [] },
          passenger: { createList: [], joinList: [] },
          createList: [],
          joinList: []
        }
      }
    }

    const tripDriver = Array.isArray(user.tripDriver) ? user.tripDriver : []
    const tripDriverJoin = Array.isArray(user.tripDriverJoin) ? user.tripDriverJoin : []
    const tripPassengerCreate = Array.isArray(user.tripPassengerCreate) ? user.tripPassengerCreate : []
    const tripPassenger = Array.isArray(user.tripPassenger) ? user.tripPassenger : []

    const carpoolMap = await fetchMap('Carpool', uniq(tripDriver.concat(tripPassenger)))
    const requestMap = await fetchMap('CarpoolRequest', uniq(tripDriverJoin.concat(tripPassengerCreate).concat(tripPassenger)))

    const driverCreate = buildList(tripDriver, carpoolMap, statuses, 'driverCreate', 'carpool')
    const driverJoin = buildList(tripDriverJoin, requestMap, statuses, 'driverJoin', 'request')
    const passengerCreate = buildList(tripPassengerCreate, requestMap, statuses, 'passengerCreate', 'request')

    const passengerJoin = []
    tripPassenger.forEach(id => {
      if (!id) return
      if (carpoolMap.has(id)) {
        const doc = carpoolMap.get(id)
        if (isVisibleDoc(doc, statuses)) {
          passengerJoin.push({
            _id: id,
            role: 'passenger',
            from: 'carpool',
            tripData: normalizeTripData(doc, 'carpool')
          })
        }
        return
      }

      const req = requestMap.get(id)
      if (isVisibleDoc(req, statuses)) {
        passengerJoin.push({
          _id: id,
          role: 'passenger',
          from: 'request',
          tripData: normalizeTripData(req, 'request')
        })
      }
    })

    return {
      ok: true,
      success: true,
      statuses,
      data: {
        driver: {
          createList: driverCreate,
          joinList: driverJoin
        },
        passenger: {
          createList: passengerCreate,
          joinList: passengerJoin
        },
        createList: driverCreate.concat(passengerCreate),
        joinList: driverJoin.concat(passengerJoin)
      }
    }
  } catch (e) {
    console.error('getHomeTripList error:', e)
    return {
      ok: false,
      success: false,
      errorMsg: e && (e.errMsg || e.message) ? String(e.errMsg || e.message) : '获取首页行程失败'
    }
  }
}
