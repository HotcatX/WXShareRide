const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const VISIBLE_STATUSES = ['open', 'full']
const LIST_EXPIRE_GRACE = 30 * 60 * 1000
const LIST_FAST_MODE_DEFAULT = true

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
      passengers: true,
      passengerID: true,
      referencePrice: true,
      price: true,
      displayPrice: true,
      cityKey: true,
      cityLabel: true,
      departureAtMs: true,
      latestDepartureAtMs: true,
      firstDepartureDate: true,
      firstDepartureTime: true,
      createdAt: true,
      _openid: true
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
      passengerID: true,
      referencePrice: true,
      price: true,
      displayPrice: true,
      cityKey: true,
      cityLabel: true,
      departureAtMs: true,
      latestDepartureAtMs: true,
      firstDepartureDate: true,
      firstDepartureTime: true,
      createdAt: true,
      _openid: true,
      driverOpenid: true
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
  if (type === 'carpool') return 'carpool'
  if (type === 'request') return 'request'
  return 'all'
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function normalizeCityKey(value) {
  return normalizeText(value)
}

function buildCityKeyCondition(event = {}) {
  const cityKey = normalizeCityKey(event.cityKey)
  if (!cityKey || cityKey === 'all') return null
  return { cityKey }
}

function normalizeTripStatus(status) {
  const value = String(status || 'open').toLowerCase()
  return value
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

function cleanOpenid(value) {
  const id = String(value || '').trim()
  return id ? id : ''
}

function addOpenid(set, value) {
  const id = cleanOpenid(value)
  if (id) set.add(id)
}

function addPassengerOpenids(set, passengers) {
  ;(Array.isArray(passengers) ? passengers : []).forEach(item => {
    addOpenid(set, item && item._openid)
  })
}

function getCarpoolPartyOpenids(doc = {}) {
  const ids = new Set()
  addOpenid(ids, doc._openid)
  addPassengerOpenids(ids, doc.passengers)
  return Array.from(ids)
}

function getRequestPartyOpenids(doc = {}) {
  const ids = new Set()
  addOpenid(ids, doc._openid)
  addOpenid(ids, doc.driverOpenid)
  ;(Array.isArray(doc.passengerID) ? doc.passengerID : []).forEach(id => addOpenid(ids, id))
  return Array.from(ids)
}

function getTripPartyOpenids(type, doc) {
  return type === 'request' ? getRequestPartyOpenids(doc) : getCarpoolPartyOpenids(doc)
}

function stripPrivateListFields(item) {
  const out = Object.assign({}, item)
  delete out._openid
  delete out.driverOpenid
  delete out.passengerID
  delete out.passengers
  return out
}

async function addForwardBlocksFromUserBlocks(actorOpenid, blockedSet) {
  const res = await db.collection('UserBlocks')
    .where({
      _openid: actorOpenid,
      active: true
    })
    .limit(100)
    .get()
  ;(res.data || []).forEach(item => addOpenid(blockedSet, item && item.targetOpenid))
}

async function getReverseBlocksFromUserBlocks(actorOpenid, routePartyIds) {
  const reverse = new Set()
  if (!routePartyIds.length) return reverse

  const partySet = new Set(routePartyIds)
  const res = await db.collection('UserBlocks')
    .where({
      targetOpenid: actorOpenid,
      active: true
    })
    .limit(200)
    .get()

  ;(res.data || []).forEach(item => {
    const blocker = cleanOpenid(item && (item.blockerOpenid || item._openid))
    if (partySet.has(blocker)) addOpenid(reverse, blocker)
  })
  return reverse
}

async function buildBlockContext(actorOpenid, typedLists) {
  const actor = cleanOpenid(actorOpenid)
  if (!actor) return { actor: '', blockedByMe: new Set(), blockedMe: new Set() }

  const blockedByMe = new Set()
  await addForwardBlocksFromUserBlocks(actor, blockedByMe)

  const partyIds = new Set()
  ;(typedLists || []).forEach(pair => {
    ;(pair.items || []).forEach(item => {
      getTripPartyOpenids(pair.type, item)
        .filter(id => id && id !== actor)
        .forEach(id => partyIds.add(id))
    })
  })

  const routePartyIds = Array.from(partyIds)
  const blockedMe = await getReverseBlocksFromUserBlocks(actor, routePartyIds)

  return { actor, blockedByMe, blockedMe }
}

function applyBlockFilter(type, list, blockContext) {
  const actor = blockContext && blockContext.actor
  if (!actor) return (list || []).map(stripPrivateListFields)

  return (list || [])
    .filter(item => {
      const ids = getTripPartyOpenids(type, item).filter(id => id && id !== actor)
      return !ids.some(id => blockContext.blockedByMe.has(id) || blockContext.blockedMe.has(id))
    })
    .map(stripPrivateListFields)
}

async function readType(type, event) {
  const config = TYPE_CONFIG[type]
  const limit = getLimit(event)
  const quick = event && event.quick !== false
  const fastOnly = quick && event.fastOnly !== false && LIST_FAST_MODE_DEFAULT
  const minDepartureAtMs = Date.now() - LIST_EXPIRE_GRACE
  const fastCityCondition = buildCityKeyCondition(event)

  const buildQuery = (where, orderField, queryLimit, cityCondition) => {
    const scopedWhere = cityCondition ? _.and([where, cityCondition]) : where
    let query = db.collection(config.collection)
      .where(scopedWhere)
      .orderBy(orderField, orderField === 'createdAt' ? 'desc' : 'asc')
      .limit(queryLimit)
    if (quick) query = query.field(config.fields)
    return query
  }

  const normalizeRows = rows => mergeById([rows])
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

  const fastWhere = {
    status: _.in(VISIBLE_STATUSES),
    latestDepartureAtMs: _.gte(minDepartureAtMs)
  }

  try {
    const fastRes = await buildQuery(fastWhere, 'latestDepartureAtMs', limit, fastCityCondition).get()
    const fastRows = normalizeRows(fastRes.data || [])
    if (fastOnly || fastRows.length >= limit) return fastRows
  } catch (e) {
    console.warn('getTripList fast query failed, falling back:', e && (e.errMsg || e.message || e))
  }

  const fallbackLimit = Math.min(limit, 20)
  const queries = VISIBLE_STATUSES.flatMap(status => [
    buildQuery({ status, departureAtMs: _.gte(minDepartureAtMs) }, 'departureAtMs', limit, fastCityCondition),
    buildQuery({ status, latestDepartureAtMs: _.gte(minDepartureAtMs) }, 'latestDepartureAtMs', limit, fastCityCondition),
    buildQuery({ status }, 'createdAt', fallbackLimit, fastCityCondition)
  ])

  const results = await Promise.all(queries.map(query => query.get()))
  return normalizeRows(mergeById(results.map(res => res.data || [])))
}

exports.main = async (event = {}) => {
  const type = normalizeType(event.type)
  const { OPENID: openid } = cloud.getWXContext()

  try {
    if (type === 'all') {
      const results = await Promise.all([
        readType('carpool', event),
        readType('request', event)
      ])
      const blockContext = await buildBlockContext(openid, [
        { type: 'carpool', items: results[0] },
        { type: 'request', items: results[1] }
      ])
      const carpool = applyBlockFilter('carpool', results[0], blockContext)
      const request = applyBlockFilter('request', results[1], blockContext)
      return {
        ok: true,
        success: true,
        data: {
          carpool,
          request
        },
        carpoolList: carpool,
        requestList: request
      }
    }

    const data = await readType(type, event)
    const blockContext = await buildBlockContext(openid, [{ type, items: data }])
    return { ok: true, success: true, type, data: applyBlockFilter(type, data, blockContext) }
  } catch (e) {
    console.error('getTripList error:', e)
    return {
      ok: false,
      success: false,
      errorMsg: e && (e.errMsg || e.message) ? String(e.errMsg || e.message) : '读取路线列表失败'
    }
  }
}
