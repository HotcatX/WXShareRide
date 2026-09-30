const referral = require("./utils/referral")
const timeline = require("./utils/timeline")
const tabMemory = require("./utils/tabMemory")
const analytics = require("./utils/analyticsSession")
const rideTelemetry = require("./utils/rideTelemetry")
const tripFollowup = require("./utils/tripFollowup")
const authority = require('./utils/backendAuthority')
const { createBackendPageGate } = require('./utils/backendPageGate')
let lastAuthorityNotice = 0
function authorityUnavailable(error) {
  if (Date.now() - lastAuthorityNotice < 3000) return
  lastAuthorityNotice = Date.now()
  if (typeof wx.showToast === 'function') wx.showToast({ icon: 'none',
    title: error && error.code === 'BACKEND_RESTART_REQUIRED' ? '请重新打开小程序' : '服务连接失败，请重新打开小程序' })
}
const pageGate = createBackendPageGate({ authority, unavailable: authorityUnavailable })

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
  const query = serializeQuery(page && (page.__timelineOptions || page.__referralShareOptions))
  return `/${route}${query ? `?${query}` : ""}`
}

function installDefaultShare() {
  if (typeof Page !== "function" || Page.__referralDefaultShareInstalled) return
  const originalPage = Page

  Page = function patchedPage(config = {}) {
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

    const originalShareTimeline = config.onShareTimeline
    config.onShareTimeline = function (...args) {
      const share = timeline.isTimelinePreview()
        ? { title: "志远共享", query: serializeQuery(this.__timelineOptions) }
        : originalShareTimeline.apply(this, args)
      // Moments always opens the current page. This marker lets private-page
      // shares return to their public counterpart after opening the mini program.
      const query = String((share && share.query) || "").split("&")
        .filter(part => part && !/^timelineShare=/.test(part)).join("&")
      return { ...share, query: `${query}${query ? "&" : ""}timelineShare=1` }
    }

    const originalShow = config.onShow
    config.onShow = function (...args) {
      rideTelemetry.pageVisible(this)
      const result = typeof originalShow === "function" ? originalShow.apply(this, args) : undefined
      analytics.pageShown(getCurrentRoute(this))
      const route = getCurrentRoute(this)
      if (route === 'pages/home/tripDetail/tripDetail' || route === 'pages/home/requestDetail/requestDetail') {
        rideTelemetry.detailViewed(this, this.data && this.data.trip, route.includes('requestDetail') ? 'request' : 'carpool')
      }
      return result
    }
    ;['onHide', 'onUnload'].forEach(name => {
      const original = config[name]
      config[name] = function (...args) {
        rideTelemetry.pageHidden(this)
        return typeof original === 'function' ? original.apply(this, args) : undefined
      }
    })

    timeline.wrapPage(config, {
      getRoute: getCurrentRoute,
      onNormalLoad(page, options) {
        page.__referralShareOptions = options
        referral.captureReferral({ path: getCurrentRoute(page), query: options }, 'pageLoad', page.__backendPage && page.__backendPage.capturedAt)
      }
    })

    const originalReady = config.onReady
    config.onReady = function (...args) {
      const result = typeof originalReady === "function" ? originalReady.apply(this, args) : undefined
      tabMemory.restoreOnReady(getCurrentRoute(this))
      return result
    }

    return originalPage(pageGate.wrapPage(config))
  }
  Page.__referralDefaultShareInstalled = true
}

installDefaultShare()

App({
  onLaunch(options = {}) {
    this._authorityVisible = false
    this._authorityEpoch = 0
    this._authorityLaunch = { options, capturedAt: Date.now() }
    timeline.updateLaunchContext(options)
    tabMemory.prepareLaunch(options)

    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
      return
    }

    // Preview reads use the same environment with a narrowly scoped public action.
    wx.cloud.init({
      env: 'cloud1-7gmtcu4s3aebce27',
      traceUser: !timeline.isTimelinePreview()
    })

    authority.subscribe(state => {
      if (!['restart_required', 'handoff_blocked'].includes(state.phase)) return
      this._authorityVisible = false; this._authorityEpoch++
      this.stopAuthorityForeground()
      if (typeof wx.hideLoading === 'function') wx.hideLoading()
      if (state.phase !== 'restart_required' || this._authorityRestarting) return
      this._authorityRestarting = true
      if (typeof wx.restartMiniProgram !== 'function') { authorityUnavailable({ code: 'BACKEND_RESTART_REQUIRED' }); return }
      // A real JS-runtime restart avoids reinterpreting old forms, image IDs or
      // late CloudBase responses in place. Never substitute reLaunch here.
      try { wx.restartMiniProgram({ path: 'pages/home/home', fail() { authorityUnavailable({ code: 'BACKEND_RESTART_REQUIRED' }) } }) }
      catch (_) { authorityUnavailable({ code: 'BACKEND_RESTART_REQUIRED' }) }
    })
    authority.ready().catch(authorityUnavailable)

    // 强制重新登录（可保留）
    // wx.clearStorageSync()
  },

  onShow(options = {}) {
    timeline.updateLaunchContext(options)
    const epoch = ++this._authorityEpoch, capturedAt = Date.now()
    this._authorityVisible = true
    const ready = authority.refresh()
    if (!authority.isReady() && typeof wx.showLoading === 'function') wx.showLoading({ title: '连接服务中', mask: true })
    ready.then(() => {
      if (!this._authorityVisible || this._authorityEpoch !== epoch || !authority.isReady()) return
      if (timeline.isTimelinePreview()) return
      this._authorityForeground = true
      tripFollowup.beginForeground(); analytics.beginForeground()
      if (this._authorityLaunch) {
        const launch = this._authorityLaunch; this._authorityLaunch = null
        referral.captureReferral(launch.options, 'appLaunch', launch.capturedAt)
      }
      referral.captureReferral(options, 'appShow', capturedAt)
      referral.ensureReferralCode().then(() => {
        if (this._authorityVisible && this._authorityEpoch === epoch && authority.isReady()) return referral.bindPendingReferral()
      }).catch(() => {})
    }, authorityUnavailable).finally(() => {
      if (this._authorityEpoch === epoch && typeof wx.hideLoading === 'function') wx.hideLoading()
    })
  },

  onHide() {
    this._authorityVisible = false; this._authorityEpoch++
    if (typeof wx.hideLoading === 'function') wx.hideLoading()
    this.stopAuthorityForeground()
  },

  stopAuthorityForeground() {
    if (!this._authorityForeground) return
    this._authorityForeground = false
    tripFollowup.endForeground()
    analytics.endForeground()
  },

  withReferralShare(config = {}) {
    if (!authority.isReady()) return { title: config.title || '志远共享', path: '/pages/home/home', query: '' }
    return referral.withReferralShare(config)
  }
})
