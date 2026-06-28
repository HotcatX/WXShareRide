const PUBLIC_CONFIG_FUNCTION = "marketApi"
const PUBLIC_CONFIG_ACTION = "publicConfig"
const PUBLIC_CONFIG_CACHE_MS = 30 * 60 * 1000

const docCache = {}
const pendingLoads = {}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function canCallCloudFunction() {
  return typeof wx !== "undefined" &&
    wx.cloud &&
    typeof wx.cloud.callFunction === "function"
}

function getCachedDoc(collection) {
  const cached = docCache[collection]
  if (!cached) return { hit: false, data: null }
  if (Date.now() - cached.ts > PUBLIC_CONFIG_CACHE_MS) return { hit: false, data: null }
  return { hit: true, data: cached.data || null }
}

function setCachedDoc(collection, data) {
  docCache[collection] = {
    ts: Date.now(),
    data: data || null
  }
}

async function loadPublicConfigDoc(collection, options = {}) {
  const name = cleanText(collection)
  if (!name || !canCallCloudFunction()) return null

  if (!options.force) {
    const cached = getCachedDoc(name)
    if (cached.hit) return cached.data
    if (pendingLoads[name]) return pendingLoads[name]
  }

  const promise = wx.cloud.callFunction({
    name: PUBLIC_CONFIG_FUNCTION,
    data: {
      action: PUBLIC_CONFIG_ACTION,
      collections: [name]
    }
  }).then(res => {
    const result = (res && res.result) || {}
    if (result.ok === false) return null
    const docs = result.docs || result.data || {}
    const doc = docs[name] || null
    setCachedDoc(name, doc)
    return doc
  }).catch(() => null)

  pendingLoads[name] = promise

  const clearPending = () => {
    if (pendingLoads[name] === promise) delete pendingLoads[name]
  }

  promise.then(clearPending, clearPending)
  return promise
}

module.exports = {
  loadPublicConfigDoc
}
