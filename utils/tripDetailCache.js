const rides = require("./compat/rides")
const TRIP_DETAIL_CACHE_KEY = "trip_detail_cache_v1"
const TRIP_DETAIL_CACHE_TTL = 5 * 60 * 1000
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
  return `server:${viewerKey}:${keyType}:${keyId}`
}

// This obsolete disk key may contain member contacts from an older release.
// Current detail reads only share an in-flight request; they never persist data.
function clearHistoricalCache() {
  try {
    const historical = wx.getStorageSync(TRIP_DETAIL_CACHE_KEY)
    if (historical !== undefined && historical !== '') {
      wx.removeStorageSync(TRIP_DETAIL_CACHE_KEY)
    }
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

function readTripDetailCache() {
  clearHistoricalCache()
  return null
}

function writeTripDetailCache(type, id, result) {
  clearHistoricalCache()
  return isSuccessResult(result) ? result : null
}

function removeTripDetailCache(type, id) {
  const key = makeKey(type, id)
  if (key) pendingRequests.delete(key)
  clearHistoricalCache()
}

async function fetchTripDetail(type, id, options = {}) {
  clearHistoricalCache()
  if (!rides.isBackendEnabled()) throw Object.assign(new Error("业务服务尚未切换"), { code: "BACKEND_DISABLED" })
  const detailType = normalizeType(type)
  const detailId = normalizeId(id)
  if (!detailId) {
    return { ok: false, success: false, notFound: true, errorMsg: "缺少路线ID", type: detailType }
  }
  const viewerKey = getViewerKey()
  const key = makeKey(detailType, detailId, viewerKey)

  if (!options.force) {
    const pending = pendingRequests.get(key)
    if (pending) return pending.promise
  }

  // A forced read may follow a join/leave mutation, so it must not join an
  // older request. Subsequent ordinary reads join the replacement request.
  const request = {}
  request.promise = Promise.resolve().then(() => rides.getTripDetail(detailType, detailId)).then(result => {
    if (getViewerKey() !== viewerKey) {
      return { ok: false, success: false, identityChanged: true, errorMsg: "登录状态已变化，请重新加载", type: detailType }
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
