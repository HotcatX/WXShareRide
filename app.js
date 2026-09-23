const referral = require("./utils/referral")
const timeline = require("./utils/timeline")
const tabMemory = require("./utils/tabMemory")
const research = require("./utils/researchParticipation")
const rideTelemetry = require("./utils/rideTelemetry")
const rideDiagnostics = require("./utils/rideDiagnostics")
const researchFollowup = require("./utils/researchFollowup")

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
      research.pageShown(getCurrentRoute(this))
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
        referral.captureReferral({ path: getCurrentRoute(page), query: options }, "pageLoad")
      }
    })

    const originalReady = config.onReady
    config.onReady = function (...args) {
      const result = typeof originalReady === "function" ? originalReady.apply(this, args) : undefined
      tabMemory.restoreOnReady(getCurrentRoute(this))
      return result
    }

    return originalPage(config)
  }
  Page.__referralDefaultShareInstalled = true
}

installDefaultShare()

App({
  onLaunch(options = {}) {
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

    if (timeline.isTimelinePreview()) return

    rideDiagnostics.install(wx, research)

    referral.captureReferral(options, "appLaunch")
    referral.ensureReferralCode().then(() => referral.bindPendingReferral())

    // 强制重新登录（可保留）
    // wx.clearStorageSync()
  },

  onShow(options = {}) {
    timeline.updateLaunchContext(options)
    if (timeline.isTimelinePreview()) return
    rideDiagnostics.beginForeground()
    researchFollowup.beginForeground()
    research.beginForeground()
    referral.captureReferral(options, "appShow")
    referral.ensureReferralCode().then(() => referral.bindPendingReferral())
  },

  onHide() {
    rideDiagnostics.endForeground()
    researchFollowup.endForeground()
    research.endForeground()
  },

  onError(error) { rideDiagnostics.captureError('runtime', error) },
  onUnhandledRejection(event) { rideDiagnostics.captureError('unhandled_rejection', event && event.reason) },

  withReferralShare(config = {}) {
    return referral.withReferralShare(config)
  }
})
