const { FIXED_PLACES } = require('./placeCatalog')
const backend = require('./backendClient')
const { loadLocationConfig } = require('./locationConfig')
const ADDRESS_CONFIG_CACHE_MS = 5 * 60 * 1000
let cached = null, pending = null
function copyConfig(config) { return { fromPlaces: config.fromPlaces.slice(), toPlaces: config.toPlaces.slice() } }
function getStaticRideAddressConfig() { const values = FIXED_PLACES.map(place => place.value); return { fromPlaces: values.slice(), toPlaces: values.slice() } }
function getCachedRideAddressConfig() {
  const age = cached ? Date.now() - cached.at : -1
  return cached && backend.isBackendEnabled() && age >= 0 && age < ADDRESS_CONFIG_CACHE_MS ? copyConfig(cached.data) : null
}
function loadRideAddressConfig({ force = false } = {}) {
  if (pending) return pending.then(copyConfig)
  const available = !force && getCachedRideAddressConfig()
  if (available) return Promise.resolve(available)
  pending = (async () => {
    const catalog = await loadLocationConfig({ force })
    const data = catalog.rideAddresses.offer
    cached = { at: Date.now(), data }; return data
  })().finally(() => { pending = null })
  return pending.then(copyConfig)
}
module.exports = { ADDRESS_CONFIG_CACHE_MS, getStaticRideAddressConfig, getCachedRideAddressConfig, loadRideAddressConfig }
