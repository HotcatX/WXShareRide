const REFERRAL_CODE_KEY = "my_referral_code"
const PENDING_REFERRAL_KEY = "pending_referral"

let ensureCodePromise = null
let bindPromise = null

function normalizeText(value) {
  return String(value || "").trim()
}

function sanitizeReferralCode(value) {
  const code = normalizeText(value).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)
  return code || ""
}

function getMyReferralCodeSync() {
  const direct = sanitizeReferralCode(wx.getStorageSync(REFERRAL_CODE_KEY))
  if (direct) return direct

  const user = wx.getStorageSync("userInfo") || {}
  return sanitizeReferralCode(user.referralCode)
}

function setMyReferralCode(code) {
  const safeCode = sanitizeReferralCode(code)
  if (!safeCode) return ""

  wx.setStorageSync(REFERRAL_CODE_KEY, safeCode)
  const user = wx.getStorageSync("userInfo") || {}
  if (user && typeof user === "object") {
    wx.setStorageSync("userInfo", { ...user, referralCode: safeCode })
  }
  return safeCode
}

function getQueryFromOptions(options = {}) {
  if (options.query && typeof options.query === "object") return options.query
  return options && typeof options === "object" ? options : {}
}

function getReferralFromOptions(options = {}) {
  const query = getQueryFromOptions(options)
  return sanitizeReferralCode(query.ref || query.referralCode || query.invite || query.inviter)
}

function fireReferralCall(data = {}) {
  if (!wx.cloud || typeof wx.cloud.callFunction !== "function") return Promise.resolve(null)
  return wx.cloud.callFunction({
    name: "referralApi",
    data
  }).catch(() => null)
}

function captureReferral(options = {}, source = "") {
  const referralCode = getReferralFromOptions(options)
  if (!referralCode) return ""

  const myCode = getMyReferralCodeSync()
  if (myCode && myCode === referralCode) return ""

  const query = getQueryFromOptions(options)
  const payload = {
    referralCode,
    source: normalizeText(source),
    scene: options.scene || "",
    path: normalizeText(options.path),
    query,
    capturedAtMs: Date.now()
  }

  wx.setStorageSync(PENDING_REFERRAL_KEY, payload)
  fireReferralCall({ action: "trackVisit", ...payload })
  return referralCode
}

function ensureReferralCode() {
  const cached = getMyReferralCodeSync()
  if (cached) return Promise.resolve(cached)

  const openid = wx.getStorageSync("openid") || ""
  const isGuest = !!wx.getStorageSync("isGuest")
  if (!openid || isGuest) return Promise.resolve("")

  if (ensureCodePromise) return ensureCodePromise
  ensureCodePromise = fireReferralCall({ action: "getMyReferralCode" })
    .then(res => {
      const result = res && res.result
      const code = result && result.ok ? setMyReferralCode(result.referralCode) : ""
      return code
    })
    .finally(() => {
      ensureCodePromise = null
    })
  return ensureCodePromise
}

function bindPendingReferral() {
  const pending = wx.getStorageSync(PENDING_REFERRAL_KEY) || null
  const referralCode = pending && sanitizeReferralCode(pending.referralCode)
  if (!referralCode) return Promise.resolve(null)

  const openid = wx.getStorageSync("openid") || ""
  const isGuest = !!wx.getStorageSync("isGuest")
  if (!openid || isGuest) return Promise.resolve(null)

  if (bindPromise) return bindPromise
  bindPromise = fireReferralCall({
    action: "bindReferral",
    referralCode,
    source: pending.source || "",
    scene: pending.scene || "",
    path: pending.path || "",
    query: pending.query || {},
    capturedAtMs: pending.capturedAtMs || 0
  })
    .then(res => {
      const result = res && res.result
      if (result && result.ok) {
        wx.removeStorageSync(PENDING_REFERRAL_KEY)
      }
      return result || null
    })
    .finally(() => {
      bindPromise = null
    })
  return bindPromise
}

function appendParamToPath(target, key, value) {
  const safeValue = encodeURIComponent(value)
  if (!target) return `${key}=${safeValue}`

  const [base, hash = ""] = String(target).split("#")
  const joiner = base.indexOf("?") >= 0 ? "&" : "?"
  const next = `${base}${joiner}${key}=${safeValue}`
  return hash ? `${next}#${hash}` : next
}

function appendParamToQuery(query, key, value) {
  const safeValue = encodeURIComponent(value)
  const text = String(query || "").replace(/^[?&]+/, "")
  return text ? `${text}&${key}=${safeValue}` : `${key}=${safeValue}`
}

function withReferralShare(config = {}) {
  const code = getMyReferralCodeSync()
  if (!code) return config

  const next = { ...config }
  if (next.path) {
    next.path = appendParamToPath(next.path, "ref", code)
  } else {
    next.query = appendParamToQuery(next.query || "", "ref", code)
  }
  return next
}

module.exports = {
  captureReferral,
  ensureReferralCode,
  bindPendingReferral,
  getMyReferralCodeSync,
  setMyReferralCode,
  withReferralShare
}
