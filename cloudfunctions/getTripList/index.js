const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const VISIBLE_STATUSES = ['open', 'full']
const LIST_EXPIRE_GRACE = 30 * 60 * 1000
const LIST_FAST_MODE_DEFAULT = true
const RIDE_SERVICE_CITY_KEY = 'ny_nj'
const RIDE_SERVICE_CITY_KEYS = [RIDE_SERVICE_CITY_KEY, 'ny', 'nj']
const DATE_PAGE_SIZE = 100
const DAY_MS = 24 * 60 * 60 * 1000

// Keep these exact aliases and route patterns aligned with utils/ridePlaceOptions.js.
const PLACE_ALIASES = {
  ewr: ['ewr', 'ewr机场', 'ewrairport', '纽瓦克机场', '纽瓦克国际机场', '纽瓦克自由国际机场', 'newarkairport', 'newarkinternationalairport', 'newarklibertyairport', 'newarklibertyinternationalairport'],
  jfk: ['jfk', 'jfk机场', 'jfk国际机场', 'jfkairport', '肯尼迪', '肯尼迪机场', '肯尼迪国际机场', '纽约肯尼迪机场', 'johnfkennedy', 'johnfkennedyairport', 'johnfkennedyinternationalairport'],
  lga: ['lga', 'lga机场', 'lgaairport', '拉瓜迪亚', '拉瓜迪亚机场', '拉瓜迪亚国际机场', '拉瓜地亚', '拉瓜地亚机场', 'laguardia', 'laguardiaairport', 'laguardiainternationalairport'],
  flushing: ['法拉盛', 'flushing'],
  lic: ['lic', 'longislandcity', '长岛市'],
  jsq: ['jsq', 'journalsquare', 'journalsquarestation', 'journalsquarepath', 'journalsquarepathstation'],
  inwood: ['inwood', 'inwoodmanhattan', 'manhattaninwood', '曼哈顿inwood'],
  midtown: ['中城', '曼哈顿中城', 'midtown', 'midtownmanhattan', 'manhattanmidtown'],
  downtown: ['下城', '曼哈顿下城', 'downtown', 'lowermanhattan', 'downtownmanhattan', 'manhattandowntown'],
  queens: ['queens', '皇后区', '皇后區']
}
const PLACE_PATTERNS = {
  ewr: /(?:^|[^a-z])ewr(?:$|[^a-z])|newark\s+(?:liberty\s+)?(?:international\s+)?airport|纽瓦克(?:自由)?(?:国际)?机场/i,
  jfk: /(?:^|[^a-z])jfk(?:$|[^a-z])|john\s*f\.?\s*kennedy|肯尼迪/i,
  lga: /(?:^|[^a-z])lga(?:$|[^a-z])|la\s*guardia|拉瓜[迪地]亚/i,
  flushing: /flushing|法拉盛/i,
  lic: /(?:^|[^a-z])lic(?:$|[^a-z])|long\s+island\s+city|长岛市/i,
  jsq: /(?:^|[^a-z])jsq(?:$|[^a-z])|journal\s+square/i,
  inwood: /(?:^|[^a-z])(?:inwood(?:\s*manhattan)?|manhattan\s*inwood)(?:$|[^a-z])/i,
  midtown: /(?:^|[^a-z])(?:midtown\s*manhattan|manhattan\s*midtown|midtown\s+(?:east|west))(?:$|[^a-z])|中城|^\s*midtown\s*$/i,
  downtown: /(?:^|[^a-z])(?:lower\s*manhattan|downtown\s*manhattan|manhattan\s*downtown)(?:$|[^a-z])|下城|^\s*downtown\s*$/i,
  queens: /(?:^|[^a-z])queens(?:$|[^a-z])|皇后[区區]/i
}

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
      businessVersion: true,
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
      businessVersion: true,
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

function parseDatePage(event) {
  if (!Object.prototype.hasOwnProperty.call(event, 'startDate') &&
      !Object.prototype.hasOwnProperty.call(event, 'endDateExclusive')) return null

  const parse = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN
    const ms = Date.parse(`${value}T00:00:00.000Z`)
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : NaN
  }
  const start = parse(event.startDate)
  const end = parse(event.endDateExclusive)
  const days = (end - start) / DAY_MS
  if (!Number.isFinite(start) || !Number.isFinite(end) || (days !== 1 && days !== 2)) {
    throw new Error('invalid_date_range: 日期范围必须为有效的 1 至 2 天')
  }
  return { startDate: event.startDate, endDateExclusive: event.endDateExclusive }
}

function parseCalendarOptions(event) {
  const month = event.month
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error('invalid_calendar_month: 月份必须为 YYYY-MM')
  }
  const start = new Date(`${month}-01T00:00:00.000Z`)
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 7) !== month) {
    throw new Error('invalid_calendar_month: 无效的月份')
  }
  const end = new Date(start.getTime())
  end.setUTCMonth(end.getUTCMonth() + 1)
  if (!/^\d{4}-/.test(end.toISOString())) {
    throw new Error('invalid_calendar_month: 月份超出支持范围')
  }

  const readPlace = (value, key) => {
    if (value === undefined || value === null) return ''
    if (typeof value !== 'string' || value.length > 200) {
      throw new Error(`invalid_calendar_filter: ${key} 必须为不超过 200 字符的地点`)
    }
    const place = value.trim()
    return place === '全部' ? '' : place
  }
  const readPresets = (value, key) => {
    if (value === undefined || value === null) return []
    if (!Array.isArray(value) || value.length > 100) {
      throw new Error(`invalid_calendar_filter: ${key} 最多包含 100 个地点`)
    }
    return Array.from(new Set(value.map(item => readPlace(item, key)).filter(item => item && item !== '其他')))
  }
  if (event.type !== undefined && !['all', 'carpool', 'request'].includes(event.type)) {
    throw new Error('invalid_calendar_filter: 无效的路线类型')
  }
  if (event.cityKey !== undefined && (typeof event.cityKey !== 'string' || event.cityKey.length > 80)) {
    throw new Error('invalid_calendar_filter: 无效的城市')
  }
  return {
    month,
    page: { startDate: `${month}-01`, endDateExclusive: end.toISOString().slice(0, 10) },
    fromPlace: readPlace(event.fromPlace, 'fromPlace'),
    toPlace: readPlace(event.toPlace, 'toPlace'),
    fromPresets: readPresets(event.fromPresets, 'fromPresets'),
    toPresets: readPresets(event.toPresets, 'toPresets')
  }
}

function makeCalendarPlaceMatcher(place) {
  const value = String(place || '').trim()
  const compact = value.toLowerCase().replace(/\s+/g, '')
  if (['fort_lee', 'fortlee', 'fortlee核心区', 'fortlee全区域'].includes(compact)) return address => /fort\s*lee/i.test(String(address || ''))
  if (['columbia', 'columbiauniversity', '哥大', '哥伦比亚大学', '哥大columbia', '哥大/columbia'].includes(compact)) return address => /哥大|columbia/i.test(String(address || ''))
  const aliasKey = Object.keys(PLACE_ALIASES).find(key => PLACE_ALIASES[key].includes(compact))
  if (aliasKey) return address => PLACE_PATTERNS[aliasKey].test(String(address || ''))
  return address => !!address && String(address).toLowerCase().includes(value.toLowerCase())
}

function makeCalendarRouteMatcher(options) {
  if (!options.fromPlace && !options.toPlace) return () => true
  const matchSide = (selected, presets) => {
    if (!selected) return () => true
    if (selected !== '其他') {
      const matches = makeCalendarPlaceMatcher(selected)
      return stops => stops.some(stop => matches(stop && stop.address))
    }
    const matchers = (presets.length ? presets : ['Fort Lee', 'Columbia']).map(makeCalendarPlaceMatcher)
    return stops => stops.some(stop => {
      const address = stop && String(stop.address || '').trim()
      return !!address && !matchers.some(matches => matches(address))
    })
  }
  const matchFrom = matchSide(options.fromPlace, options.fromPresets)
  const matchTo = matchSide(options.toPlace, options.toPresets)
  return trip => {
    const departures = Array.isArray(trip.departures) ? trip.departures : []
    const destinations = Array.isArray(trip.destinations) ? trip.destinations : []
    // Match the list's address-filter eligibility, including complete departure details.
    if (!departures.some(stop => stop && stop.date && stop.time && String(stop.address || '').trim()) ||
        !destinations.some(stop => stop && String(stop.address || '').trim())) return false
    return matchFrom(departures) && matchTo(destinations)
  }
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

function isRideServiceCityKey(value) {
  return RIDE_SERVICE_CITY_KEYS.includes(normalizeCityKey(value))
}

function buildCityKeyCondition(event = {}) {
  const cityKey = normalizeCityKey(event.cityKey)
  if (!cityKey || cityKey === 'all') return null
  if (isRideServiceCityKey(cityKey)) return { cityKey: _.in(RIDE_SERVICE_CITY_KEYS) }
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
  const out = Object.assign({}, item, { __dataGeneratedAt: Date.now() })
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
      // Blocking a participant must not hide the publisher's own eligible route.
      // This only affects list visibility; joining and contact checks stay separate.
      if (cleanOpenid(item && item._openid) === actor) return true
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

async function readDatePageType(type, event, page, minDepartureAtMs, options = {}) {
  const config = TYPE_CONFIG[type]
  const cityCondition = buildCityKeyCondition(event)
  const baseConditions = [
    { status: _.in(VISIBLE_STATUSES) },
    { latestDepartureAtMs: _.gte(minDepartureAtMs) }
  ]
  if (cityCondition) baseConditions.push(cityCondition)

  const buildQuery = (conditions, limit, fields) => {
    let query = db.collection(config.collection)
      .where(_.and([...baseConditions, ...conditions]))
      .orderBy('firstDepartureDate', 'asc')
      .orderBy('_id', 'asc')
      .limit(limit)
    if (fields) query = query.field(fields)
    return query
  }

  // A date is one logical page: do not truncate a busy day at the old 80-row limit.
  // The compound cursor also avoids offset shifts when an earlier row is removed.
  const rows = []
  let cursor = null
  while (true) {
    const conditions = [
      { firstDepartureDate: _.gte(page.startDate) },
      { firstDepartureDate: _.lt(page.endDateExclusive) }
    ]
    if (cursor) {
      conditions.push(_.or([
        { firstDepartureDate: _.gt(cursor.date) },
        _.and([{ firstDepartureDate: cursor.date }, { _id: _.gt(cursor.id) }])
      ]))
    }
    const fields = options.fields || (event.quick !== false ? config.fields : null)
    const result = await buildQuery(conditions, DATE_PAGE_SIZE, fields).get()
    const batch = result.data || []
    rows.push(...batch)
    if (batch.length < DATE_PAGE_SIZE) break
    const last = batch[batch.length - 1]
    if (!last || !last._id || !last.firstDepartureDate ||
        (cursor && last._id === cursor.id && last.firstDepartureDate === cursor.date)) {
      throw new Error('invalid_date_cursor: 无法继续读取完整日期的路线')
    }
    cursor = { date: last.firstDepartureDate, id: last._id }
  }

  let nextDate = ''
  if (options.probeNextDate !== false) {
    const nextResult = await buildQuery(
      [{ firstDepartureDate: _.gte(page.endDateExclusive) }],
      1,
      { firstDepartureDate: true }
    ).get()
    nextDate = nextResult.data && nextResult.data[0] && nextResult.data[0].firstDepartureDate || ''
  }
  const data = mergeById([rows])
  return {
    data: options.skipSort ? data : data.sort((a, b) => getTripSortMs(a) - getTripSortMs(b)),
    nextDate
  }
}

async function readCalendar(event, type, openid) {
  const options = parseCalendarOptions(event)
  const types = type === 'all' ? ['carpool', 'request'] : [type]
  const minDepartureAtMs = Date.now() - LIST_EXPIRE_GRACE
  const matchesRoute = makeCalendarRouteMatcher(options)
  const results = await Promise.all(types.map(item => {
    const fields = { _id: true, firstDepartureDate: true, _openid: true }
    if (item === 'carpool') fields.passengers = true
    else Object.assign(fields, { driverOpenid: true, passengerID: true })
    if (options.fromPlace || options.toPlace) Object.assign(fields, { departures: true, destinations: true })
    return readDatePageType(item, event, options.page, minDepartureAtMs, { fields, probeNextDate: false, skipSort: true })
  }))
  const typedLists = types.map((item, index) => ({ type: item, items: results[index].data.filter(matchesRoute) }))
  const blockContext = await buildBlockContext(openid, typedLists)
  const counts = new Map()
  typedLists.forEach(pair => {
    applyBlockFilter(pair.type, pair.items, blockContext).forEach(trip => {
      const date = trip.firstDepartureDate
      // Invalid legacy dates must not create calendar cells or leak stored values.
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !date.startsWith(`${options.month}-`)) return
      const parsed = Date.parse(`${date}T00:00:00.000Z`)
      if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) return
      if (!counts.has(date)) counts.set(date, { date, carpoolCount: 0, requestCount: 0 })
      counts.get(date)[pair.type === 'carpool' ? 'carpoolCount' : 'requestCount'] += 1
    })
  })
  return {
    ok: true,
    success: true,
    month: options.month,
    data: { days: Array.from(counts.values()).sort((a, b) => a.date.localeCompare(b.date)) }
  }
}

function readPlaceSuggestionCity(event) {
  if (typeof event.cityKey !== 'string' || event.cityKey.length > 80 || event.cityKey.trim() !== event.cityKey ||
      event.cityKey.toLowerCase() === 'all' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(event.cityKey)) {
    throw new Error('invalid_places_city: 城市必须为 1 至 80 字符的城市标识')
  }
  return event.cityKey
}

async function readPlaceSuggestions(event) {
  readPlaceSuggestionCity(event)
  // Legacy clients retain their configured fixed choices. Free-text route
  // addresses are not a public POI directory and must not be redistributed.
  // Versioned public candidates now come from the authenticated collector API.
  return { ok: true, success: true, data: { fromPlaces: [], toPlaces: [] } }
}

async function readDatePage(event, page, type, openid) {
  const types = type === 'all' ? ['carpool', 'request'] : [type]
  const minDepartureAtMs = Date.now() - LIST_EXPIRE_GRACE
  const results = await Promise.all(types.map(item => readDatePageType(item, event, page, minDepartureAtMs)))
  const blockContext = await buildBlockContext(openid, types.map((item, index) => ({ type: item, items: results[index].data })))
  const filtered = types.map((item, index) => applyBlockFilter(item, results[index].data, blockContext))
  const nextDate = results.map(result => result.nextDate).filter(Boolean).sort()[0] || ''
  const pageInfo = { ...page, nextDate, hasMore: !!nextDate }
  if (type !== 'all') {
    return { ok: true, success: true, type, data: filtered[0], page: pageInfo }
  }
  return {
    ok: true,
    success: true,
    data: { carpool: filtered[0], request: filtered[1] },
    carpoolList: filtered[0],
    requestList: filtered[1],
    page: pageInfo
  }
}

exports.main = async (event = {}) => {
  const type = normalizeType(event.type)
  const { OPENID: openid } = cloud.getWXContext()

  try {
    if (event.action === 'calendar') return await readCalendar(event, type, openid)
    if (event.action === 'places') return await readPlaceSuggestions(event, openid)
    const datePage = parseDatePage(event)
    if (datePage) return await readDatePage(event, datePage, type, openid)
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
