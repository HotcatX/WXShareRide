const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const VISIBLE_STATUSES = ['open', 'full']
const LIST_EXPIRE_GRACE = 30 * 60 * 1000

const TYPE_CONFIG = {
  carpool: {
    collection: 'Carpool',
    fields: {
      _id: true,
      status: true,
      departures: true,
      destinations: true,
      availSeatNum: true,
      passengerCount: true,
      departureAtMs: true,
      latestDepartureAtMs: true,
      firstDepartureDate: true,
      firstDepartureTime: true,
      createdAt: true
    }
  },
  request: {
    collection: 'CarpoolRequest',
    fields: {
      _id: true,
      status: true,
      departures: true,
      destinations: true,
      passengerCount: true,
      requestPassengerCount: true,
      departureAtMs: true,
      latestDepartureAtMs: true,
      firstDepartureDate: true,
      firstDepartureTime: true,
      createdAt: true
    }
  }
}

function getLimit(event) {
  const n = Number(event && event.limit)
  if (!Number.isFinite(n) || n <= 0) return 80
  return Math.max(20, Math.min(100, Math.floor(n)))
}

function normalizeType(value) {
  const type = String(value || '').toLowerCase()
  if (type === 'carpool' || type === 'trip') return 'carpool'
  if (type === 'request' || type === 'carpoolrequest') return 'request'
  return 'all'
}

function normalizeTripStatus(status) {
  const value = String(status || 'open').toLowerCase()
  return value === 'close' || value === 'closed' ? 'past' : value
}

function getTimeValue(value) {
  if (!value) return 0
  if (typeof value === 'number') return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'object' && value.$date) return Number(value.$date)
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

function getTripSortMs(item) {
  const saved = Number(item && item.departureAtMs)
  if (Number.isFinite(saved) && saved > 0) return saved

  const dep = item && Array.isArray(item.departures) && item.departures.length ? item.departures[0] : null
  if (dep && dep.date && dep.time) {
    const parsed = new Date(`${dep.date}T${dep.time}`).getTime()
    if (Number.isFinite(parsed)) return parsed
  }

  const createdAt = getTimeValue(item && item.createdAt)
  return createdAt || Number.MAX_SAFE_INTEGER
}

function mergeById(lists) {
  const map = new Map()
  ;(lists || []).forEach(list => {
    ;(list || []).forEach(item => {
      if (!item || !item._id || map.has(item._id)) return
      map.set(item._id, item)
    })
  })
  return Array.from(map.values())
}

async function readType(type, event) {
  const config = TYPE_CONFIG[type]
  const limit = getLimit(event)
  const quick = event && event.quick !== false
  const minDepartureAtMs = Date.now() - LIST_EXPIRE_GRACE

  const queries = VISIBLE_STATUSES.map(status => {
    let query = db.collection(config.collection)
      .where({ status })
      .limit(limit)
    if (quick) query = query.field(config.fields)
    return query
  })

  const results = await Promise.all(queries.map(query => query.get()))
  return mergeById(results.map(res => res.data || []))
    .map(item => {
      const status = normalizeTripStatus(item.status)
      return status === item.status ? item : Object.assign({}, item, { status })
    })
    .filter(item => {
      const status = normalizeTripStatus(item.status)
      const ts = Number(item.latestDepartureAtMs || item.departureAtMs)
      const notExpired = !Number.isFinite(ts) || ts <= 0 || ts >= minDepartureAtMs
      return (status === 'open' || status === 'full') && notExpired
    })
    .sort((a, b) => getTripSortMs(a) - getTripSortMs(b))
    .slice(0, limit)
}

exports.main = async (event = {}) => {
  const type = normalizeType(event.type || event.kind || event.routeType)

  try {
    if (type === 'all') {
      const results = await Promise.all([
        readType('carpool', event),
        readType('request', event)
      ])
      return {
        ok: true,
        success: true,
        data: {
          carpool: results[0],
          request: results[1]
        },
        carpoolList: results[0],
        requestList: results[1]
      }
    }

    const data = await readType(type, event)
    return { ok: true, success: true, type, data }
  } catch (e) {
    console.error('getTripList error:', e)
    return {
      ok: false,
      success: false,
      errorMsg: e && (e.errMsg || e.message) ? String(e.errMsg || e.message) : '读取路线列表失败'
    }
  }
}
