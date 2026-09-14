// Public, read-only views. Never return source documents or delegate to private actions.
const MAX_LIMIT = 20
const MAX_RESULTS = 100
const MAX_SCAN = 150
const TIME_ZONE = 'America/New_York'
const CITY_LABELS = {
  ny_nj: '纽约/新泽西', ny: '纽约', nj: '新泽西', boston: '波士顿',
  philadelphia: '费城', dc: '华盛顿DC', la: '洛杉矶', bay_area: '旧金山湾区',
  san_diego: '圣地亚哥', seattle: '西雅图', chicago: '芝加哥', champaign: '香槟',
  ann_arbor: '安娜堡', columbus: '哥伦布', dallas: '达拉斯', houston: '休斯顿',
  austin: '奥斯汀', atlanta: '亚特兰大', miami: '迈阿密', orlando: '奥兰多'
}
const EN_CITY_LABELS = {
  ny_nj: 'New York / New Jersey', ny: 'New York', nj: 'New Jersey', boston: 'Boston',
  philadelphia: 'Philadelphia', dc: 'Washington, DC', la: 'Los Angeles', bay_area: 'San Francisco Bay Area',
  san_diego: 'San Diego', seattle: 'Seattle', chicago: 'Chicago', champaign: 'Champaign',
  ann_arbor: 'Ann Arbor', columbus: 'Columbus', dallas: 'Dallas', houston: 'Houston',
  austin: 'Austin', atlanta: 'Atlanta', miami: 'Miami', orlando: 'Orlando'
}
const EN_AREAS = [
  [/哥大|哥伦比亚大学|\bcolumbia\b/i, 'Columbia University'],
  [/纽瓦克|newark|(?:^|[^a-z])ewr(?:$|[^a-z])/i, 'Newark'],
  [/(?:^|[^a-z])jfk(?:$|[^a-z])|john\s*f\.?\s*kennedy|肯尼迪/i, 'JFK'], [/拉瓜[迪地]亚|la\s*guardia|(?:^|[^a-z])lga(?:$|[^a-z])/i, 'LaGuardia'],
  [/法拉盛|\bflushing\b/i, 'Flushing'], [/\bfort\s?lee\b/i, 'Fort Lee'],
  [/曼哈顿|\bmanhattan\b/i, 'Manhattan'],
  [/皇后区|\bqueens\b|\blong island city\b|\blic\b/i, 'Queens'],
  [/布鲁克林|\bbrooklyn\b/i, 'Brooklyn'],
  [/\bjersey city\b|\bnewport\b|\bjournal square\b|\bjsq\b/i, 'Jersey City'],
  [/\bhoboken\b/i, 'Hoboken'], [/新泽西|\bnew jersey\b|\bnj\b/i, 'New Jersey'],
  [/纽约|\bnew york\b|\bnyc\b|\bny\b/i, 'New York'],
  [/波士顿|\bboston\b|\bcambridge\b/i, 'Boston'],
  [/费城|\bphiladelphia\b/i, 'Philadelphia'], [/洛杉矶|\blos angeles\b/i, 'Los Angeles'],
  [/西雅图|\bseattle\b/i, 'Seattle'], [/芝加哥|\bchicago\b/i, 'Chicago']
]
const EN_TAGS = { '家具': 'Furniture', '数码': 'Electronics', '电子产品': 'Electronics', '电器': 'Appliances', '家电': 'Appliances', '日用品': 'Home essentials', '服饰': 'Clothing', '书籍': 'Books', '其他': 'Other', '全新': 'New', '9成新': 'Like new', '九成新': 'Like new', '8成新': 'Good condition', '八成新': 'Good condition' }
function localizedText(value, doc, max, locale) {
  const result = cleanPublicText(value, doc, max)
  return locale === 'en' ? result.replace(/\[(?:已隐藏|链接已隐藏|联系方式已隐藏|地址已隐藏|位置已隐藏)\]/g, '[redacted]') : result
}
const STATE_CODES = new Set(('NY_NJ NY NJ CA MA PA CT RI NH VT ME MD VA DC DE NC SC GA FL IL MI OH IN WI MN IA MO KS NE TX WA OR AZ CO UT NV NM TN KY AL LA OK AR MS ID MT WY ND SD AK HI WV').split(' '))
const CITY_STATES = { ny_nj: 'NY_NJ', ny: 'NY_NJ', nj: 'NY_NJ', boston: 'MA', philadelphia: 'PA', dc: 'DC', la: 'CA', bay_area: 'CA', san_diego: 'CA', seattle: 'WA', chicago: 'IL', champaign: 'IL', ann_arbor: 'MI', columbus: 'OH', dallas: 'TX', houston: 'TX', austin: 'TX', atlanta: 'GA', miami: 'FL', orlando: 'FL' }
// Only these fixed area labels can be derived from a route's point text.
const AREAS = [
  [/曼哈顿|\bmanhattan\b|\bcolumbia\b/i, '曼哈顿'],
  [/皇后区|\bqueens\b|\blong island city\b|\blic\b/i, 'Queens'],
  [/布鲁克林|\bbrooklyn\b/i, 'Brooklyn'],
  [/\bfort\s?lee\b/i, 'Fort Lee'],
  [/\bjersey city\b|\bnewport\b|\bjournal square\b|\bjsq\b/i, 'Jersey City'],
  [/\bhoboken\b/i, 'Hoboken'], [/\bnewark\b/i, 'Newark'],
  [/新泽西|\bnew jersey\b|\bnj\b/i, '新泽西'],
  [/纽约|\bnew york\b|\bnyc\b|\bny\b|\bjfk\b|\blga\b/i, '纽约'],
  [/波士顿|\bboston\b|\bcambridge\b/i, '波士顿'],
  [/费城|\bphiladelphia\b/i, '费城'], [/洛杉矶|\blos angeles\b/i, '洛杉矶'],
  [/西雅图|\bseattle\b/i, '西雅图'], [/芝加哥|\bchicago\b/i, '芝加哥']
]
const FLAGS = ['isDeleted', 'deleted', 'isCancelled', 'cancelled', 'canceled', 'isEnded', 'ended', 'completed', 'deletedAt', 'cancelledAt', 'canceledAt', 'endedAt', 'completedAt']
function fields(names) { return Object.fromEntries(names.map(name => [name, true])) }
const MARKET_FIELDS = fields([
  '_id', '_openid', 'listingType', 'status', 'title', 'desc', 'price', 'category', 'condition',
  'regionState', 'regionCounty', 'regionArea', 'cityKey', 'location', 'Apartment', 'pickup', 'address',
  'sellerName', 'sellerWechat', 'sellerPhone', 'sellerNote', 'buyerOpenid', 'managedByOpenid',
  'imageFileID', 'thumbFileID', 'imageFileIDs', 'thumbFileIDs', 'createTime',
  'expireTime', 'pickupStartDate', 'pickupEndDate', 'expiresAtText', 'availableStartDate', 'leaseEndDate', ...FLAGS
])
const TRIP_FIELDS = fields([
  '_id', 'status', 'departures', 'destinations', 'cityKey', 'cityLabel', 'regionState',
  'availSeatNum', 'passengerCount', 'requestPassengerCount', 'referencePrice', 'price', 'displayPrice',
  'departureAtMs', 'latestDepartureAtMs', 'firstDepartureDate', 'firstDepartureTime', 'createdAt', ...FLAGS
])
function text(value, max = 2000) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).slice(0, max).replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim() : ''
}
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function privateValues(doc) {
  const loc = doc.location && typeof doc.location === 'object' ? doc.location : {}
  return [doc._openid, doc.buyerOpenid, doc.managedByOpenid, doc.sellerName, doc.sellerWechat,
    doc.sellerPhone, doc.sellerNote, doc.Apartment, doc.pickup, doc.address,
    loc.address, loc.detailAddress, loc.name, loc.displayName, loc.buildingName]
    .map(value => text(value)).filter(value => value.length >= 2).sort((a, b) => b.length - a.length)
}
function cleanPublicText(value, doc = {}, max = 1200) {
  let result = text(value, 6000).replace(/<[^>]*>/g, '')
  for (const secret of privateValues(doc)) {
    const boundary = /^[a-z\d]/i.test(secret) && /[a-z\d]$/i.test(secret)
    const pattern = boundary ? `(^|[^a-z\\d])${escapeRegExp(secret)}(?=$|[^a-z\\d])` : escapeRegExp(secret)
    result = result.replace(new RegExp(pattern, 'gi'), boundary ? '$1[已隐藏]' : '[已隐藏]')
  }
  result = result
    .replace(/https?:\/\/\S+|www\.\S+/gi, '[链接已隐藏]')
    .replace(/[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d.-]+\.[a-z]{2,}/gi, '[联系方式已隐藏]')
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, match => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(match.trim())) return match
      const digits = match.replace(/\D/g, '').length
      return digits >= 9 ? '[联系方式已隐藏]' : match
    })
    .replace(/(?:微信|微\s*信|加[微vV]|联系方式|联系(?:电话|微信)|手机号|电话|邮箱|收款|付款账号|\b(?:wechat|weixin|wx|vx|phone|tel|email|zelle|venmo|paypal)\b)[^\n。；;]*/gi, '[联系方式已隐藏]')
    .replace(/(?:详细地址|地址|门牌|室号|\b(?:address|apartment|apt|suite|unit)\b)[^\n。；;]*/gi, '[地址已隐藏]')
    .replace(/\b\d{1,6}\s+(?:[a-z\d.-]+\s+){0,5}(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|place|pl)\b[^\n。；;,]*/gi, '[地址已隐藏]')
    .replace(/[\p{Script=Han}]{0,12}(?:路|街|巷)\s*\d+\s*号[^\n。；;]*/gu, '[地址已隐藏]')
    .replace(/-?\d{1,3}\.\d{4,}\s*[,，/]\s*-?\d{1,3}\.\d{4,}/g, '[位置已隐藏]')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return result.slice(0, max)
}
function number(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return NaN
  if (value === '') return NaN
  const n = Number(value)
  return Number.isFinite(n) ? n : NaN
}
function dateOnly(value) {
  const s = text(value, 20)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return ''
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? s : ''
}
function zonedParts(ms) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(ms)).filter(part => part.type !== 'literal').map(part => [part.type, +part.value]))
}
function tripTime(date, time) {
  const safeDate = dateOnly(date)
  const m = /^(\d{1,2}):(\d{2})$/.exec(text(time, 10))
  if (!safeDate || !m || +m[1] > 23 || +m[2] > 59) return 0
  const [y, mo, day] = safeDate.split('-').map(Number)
  const local = Date.UTC(y, mo - 1, day, +m[1], +m[2])
  let utc = local
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(utc)
    utc = local - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utc)
  }
  const p = zonedParts(utc)
  return p.year === y && p.month === mo && p.day === day && p.hour === +m[1] && p.minute === +m[2] ? utc : 0
}
function marketExpiry(doc) {
  const saved = number(doc.expireTime)
  if (saved > 0) return saved
  const end = dateOnly(doc.leaseEndDate || doc.pickupEndDate || doc.expiresAtText)
  return end ? tripTime(end, '23:59') + 59999 : 0
}
function tripExpiry(doc) {
  const saved = number(doc.latestDepartureAtMs) || number(doc.departureAtMs)
  if (saved > 0) return saved
  return Math.max(0, ...(Array.isArray(doc.departures) ? doc.departures.slice(0, 30) : [])
    .map(point => tripTime(point && point.date, point && point.time)), tripTime(doc.firstDepartureDate, doc.firstDepartureTime))
}
function hasEndedFlag(doc) { return FLAGS.some(key => doc[key] === true || (key.endsWith('At') && !!doc[key])) }
function isVisibleMarket(doc, now) {
  return ['goods', 'sublet'].includes(doc.listingType) && doc.status === 'online' && !hasEndedFlag(doc) && marketExpiry(doc) > now
}
function isVisibleTrip(doc, now) {
  return ['open', 'full'].includes(doc.status) && !hasEndedFlag(doc) && tripExpiry(doc) > now
}
function region(doc, locale) {
  const city = text(doc.cityKey, 40).toLowerCase()
  if (Object.prototype.hasOwnProperty.call(CITY_LABELS, city)) return locale === 'en' ? EN_CITY_LABELS[city] : CITY_LABELS[city]
  const state = text(doc.regionState, 10).toUpperCase()
  return STATE_CODES.has(state) ? (state === 'NY_NJ' ? (locale === 'en' ? 'New York / New Jersey' : '纽约/新泽西') : state) : (locale === 'en' ? 'Area to be confirmed' : '区域待确认')
}
function pointArea(points, locale) {
  const list = Array.isArray(points) ? points.slice(0, 30) : []
  for (const point of list) {
    if (!point || typeof point !== 'object') continue
    const city = text(point.cityKey, 40).toLowerCase()
    if (locale === 'en') {
      // Match public area names only, never return the address text itself.
      const source = [point.address, point.city, point.regionArea, point.regionCounty, point.regionState].map(v => text(v, 300)).join(' ')
      const known = EN_AREAS.find(([pattern]) => pattern.test(source))
      if (known) return known[1]
      if (Object.prototype.hasOwnProperty.call(EN_CITY_LABELS, city)) return EN_CITY_LABELS[city]
      continue
    }
    if (Object.prototype.hasOwnProperty.call(CITY_LABELS, city)) return CITY_LABELS[city]
    const source = [point.city, point.regionState, point.regionCounty, point.regionArea, point.address].map(v => text(v, 300)).join(' ')
    const known = AREAS.find(([pattern]) => pattern.test(source))
    if (known) return known[1]
  }
  return ''
}
function priceText(value, kind, locale) {
  const s = text(value, 50)
  if (s === '免费' || /^free$/i.test(s)) return locale === 'en' ? 'Free' : '免费'
  const match = /^\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:美元|元|USD|\$)?\s*(?:[-–~至]\s*\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:美元|元|USD|\$)?)?\s*(?:\/人|每人|\/月|\/person|\/month)?$/i.exec(s)
  if (!match || +match[1] > 1000000 || (match[2] && (+match[2] > 1000000 || +match[2] < +match[1]))) return locale === 'en' ? (kind === 'sublet' ? 'Rent to be confirmed' : 'Price to be confirmed') : (kind === 'sublet' ? '租金待确认' : '价格待确认')
  return `$${Number(match[1])}${match[2] ? `–$${Number(match[2])}` : ''}${kind === 'sublet' ? (locale === 'en' ? '/month' : '/月') : locale === 'en' && ['carpool', 'request'].includes(kind) ? '/person' : ''}`
}
function tripPrice(doc) {
  // Older imports can contain an empty referencePrice alongside a valid price.
  // Keep zero fares, but do not let a blank preferred field hide the fallback.
  return [doc.referencePrice, doc.price, doc.displayPrice].find(value =>
    (typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isFinite(value)))
}
function makeMarketItem(doc, detail, locale) {
  const kind = doc.listingType
  const start = dateOnly(kind === 'sublet' ? (doc.availableStartDate || doc.pickupStartDate) : doc.pickupStartDate)
  const end = dateOnly(kind === 'sublet' ? (doc.leaseEndDate || doc.pickupEndDate) : doc.pickupEndDate)
  return {
    id: doc._id, kind, title: localizedText(doc.title, doc, 90, locale) || (locale === 'en' ? (kind === 'sublet' ? 'Sublet listing' : 'Secondhand item') : (kind === 'sublet' ? '转租房源' : '二手商品')),
    description: localizedText(doc.desc, doc, detail ? 1200 : 180, locale), priceText: priceText(doc.price, kind, locale),
    regionText: region(doc, locale), timeText: [start, end].filter(Boolean).join(locale === 'en' ? ' to ' : ' 至 '), availabilityText: locale === 'en' ? 'Available' : '发布中',
    images: [], tags: [localizedText(doc.category, doc, 30, locale), localizedText(doc.condition, doc, 30, locale)].filter(Boolean).map(tag => locale === 'en' && Object.prototype.hasOwnProperty.call(EN_TAGS, tag) ? EN_TAGS[tag] : tag)
  }
}
function makeTripItem(doc, kind, now, locale) {
  const from = pointArea(doc.departures, locale)
  const to = pointArea(doc.destinations, locale)
  const route = from && to ? `${from} → ${to}` : region(doc, locale)
  const times = (Array.isArray(doc.departures) ? doc.departures.slice(0, 30) : [])
    .map(point => tripTime(point && point.date, point && point.time)).filter(ms => ms > now).sort((a, b) => a - b)
  const p = zonedParts(times[0] || tripExpiry(doc))
  const pad = n => String(n).padStart(2, '0')
  const seats = number(kind === 'carpool' ? doc.availSeatNum : (doc.requestPassengerCount ?? doc.passengerCount))
  const count = Number.isFinite(seats) && seats >= 0 && seats <= 99 ? Math.floor(seats) : null
  const dateKey = `${p.year}-${pad(p.month)}-${pad(p.day)}`
  // A full passenger request group still needs a vehicle; it is not a full car.
  const full = kind === 'carpool' && (doc.status === 'full' || count === 0)
  if (locale === 'en') return {
    id: doc._id, kind, title: `${kind === 'carpool' ? 'Ride offered' : 'Ride wanted'} · ${route}`,
    description: kind === 'carpool' ? 'A community member is offering seats. Confirm availability and pickup arrangements in the WeChat mini-program.' : 'A community member is looking for a ride. Arrange the details in the WeChat mini-program.',
    priceText: priceText(tripPrice(doc), kind, locale), regionText: route,
    timeText: `${dateKey} ${pad(p.hour)}:${pad(p.minute)}`, availabilityText: full ? 'Full' : count === null ? 'Confirm availability' : kind === 'carpool' ? `${count} seat${count === 1 ? '' : 's'} left` : `${count} seat${count === 1 ? '' : 's'} wanted`,
    images: [], tags: [kind === 'carpool' ? 'Ride offered' : 'Ride wanted'],
    fromLabel: from || 'Pickup area to be confirmed', toLabel: to || 'Destination area to be confirmed', dateKey,
    departureAtMs: times[0] || tripExpiry(doc), seats: count, full
  }
  return {
    id: doc._id, kind, title: `${kind === 'carpool' ? '司机线路' : '乘客求车'} · ${route}`,
    description: kind === 'carpool' ? '提供拼车座位，具体上下车安排请在小程序内确认。' : '乘客正在寻找同行车辆，具体安排请在小程序内确认。',
    priceText: priceText(tripPrice(doc), kind), regionText: route,
    timeText: `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`,
    availabilityText: doc.status === 'full' ? '已满员' : count === null ? '可联系确认' : kind === 'carpool' ? `余 ${count} 座` : `需 ${count} 座`,
    images: [], tags: [kind === 'carpool' ? '车找人' : '人找车']
  }
}
function parseRequest(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null
  const action = event.previewAction
  const locale = event.locale === undefined ? 'zh' : event.locale
  if (!['zh', 'en'].includes(locale)) return null
  if (!['marketList', 'marketDetail', 'tripList', 'tripDetail'].includes(action)) return null
  const market = action.startsWith('market')
  const detail = action.endsWith('Detail')
  const type = market && detail ? 'all' : (event.type || (market ? 'goods' : 'all'))
  if (!(market ? ['goods', 'sublet', 'all'] : ['carpool', 'request', 'all']).includes(type)) return null
  if (!market && detail && type === 'all') return null
  const id = detail ? text(event.id, 129) : ''
  if (detail && !/^[a-z\d_-]{1,128}$/i.test(id)) return null
  const sellerId = text(event.sellerId, 129)
  if (event.sellerId !== undefined && (!market || !/^[a-z\d_-]{1,128}$/i.test(sellerId))) return null
  const rawLimit = event.limit === undefined ? MAX_LIMIT : number(event.limit)
  const offset = event.offset === undefined ? 0 : number(event.offset)
  if (!Number.isFinite(rawLimit) || rawLimit < 1 || !Number.isInteger(offset) || offset < 0 || offset >= MAX_RESULTS) return null
  const cityKey = text(event.cityKey, 41)
  const category = text(event.category, 41)
  if (event.cityKey !== undefined && (typeof event.cityKey !== 'string' || cityKey.length > 40 || !/^[a-z_]*$/i.test(cityKey))) return null
  if (event.category !== undefined && (typeof event.category !== 'string' || category.length > 40)) return null
  return { action, market, detail, type, id, sellerId, limit: Math.min(MAX_LIMIT, Math.floor(rawLimit)), offset, cityKey, category, locale }
}
function cityMatches(doc, requested, market) {
  const key = requested.toLowerCase()
  if (!key || key === 'all') return true
  const stored = text(doc.cityKey, 40).toLowerCase()
  if (['ny', 'nj', 'ny_nj'].includes(key) && ['ny', 'nj', 'ny_nj'].includes(stored)) return true
  if (stored === key) return true
  const state = text(doc.regionState, 10).toUpperCase()
  return market && !!state && (state === (CITY_STATES[key] || requested.toUpperCase()) || (['ny', 'nj', 'ny_nj'].includes(key) && ['NY', 'NJ', 'NY_NJ'].includes(state)))
}
function cityCondition(command, requested, market) {
  const key = requested.toLowerCase()
  if (!key || key === 'all') return null
  const aliases = ['ny', 'nj', 'ny_nj'].includes(key) ? ['ny', 'nj', 'ny_nj'] : [key]
  const byCity = { cityKey: command.in(aliases) }
  if (!market) return byCity
  const states = ['ny', 'nj', 'ny_nj'].includes(key) ? ['NY', 'NJ', 'NY_NJ'] : [CITY_STATES[key] || requested.toUpperCase()]
  return command.or([byCity, { regionState: command.in(states) }])
}
function visibilityCondition(command, market, now) {
  const p = zonedParts(now)
  const today = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
  const unset = field => command.or([
    { [field]: command.exists(false) }, { [field]: command.lte(0) }, { [field]: command.in([null, '']) }
  ])
  if (market) {
    return command.or([
      { expireTime: command.gt(now) },
      command.and([unset('expireTime'), command.or([
        { leaseEndDate: command.gte(today) }, { pickupEndDate: command.gte(today) }, { expiresAtText: command.gte(today) }
      ])])
    ])
  }
  return command.or([
    { latestDepartureAtMs: command.gt(now) },
    command.and([unset('latestDepartureAtMs'), command.or([
      { departureAtMs: command.gt(now) },
      command.and([unset('departureAtMs'), command.or([
        { 'departures.date': command.gte(today) }, { firstDepartureDate: command.gte(today) }
      ])])
    ])])
  ])
}
function safeFileID(value, envId) {
  if (typeof value !== 'string' || typeof envId !== 'string' || !/^[a-z\d-]+$/i.test(envId)) return ''
  const match = /^cloud:\/\/([^/]+)\/(.+)$/.exec(value)
  if (!match || !match[1].startsWith(`${envId}.`) || !/^[a-z\d-]+$/i.test(match[1].slice(envId.length + 1))) return ''
  const path = match[2]
  const publicPath = /^(market|market_thumb)\//.test(path) || /^web-admin\/[a-z\d_-]{1,128}\/[a-f\d]{32}\.(?:jpe?g|png|webp)$/i.test(path)
  if (!publicPath || /[\s%?#\\\u0000-\u001f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) return ''
  return /\.(?:jpe?g|png|gif|webp|bmp|avif)$/i.test(path) ? value : ''
}
function safeImageURL(value) {
  if (typeof value !== 'string' || value.length > 4096) return ''
  try {
    const url = new URL(value)
    const suffixes = ['tcb.qcloud.la', 'tcloudbaseapp.com', 'myqcloud.com', 'tencentcos.cn', 'qcloud.com']
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return ''
    if (!suffixes.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return ''
    return url.href
  } catch (_) { return '' }
}
function createPublicPreviewHandler({ db, cloud, now = () => Date.now(), getEnvId }) {
  const getEnvironment = getEnvId || (() => {
    const context = cloud.getWXContext()
    return context.ENV || process.env.TCB_ENV || process.env.SCF_NAMESPACE || ''
  })
  async function read(collection, where, projection, detail, orderField) {
    const rows = []
    for (let offset = 0; offset < (detail ? 1 : MAX_SCAN); offset += 100) {
      const limit = detail ? 1 : Math.min(100, MAX_SCAN - offset)
      let query = db.collection(collection).where(where).field(projection)
      if (!detail) query = query.orderBy(orderField, 'desc')
      const result = await query.skip(offset).limit(limit).get()
      const batch = Array.isArray(result.data) ? result.data : []
      rows.push(...batch.slice(0, limit))
      if (batch.length < limit) break
    }
    return rows
  }
  async function addImages(entries, detail) {
    const env = getEnvironment()
    const requests = entries.map(({ item, doc }) => {
      if (!['goods', 'sublet'].includes(item.kind)) return []
      const raw = detail
        ? [doc.imageFileID, ...(Array.isArray(doc.imageFileIDs) ? doc.imageFileIDs.slice(0, 8) : []), doc.thumbFileID]
        : [doc.thumbFileID, ...(Array.isArray(doc.thumbFileIDs) ? doc.thumbFileIDs.slice(0, 2) : []), doc.imageFileID, ...(Array.isArray(doc.imageFileIDs) ? doc.imageFileIDs.slice(0, 2) : [])]
      return [...new Set(raw.map(id => safeFileID(id, env)).filter(Boolean))].slice(0, detail ? 4 : 1)
    })
    const fileList = [...new Set(requests.flat())]
    const urls = new Map()
    if (fileList.length) {
      try {
        const result = await cloud.getTempFileURL({ fileList })
        for (const row of result.fileList || []) {
          const url = safeImageURL(row.tempFileURL)
          if (fileList.includes(row.fileID) && (row.status === undefined || row.status === 0) && url) urls.set(row.fileID, url)
        }
      } catch (_) { /* Text previews remain available when image resolution fails. */ }
    }
    return entries.map(({ item }, i) => ({ ...item, images: requests[i].map(id => urls.get(id)).filter(Boolean) }))
  }
  return async function publicPreview(event = {}) {
    const request = parseRequest(event)
    if (!request) return { ok: false, error: 'invalid_preview_request' }
    const timestamp = now()
    try {
      const entries = []
      if (request.market) {
        let where = { status: 'online', listingType: request.type === 'all' ? db.command.in(['goods', 'sublet']) : request.type }
        if (request.detail) where._id = request.id
        if (request.sellerId && !request.detail) where._openid = request.sellerId
        if (request.category && request.category !== '全部' && !request.detail) where.category = request.category
        if (!request.detail) where = db.command.and([
          where, visibilityCondition(db.command, true, timestamp), cityCondition(db.command, request.cityKey, true)
        ].filter(Boolean))
        const rows = await read('market_goods', where, MARKET_FIELDS, request.detail, 'createTime')
        for (const doc of rows) {
          if (!isVisibleMarket(doc, timestamp) || (!request.detail && !cityMatches(doc, request.cityKey, true))) continue
          entries.push({ item: makeMarketItem(doc, request.detail, request.locale), doc, sort: number(doc.createTime) || (doc.createTime instanceof Date ? doc.createTime.getTime() : 0) })
        }
      } else {
        const types = request.type === 'all' ? ['carpool', 'request'] : [request.type]
        for (const kind of types) {
          let where = { status: db.command.in(['open', 'full']) }
          if (request.detail) where._id = request.id
          if (!request.detail) where = db.command.and([
            where, visibilityCondition(db.command, false, timestamp), cityCondition(db.command, request.cityKey, false)
          ].filter(Boolean))
          const rows = await read(kind === 'carpool' ? 'Carpool' : 'CarpoolRequest', where, TRIP_FIELDS, request.detail, 'createdAt')
          for (const doc of rows) {
            if (!isVisibleTrip(doc, timestamp) || (!request.detail && !cityMatches(doc, request.cityKey, false))) continue
            entries.push({ item: makeTripItem(doc, kind, timestamp, request.locale), doc, sort: tripExpiry(doc) })
          }
        }
      }
      if (request.detail) {
        if (!entries.length) return { ok: false, error: 'not_found' }
        return { ok: true, item: (await addImages(entries.slice(0, 1), true))[0] }
      }
      entries.sort((a, b) => (request.market ? b.sort - a.sort : a.sort - b.sort) || a.item.kind.localeCompare(b.item.kind) || a.item.id.localeCompare(b.item.id))
      const bounded = entries.slice(0, MAX_RESULTS)
      const selected = bounded.slice(request.offset, request.offset + request.limit)
      const nextOffset = request.offset + selected.length
      return { ok: true, items: await addImages(selected, false), hasMore: nextOffset < bounded.length, nextOffset }
    } catch (_) {
      return { ok: false, error: 'preview_unavailable' }
    }
  }
}

module.exports = { createPublicPreviewHandler, cleanPublicText, isVisibleMarket, isVisibleTrip, tripTime, safeFileID, safeImageURL, parseRequest }
