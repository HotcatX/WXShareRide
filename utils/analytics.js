const ANALYTICS_SESSION_KEY = "analytics_session_id_v1"

let cachedSessionId = ""
let cachedNetworkType = ""

function getSessionId() {
  if (cachedSessionId) return cachedSessionId

  try {
    cachedSessionId = wx.getStorageSync(ANALYTICS_SESSION_KEY)
  } catch (e) {}

  if (!cachedSessionId) {
    cachedSessionId = `${Date.now()}_${Math.random().toString(16).slice(2)}`
    try {
      wx.setStorageSync(ANALYTICS_SESSION_KEY, cachedSessionId)
    } catch (e) {}
  }

  return cachedSessionId
}

function getCurrentRoute() {
  try {
    const pages = getCurrentPages()
    const current = pages && pages.length ? pages[pages.length - 1] : null
    return current && current.route ? current.route : ""
  } catch (e) {
    return ""
  }
}

function getAppVersion() {
  try {
    const info = wx.getAccountInfoSync && wx.getAccountInfoSync()
    const mini = info && info.miniProgram ? info.miniProgram : {}
    return mini.envVersion || "unknown"
  } catch (e) {
    return "unknown"
  }
}

function refreshNetworkType() {
  if (cachedNetworkType) return
  try {
    wx.getNetworkType({
      success: res => {
        cachedNetworkType = res && res.networkType ? res.networkType : "unknown"
      },
      fail: () => {
        cachedNetworkType = "unknown"
      }
    })
  } catch (e) {
    cachedNetworkType = "unknown"
  }
}

function createTimer() {
  return Date.now()
}

function trackEvent(event, payload = {}) {
  if (!event || !wx || !wx.cloud) return Promise.resolve()

  refreshNetworkType()

  const data = {
    event,
    page: payload.page || getCurrentRoute(),
    sessionId: getSessionId(),
    appVersion: payload.appVersion || getAppVersion(),
    networkType: payload.networkType || cachedNetworkType || "unknown",
    ...payload
  }

  return wx.cloud.callFunction({
    name: "trackEvent",
    data
  }).catch(err => {
    console.warn("[analytics] trackEvent failed:", event, err)
  })
}

function trackDuration(event, startedAt, payload = {}) {
  const durationMs = Math.max(0, Date.now() - Number(startedAt || Date.now()))
  return trackEvent(event, { ...payload, durationMs })
}

module.exports = {
  createTimer,
  trackDuration,
  trackEvent
}
