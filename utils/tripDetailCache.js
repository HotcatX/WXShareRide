const TRIP_DETAIL_CACHE_KEY = "trip_detail_cache_v1"
const TRIP_DETAIL_CACHE_TTL = 5 * 60 * 1000
const TRIP_DETAIL_CACHE_MAX_STALE = 30 * 60 * 1000
const TRIP_DETAIL_CACHE_MAX_SIZE = 80
const PREFETCH_LIMIT = 8
const pendingRequests = new Map()

function cleanText(value) {
  return String(value || "").trim()
}

function normalizeType(value) {
  return cleanText(value).toLowerCase() === "request" ? "request" : "carpool"
}

function normalizeId(value) {
  return cleanText(value)
}

function getViewerKey() {
  try {
    const openid = cleanText(wx.getStorageSync("openid"))
    const isGuest = !!wx.getStorageSync("isGuest")
    return openid && !isGuest ? openid : "guest"
  } catch (e) {
    return "guest"
  }
}

function makeKey(type, id, viewerKey = getViewerKey()) {
  const keyType = normalizeType(type)
  const keyId = normalizeId(id)
  if (!keyId) return ""
  return `${viewerKey}:${keyType}:${keyId}`
}

function getStore() {
  try {
    const store = wx.getStorageSync(TRIP_DETAIL_CACHE_KEY)
    return store && typeof store === "object" && !Array.isArray(store) ? store : {}
  } catch (e) {
    return {}
  }
}

function setStore(store = {}) {
  try {
    wx.setStorageSync(TRIP_DETAIL_CACHE_KEY, store)
  } catch (e) {
  }
}

function getResultTrip(result = {}) {
  const trip = Array.isArray(result.data) ? result.data[0] : result.data
  return trip || null
}

function isSuccessResult(result = {}) {
  return !!(result && (result.ok || result.success) && getResultTrip(result))
}

function pruneStore(store = {}) {
  const keys = Object.keys(store)
  if (keys.length <= TRIP_DETAIL_CACHE_MAX_SIZE) return store

  keys
    .sort((a, b) => (Number(store[a]?.ts) || 0) - (Number(store[b]?.ts) || 0))
    .slice(0, keys.length - TRIP_DETAIL_CACHE_MAX_SIZE)
    .forEach(key => delete store[key])

  return store
}

function readTripDetailCache(type, id, options = {}) {
  const key = makeKey(type, id)
  if (!key) return null
  const entry = getStore()[key]
  if (!entry || !entry.result || !entry.ts) return null
  const age = Date.now() - Number(entry.ts || 0)
  if (!Number.isFinite(age) || age < 0) return null
  const maxAge = options.allowStale ? TRIP_DETAIL_CACHE_MAX_STALE : TRIP_DETAIL_CACHE_TTL
  if (age > maxAge) return null
  if (!isSuccessResult(entry.result)) return null
  return entry.result
}

function writeTripDetailCache(type, id, result) {
  const key = makeKey(type, id)
  if (!key || !isSuccessResult(result)) return null
  const store = pruneStore(getStore())
  store[key] = {
    ts: Date.now(),
    result
  }
  setStore(store)
  return result
}

function removeTripDetailCache(type, id) {
  const key = makeKey(type, id)
  if (!key) return
  // An older read must not put pre-mutation membership/contact data back into storage.
  pendingRequests.delete(key)
  const store = getStore()
  if (!store[key]) return
  delete store[key]
  setStore(store)
}

async function fetchTripDetail(type, id, options = {}) {
  const detailType = normalizeType(type)
  const detailId = normalizeId(id)
  if (!detailId) {
    return { ok: false, success: false, notFound: true, errorMsg: "缺少路线ID", type: detailType }
  }
  const viewerKey = getViewerKey()
  const key = makeKey(detailType, detailId, viewerKey)

  if (!options.force) {
    const cached = readTripDetailCache(detailType, detailId, { allowStale: !!options.allowStale })
    if (cached) return cached
    const pending = pendingRequests.get(key)
    if (pending) return pending.promise
  }

  // A forced read may follow a join/leave mutation, so it must not join an
  // older request. Its response also takes precedence over older cache writes.
  const request = {}
  request.promise = Promise.resolve().then(() => wx.cloud.callFunction({
    name: "getTripDetail",
    data: { type: detailType, id: detailId }
  })).then(res => {
    if (getViewerKey() !== viewerKey) {
      return { ok: false, success: false, identityChanged: true, errorMsg: "登录状态已变化，请重新加载", type: detailType }
    }
    const result = (res && res.result) || {}
    if (pendingRequests.get(key) === request) {
      if (isSuccessResult(result)) {
        writeTripDetailCache(detailType, detailId, result)
      } else if (result.notFound || result.blocked) {
        removeTripDetailCache(detailType, detailId)
      }
    }
    return result
  }).finally(() => {
    if (pendingRequests.get(key) === request) pendingRequests.delete(key)
  })
  pendingRequests.set(key, request)
  return request.promise
}

function normalizeEntry(entry = {}) {
  if (!entry) return null
  const type = normalizeType(entry.type || entry.from || entry.sourceType)
  const id = normalizeId(entry.id || entry.tripId || entry.requestId || entry._id)
  if (!id) return null
  return { type, id }
}

function prefetchTripDetails(entries = [], options = {}) {
  const limit = Math.max(1, Number(options.limit) || PREFETCH_LIMIT)
  const seen = new Set()
  const targets = []

  ;(Array.isArray(entries) ? entries : []).forEach(raw => {
    const entry = normalizeEntry(raw)
    if (!entry) return
    const key = `${entry.type}:${entry.id}`
    if (seen.has(key)) return
    seen.add(key)
    if (!options.force && readTripDetailCache(entry.type, entry.id)) return
    targets.push(entry)
  })

  const picked = targets.slice(0, limit)
  if (!picked.length) return Promise.resolve([])

  return Promise.all(picked.map(entry =>
    fetchTripDetail(entry.type, entry.id, { force: !!options.force })
      .catch(() => null)
  ))
}

module.exports = {
  TRIP_DETAIL_CACHE_TTL,
  readTripDetailCache,
  writeTripDetailCache,
  removeTripDetailCache,
  fetchTripDetail,
  prefetchTripDetails
}
