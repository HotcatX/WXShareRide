const { normalizeRidePlace, uniqueRidePlaces } = require('./ridePlaceOptions')
const { FIXED_PLACES, configuredPlaceId } = require('./placeCatalog')
const ADDRESS_CONFIG_CACHE_MS = 5 * 60 * 1000
let cached = null, pending = null
function copyConfig(config) { return { fromPlaces: config.fromPlaces.slice(), toPlaces: config.toPlaces.slice() } }
function getStaticRideAddressConfig() { const values = FIXED_PLACES.map(place => place.value); return { fromPlaces: values.slice(), toPlaces: values.slice() } }
function getCachedRideAddressConfig() {
  const age = cached ? Date.now() - cached.at : -1
  return cached && age >= 0 && age < ADDRESS_CONFIG_CACHE_MS ? copyConfig(cached.data) : null
}
function readPlaces(response) {
  const record = response && Array.isArray(response.data) && response.data[0]
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('地点配置加载失败')
  const values = Object.keys(record).filter(key => key !== '_id').map(key => record[key])
  if (!values.length || values.some(value => typeof value !== 'string' || !normalizeRidePlace(value))) throw new Error('地点配置格式无效')
  const places = uniqueRidePlaces(values)
  return FIXED_PLACES.map(place => {
    const value = places.find(value => configuredPlaceId(value) === place.placeId)
    return value && value !== '纽瓦克' ? value : place.value
  }).concat(places.filter(value => configuredPlaceId(value) === 'unknown'))
}
function loadRideAddressConfig({ force = false } = {}) {
  if (pending) return pending.then(copyConfig)
  const available = !force && getCachedRideAddressConfig()
  if (available) return Promise.resolve(available)
  pending = (async () => {
    const db = wx.cloud.database()
    const [from, to] = await Promise.all([db.collection('Departure').get(), db.collection('Arrival').get()])
    const data = { fromPlaces: readPlaces(from), toPlaces: readPlaces(to) }
    cached = { at: Date.now(), data }; return data
  })().finally(() => { pending = null })
  return pending.then(copyConfig)
}
module.exports = { ADDRESS_CONFIG_CACHE_MS, getStaticRideAddressConfig, getCachedRideAddressConfig, loadRideAddressConfig }
