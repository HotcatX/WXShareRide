const referral = require("./utils/referral")

function serializeQuery(query = {}) {
  if (!query || typeof query !== "object") return ""
  const pairs = []
  Object.keys(query).forEach(key => {
    if (["ref", "referralCode", "invite", "inviter"].includes(key)) return
    const value = query[key]
    if (value === undefined || value === null || value === "") return
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  })
  return pairs.join("&")
}

function getCurrentRoute(page) {
  if (page && page.route) return page.route
  const pages = typeof getCurrentPages === "function" ? getCurrentPages() : []
  const current = pages[pages.length - 1] || {}
  return current.route || "pages/home/home"
}

function getDefaultSharePath(page) {
  const route = getCurrentRoute(page)
  const query = serializeQuery(page && page.__referralShareOptions)
  return `/${route}${query ? `?${query}` : ""}`
}

function installDefaultShare() {
  if (typeof Page !== "function" || Page.__referralDefaultShareInstalled) return
  const originalPage = Page

  Page = function patchedPage(config = {}) {
    const originalOnLoad = config.onLoad
    config.onLoad = function patchedOnLoad(options = {}) {
      this.__referralShareOptions = options || {}
      referral.captureReferral({
        path: getCurrentRoute(this),
        query: options || {}
      }, "pageLoad")
      return typeof originalOnLoad === "function" ? originalOnLoad.call(this, options) : undefined
    }

    if (typeof config.onShareAppMessage !== "function") {
      config.onShareAppMessage = function defaultShareAppMessage() {
        return referral.withReferralShare({
          title: "志远共享",
          path: getDefaultSharePath(this)
        })
      }
    }

    if (typeof config.onShareTimeline !== "function") {
      config.onShareTimeline = function defaultShareTimeline() {
        return referral.withReferralShare({
          title: "志远共享",
          query: serializeQuery(this.__referralShareOptions)
        })
      }
    }

    return originalPage(config)
  }
  Page.__referralDefaultShareInstalled = true
}

installDefaultShare()

App({
  onLaunch(options = {}) {

    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
      return
    }

    // 只初始化一次，指定新的测试环境
    wx.cloud.init({
      env: 'cloud1-7gmtcu4s3aebce27',
      traceUser: true
    })

    referral.captureReferral(options, "appLaunch")
    referral.ensureReferralCode().then(() => referral.bindPendingReferral())

    // 强制重新登录（可保留）
    // wx.clearStorageSync()
  },

  onShow(options = {}) {
    referral.captureReferral(options, "appShow")
    referral.ensureReferralCode().then(() => referral.bindPendingReferral())
  },

  withReferralShare(config = {}) {
    return referral.withReferralShare(config)
  }
})
