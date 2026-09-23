const { normalizeRideServiceCityKey } = require('./cityTree')
const { CATALOG_VERSION, FIXED_PLACES, resolvePlaceId } = require('./placeCatalog')
const { normalizeRidePlace, placeIdentity } = require('./ridePlaceOptions')
const CACHE_MS = 5 * 60 * 1000
const RECENT_PREFIX = 'ridePlaceRecentV2:'
const cache = new Map()
let activeViewer = null
function storage(key) { try { return wx.getStorageSync(key) } catch (_) { return null } }
function currentViewer() { return storage('isGuest') ? '' : String(storage('openid') || '') }
function copy(value) { return JSON.parse(JSON.stringify(value)) }
function collectionScope() { try { return require('./researchParticipation').getCollectionScope() || '' } catch (_) { return '' } }
function context(options = {}) {
  const viewer = options.viewerKey == null ? currentViewer() : String(options.viewerKey)
  if (viewer !== activeViewer) { cache.clear(); activeViewer = viewer }
  const field = options.field === 'destination' || options.field === 'to' ? 'destination' : 'departure'
  const mode = ['driver', 'passenger', 'filter'].includes(options.mode) ? options.mode : 'driver'
  const counterpartPlaceId = /^[a-z][a-z0-9_]{1,79}$/.test(options.counterpartPlaceId || '') && !['unknown', 'custom'].includes(options.counterpartPlaceId) ? options.counterpartPlaceId : ''
  const cityKey = normalizeRideServiceCityKey(options.cityKey)
  const revision = String(options.revision == null ? (storage('rideListShouldRefreshAt') || '') : options.revision)
  const scope = collectionScope()
  const baseKey = JSON.stringify([viewer, cityKey, field, mode, counterpartPlaceId, revision, CATALOG_VERSION])
  const key = JSON.stringify([scope, baseKey])
  return { viewer, scope, cityKey, field, mode, counterpartPlaceId, baseKey, key }
}
function recentKey(ctx) { return RECENT_PREFIX + encodeURIComponent(ctx.viewer) }
function readRecent(ctx) {
  if (!ctx.viewer || ctx.viewer !== currentViewer()) return []
  const saved = storage(recentKey(ctx))
  return (Array.isArray(saved) ? saved : []).filter(item => item && item.cityKey === ctx.cityKey && typeof item.at === 'number' && Date.now() - item.at >= 0 && Date.now() - item.at <= 90 * 86400000 && normalizeRidePlace(item.value) && resolvePlaceId(item.value) === 'unknown').slice(0, 3)
    .map(item => ({ value: normalizeRidePlace(item.value), label: normalizeRidePlace(item.value), placeId: resolvePlaceId(item.value) === 'unknown' ? (item.publicPlaceId || 'custom') : resolvePlaceId(item.value), source: 'personal' }))
}
function rememberPlace(value, options = {}, publicPlaceId) {
  const ctx = context(options), text = normalizeRidePlace(value)
  if (!ctx.viewer || ctx.viewer !== currentViewer() || !text) return
  const saved = storage(recentKey(ctx))
  const entries = Array.isArray(saved) ? saved : []
  const safePublicId = /^poi_[a-z0-9_]{1,75}$/.test(publicPlaceId || '') ? publicPlaceId : undefined
  const next = [{ value: text, cityKey: ctx.cityKey, at: Date.now(), ...(safePublicId ? { publicPlaceId: safePublicId } : {}) }, ...entries.filter(item => item && !(item.cityKey === ctx.cityKey && placeIdentity(item.value) === placeIdentity(text)))].slice(0, 30)
  try { wx.setStorageSync(recentKey(ctx), next) } catch (_) {}
}
function fallback() {
  return { ok: true, catalogVersion: CATALOG_VERSION, rankingVersion: 'fixed-recent-v1', preferenceVersion: 'none', circles: [], rankingBasis: 'confirmed_selection', generatedAt: Date.now(), places: [], localFallback: true }
}
function compose(ctx, response, cachedAt) {
  if (ctx.viewer !== currentViewer() || (ctx.scope && ctx.scope !== collectionScope())) { response = null; cachedAt = 0 }
  const snapshot = copy(response || fallback())
  const seen = new Set(FIXED_PLACES.map(place => place.placeId))
  const names = new Set(FIXED_PLACES.map(place => placeIdentity(place.value)))
  const places = []
  for (const row of [...readRecent(ctx), ...(snapshot.places || [])]) {
    const value = normalizeRidePlace(row.value || row.label), name = placeIdentity(value)
    if (!value || names.has(name) || (row.placeId !== 'custom' && seen.has(row.placeId))) continue
    names.add(name); if (row.placeId !== 'custom') seen.add(row.placeId)
    places.push({ ...row, value, label: normalizeRidePlace(row.label) || value })
  }
  return { ...snapshot, places, cacheAgeMs: cachedAt ? Math.max(0, Math.min(86400000, Date.now() - cachedAt)) : 0, fromPlaces: places.map(place => place.value), toPlaces: places.map(place => place.value) }
}
function getCachedPlaceRecommendations(options = {}) {
  const ctx = context(options), entry = cache.get(ctx.key)
  const age = entry ? Date.now() - entry.at : -1
  return compose(ctx, entry && entry.data && age >= 0 && age < CACHE_MS ? entry.data : null, entry && entry.data && age >= 0 && age < CACHE_MS ? entry.at : 0)
}
function validate(response) {
  const code = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)
  if (!response || response.ok !== true || !Array.isArray(response.places) || response.places.length > 9 || !code(response.catalogVersion) || !code(response.rankingVersion) || !Number.isSafeInteger(response.generatedAt) || response.generatedAt < 0 ||
    (response.snapshotId !== undefined && !/^[A-Za-z0-9_-]{16,80}$/.test(response.snapshotId)) ||
    (response.preferenceVersion !== undefined && !code(response.preferenceVersion)) ||
    (response.circles !== undefined && (!Array.isArray(response.circles) || response.circles.length > 2 || response.circles.some(circle => !circle || !code(circle.circleId) || typeof circle.stable !== 'boolean')))) throw new Error('地点推荐暂不可用')
  for (const row of response.places) {
    if (!row || !/^[a-z][a-z0-9_]{1,79}$/.test(row.placeId || '') || ['custom', 'unknown'].includes(row.placeId) || !normalizeRidePlace(row.label) || !['circle', 'city', 'new'].includes(row.source)) throw new Error('地点推荐格式无效')
  }
  return response
}
function loadPlaceRecommendations(options = {}) {
  const ctx = context(options)
  // A status/activation response can establish the scope while an identical
  // first request is already waiting. Share that request across the transition.
  const previous = cache.get(ctx.key) || [...cache.values()].find(entry => entry.promise && !entry.scope && entry.baseKey === ctx.baseKey)
  if (!ctx.viewer || ctx.viewer !== currentViewer()) return Promise.resolve(compose(ctx, null, 0))
  if (previous && previous.promise) return previous.promise.then(data => compose({ ...ctx, scope: previous.scope || ctx.scope }, data, previous.at))
  if (!options.force && previous && previous.data && Date.now() - previous.at >= 0 && Date.now() - previous.at < CACHE_MS) return Promise.resolve(compose(ctx, previous.data, previous.at))
  const entry = { key: ctx.key, scope: ctx.scope, baseKey: ctx.baseKey, at: 0, data: null, promise: null }; cache.set(ctx.key, entry)
  while (cache.size > 20) cache.delete(cache.keys().next().value)
  entry.promise = (async () => {
    const api = require('./researchParticipation')
    if (typeof api.requestPlaceSuggestions !== 'function') return fallback()
    const result = await api.requestPlaceSuggestions({ schemaVersion: 1, cityKey: ctx.cityKey, field: ctx.field, mode: ctx.mode, ...(ctx.counterpartPlaceId ? { counterpartPlaceId: ctx.counterpartPlaceId } : {}) })
    if (!result) return fallback()
    const data = validate(result)
    if (activeViewer !== ctx.viewer || currentViewer() !== ctx.viewer) return fallback()
    const ready = context(options)
    if (!ready.scope || (ctx.scope && ready.scope !== ctx.scope) || ready.baseKey !== ctx.baseKey) return fallback()
    if (cache.get(entry.key) === entry) {
      // Store a cold-start response under the grant that actually authorized it,
      // never under the empty pre-auth key that caused another request on reopen.
      if (entry.key !== ready.key) { cache.delete(entry.key); entry.key = ready.key; entry.scope = ready.scope }
      if (!cache.has(ready.key) || cache.get(ready.key) === entry) {
        cache.set(ready.key, entry); entry.data = copy(data); entry.at = Date.now()
      }
    }
    return data
  })().catch(() => fallback()).finally(() => { entry.promise = null; if (!entry.data && cache.get(entry.key) === entry) cache.delete(entry.key) })
  return entry.promise.then(data => compose({ ...ctx, scope: entry.scope || ctx.scope }, currentViewer() === ctx.viewer ? data : null, entry.at))
}
module.exports = { CACHE_MS, getCachedPlaceRecommendations, loadPlaceRecommendations, rememberPlace, currentViewer }
