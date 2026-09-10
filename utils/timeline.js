// Moments opens an isolated, unauthenticated page (scene 1154).
// Only App launch/show options are trusted to select that runtime mode.
const TIMELINE_SCENE = 1154
let currentScene = null

function updateLaunchContext(options = {}) {
  const scene = Number(options.scene)
  if (Number.isFinite(scene) && scene > 0) currentScene = scene
}

function isTimelinePreview() {
  if (currentScene !== null) return currentScene === TIMELINE_SCENE
  if (typeof wx === "undefined") return false
  for (const name of ["getEnterOptionsSync", "getLaunchOptionsSync"]) {
    if (typeof wx[name] !== "function") continue
    try {
      const options = wx[name]() || {}
      if (Number(options.scene) > 0) return Number(options.scene) === TIMELINE_SCENE
    } catch (e) {}
  }
  return false
}

function text(value, max = 128) {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim().slice(0, max) : ""
}

function firstId(options, keys) {
  for (const key of keys) {
    const value = text(options[key])
    if (/^[a-zA-Z0-9_-]+$/.test(value)) return value
  }
  return ""
}

function routeName(route) {
  return text(route, 200).replace(/^\//, "")
}

const CARPOOL_DETAILS = new Set([
  "pages/home/tripDetail/tripDetail",
  "pages/profile/myTripDetailDriver/myTripDetailDriver"
])
const REQUEST_DETAILS = new Set([
  "pages/home/requestDetail/requestDetail",
  "pages/profile/myRequestDetailDriver/myRequestDetailDriver",
  "pages/profile/myTripRequestPassenger/myTripRequestPassenger"
])
const PASSENGER_DETAIL = "pages/profile/myTripDetailPassenger/myTripDetailPassenger"
const SELLER_PAGES = new Set([
  "pages/market/marketSeller/marketSeller",
  "pages/market/marketMy/marketMy"
])
const PRIVATE_SHARE_PAGES = new Set([
  "pages/profile/myTripDetailDriver/myTripDetailDriver",
  "pages/profile/myRequestDetailDriver/myRequestDetailDriver",
  "pages/profile/myTripRequestPassenger/myTripRequestPassenger",
  PASSENGER_DETAIL,
  "pages/market/marketMy/marketMy"
])

function getPreviewContext(route, options = {}) {
  const name = routeName(route)
  const cityKey = text(options.city || options.cityKey, 60)
  const marketType = text(options.type || options.listingType).toLowerCase() === "sublet" ? "sublet" : "goods"
  const info = { kind: "info", title: "志远共享" }

  if (name === "pages/market/market") {
    return { kind: "market", type: marketType, cityKey, category: text(options.cat || options.category, 60) }
  }
  if (name === "pages/market/marketDetail/marketDetail") {
    const id = firstId(options, ["id"])
    return id ? { kind: "market", type: marketType, id } : { ...info, title: "分享内容暂不可用" }
  }
  if (SELLER_PAGES.has(name)) {
    const sellerId = firstId(options, ["openid"])
    return sellerId ? { kind: "market", type: marketType, sellerId, title: "公开商品" } : { ...info, title: "分享内容暂不可用" }
  }
  if (name === "pages/home/home" || name === "pages/home/carpoolList/carpoolList") {
    // Legacy from/to/time values are UI indexes, not stable public place IDs.
    return { kind: "trip", type: "all", cityKey }
  }
  if (CARPOOL_DETAILS.has(name) || REQUEST_DETAILS.has(name) || name === PASSENGER_DETAIL) {
    const request = REQUEST_DETAILS.has(name) || (name === PASSENGER_DETAIL &&
      text(options.sourceType || options.type || options.from).toLowerCase() === "request")
    let keys = ["tripId", "id"]
    if (name === "pages/home/tripDetail/tripDetail") keys = ["id", "tripId"]
    if (name === "pages/home/requestDetail/requestDetail") keys = ["id"]
    if (name === "pages/profile/myRequestDetailDriver/myRequestDetailDriver") keys = ["requestId", "id", "requestID", "tripId", "tripID", "_id"]
    if (name === "pages/profile/myTripRequestPassenger/myTripRequestPassenger") keys = ["requestId", "id", "tripId", "tripid"]
    const id = firstId(options, keys)
    return id ? { kind: "trip", type: request ? "request" : "carpool", id } : { ...info, title: "分享内容暂不可用" }
  }
  // Account, editing and management pages never render private page data in Moments.
  return info
}

function encodeQuery(query) {
  return Object.keys(query).filter(key => query[key] !== "" && query[key] != null)
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(query[key]))}`).join("&")
}

function getFullPageTarget(route, options = {}) {
  const name = routeName(route)
  const context = getPreviewContext(name, options)
  let target = ""
  const query = {}
  if (name.startsWith("pages/profile/my") && context.kind === "trip" && context.id) {
    target = context.type === "request" ? "/pages/home/requestDetail/requestDetail" : "/pages/home/tripDetail/tripDetail"
    query.id = context.id
  } else if (name === "pages/market/marketMy/marketMy" && context.sellerId) {
    target = "/pages/market/marketSeller/marketSeller"
    query.openid = context.sellerId
    query.type = context.type
  }
  if (!target) return ""
  for (const key of ["ref", "referralCode", "invite", "inviter"]) {
    const value = text(options[key], 80)
    if (value) query[key] = value
  }
  return `${target}?${encodeQuery(query)}`
}

function wrapPage(config, hooks = {}) {
  const originals = { ...config }
  const getRoute = page => typeof hooks.getRoute === "function" ? hooks.getRoute(page) : page.route || ""
  config.data = {
    ...(config.data || {}),
    isTimelinePreview: isTimelinePreview(),
    timelinePageReady: false,
    timelineContext: null
  }

  function showPreview(page) {
    page.__timelineWasPreview = true
    page.setData({
      isTimelinePreview: true,
      timelinePageReady: true,
      timelineContext: getPreviewContext(getRoute(page), page.__timelineOptions || {})
    })
  }

  function redirectSharedPage(page) {
    const options = page.__timelineOptions || {}
    if (!page.__timelineWasPreview && text(options.timelineShare) !== "1") return false
    const route = getRoute(page)
    const url = getFullPageTarget(route, options)
    if (!url) {
      if (!PRIVATE_SHARE_PAGES.has(routeName(route))) return false
      page.__timelineRedirecting = true
      page.setData({
        isTimelinePreview: true,
        timelinePageReady: true,
        timelineContext: { kind: "info", title: "分享内容暂不可用" }
      })
      return true
    }
    page.__timelineRedirecting = true
    wx.redirectTo({
      url,
      fail() {
        page.setData({
          isTimelinePreview: true,
          timelinePageReady: true,
          timelineContext: { kind: "info", title: "暂时无法打开分享内容" }
        })
      }
    })
    return true
  }

  function loadNormal(page) {
    if (page.__timelineNormalLoaded || page.__timelineRedirecting) return
    page.__timelineNormalLoaded = true
    const options = page.__timelineOptions || {}
    if (typeof hooks.onNormalLoad === "function") hooks.onNormalLoad(page, options)
    return typeof originals.onLoad === "function" ? originals.onLoad.call(page, options) : undefined
  }

  config.onLoad = function (options = {}) {
    this.__timelineOptions = { ...options }
    if (isTimelinePreview()) return showPreview(this)
    if (redirectSharedPage(this)) return
    this.setData({ isTimelinePreview: false, timelinePageReady: true })
    return loadNormal(this)
  }

  config.onShow = function (...args) {
    if (isTimelinePreview()) {
      if (!this.data.isTimelinePreview) showPreview(this)
      return
    }
    if (this.__timelineRedirecting) return
    if (this.data.isTimelinePreview) {
      if (redirectSharedPage(this)) return
      this.setData({ isTimelinePreview: false, timelinePageReady: true, timelineContext: null }, () => {
        loadNormal(this)
        if (typeof originals.onShow === "function") originals.onShow.apply(this, args)
        if (this.__timelineReadyObserved && !this.__timelineReadyCalled) {
          this.__timelineReadyCalled = true
          if (typeof originals.onReady === "function") originals.onReady.call(this)
        }
      })
      return
    }
    if (this.__timelineNormalLoaded && typeof originals.onShow === "function") return originals.onShow.apply(this, args)
  }

  config.onReady = function (...args) {
    this.__timelineReadyObserved = true
    if (isTimelinePreview() || this.data.isTimelinePreview || this.__timelineRedirecting) return
    this.__timelineReadyCalled = true
    if (typeof originals.onReady === "function") return originals.onReady.apply(this, args)
  }

  for (const name of ["onHide", "onUnload", "onPullDownRefresh", "onReachBottom", "onPageScroll", "onResize", "onTabItemTap", "onSaveExitState"]) {
    if (typeof originals[name] !== "function" && name !== "onPullDownRefresh") continue
    config[name] = function (...args) {
      if (isTimelinePreview() || this.data.isTimelinePreview || !this.__timelineNormalLoaded || this.__timelineRedirecting) {
        if (name === "onPullDownRefresh" && typeof wx.stopPullDownRefresh === "function") wx.stopPullDownRefresh()
        return
      }
      if (typeof originals[name] === "function") return originals[name].apply(this, args)
    }
  }
  return config
}

module.exports = { updateLaunchContext, isTimelinePreview, getPreviewContext, getFullPageTarget, wrapPage }
