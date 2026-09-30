const PREVIEW_ACTIONS = ['marketList', 'marketDetail', 'tripList', 'tripDetail']
const ITEM_KINDS = ['goods', 'sublet', 'carpool', 'request']
const backend = require('./backendClient')
const { getRideDateTime } = require('./rideTime')
const { getCityStateFilter } = require('./cityTree')

async function serverPreview(data) {
  // Preview is explicitly anonymous even on a device with a remembered login.
  // The canonical route performs text redaction; this adapter formats only its
  // public fields and never reconstructs seller/private fields from a cache.
  const detail = data.previewAction.endsWith('Detail')
  if (data.previewAction.startsWith('trip')) {
    const kind = data.type === 'carpool' ? 'offer' : data.type === 'request' ? 'request' : ''
    const query = `offset=${data.offset || 0}&limit=${data.limit || 10}${kind ? `&kind=${kind}` : ''}`
    const response = await backend.get(detail ? `/api/v1/previews/rides/${encodeURIComponent(data.id)}` : `/api/v1/previews/rides?${query}`, { anonymous: true })
    const rows = detail ? [response] : response.items
    if (!Array.isArray(rows)) throw friendlyError('INVALID_RESPONSE')
    const items = rows.map(row => {
      const time = getRideDateTime(Date.parse(row.departureAt))
      return { id: row.id, kind: row.kind === 'offer' ? 'carpool' : 'request', title: `${row.fromArea} → ${row.toArea}`,
        description: '', priceText: row.listedPriceCents === null ? '价格面议' : `$${(row.listedPriceCents / 100).toFixed(row.listedPriceCents % 100 ? 2 : 0)}`,
        regionText: `${row.fromArea} → ${row.toArea}`, timeText: time ? `${time.date} ${time.time}` : '',
        availabilityText: `余 ${row.availableSeats} 座`, images: [], tags: [row.kind === 'offer' ? '车找人' : '人找车'] }
    })
    return detail ? { ok: true, item: items[0] } : { ok: true, items, hasMore: response.hasMore, nextOffset: response.nextOffset }
  }
  const prefix = data.sellerId ? `/api/v1/market/sellers/${encodeURIComponent(data.sellerId)}/listings` : '/api/v1/market/listings'
  const cityKey = data.cityKey || ''
  const regionState = !cityKey || ['ALL', 'all', 'ALL_STATES'].includes(cityKey) ? ''
    : /^(?:[A-Z]{2}|NY_NJ)$/.test(cityKey) ? cityKey : getCityStateFilter({ key: cityKey }).key
  const params = { listingType: data.type, offset: data.offset, limit: data.limit,
    category: data.category === '全部' ? '' : data.category, regionState }
  const query = Object.entries(params).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
  const response = await backend.get(detail ? `${prefix}/${encodeURIComponent(data.id)}` : `${prefix}?${query}`, { anonymous: true })
  const rows = detail ? [response] : response.items
  if (!Array.isArray(rows)) throw friendlyError('INVALID_RESPONSE')
  const ids = [...new Set(rows.flatMap(row => (row.images || []).map(image => image.fileId)))]
  const urls = {}
  for (let index = 0; index < ids.length; index += 50) {
    const entries = await backend.resolveImages(ids.slice(index, index + 50), { anonymous: true })
    entries.forEach(entry => { urls[entry.fileId] = entry.url })
  }
  const items = rows.map(row => ({ id: row.id, kind: row.listingType, title: row.title, description: row.description,
    priceText: `$${(row.priceCents / 100).toFixed(row.priceCents % 100 ? 2 : 0)}${row.listingType === 'sublet' ? '/月' : ''}`,
    regionText: row.region?.state || '', timeText: `${row.startDate} 至 ${row.endDate}`, availabilityText: '在售',
    images: (row.images || []).map(image => urls[image.fileId]).filter(Boolean), tags: [row.category, row.condition].filter(Boolean) }))
  return detail ? { ok: true, item: items[0] } : { ok: true, items, hasMore: response.hasMore, nextOffset: response.nextOffset }
}

function text(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function friendlyError(code) {
  code = typeof code === 'string' ? code.toUpperCase() : ''
  const unavailable = ['NOT_FOUND', 'NOT_AVAILABLE', 'EXPIRED', 'INVALID_ID', 'ITEM_NOT_FOUND', 'INVALID_PREVIEW_REQUEST', 'LISTING_NOT_FOUND', 'RIDE_NOT_FOUND', 'SELLER_NOT_FOUND'].includes(code)
  const error = new Error(unavailable
    ? '这条信息已失效或暂未公开，可以浏览其他公开信息。'
    : code === 'TIMEOUT'
      ? '加载时间有点久，请稍后重试。'
      : '暂时无法加载公开信息，请稍后重试。')
  error.code = unavailable ? 'UNAVAILABLE' : code === 'TIMEOUT' ? 'TIMEOUT' : 'LOAD_FAILED'
  error.retryable = !unavailable
  return error
}

function requestData(options) {
  const action = options && options.action
  if (!PREVIEW_ACTIONS.includes(action)) throw friendlyError('INVALID_ACTION')
  const data = { action: 'publicPreview', previewAction: action }
  const market = action.indexOf('market') === 0
  const detail = action.endsWith('Detail')
  const types = market ? ['goods', 'sublet'] : ['all', 'carpool', 'request']
  data.type = types.includes(options.type) ? options.type : market ? 'goods' : 'all'
  if (detail) {
    data.id = text(options.id, 160)
    if (!data.id) throw friendlyError('INVALID_ID')
  } else {
    const offset = Number(options.offset)
    const limit = Number(options.limit)
    data.offset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0
    data.limit = Number.isFinite(limit) ? Math.min(20, Math.max(1, Math.floor(limit))) : 10
    ;['cityKey', 'category'].forEach(key => {
      const value = text(options[key], 100)
      if (value) data[key] = value
    })
    if (market) {
      const sellerId = text(options.sellerId, 160)
      if (sellerId) data.sellerId = sellerId
    }
  }
  return data
}

// The server is responsible for redacting public text and images. Keep its
// explicit public projection here; never spread a database record into a view.
function publicItem(value) {
  if (!value || typeof value !== 'object') return null
  const id = text(value.id, 160)
  if (!id || !ITEM_KINDS.includes(value.kind)) return null
  return {
    id,
    kind: value.kind,
    title: text(value.title, 200),
    description: text(value.description, 12000),
    priceText: text(value.priceText, 100),
    regionText: text(value.regionText, 200),
    timeText: text(value.timeText, 200),
    availabilityText: text(value.availabilityText, 100),
    images: (Array.isArray(value.images) ? value.images : [])
      .filter(url => typeof url === 'string' && /^https:\/\/[^\s/]+\/[^\s]*$/i.test(url))
      .slice(0, 12),
    tags: (Array.isArray(value.tags) ? value.tags : [])
      .map(tag => text(tag, 60)).filter(Boolean).slice(0, 12)
  }
}

function normalizeResult(result, data) {
  if (!result || result.ok !== true) {
    const code = result && (result.code || result.errorCode || result.error)
    throw friendlyError(typeof code === 'string' ? code : '')
  }
  if (data.previewAction.endsWith('Detail')) {
    const item = publicItem(result.item)
    if (!item) throw friendlyError('NOT_FOUND')
    return { ok: true, item }
  }
  if (!Array.isArray(result.items)) throw friendlyError('INVALID_RESPONSE')
  const items = result.items.map(publicItem).filter(Boolean)
  const offset = Number(result.nextOffset)
  const nextOffset = Number.isFinite(offset) ? Math.floor(offset) : data.offset
  return {
    ok: true,
    items,
    hasMore: result.hasMore === true && nextOffset > data.offset,
    nextOffset: Math.max(data.offset, nextOffset)
  }
}

async function callPublicPreview(options) {
  await backend.ready()
  const data = requestData(options)
  const result = await serverPreview(data).catch(error => { throw friendlyError(error.code) })
  return normalizeResult(result, data)
}

module.exports = { callPublicPreview }
