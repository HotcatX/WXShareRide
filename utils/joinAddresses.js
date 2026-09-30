const { placeIdentity } = require('./ridePlaceOptions')
const { normalizeRideServiceCityKey } = require('./cityTree')

const STORAGE_PREFIX = 'rideJoinAddressesV1:'
const MAX_ROUTES = 30
const address = value => typeof value === 'string' && value.trim().length <= 60 ? value.trim() : ''

function routeKey(trip = {}) {
  const stops = values => Array.isArray(values) && values.length && values.length <= 10
    ? values.map(stop => placeIdentity(stop && stop.address)) : []
  const from = stops(trip.departures), to = stops(trip.destinations)
  if (!from.length || !to.length || [...from, ...to].some(value => !value)) return ''
  // Dates change each week; direction, service city and intermediate stops do not.
  return JSON.stringify([normalizeRideServiceCityKey(trip.cityKey), from, to])
}

function storageKey(storage) {
  const owner = storage.getStorageSync('openid')
  return !storage.getStorageSync('isGuest') && typeof owner === 'string' && owner.trim()
    ? STORAGE_PREFIX + encodeURIComponent(owner.trim()) : ''
}

function entries(storage, key) {
  const saved = storage.getStorageSync(key)
  return (Array.isArray(saved) ? saved : []).filter(item => item && typeof item.route === 'string' &&
    address(item.pickupAddress) && address(item.dropoffAddress)).slice(0, MAX_ROUTES)
}

function readJoinAddresses(trip, storage) {
  try {
    const key = storageKey(storage), route = routeKey(trip)
    if (!key || !route) return null
    const saved = entries(storage, key).find(item => item.route === route)
    return saved ? { pickupAddress: address(saved.pickupAddress), dropoffAddress: address(saved.dropoffAddress) } : null
  } catch (_) { return null }
}

function rememberJoinAddresses(trip, values, storage) {
  try {
    const key = storageKey(storage), route = routeKey(trip)
    const pickupAddress = address(values && values.pickupAddress), dropoffAddress = address(values && values.dropoffAddress)
    if (!key || !route || !pickupAddress || !dropoffAddress) return false
    const saved = entries(storage, key).filter(item => item.route !== route)
    storage.setStorageSync(key, [{ route, pickupAddress, dropoffAddress }, ...saved].slice(0, MAX_ROUTES))
    return true
  } catch (_) { return false }
}

module.exports = { routeKey, readJoinAddresses, rememberJoinAddresses }
