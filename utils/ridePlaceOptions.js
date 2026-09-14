const { normalizeRideServiceCityKey } = require('./cityTree')

const PLACE_MAX_LENGTH = 200
const PLACE_CACHE_MS = 5 * 60 * 1000
const cache = new Map()
const PLACE_ALIASES = {
  ewr: ['ewr', 'ewr机场', 'ewrairport', '纽瓦克', '纽瓦克机场', '纽瓦克国际机场', '纽瓦克自由国际机场', 'newark', 'newarkairport', 'newarkinternationalairport', 'newarklibertyairport', 'newarklibertyinternationalairport'],
  jfk: ['jfk', 'jfk机场', 'jfk国际机场', 'jfkairport', '肯尼迪', '肯尼迪机场', '肯尼迪国际机场', '纽约肯尼迪机场', 'johnfkennedy', 'johnfkennedyairport', 'johnfkennedyinternationalairport'],
  lga: ['lga', 'lga机场', 'lgaairport', '拉瓜迪亚', '拉瓜迪亚机场', '拉瓜迪亚国际机场', '拉瓜地亚', '拉瓜地亚机场', 'laguardia', 'laguardiaairport', 'laguardiainternationalairport'],
  flushing: ['法拉盛', 'flushing']
}
const SHORT_PLACE_LABELS = { fortlee: 'Fort Lee', columbia: '哥大', ewr: '纽瓦克', jfk: 'JFK', lga: '拉瓜迪亚', flushing: '法拉盛' }

function normalizeRidePlace(value) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text && text.length <= PLACE_MAX_LENGTH ? text : ''
}

function placeIdentity(value) {
  const text = normalizeRidePlace(value).toLowerCase()
  const compact = text.replace(/\s+/g, '')
  if (['fortlee', 'fortlee核心区'].includes(compact)) return 'fortlee'
  if (['哥大', '哥伦比亚大学', 'columbia', 'columbiauniversity', '哥大columbia', '哥大/columbia'].includes(compact)) return 'columbia'
  for (const [key, aliases] of Object.entries(PLACE_ALIASES)) if (aliases.includes(compact)) return key
  return text
}

function shortRidePlaceLabel(value) {
  return SHORT_PLACE_LABELS[placeIdentity(value)] || normalizeRidePlace(value)
}

function ridePlaceAliasPattern(value) {
  const aliases = PLACE_ALIASES[placeIdentity(value)]
  if (!aliases) return ''
  const patterns = aliases.map(alias => [...alias].map(character => character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'))
  return `^\\s*(?:${patterns.join('|')})\\s*$`
}

function makeRidePlaceMatcher(place) {
  const value = normalizeRidePlace(place)
  if (!value) return () => false
  // Keep the existing broad Fort Lee / Columbia route filters and price values.
  if (/fort\s*lee/i.test(value)) return address => /fort\s*lee/i.test(String(address || ''))
  if (/哥大|columbia/i.test(value)) return address => /哥大|columbia/i.test(String(address || ''))
  const identity = placeIdentity(value)
  const patterns = {
    ewr: /(?:^|[^a-z])ewr(?:$|[^a-z])|newark|纽瓦克/i,
    jfk: /(?:^|[^a-z])jfk(?:$|[^a-z])|john\s*f\.?\s*kennedy|肯尼迪/i,
    lga: /(?:^|[^a-z])lga(?:$|[^a-z])|la\s*guardia|拉瓜[迪地]亚/i,
    flushing: /flushing|法拉盛/i
  }
  if (patterns[identity]) return address => patterns[identity].test(String(address || ''))
  return address => !!address && String(address).toLowerCase().includes(value.toLowerCase())
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

module.exports = { PLACE_MAX_LENGTH, normalizeRidePlace, placeIdentity, shortRidePlaceLabel, ridePlaceAliasPattern, makeRidePlaceMatcher, uniqueRidePlaces, loadRidePlaceOptions }
