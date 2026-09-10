const PREVIEW_ACTIONS = ['marketList', 'marketDetail', 'tripList', 'tripDetail']
const ITEM_KINDS = ['goods', 'sublet', 'carpool', 'request']
const REQUEST_TIMEOUT_MS = 15000

function text(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function friendlyError(code) {
  code = typeof code === 'string' ? code.toUpperCase() : ''
  const unavailable = ['NOT_FOUND', 'NOT_AVAILABLE', 'EXPIRED', 'INVALID_ID', 'ITEM_NOT_FOUND', 'INVALID_PREVIEW_REQUEST'].includes(code)
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

function callPublicPreview(options) {
  return new Promise((resolve, reject) => {
    let data
    try {
      data = requestData(options)
    } catch (error) {
      reject(error)
      return
    }
    if (typeof wx === 'undefined' || !wx.cloud || typeof wx.cloud.callFunction !== 'function') {
      reject(friendlyError('UNAVAILABLE_CLIENT'))
      return
    }
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(friendlyError('TIMEOUT')), REQUEST_TIMEOUT_MS)
    try {
      Promise.resolve(wx.cloud.callFunction({ name: 'marketApi', data })).then(response => {
        try {
          finish(null, normalizeResult(response && response.result, data))
        } catch (error) {
          finish(error)
        }
      }, () => finish(friendlyError('LOAD_FAILED')))
    } catch (error) {
      finish(friendlyError('LOAD_FAILED'))
    }
  })
}

module.exports = { callPublicPreview }
