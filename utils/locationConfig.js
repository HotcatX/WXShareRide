const backend = require('./backendClient')
const CACHE_MS = 5 * 60 * 1000
const copy = value => JSON.parse(JSON.stringify(value))
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.trim().length > 0
const list = value => Array.isArray(value) && value.length > 0
const aliases = value => Array.isArray(value) && value.every(text)
function validCatalog(value) {
  return object(value) && text(value.version) && text(value.placeCatalogVersion) && list(value.fixedPlaces) &&
    value.fixedPlaces.every(place => object(place) && text(place.placeId) && text(place.label) && text(place.value) &&
      aliases(place.aliases) && typeof place.airport === 'boolean') &&
    object(value.rideAddresses) && ['offer', 'request'].every(kind => object(value.rideAddresses[kind]) &&
      ['fromPlaces', 'toPlaces'].every(field => list(value.rideAddresses[kind][field]) && value.rideAddresses[kind][field].every(text))) &&
    Array.isArray(value.requestPrices) && value.requestPrices.every(row => object(row) && text(row.fromAddress) && text(row.toAddress) && text(row.label)) &&
    object(value.cityTree) && list(value.cityTree.countries) && value.cityTree.countries.every(country => object(country) &&
      text(country.code) && text(country.label) && list(country.groups) && country.groups.every(group => object(group) &&
        text(group.title) && list(group.cities) && group.cities.every(city => object(city) && text(city.key) && text(city.label) && aliases(city.aliases)))) &&
    list(value.regionTree) &&
    value.regionTree.every(state => object(state) && text(state.key) && text(state.label) && list(state.groups) &&
      state.groups.every(group => object(group) && text(group.key) && text(group.label) && list(group.areas) && group.areas.every(text))) &&
    object(value.marketRegionTree) && list(value.marketRegionTree.states) && value.marketRegionTree.states.every(state =>
      object(state) && text(state.key) && text(state.label) && list(state.areas) && state.areas.every(area =>
        object(area) && text(area.key) && text(area.label) && aliases(area.aliases)))
}
function createLocationClient(api = backend, now = Date.now) {
  let cached = null, pending = null
  async function load({ force = false } = {}) {
    if (!api.isBackendEnabled()) throw new Error('地点服务尚未切换')
    const age = cached ? now() - cached.at : -1
    if (!force && cached && age >= 0 && age < CACHE_MS) return copy(cached.data)
    if (!pending) {
      pending = Promise.resolve().then(() => api.get('/api/v1/locations', { public: true })).then(data => {
        if (!validCatalog(data)) throw new Error('地点配置格式无效')
        cached = { at: now(), data: copy(data) }
        return data
      }).finally(() => { pending = null })
    }
    return copy(await pending)
  }
  return { load }
}
const client = createLocationClient()
module.exports = { loadLocationConfig: options => client.load(options), createLocationClient, validCatalog, CACHE_MS }
