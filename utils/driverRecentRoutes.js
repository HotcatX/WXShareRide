const { isValidRideDate } = require('./rideTime')
const { getDriverRoutePriceKey } = require('./driverRideDefaults')

const STORAGE_PREFIX = 'driver_recent_routes_v1:'
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000
const MAX_ROUTES = 12
const accounts = new Map()
const pendingLoads = new Map()

function text(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function accountId(value) {
  return typeof value === 'string' && value.trim().length <= 128 ? value.trim() : ''
}

function currentAccount() {
  try { return accountId(wx.getStorageSync('openid')) } catch (e) { return '' }
}

function timestamp(value) {
  if (value && typeof value.getTime === 'function') value = value.getTime()
  else if (value && typeof value === 'object' && value.$date !== undefined) return timestamp(value.$date)
  else if (value && typeof value === 'object' && Number.isFinite(value.seconds)) value = value.seconds * 1000
  else if (typeof value === 'string') value = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function placeKey(value) { return value.toLowerCase().replace(/\s+/g, '') }

function normalizeRoute(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null
  const departure = Array.isArray(source.departures) ? source.departures[0] : null
  const destination = Array.isArray(source.destinations) ? source.destinations[0] : null
  const rawDeparture = source.departureAddress || (departure && departure.address)
  const rawDestination = source.destinationAddress || (destination && destination.address)
  if (typeof rawDeparture !== 'string' || typeof rawDestination !== 'string' ||
      rawDeparture.trim().length > 120 || rawDestination.trim().length > 120) return null
  const departureAddress = text(rawDeparture, 120)
  const destinationAddress = text(rawDestination, 120)
  const departureTime = text(source.departureTime || (departure && departure.time), 20)
  const sourceDate = source.departureDate || (departure && departure.date)
  const seats = source.passengerCount
  const passengerCount = typeof seats === 'number' || typeof seats === 'string' ? Number(seats) : NaN
  if (!departureAddress || !destinationAddress || placeKey(departureAddress) === placeKey(destinationAddress) ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(departureTime) ||
      (sourceDate && !isValidRideDate(sourceDate)) ||
      !Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 7) return null

  const cityKey = text(source.cityKey, 80) || 'ny_nj'
  const routeParts = [cityKey, placeKey(departureAddress), placeKey(destinationAddress), departureTime]
  const _id = 'recent:' + routeParts.map(encodeURIComponent).join(':')
  const referencePrice = typeof source.referencePrice === 'number' && Number.isFinite(source.referencePrice)
    ? String(source.referencePrice) : text(source.referencePrice, 40)
  const isCampusRoute = !!getDriverRoutePriceKey(departureAddress, destinationAddress)
  return {
    _id, departureAddress, destinationAddress, departureTime, passengerCount,
    referencePrice, comment: text(source.comment, 100), cityKey,
    shortcutTitle: isCampusRoute ? (destinationAddress === '哥大' ? '去学校' : '回程') : '常用路线',
    lastPublishedAt: timestamp(source.lastPublishedAt || source.createdAt)
  }
}

function mergeRoutes(...groups) {
  const candidates = groups.reduce((all, rows) => all.concat(Array.isArray(rows) ? rows : []), [])
    .map((source, priority) => ({ route: normalizeRoute(source), priority }))
    .filter(item => item.route)
    .sort((a, b) => b.route.lastPublishedAt - a.route.lastPublishedAt || a.priority - b.priority)
  const seen = new Set()
  return candidates.filter(({ route }) => {
    if (seen.has(route._id)) return false
    seen.add(route._id)
    return true
  }).slice(0, MAX_ROUTES).map(item => item.route)
}

function cacheFor(openid) {
  if (accounts.has(openid)) return accounts.get(openid)
  let saved
  try { saved = wx.getStorageSync(STORAGE_PREFIX + encodeURIComponent(openid)) } catch (e) {}
  const cache = {
    version: 1,
    syncedAt: saved && saved.version === 1 ? timestamp(saved.syncedAt) : 0,
    routes: mergeRoutes(saved && saved.version === 1 ? saved.routes : [])
  }
  accounts.set(openid, cache)
  return cache
}

function saveCache(openid, cache) {
  accounts.set(openid, cache)
  try { wx.setStorageSync(STORAGE_PREFIX + encodeURIComponent(openid), cache) } catch (e) {
    // A storage quota or device error must never turn a successful publish into a failure.
  }
}

function readRecentDriverRoutes(openid) {
  const key = accountId(openid)
  return key ? mergeRoutes(cacheFor(key).routes) : []
}

function recordRecentDriverRoute(openid, snapshot) {
  const key = accountId(openid)
  if (!key || !snapshot || (snapshot._openid && snapshot._openid !== key)) return readRecentDriverRoutes(key)
  const route = normalizeRoute({ ...snapshot, lastPublishedAt: Date.now() })
  if (!route) return readRecentDriverRoutes(key)
  const cache = cacheFor(key)
  const routes = mergeRoutes([route], cache.routes)
  saveCache(key, { ...cache, routes })
  return mergeRoutes(routes)
}

function loadRecentDriverRoutes(openid) {
  const key = accountId(openid)
  if (!key) return Promise.resolve([])
  const accountAtStart = currentAccount()
  if (accountAtStart && accountAtStart !== key) return Promise.resolve([])
  if (pendingLoads.has(key)) return pendingLoads.get(key)
  const cache = cacheFor(key)
  const age = Date.now() - cache.syncedAt
  if (cache.syncedAt && age >= 0 && age < SYNC_INTERVAL_MS) return Promise.resolve(mergeRoutes(cache.routes))

  const task = Promise.resolve().then(async () => {
    try {
      const result = await wx.cloud.database().collection('Carpool')
        .where({ _openid: key })
        .field({ _id: true, _openid: true, departures: true, destinations: true,
          passengerCount: true, referencePrice: true, comment: true, createdAt: true, cityKey: true })
        .orderBy('createdAt', 'desc').limit(20).get()
      // The account may change while the request is in flight. Never populate the next user's UI.
      if (accountAtStart && currentAccount() !== accountAtStart) return []
      if (!result || !Array.isArray(result.data)) throw new Error('历史路线加载失败')
      const ownRows = result.data.filter(row => row && row._openid === key)
      // Re-read memory here: a successful publication may have added a newer row during the request.
      const latest = cacheFor(key)
      const routes = mergeRoutes(latest.routes, ownRows)
      saveCache(key, { version: 1, syncedAt: Date.now(), routes })
      return mergeRoutes(routes)
    } catch (e) {
      if (accountAtStart && currentAccount() !== accountAtStart) return []
      // Keep the cache intact; the caller can render it and offer an explicit retry.
      throw e
    }
  }).finally(() => {
    if (pendingLoads.get(key) === task) pendingLoads.delete(key)
  })
  pendingLoads.set(key, task)
  return task
}

module.exports = { readRecentDriverRoutes, loadRecentDriverRoutes, recordRecentDriverRoute }
