const { normalizeRideServiceCityKey } = require('./cityTree')

const PLACE_MAX_LENGTH = 200
const PLACE_CACHE_MS = 5 * 60 * 1000
const cache = new Map()

function normalizeRidePlace(value) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text && text.length <= PLACE_MAX_LENGTH ? text : ''
}

function placeIdentity(value) {
  const text = normalizeRidePlace(value).toLowerCase()
  const compact = text.replace(/\s+/g, '')
  if (['fortlee', 'fortlee核心区'].includes(compact)) return 'fortlee'
  if (['哥大', '哥伦比亚大学', 'columbia', 'columbiauniversity'].includes(compact)) return 'columbia'
  return text
}

function uniqueRidePlaces(values) {
  const seen = new Set()
  return (Array.isArray(values) ? values : []).reduce((places, value) => {
    const text = normalizeRidePlace(value)
    const key = placeIdentity(text)
    if (!text || ['全部', '其他', '自选'].includes(text) || seen.has(key)) return places
    seen.add(key)
    places.push(text)
    return places
  }, [])
}

function copyOptions(options) {
  return { fromPlaces: options.fromPlaces.slice(), toPlaces: options.toPlaces.slice() }
}

function storedValue(key) {
  try { return wx.getStorageSync(key) } catch (_) { return '' }
}

function loadRidePlaceOptions({ cityKey, viewerKey, revision, force = false } = {}) {
  const city = normalizeRideServiceCityKey(cityKey)
  const viewer = viewerKey == null
    ? (storedValue('isGuest') ? '' : String(storedValue('openid') || ''))
    : String(viewerKey)
  const version = revision == null ? storedValue('rideListShouldRefreshAt') : revision
  const key = JSON.stringify([city, viewer, String(version || '')])
  const previous = cache.get(key)
  if (previous && previous.promise) return previous.promise.then(copyOptions)
  const age = previous ? Date.now() - previous.at : -1
  if (!force && previous && previous.data && age >= 0 && age < PLACE_CACHE_MS) {
    return Promise.resolve(copyOptions(previous.data))
  }

  const entry = { at: 0, data: null, promise: null }
  cache.set(key, entry)
  while (cache.size > 20) cache.delete(cache.keys().next().value)
  // Start under the current WeChat identity immediately, before any await.
  entry.promise = (async () => {
    const response = await wx.cloud.callFunction({ name: 'getTripList', data: { action: 'places', cityKey: city } })
    const result = response && response.result
    const data = result && result.data
    if (!result || result.success !== true || !data ||
      !Array.isArray(data.fromPlaces) || !Array.isArray(data.toPlaces) ||
      !data.fromPlaces.every(value => typeof value === 'string') ||
      !data.toPlaces.every(value => typeof value === 'string')) {
      throw new Error('地点加载失败，请重试')
    }
    entry.data = { fromPlaces: uniqueRidePlaces(data.fromPlaces), toPlaces: uniqueRidePlaces(data.toPlaces) }
    entry.at = Date.now()
    return entry.data
  })().catch(error => {
    if (cache.get(key) === entry) cache.delete(key)
    throw error
  }).finally(() => { entry.promise = null })
  return entry.promise.then(copyOptions)
}

module.exports = { PLACE_MAX_LENGTH, normalizeRidePlace, placeIdentity, uniqueRidePlaces, loadRidePlaceOptions }
