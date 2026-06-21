// 与 marketPost 保持一致：分类顺序固定
const { showDataError } = require("../../utils/error")

const GOODS_CATEGORY_OPTIONS = ["家具", "厨具", "电器", "服包鞋饰", "电子产品", "运动装备", "食品", "其他"]
const SUBLET_CATEGORY_OPTIONS = ["单间", "主卧", "客厅", "Studio", "1B1B", "2B2B", "整租", "其他"]
const LISTING_TYPE_STORAGE_KEY = "market_active_listing_type_v1"
const LISTING_TYPE_CONFIG = {
  goods: {
    type: "goods",
    label: "二手",
    brandKicker: "Campus market",
    brandTitle: "二手市场",
    searchPlaceholder: "搜索商品、品牌或关键词",
    resultTitle: "最新闲置",
    resultUnit: "件",
    priceLabel: "价格",
    distanceLabel: "距离",
    emptyTitle: "没有找到商品",
    emptySubtitle: "换个关键词或筛选条件再试试",
    categories: GOODS_CATEGORY_OPTIONS
  },
  sublet: {
    type: "sublet",
    label: "转租",
    brandKicker: "Campus market",
    brandTitle: "转租房源",
    searchPlaceholder: "搜索公寓、区域或关键词",
    resultTitle: "最新转租",
    resultUnit: "套",
    priceLabel: "月租",
    distanceLabel: "距离",
    emptyTitle: "没有找到房源",
    emptySubtitle: "换个区域或关键词再试试",
    categories: SUBLET_CATEGORY_OPTIONS
  }
}

// ====== Performance / Cache ======
const GOODS_CACHE_KEY_PREFIX = "market_goods_list_cache_v5"
const THUMB_CACHE_KEY = "market_thumburl_cache_v1"
const MARKET_AD_CACHE_KEY_PREFIX = "market_ads_cache_v1"
const MARKET_REFRESH_KEY = "market_goods_changed_at"
const GOODS_CACHE_MAX_STALE_MS = 24 * 60 * 60 * 1000 // 24h 内先用旧缓存秒开，再后台刷新
const GOODS_CACHE_FRESH_MS = 5 * 60 * 1000           // 5 分钟内切换类型只用缓存，不再打云函数
const MARKET_AD_CACHE_FRESH_MS = 10 * 60 * 1000
const REFRESH_DEBOUNCE_MS = 30 * 1000             // 30 sec
const FIRST_PAGE_FETCH_COOLDOWN_MS = 8 * 1000      // 同一筛选条件短时间防重复请求
const MARKET_AD_MIN_GOODS = 3
const MARKET_AD_INSERT_MIN_INDEX = 2
const MARKET_AD_INSERT_MAX_INDEX = 5

function normalizeListingType(value) {
  return String(value || "").toLowerCase() === "sublet" ? "sublet" : "goods"
}

function getListingTypeConfig(type) {
  return LISTING_TYPE_CONFIG[normalizeListingType(type)] || LISTING_TYPE_CONFIG.goods
}

function getGoodsCacheKey(type) {
  return `${GOODS_CACHE_KEY_PREFIX}_${normalizeListingType(type)}`
}

function getMarketAdCacheKey() {
  return MARKET_AD_CACHE_KEY_PREFIX
}

function hashString(value) {
  const text = String(value || "")
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function seededUnit(seed) {
  const x = Math.sin(hashString(seed) || 1) * 10000
  return x - Math.floor(x)
}

function normalizeCoordKey(location = {}) {
  const lat = toFiniteNumber(location.lat ?? location.latitude)
  const lng = toFiniteNumber(location.lng ?? location.longitude)
  if (lat === null || lng === null) return ""
  return `${lat.toFixed(5)},${lng.toFixed(5)}`
}

function buildListQueryKey(filters = {}, sort = {}) {
  return [
    normalizeListingType(filters.listingType),
    String(filters.category || "全部"),
    String(filters.region || "全部"),
    String(filters.keyword || "").trim(),
    String(sort.by || ""),
    normalizeCoordKey(sort.origin || {})
  ].join("|")
}

function normalizeAdTargetType(value) {
  const raw = String(value || "").trim()
  const lower = raw.toLowerCase()
  if (!raw) return "page"
  if (lower === "miniprogram") return "miniProgram"
  if (["servicechat", "customerservice", "wecom", "wechatservice"].includes(lower)) return "serviceChat"
  if (["wechat", "copywechat"].includes(lower)) return "copyWechat"
  if (["page", "tab", "web", "copy", "contact", "none"].includes(lower)) return lower
  return raw
}

function getStoredListingType() {
  try {
    return normalizeListingType(wx.getStorageSync(LISTING_TYPE_STORAGE_KEY))
  } catch (e) {
    return "goods"
  }
}

function setStoredListingType(type) {
  try {
    wx.setStorageSync(LISTING_TYPE_STORAGE_KEY, normalizeListingType(type))
  } catch (e) {}
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function hasLatLng(location = {}) {
  return toFiniteNumber(location.lat ?? location.latitude) !== null &&
    toFiniteNumber(location.lng ?? location.longitude) !== null
}

function distanceMiles(a = {}, b = {}) {
  const lat1 = toFiniteNumber(a.lat ?? a.latitude)
  const lng1 = toFiniteNumber(a.lng ?? a.longitude)
  const lat2 = toFiniteNumber(b.lat ?? b.latitude)
  const lng2 = toFiniteNumber(b.lng ?? b.longitude)
  if (lat1 === null || lng1 === null || lat2 === null || lng2 === null) return null

  const toRad = deg => deg * Math.PI / 180
  const earthMiles = 3958.8
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const s1 = Math.sin(dLat / 2)
  const s2 = Math.sin(dLng / 2)
  const h = s1 * s1 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * s2 * s2
  return earthMiles * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

function formatDistanceText(miles) {
  if (!Number.isFinite(miles)) return ""
  if (miles < 0.1) return "<0.1mi"
  if (miles < 10) return `${miles.toFixed(1)}mi`
  return `${Math.round(miles)}mi`
}

function getMarketGoodsChangedAt() {
  try {
    return Number(wx.getStorageSync(MARKET_REFRESH_KEY)) || 0
  } catch (e) {
    return 0
  }
}

function safeDecode(value) {
  const text = String(value || "")
  try {
    return decodeURIComponent(text)
  } catch (e) {
    return text
  }
}

function buildCategoryTabs(categories = [], activeCategory = "全部") {
  return categories.map(label => ({
    label,
    className: label === activeCategory ? "active" : ""
  }))
}

function buildListingTypeTabs(activeType = "goods") {
  const current = normalizeListingType(activeType)
  return ["goods", "sublet"].map(type => ({
    type,
    label: LISTING_TYPE_CONFIG[type].label,
    className: type === current ? "active" : ""
  }))
}

function formatShortDateText(value) {
  const text = String(value || "").trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return text
  return `${match[2]}-${match[3]}`
}

function buildSubletStartText(item = {}) {
  const startText = formatShortDateText(item.availableStartDate || item.pickupStartDate)
  if (!startText) return String(item.roomType || item.category || "转租").trim() || "转租"
  return `${startText}起`
}

function buildMarketListFlags(state = {}) {
  const displayGoods = Array.isArray(state.displayGoods) ? state.displayGoods : []
  const displayCount = displayGoods.length
  const isLoadingGoods = !!state.isLoadingGoods
  const isLoadingMore = !!state.isLoadingMore
  const canViewMore = !!state.canViewMore

  return {
    hasDisplayGoods: displayCount > 0,
    showSkeleton: isLoadingGoods && displayCount === 0,
    showEmpty: !isLoadingGoods && displayCount === 0,
    showLoadingMore: isLoadingMore && displayCount > 0,
    showViewMore: canViewMore && !isLoadingGoods && displayCount > 0
  }
}

function normalizeMarketAd(ad = {}) {
  const target = ad.target && typeof ad.target === "object" ? ad.target : {}
  const id = String(ad.id || ad._id || "").trim()
  const title = String(ad.title || "").trim() || "校园推荐"
  return {
    ...ad,
    id,
    _feedKey: `ad_${id || hashString(title + (ad.imageSrc || ""))}`,
    isAd: true,
    title,
    subtitle: String(ad.subtitle || "").trim(),
    badgeText: String(ad.badgeText || "广告").trim() || "广告",
    ctaText: String(ad.ctaText || "查看").trim() || "查看",
    imageSrc: ad.imageSrc || ad.imageUrl || "/images/market.png",
    hasImage: !!(ad.imageSrc || ad.imageUrl || ad.imageFileID || ad.thumbFileID),
    targetType: normalizeAdTargetType(ad.targetType || target.type),
    targetPath: String(ad.targetPath || target.path || "").trim(),
    targetUrl: String(ad.targetUrl || target.url || "").trim(),
    targetAppId: String(ad.targetAppId || target.appId || "").trim(),
    targetExtraData: ad.targetExtraData || target.extraData || {},
    contactSessionFrom: String(ad.contactSessionFrom || target.sessionFrom || "").trim(),
    contactMessageTitle: String(ad.contactMessageTitle || target.messageTitle || title).trim(),
    contactMessagePath: String(ad.contactMessagePath || target.messagePath || target.path || "/pages/market/market").trim(),
    contactMessageImg: String(ad.contactMessageImg || target.messageImg || ad.imageSrc || ad.imageUrl || "").trim(),
    showMessageCard: ad.showMessageCard !== false,
    serviceCorpId: String(ad.serviceCorpId || target.corpId || "").trim(),
    serviceUrl: String(ad.serviceUrl || target.serviceUrl || target.url || "").trim(),
    wechatId: String(ad.wechatId || ad.targetWechat || target.wechatId || target.wechat || "").trim(),
    weight: Math.max(1, Number(ad.weight) || 1),
    priority: Number(ad.priority) || 0
  }
}

function getMarketApiResult(res) {
  const result = res && res.result
  if (!result || result.ok === false) {
    throw new Error((result && (result.error || result.message)) || "market_api_failed")
  }
  return result
}

// 云端分页：小程序端单次 get 实际上最多 20
const CLOUD_PAGE_SIZE = 20
const INITIAL_LOAD_SIZE = 8                         // 首屏只拉当前可见数量


Page({
  data: {
    statusBarHeight: 0,

    activeListingType: "goods",
    listingTypeTabs: buildListingTypeTabs("goods"),
    brandKicker: LISTING_TYPE_CONFIG.goods.brandKicker,
    brandTitle: LISTING_TYPE_CONFIG.goods.brandTitle,
    searchPlaceholder: LISTING_TYPE_CONFIG.goods.searchPlaceholder,
    priceControlLabel: LISTING_TYPE_CONFIG.goods.priceLabel,
    distanceControlLabel: LISTING_TYPE_CONFIG.goods.distanceLabel,
    emptyTitle: LISTING_TYPE_CONFIG.goods.emptyTitle,
    emptySubtitle: LISTING_TYPE_CONFIG.goods.emptySubtitle,

    // Filters
    keyword: "",
    activeCategory: "全部",
    activeRegion: "全部",
    activeRegionLabel: "全部",
    priceSortLabel: "默认",
    distanceSortLabel: "默认",
    resultTitle: LISTING_TYPE_CONFIG.goods.resultTitle,
    resultCountText: `0 ${LISTING_TYPE_CONFIG.goods.resultUnit}`,
    regions: ["全部"],
    categories: ["全部", ...LISTING_TYPE_CONFIG.goods.categories],
    categoryTabs: buildCategoryTabs(["全部", ...LISTING_TYPE_CONFIG.goods.categories], "全部"),
    skeletonItems: [0, 1, 2, 3],

    // RegionTree (from cloud)
    regionTree: [],
    regionPickerVisible: false,
    regionPickerValue: [0, 0, 0],
    regionCol1: [],
    regionCol2: [],
    regionCol3: [],

    // Goods
    allGoods: [],
    filteredGoods: [],
    displayGoods: [],
    displayFeed: [],
    marketAds: [],
    hasDisplayGoods: false,
    showSkeleton: false,
    showEmpty: false,
    showLoadingMore: false,
    showViewMore: false,
    pageSize: 8,
    canViewMore: true,

    // Cloud pagination state
    cloudSkip: 0,
    cloudHasMore: true,
    isLoadingGoods: false,
    isLoadingMore: false,

    priceSortOrder: 'none', // 'none' | 'asc' | 'desc'
    distanceSortActive: false,
    distanceSortClass: "",
    myLocation: null,
    publishFabVisibleClass: ""
  },

  _getStatusBarHeight() {
    try {
      if (typeof wx.getWindowInfo === "function") {
        return wx.getWindowInfo().statusBarHeight || 0
      }
    } catch (e) {}

    try {
      return wx.getSystemInfoSync().statusBarHeight || 0
    } catch (e) {
      return 0
    }
  },

  _runAfterFirstPaint(fn) {
    setTimeout(() => {
      if (typeof fn === "function") fn()
    }, 300)
  },

  _applyListingTypeUi(type, options = {}) {
    const listingType = normalizeListingType(type)
    const config = getListingTypeConfig(listingType)
    const categories = ["全部", ...config.categories]
    const requestedCategory = options.category || this.data.activeCategory || "全部"
    const activeCategory = categories.includes(requestedCategory) ? requestedCategory : "全部"

    this.setData({
      activeListingType: listingType,
      listingTypeTabs: buildListingTypeTabs(listingType),
      brandKicker: config.brandKicker,
      brandTitle: config.brandTitle,
      searchPlaceholder: config.searchPlaceholder,
      priceControlLabel: config.priceLabel,
      distanceControlLabel: config.distanceLabel,
      emptyTitle: config.emptyTitle,
      emptySubtitle: config.emptySubtitle,
      categories,
      activeCategory,
      categoryTabs: buildCategoryTabs(categories, activeCategory)
    })
  },

  _resetGoodsStateForFetch(extra = {}) {
    this.setData({
      allGoods: [],
      filteredGoods: [],
      displayGoods: [],
      displayFeed: [],
      cloudSkip: 0,
      cloudHasMore: true,
      canViewMore: true,
      ...extra
    })
  },

  _buildListSort() {
    if (!this.data.distanceSortActive) return {}
    const lat = toFiniteNumber(this.data.myLocation?.lat ?? this.data.myLocation?.latitude)
    const lng = toFiniteNumber(this.data.myLocation?.lng ?? this.data.myLocation?.longitude)
    if (lat === null || lng === null) return {}
    return {
      by: "distance",
      origin: { lat, lng }
    }
  },

  _getDefaultSortPatch(location = this.data.myLocation) {
    const distanceActive = hasLatLng(location || {})
    return {
      priceSortOrder: "none",
      priceSortLabel: "默认",
      distanceSortActive: distanceActive,
      distanceSortClass: "",
      distanceSortLabel: distanceActive ? "最近" : "默认"
    }
  },

  _switchListingType(type, options = {}) {
    const listingType = normalizeListingType(type)
    const prevType = this.data.activeListingType || "goods"
    const force = !!options.force
    if (!force && listingType === prevType) {
      setStoredListingType(listingType)
      return
    }

    setStoredListingType(listingType)
    this._userSortTouched = false
    this._applyListingTypeUi(listingType, {
      category: options.category || "全部"
    })
    this._resetGoodsStateForFetch({
      keyword: options.keepKeyword ? this.data.keyword : "",
      ...this._getDefaultSortPatch()
    })
    this.updateMarketHeaderState(0)

    if (!this._marketBootstrapped && !options.allowBeforeBootstrap) return

    const cacheState = this._restoreGoodsFromCache()
    if (cacheState.restored) this.applyFilters(true)
    if (!cacheState.restored || !cacheState.isFresh) {
      this._fetchFirstPage({ reason: "switchType" })
    }
    this._loadMarketAds()
  },

  onShareAppMessage() {
    const { activeCategory = '', activeRegion = '', activeListingType = 'goods' } = this.data
    const config = getListingTypeConfig(activeListingType)

    const qs = []
    if (activeListingType !== "goods") qs.push(`type=${encodeURIComponent(activeListingType)}`)
    if (activeCategory && activeCategory !== "全部") qs.push(`cat=${encodeURIComponent(activeCategory)}`)
    if (activeRegion && activeRegion !== "全部") qs.push(`region=${encodeURIComponent(activeRegion)}`)

    const path = `/pages/market/market${qs.length ? `?${qs.join('&')}` : ''}`

    return getApp().withReferralShare({
      title: `${config.brandTitle}｜看看有没有你想要的`,
      path
    })
  },

  onShareTimeline() {
    const { activeCategory = '', activeRegion = '', activeListingType = 'goods' } = this.data
    const config = getListingTypeConfig(activeListingType)
    const qs = []
    if (activeListingType !== "goods") qs.push(`type=${encodeURIComponent(activeListingType)}`)
    if (activeCategory && activeCategory !== "全部") qs.push(`cat=${encodeURIComponent(activeCategory)}`)
    if (activeRegion && activeRegion !== "全部") qs.push(`region=${encodeURIComponent(activeRegion)}`)

    return getApp().withReferralShare({
      title: `${config.brandTitle}｜看看有没有你想要的`,
      query: qs.join('&')
    })
  },

  onTogglePriceSort() {
    this._userSortTouched = true
    const cur = this.data.priceSortOrder || 'none'
    const next = cur === 'none' ? 'asc' : (cur === 'asc' ? 'desc' : 'none')
    const wasDistanceSortActive = !!this.data.distanceSortActive
    this.setData({
      priceSortOrder: next,
      priceSortLabel: next === 'asc' ? '低到高' : (next === 'desc' ? '高到低' : '默认'),
      distanceSortActive: false,
      distanceSortClass: "",
      distanceSortLabel: '默认'
    })
    if (wasDistanceSortActive) {
      this._resetGoodsStateForFetch()
      this._fetchFirstPage({ force: true, reason: "priceSort" })
      return
    }

    this.applyFilters(true)
  },

  async onToggleDistanceSort() {
    this._userSortTouched = true
    const next = !this.data.distanceSortActive
    if (next && !hasLatLng(this.data.myLocation || {})) {
      await this._loadMyLocationFromProfile()
    }

    if (next && !hasLatLng(this.data.myLocation || {})) {
      wx.showModal({
        title: "请先设置定位",
        content: "需要在个人资料里选择位置后，才能按距离排序。",
        confirmText: "去设置",
        cancelText: "取消",
        success: res => {
          if (res.confirm) wx.navigateTo({ url: "/pages/profile/editInfo/editInfo?from=marketDistance" })
        }
      })
      return
    }

    this.setData({
      distanceSortActive: next,
      distanceSortClass: next ? "" : "active",
      distanceSortLabel: next ? "最近" : "默认",
      priceSortOrder: next ? "none" : this.data.priceSortOrder,
      priceSortLabel: next ? "默认" : this.data.priceSortLabel
    })
    this._resetGoodsStateForFetch()
    this._fetchFirstPage({ force: true, reason: next ? "distanceSort" : "distanceSortOff" })
  },

  onLoad(options = {}) {
    const initialCategory = options.cat ? safeDecode(options.cat) : ""
    const initialRegion = options.region ? safeDecode(options.region) : ""
    const initialType = options.type || options.listingType || getStoredListingType()

    this.setData({ statusBarHeight: this._getStatusBarHeight() })
    this._applyListingTypeUi(initialType, { category: initialCategory || "全部" })

    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })

    this._thumbUrlCache = wx.getStorageSync(THUMB_CACHE_KEY) || {}
    this._lastRefreshAt = 0
    this._lastHandledGoodsChangeAt = getMarketGoodsChangedAt()
    this._marketBootstrapped = false
    this._userSortTouched = false
    this._marketAdSessionSeed = `${Date.now()}_${Math.random().toString(16).slice(2)}`

    this._runAfterFirstPaint(() => {
      this._bootstrapMarketData(initialCategory, initialRegion, initialType)
    })
  },

  async onShow() {
    if (!this._marketBootstrapped) return

    const storedType = getStoredListingType()
    if (storedType !== this.data.activeListingType) {
      this._switchListingType(storedType, { force: true })
      return
    }

    const locationState = await this._loadMyLocationFromProfile({
      applyDefaultSort: !this._userSortTouched
    })
    const changedAt = getMarketGoodsChangedAt()
    if (changedAt && changedAt !== this._lastHandledGoodsChangeAt) {
      this._lastHandledGoodsChangeAt = changedAt
      this._lastRefreshAt = 0
      this._fetchFirstPage({ force: true, reason: "changed" })
      return
    }
    if (this.data.distanceSortActive && (locationState?.sortChanged || locationState?.locationChanged)) {
      this._resetGoodsStateForFetch()
      this._fetchFirstPage({ force: true, reason: "locationChanged" })
      return
    }
    this._maybeRefreshGoods(false)
  },

  async _bootstrapMarketData(initialCategory = "", initialRegion = "", initialType = "goods") {
    this._marketBootstrapped = true

    this._applyListingTypeUi(initialType, { category: initialCategory || "全部" })
    if (initialRegion) {
      this.setData({ activeRegion: initialRegion, activeRegionLabel: initialRegion })
    }

    this.loadRegionTreeFromCloud()
    await this._loadMyLocationFromProfile({ applyDefaultSort: true })

    const cacheState = this._restoreGoodsFromCache()
    if (cacheState.restored) this.applyFilters(true)
    this._loadMarketAds()

    if (!cacheState.restored || !cacheState.isFresh) {
      this._maybeRefreshGoods(!cacheState.restored)
    }
  },

  onPullDownRefresh() {
    // 下拉刷新：强制重新拉第一页（按当前筛选条件）
    Promise.resolve()
      .then(() => Promise.all([
        this._fetchFirstPage({ force: true, reason: "pullDown" }),
        this._loadMarketAds({ force: true })
      ]))
      .catch(() => {})
      .finally(() => {
        try { wx.stopPullDownRefresh() } catch (e) {}
      })
  },

  // ====== 事件（WXML 绑定需要这些方法）======
  onKeywordInput(e) {
    this.setData({ keyword: (e.detail.value || "") })
  },

  async onSearch() {
    // 搜索：按当前 keyword + category + region 重新拉第一页
    this.setData({
      allGoods: [],
      filteredGoods: [],
      displayGoods: [],
      displayFeed: [],
      cloudSkip: 0,
      cloudHasMore: true,
      canViewMore: true
    })
    await this._fetchFirstPage({ reason: "search" })
  },

  onClearKeyword() {
    if (!this.data.keyword) return
    this.setData({
      keyword: "",
      allGoods: [],
      filteredGoods: [],
      displayGoods: [],
      displayFeed: [],
      cloudSkip: 0,
      cloudHasMore: true,
      canViewMore: true
    })
    this._fetchFirstPage({ reason: "clearKeyword" })
  },

  onResetMarketFilters() {
    this._userSortTouched = false
    this.setData({
      keyword: "",
      activeCategory: "全部",
      categoryTabs: buildCategoryTabs(this.data.categories, "全部"),
      activeRegion: "全部",
      activeRegionLabel: "全部",
      ...this._getDefaultSortPatch(),
      allGoods: [],
      filteredGoods: [],
      displayGoods: [],
      displayFeed: [],
      cloudSkip: 0,
      cloudHasMore: true,
      canViewMore: true
    })
    this._fetchFirstPage({ reason: "resetFilters" })
  },

  async onSelectCat(e) {
    const cat = e.currentTarget.dataset.cat

    // 切类目：云端 where(category=xxx) + 分页拉取
    this.setData({
      activeCategory: cat || "全部",
      categoryTabs: buildCategoryTabs(this.data.categories, cat || "全部"),
      allGoods: [],
      filteredGoods: [],
      displayGoods: [],
      displayFeed: [],
      cloudSkip: 0,
      cloudHasMore: true,
      canViewMore: true
    })
    this.updateMarketHeaderState(0)
    await this._fetchFirstPage({ reason: "category" })
  },

  onSelectListingType(e) {
    const type = e.currentTarget.dataset.type || "goods"
    this._switchListingType(type)
  },

  onMarketTabTypeChange(e) {
    const type = e.detail && e.detail.type
    if (!type) return
    this._switchListingType(type)
  },

  onTapFeedItem(e) {
    const index = Number(e.currentTarget.dataset.index)
    const item = (this.data.displayFeed || [])[index]
    if (item && item.isAd) {
      this._openMarketAd(item)
      return
    }
    const id = (item && item.id) || e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/market/marketDetail/marketDetail?id=${id}` })
  },

  onTapAdContact(e) {
    const index = Number(e.currentTarget.dataset.index)
    const item = (this.data.displayFeed || [])[index]
    if (item && item.isAd) this._trackMarketAdClick(item)
  },

  onSellIdle() {
    wx.navigateTo({ url: `/pages/market/marketPost/marketPost?type=${this.data.activeListingType || "goods"}` })
  },

  _setPublishFabHidden(hidden) {
    if (this._publishFabHidden === hidden) return
    this._publishFabHidden = hidden
    this.setData({ publishFabVisibleClass: hidden ? "fab-hidden" : "" })
  },

  onGoodsScroll(e) {
    const scrollTop = Number(e?.detail?.scrollTop) || 0
    const previous = Number(this._lastGoodsScrollTop) || 0
    const delta = scrollTop - previous
    this._lastGoodsScrollTop = scrollTop

    if (scrollTop < 24) {
      this._setPublishFabHidden(false)
      return
    }
    if (delta > 10) {
      this._setPublishFabHidden(true)
    } else if (delta < -10) {
      this._setPublishFabHidden(false)
    }
  },

  stopTouchMove() {},

  // ====== 分类初始化 ======
  initCategoriesFromGoods() {
    const config = getListingTypeConfig(this.data.activeListingType)
    const categories = ["全部", ...config.categories]
    const activeCategory = categories.includes(this.data.activeCategory) ? this.data.activeCategory : "全部"
    this.setData({
      categories,
      activeCategory,
      categoryTabs: buildCategoryTabs(categories, activeCategory)
    })
  },

  initRegionsFromGoods() {
    const set = new Set((this.data.allGoods || []).map(g => g.region).filter(Boolean))
    this.setData({ regions: ["全部", ...Array.from(set)] })
  },

  async loadRegionTreeFromCloud() {
    try {
      const db = wx.cloud.database()
      let docData = null
      try {
        const doc = await db.collection("regionTree").doc("default").get()
        docData = doc?.data || null
      } catch (e) {}

      if (!docData) {
        const res = await db.collection("regionTree").limit(1).get()
        docData = (res.data || [])[0] || null
      }

      let tree = docData
      if (tree && Array.isArray(tree.tree)) tree = tree.tree
      if (!Array.isArray(tree) || !tree.length) throw new Error("regionTree 数据为空或格式错误")

      // ✅ 确保顶层永远有 “全部”
      const allNode = { label: "全部", children: [{ label: "全部", children: ["全部"] }] }
      if (!tree.some(x => x && x.label === "全部")) {
        tree = [allNode, ...tree]
      }

      const col1 = tree.map(x => x.label)
      const lv1 = tree[0]
      const col2 = (lv1.children || []).map(x => x.label) || ["全部"]
      const lv2 = (lv1.children || [])[0] || { children: ["全部"] }
      const raw3 = (lv2.children || []).filter(Boolean)
      const col3 = ["全部", ...raw3.filter(x => x !== "全部")]

      this.setData({
        regionTree: tree,
        regionPickerValue: [0, 0, 0],
        regionCol1: col1,
        regionCol2: col2.length ? col2 : ["全部"],
        regionCol3: col3.length ? col3 : ["全部"]
      })
    } catch (e) {
      console.error("regionTree 加载失败：", e)
      showDataError("地区加载失败", e, "地区配置从数据库加载失败，请稍后重试。")
      this.setData({
        regionTree: [],
        regionPickerValue: [0, 0, 0],
        regionCol1: ["加载失败"],
        regionCol2: ["加载失败"],
        regionCol3: ["加载失败"]
      })
    }
  },

  onTapRegion() {
    this.setData({ regionPickerVisible: true })
  },

  onRegionPickerChange(e) {
    const v = Array.isArray(e.detail.value) ? e.detail.value : [0, 0, 0]
    const [v0, v1] = v
    const tree = this.data.regionTree || []
    const lv1 = tree[v0] || tree[0] || { children: [] }
    const col2 = (lv1.children || []).map(x => x.label)
    const lv2 = (lv1.children || [])[v1] || (lv1.children || [])[0] || { children: ["全部"] }
    const raw3 = (lv2.children || []).filter(Boolean)
    const col3 = ["全部", ...raw3.filter(x => x !== "全部")]

    this.setData({
      regionPickerValue: v,
      regionCol2: col2.length ? col2 : ["全部"],
      regionCol3: col3.length ? col3 : ["全部"]
    })
  },

  onRegionPickerCancel() {
    this.setData({ regionPickerVisible: false })
  },

  onRegionPickerConfirm() {
    const pickerValue = Array.isArray(this.data.regionPickerValue) ? this.data.regionPickerValue : [0, 0, 0]
    const [v0, v1, v2] = pickerValue
    const tree = this.data.regionTree || []
    const lv1 = tree[v0] || tree[0]
    const lv2 = (lv1?.children || [])[v1] || (lv1?.children || [])[0]
    const col3 = this.data.regionCol3 || ["全部"]
    const lv3 = col3[v2] || col3[0]
    let region = "全部"
    if (lv1?.label && lv1.label !== "全部") {
      region = `${lv1.label} / ${lv2?.label || "全部"} / ${lv3 || "全部"}`
    }

    this.setData({
      activeRegion: region,
      activeRegionLabel: region === "全部" ? "全部" : region,
      regionPickerVisible: false,

      allGoods: [],
      filteredGoods: [],
      displayGoods: [],
      displayFeed: [],
      cloudSkip: 0,
      cloudHasMore: true,
      canViewMore: true
    })
    this.updateMarketHeaderState(0)
    // 切换地区后：按新筛选条件重新拉第一页
    this._fetchFirstPage({ reason: "region" })
  },

  // ====== 核心：映射商品（✅缩略图优先）======
  _mapDocToGood(x) {
    const listingType = normalizeListingType(x.listingType)
    const config = getListingTypeConfig(listingType)
    const thumbKey = (x.thumbFileID || x.imageFileID || "")
    const hasImage = !!(x.hasImage || x.imageFileID || x.thumbFileID || (Array.isArray(x.imageFileIDs) && x.imageFileIDs.length))
    const title = String(x.title || "").trim() || (listingType === "sublet" ? "未命名房源" : "未命名商品")
    const priceNumber = Number(x.price)
    const basePriceText = Number.isFinite(priceNumber) ? priceNumber.toFixed(priceNumber % 1 === 0 ? 0 : 2) : "0"
    const priceText = listingType === "sublet" ? `${basePriceText}/月` : basePriceText
    const conditionText = listingType === "sublet"
      ? buildSubletStartText(x)
      : (x.condition || "成色未填")
    const category = config.categories.includes(x.category) ? x.category : "其他"
    return this._withDistance({
      id: x._id,
      listingType,
      title,
      price: x.price,
      priceText,
      category,
      region: x.region,
      location: x.location || {},
      condition: conditionText,
      conditionText,
      desc: x.desc,
      postDate: x.postDate,

      // 旧字段
      imageFileID: x.imageFileID || "",

      // 新字段（可没有，兼容老数据）
      thumbFileID: x.thumbFileID || "",
      imageFileIDs: Array.isArray(x.imageFileIDs) ? x.imageFileIDs : [],
      thumbFileIDs: Array.isArray(x.thumbFileIDs) ? x.thumbFileIDs : [],
      hasImage,
      pickupStartDate: x.pickupStartDate || "",
      pickupEndDate: x.pickupEndDate || x.expiresAtText || "",
      pickupRangeText: x.pickupRangeText || "",
      expireTime: Number(x.expireTime) || 0,
      status: x.status || "online",

      thumbUrl: x.thumbUrl || (thumbKey ? (this._thumbUrlCache[thumbKey] || "") : ""),
      imageSrc: x.imageSrc || x.thumbUrl || (thumbKey ? (this._thumbUrlCache[thumbKey] || thumbKey) : (listingType === "sublet" ? "/images/sublease.png" : "/images/market.png"))
    })
  },

  _withDistance(g) {
    const miles = hasLatLng(this.data.myLocation || {}) && hasLatLng(g?.location || {})
      ? distanceMiles(this.data.myLocation, g.location)
      : null
    return {
      ...g,
      distanceMiles: miles,
      distanceText: formatDistanceText(miles)
    }
  },

  _getAdSeedBase(goods = []) {
    const firstIds = goods.slice(0, 8).map(item => item.id || "").join(",")
    return [
      this._marketAdSessionSeed || "",
      this.data.activeListingType,
      this.data.activeCategory,
      this.data.activeRegion,
      this.data.keyword,
      firstIds
    ].join("|")
  },

  _pickMarketAd(ads = [], goods = []) {
    const list = (Array.isArray(ads) ? ads : []).map(normalizeMarketAd).filter(ad => ad.id)
    if (!list.length || goods.length < MARKET_AD_MIN_GOODS) return null

    const totalWeight = list.reduce((sum, ad) => sum + Math.max(1, Number(ad.weight) || 1), 0)
    if (!totalWeight) return list[0]
    let cursor = seededUnit(`${this._getAdSeedBase(goods)}|ad`) * totalWeight
    for (let i = 0; i < list.length; i += 1) {
      cursor -= Math.max(1, Number(list[i].weight) || 1)
      if (cursor <= 0) return list[i]
    }
    return list[list.length - 1]
  },

  _pickMarketAdSlot(goodsLength, goods = [], ad = {}) {
    if (goodsLength < MARKET_AD_MIN_GOODS) return -1
    const min = Math.min(MARKET_AD_INSERT_MIN_INDEX, goodsLength)
    const max = Math.min(MARKET_AD_INSERT_MAX_INDEX, goodsLength)
    if (max <= min) return min
    const offset = Math.floor(seededUnit(`${this._getAdSeedBase(goods)}|slot|${ad.id || ""}`) * (max - min + 1))
    return min + offset
  },

  _buildDisplayFeed(goods = this.data.displayGoods, ads = this.data.marketAds) {
    const list = (Array.isArray(goods) ? goods : []).map(item => ({
      ...item,
      isAd: false,
      _feedKey: `goods_${item.id || item._id || hashString(item.title || "")}`
    }))
    const ad = this._pickMarketAd(ads, list)
    if (!ad) return list

    const slot = this._pickMarketAdSlot(list.length, list, ad)
    if (slot < 0) return list
    const next = list.slice()
    next.splice(slot, 0, normalizeMarketAd(ad))
    return next
  },

  _applyDisplayFeed(displayGoods = this.data.displayGoods, marketAds = this.data.marketAds) {
    this.setData({
      displayFeed: this._buildDisplayFeed(displayGoods, marketAds)
    })
  },

  _restoreMarketAdsFromCache() {
    try {
      const cached = wx.getStorageSync(getMarketAdCacheKey())
      if (!cached || !cached.ts || !Array.isArray(cached.ads)) return { restored: false, isFresh: false }
      const age = Date.now() - cached.ts
      if (age > GOODS_CACHE_MAX_STALE_MS) return { restored: false, isFresh: false }
      const ads = cached.ads.map(normalizeMarketAd).filter(ad => ad.id)
      this.setData({
        marketAds: ads,
        displayFeed: this._buildDisplayFeed(this.data.displayGoods, ads)
      })
      return { restored: true, isFresh: age <= MARKET_AD_CACHE_FRESH_MS }
    } catch (e) {
      return { restored: false, isFresh: false }
    }
  },

  _saveMarketAdsToCache(ads = []) {
    try {
      wx.setStorageSync(getMarketAdCacheKey(), {
        ts: Date.now(),
        ads
      })
    } catch (e) {}
  },

  async _loadMarketAds(options = {}) {
    const cacheState = this._restoreMarketAdsFromCache()
    if (cacheState.restored && cacheState.isFresh && !options.force) return
    if (!cacheState.restored) {
      this.setData({
        marketAds: [],
        displayFeed: this._buildDisplayFeed(this.data.displayGoods, [])
      })
    }

    const requestKey = "market_feed"
    if (this._marketAdsInFlightKey === requestKey) return
    this._marketAdsInFlightKey = requestKey
    try {
      const res = await wx.cloud.callFunction({
        name: "marketApi",
        data: {
          action: "listAds",
          placement: "market_feed",
          limit: 20
        }
      })
      const result = getMarketApiResult(res)
      const ads = (result.ads || result.data || []).map(normalizeMarketAd).filter(ad => ad.id)
      this._saveMarketAdsToCache(ads)
      this.setData({
        marketAds: ads,
        displayFeed: this._buildDisplayFeed(this.data.displayGoods, ads)
      })
    } catch (e) {
      console.warn("[market] load ads failed:", e)
      if (!cacheState.restored) this._applyDisplayFeed()
    } finally {
      if (this._marketAdsInFlightKey === requestKey) this._marketAdsInFlightKey = ""
    }
  },

  _trackMarketAdClick(ad = {}) {
    if (!ad.id) return
    wx.cloud.callFunction({
      name: "marketApi",
      data: {
        action: "trackAdClick",
        adId: ad.id,
        placement: "market_feed",
        listingType: this.data.activeListingType
      }
    }).catch(() => {})
  },

  _openMarketAd(ad = {}) {
    const targetType = String(ad.targetType || "page").trim()
    const targetPath = String(ad.targetPath || "").trim()
    const targetUrl = String(ad.targetUrl || "").trim()
    this._trackMarketAdClick(ad)

    if (targetType === "none") return

    if (targetType === "contact") return

    if (targetType === "miniProgram" && ad.targetAppId) {
      wx.navigateToMiniProgram({
        appId: ad.targetAppId,
        path: targetPath || "",
        extraData: ad.targetExtraData || {},
        fail: () => wx.showToast({ title: "暂时无法打开广告", icon: "none" })
      })
      return
    }

    if (targetType === "tab" && targetPath) {
      wx.switchTab({ url: targetPath })
      return
    }

    if (targetType === "serviceChat") {
      const serviceUrl = String(ad.serviceUrl || targetUrl || "").trim()
      const corpId = String(ad.serviceCorpId || ad.targetAppId || "").trim()
      if (!corpId || !serviceUrl || typeof wx.openCustomerServiceChat !== "function") {
        wx.showToast({ title: "暂时无法打开客服", icon: "none" })
        return
      }
      wx.openCustomerServiceChat({
        corpId,
        extInfo: { url: serviceUrl },
        showMessageCard: !!ad.showMessageCard,
        sendMessageTitle: ad.contactMessageTitle || ad.title || "校园推荐",
        sendMessagePath: ad.contactMessagePath || "/pages/market/market",
        sendMessageImg: ad.contactMessageImg || ad.imageSrc || "",
        fail: () => wx.showToast({ title: "暂时无法打开客服", icon: "none" })
      })
      return
    }

    if (targetType === "copyWechat") {
      const wechatId = String(ad.wechatId || targetUrl || "").trim()
      if (!wechatId) {
        wx.showToast({ title: "广告暂未配置微信号", icon: "none" })
        return
      }
      wx.setClipboardData({
        data: wechatId,
        success: () => wx.showToast({ title: "微信号已复制", icon: "none" })
      })
      return
    }

    if ((targetType === "web" || /^https?:\/\//i.test(targetUrl)) && targetUrl) {
      wx.navigateTo({
        url: `/pages/other/webview/webview?url=${encodeURIComponent(targetUrl)}`,
        fail: () => wx.setClipboardData({
          data: targetUrl,
          success: () => wx.showToast({ title: "链接已复制", icon: "none" })
        })
      })
      return
    }

    if (targetType === "copy" && targetUrl) {
      wx.setClipboardData({
        data: targetUrl,
        success: () => wx.showToast({ title: "链接已复制", icon: "none" })
      })
      return
    }

    if (targetPath) {
      wx.navigateTo({
        url: targetPath,
        fail: () => wx.showToast({ title: "暂时无法打开广告", icon: "none" })
      })
      return
    }

    wx.showToast({ title: "广告暂未配置跳转", icon: "none" })
  },

  async _loadMyLocationFromProfile(options = {}) {
    const applyDefaultSort = !!options.applyDefaultSort
    const previousLocationKey = normalizeCoordKey(this.data.myLocation || {})
    const previousDistanceSortActive = !!this.data.distanceSortActive
    const openid = wx.getStorageSync("openid") || ""
    const isGuest = !!wx.getStorageSync("isGuest")
    if (!openid || isGuest) {
      const patch = {
        myLocation: null,
        ...(applyDefaultSort || previousDistanceSortActive ? this._getDefaultSortPatch(null) : {})
      }
      const nextSortActive = !!patch.distanceSortActive
      this.setData(patch)
      return {
        myLocation: null,
        locationChanged: !!previousLocationKey,
        sortChanged: previousDistanceSortActive !== nextSortActive
      }
    }

    try {
      const res = await wx.cloud.callFunction({ name: "getUserInfo" })
      const user = (res?.result?.data || [])[0] || {}
      const location = user.location || {}
      const myLocation = hasLatLng(location) ? location : null
      const patch = { myLocation }
      if (applyDefaultSort || (previousDistanceSortActive && !myLocation)) {
        Object.assign(patch, this._getDefaultSortPatch(myLocation))
      }
      const nextLocationKey = normalizeCoordKey(myLocation || {})
      const nextSortActive = Object.prototype.hasOwnProperty.call(patch, "distanceSortActive")
        ? !!patch.distanceSortActive
        : previousDistanceSortActive
      this.setData(patch)
      this._refreshGoodsDistance()
      return {
        myLocation,
        locationChanged: previousLocationKey !== nextLocationKey,
        sortChanged: previousDistanceSortActive !== nextSortActive
      }
    } catch (e) {
      return {
        myLocation: this.data.myLocation || null,
        locationChanged: false,
        sortChanged: false
      }
    }
  },

  _refreshGoodsDistance() {
    const allGoods = (this.data.allGoods || []).map(g => this._withDistance(g))
    this.setData({ allGoods })
    this.applyFilters(false)
  },

  _isVisibleMarketDoc(x) {
    if (!x) return false
    const activeListingType = normalizeListingType(this.data.activeListingType)
    const itemListingType = normalizeListingType(x.listingType)
    if (itemListingType !== activeListingType) return false
    const status = String(x.status || "online").toLowerCase()
    if (status === "deleted" || status === "offline" || status === "expired" || status === "sold") return false
    const expireTime = Number(x.expireTime) || 0
    if (expireTime && expireTime <= Date.now()) return false
    return true
  },

  async _fetchFirstPage(options = {}) {
    const filters = {
      listingType: this.data.activeListingType,
      category: this.data.activeCategory,
      region: this.data.activeRegion,
      keyword: this.data.keyword
    }
    const sort = this._buildListSort()
    const requestKey = buildListQueryKey(filters, sort)
    const now = Date.now()
    const force = !!options.force

    if (!force) {
      if (this._firstPageInFlightKey === requestKey) return false
      const lastAt = this._firstPageFetchAtByKey && this._firstPageFetchAtByKey[requestKey]
      if (lastAt && now - lastAt < FIRST_PAGE_FETCH_COOLDOWN_MS) return false
    }

    this._firstPageInFlightKey = requestKey
    this._firstPageFetchAtByKey = this._firstPageFetchAtByKey || {}
    this._firstPageFetchAtByKey[requestKey] = now
    const requestToken = `${requestKey}|first|${now}`
    this._activeGoodsRequestToken = requestToken

    try {
      this.setData({
        isLoadingGoods: true,
        isLoadingMore: false,
        ...buildMarketListFlags({ ...this.data, isLoadingGoods: true, isLoadingMore: false })
      })

      const res = await wx.cloud.callFunction({
        name: "marketApi",
        data: {
          action: "list",
          filters,
          sort,
          skip: 0,
          limit: INITIAL_LOAD_SIZE
        }
      })
      const result = getMarketApiResult(res)
      const currentKey = buildListQueryKey({
        listingType: this.data.activeListingType,
        category: this.data.activeCategory,
        region: this.data.activeRegion,
        keyword: this.data.keyword
      }, this._buildListSort())
      if (currentKey !== requestKey) return false

      const rawRows = result.items || result.data || []
      const rows = rawRows.filter(x => this._isVisibleMarketDoc(x)).map(x => this._mapDocToGood(x))

      this.setData({
        allGoods: rows,
        cloudSkip: result.nextSkip || rawRows.length,
        cloudHasMore: !!result.hasMore
      })

      if (!sort.by && filters.category === "全部" && filters.region === "全部" && !String(filters.keyword || "").trim()) {
        this._saveGoodsToCache(rawRows, {
          type: filters.listingType,
          nextSkip: result.nextSkip || rawRows.length,
          hasMore: !!result.hasMore
        })
      }

      this.initRegionsFromGoods()
      this.applyFilters(true)
      return true
    } catch (e) {
      console.error(e)
      showDataError("市场加载失败", e, "市场列表从数据库加载失败，请稍后重试。")
      return false
    } finally {
      if (this._firstPageInFlightKey === requestKey) this._firstPageInFlightKey = ""
      if (this._activeGoodsRequestToken === requestToken) {
        this._activeGoodsRequestToken = ""
        this.setData({
          isLoadingGoods: false,
          isLoadingMore: false,
          ...buildMarketListFlags({ ...this.data, isLoadingGoods: false, isLoadingMore: false })
        })
      }
    }
  },

  async _fetchNextPage(resetPagingAfterAppend = false, options = {}) {
    if (!this.data.cloudHasMore) return false
    if (this.data.isLoadingGoods) return false
    const minDisplayCount = Math.max(0, Number(options.minDisplayCount) || 0)
    const filters = {
      listingType: this.data.activeListingType,
      category: this.data.activeCategory,
      region: this.data.activeRegion,
      keyword: this.data.keyword
    }
    const sort = this._buildListSort()
    const requestKey = buildListQueryKey(filters, sort)
    const requestToken = `${requestKey}|next|${Date.now()}`
    this._activeGoodsRequestToken = requestToken

    try {
      this.setData({
        isLoadingGoods: true,
        isLoadingMore: true,
        ...buildMarketListFlags({ ...this.data, isLoadingGoods: true, isLoadingMore: true })
      })

      const skip = this.data.cloudSkip || 0
      const res = await wx.cloud.callFunction({
        name: "marketApi",
        data: {
          action: "list",
          filters,
          sort,
          skip,
          limit: CLOUD_PAGE_SIZE
        }
      })
      const result = getMarketApiResult(res)
      const currentKey = buildListQueryKey({
        listingType: this.data.activeListingType,
        category: this.data.activeCategory,
        region: this.data.activeRegion,
        keyword: this.data.keyword
      }, this._buildListSort())
      if (currentKey !== requestKey) return false

      const rawBatch = result.items || result.data || []
      const batch = rawBatch.filter(x => this._isVisibleMarketDoc(x)).map(x => this._mapDocToGood(x))
      const all = [...(this.data.allGoods || []), ...batch]

      this.setData({
        allGoods: all,
        cloudSkip: result.nextSkip || (skip + rawBatch.length),
        cloudHasMore: !!result.hasMore
      })

      if (!sort.by && filters.category === "全部" && filters.region === "全部" && !String(filters.keyword || "").trim()) {
        const cached = wx.getStorageSync(getGoodsCacheKey(filters.listingType)) || {}
        this._saveGoodsToCache([...(cached.list || []), ...rawBatch], {
          type: filters.listingType,
          nextSkip: result.nextSkip || (skip + rawBatch.length),
          hasMore: !!result.hasMore
        })
      }

      this.initRegionsFromGoods()
      this.applyFilters(resetPagingAfterAppend, { minDisplayCount })
      return true
    } catch (e) {
      console.error(e)
      showDataError("市场加载失败", e, "市场列表从数据库加载失败，请稍后重试。")
      return false
    } finally {
      if (this._activeGoodsRequestToken === requestToken) {
        this._activeGoodsRequestToken = ""
        this.setData({
          isLoadingGoods: false,
          isLoadingMore: false,
          ...buildMarketListFlags({ ...this.data, isLoadingGoods: false, isLoadingMore: false })
        })
      }
    }
  },


  // 右侧商品列表滚动到底：自动触发“查看更多”的同一套逻辑（不改原有分页/筛选）
  onGoodsScrollToLower() {
    // 轻量节流，避免 scrolltolower 连续触发
    const now = Date.now()
    if (this._lastScrollToLowerAt && now - this._lastScrollToLowerAt < 500) return
    this._lastScrollToLowerAt = now

    // 正在拉取云端时不重复触发
    if (this.data.isLoadingGoods) return

    // 只要还有更多可展示/可拉取，就走原来的 onViewMore
    if (this.data.canViewMore || this.data.cloudHasMore) {
      this.onViewMore()
    }
  },

  onViewMore() {
    const filtered = this.data.filteredGoods || []
    const cur = (this.data.displayGoods || []).length
    const nextLen = cur + (this.data.pageSize || 8)

    const next = filtered.slice(0, nextLen)
    const nextCanViewMore = next.length < filtered.length || !!this.data.cloudHasMore
    const nextFeed = this._buildDisplayFeed(next, this.data.marketAds)
    this.setData({
      displayGoods: next,
      displayFeed: nextFeed,
      canViewMore: nextCanViewMore,
      ...buildMarketListFlags({
        ...this.data,
        displayGoods: next,
        canViewMore: nextCanViewMore
      })
    })

    // 如果本地不够了，继续拉云端
    if (next.length >= filtered.length - 2) {
      this._fetchNextPage(false, { minDisplayCount: nextLen })
    }
  },

  // （保留，不再使用也无害）
  async _autoFillForCurrentFilters(maxPages = 3) {
    for (let i = 0; i < maxPages; i++) {
      this.applyFilters(true)
      const filtered = this.data.filteredGoods || []
      if (filtered.length > 0) return
      if (!this.data.cloudHasMore) return
      await this._fetchNextPage(true)
    }
  },

  // ====== 展示侧过滤/排序（云端已筛选，这里只做排序 + 前端切片）======
  applyFilters(resetPaging = false, options = {}) {
    const { allGoods, pageSize } = this.data
    const minDisplayCount = Math.max(0, Number(options.minDisplayCount) || 0)

    const filtered = [...(allGoods || [])]

    // sort（必须在 slice 前做）
    if (this.data.distanceSortActive) {
      filtered.sort((a, b) => {
        const da = Number.isFinite(a.distanceMiles) ? a.distanceMiles : Number.POSITIVE_INFINITY
        const db = Number.isFinite(b.distanceMiles) ? b.distanceMiles : Number.POSITIVE_INFINITY
        if (da !== db) return da - db
        return String(b.postDate || "").localeCompare(String(a.postDate || ""))
      })
    }

    const order = this.data.priceSortOrder || 'none'
    if (!this.data.distanceSortActive && order !== 'none') {
      const getPrice = (g) => {
        const raw =
          g?.price ??
          g?.displayPrice ??
          g?.sellPrice ??
          g?.amount ??
          g?.money

        const n = Number(String(raw ?? '').replace(/[^\d.]/g, ''))
        return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY
      }

      filtered.sort((a, b) => {
        const pa = getPrice(a)
        const pb = getPrice(b)
        return order === 'asc' ? (pa - pb) : (pb - pa)
      })
    }

    // paging slice
    let display
    let canViewMore
    if (resetPaging) {
      const targetCount = Math.max(pageSize, minDisplayCount)
      display = filtered.slice(0, targetCount)
      canViewMore = filtered.length > targetCount
    } else {
      const cur = (this.data.displayGoods || []).length
      const targetCount = Math.max(cur, minDisplayCount)
      display = filtered.slice(0, targetCount)
      canViewMore = filtered.length > targetCount
    }

    const nextCanViewMore = canViewMore || !!this.data.cloudHasMore
    const displayFeed = this._buildDisplayFeed(display, this.data.marketAds)
    this.setData({
      filteredGoods: filtered,
      displayGoods: display,
      displayFeed,
      // 既要考虑本地还有没展示的，也要考虑云端还有未拉取的
      canViewMore: nextCanViewMore,
      ...buildMarketListFlags({
        ...this.data,
        displayGoods: display,
        canViewMore: nextCanViewMore
      })
    })
    this.updateMarketHeaderState(filtered.length)

    this._fillThumbUrlsFor(display).catch(() => {})
  },

  updateMarketHeaderState(count) {
    const activeCategory = this.data.activeCategory || "全部"
    const activeRegion = this.data.activeRegion || "全部"
    const config = getListingTypeConfig(this.data.activeListingType)
    this.setData({
      resultTitle: activeCategory === "全部" ? config.resultTitle : activeCategory,
      resultCountText: `${Number(count) || 0} ${config.resultUnit}`,
      activeRegionLabel: activeRegion === "全部" ? "全部" : activeRegion
    })
  },

  // ====== thumb temp url ======
  async _fillThumbUrlsFor(goodsList) {
    const list = goodsList || []
    const missing = Array.from(new Set(
      list
        .map(g => g && (g.thumbFileID || g.imageFileID))
        .filter(Boolean)
        .filter(fileID => !this._thumbUrlCache[fileID])
    ))

    if (!missing.length) return

    const chunkSize = 50
    for (let i = 0; i < missing.length; i += chunkSize) {
      const chunk = missing.slice(i, i + chunkSize)
      try {
        const r = await wx.cloud.getTempFileURL({ fileList: chunk })
        ;(r.fileList || []).forEach(x => {
          if (x.fileID && x.tempFileURL) this._thumbUrlCache[x.fileID] = x.tempFileURL
        })
      } catch (e) {
        console.error("getTempFileURL failed:", e)
      }
    }

    try { wx.setStorageSync(THUMB_CACHE_KEY, this._thumbUrlCache) } catch (e) {}

    const attachThumbUrl = (g) => {
      if (!g) return g
      const key = g.thumbFileID || g.imageFileID
      if (!key) return g
      const url = this._thumbUrlCache[key]
      if (!url) return g
      return { ...g, thumbUrl: url, imageSrc: url }
    }

    const nextAll = (this.data.allGoods || []).map(attachThumbUrl)
    const nextDisplay = (this.data.displayGoods || []).map(attachThumbUrl)
    const nextFeed = this._buildDisplayFeed(nextDisplay, this.data.marketAds)
    this.setData({
      allGoods: nextAll,
      displayGoods: nextDisplay,
      displayFeed: nextFeed
    })
  },

  // ====== 缓存 ======
  _restoreGoodsFromCache() {
    try {
      const cached = wx.getStorageSync(getGoodsCacheKey(this.data.activeListingType))
      if (!cached || !cached.ts || !Array.isArray(cached.list)) return { restored: false, isFresh: false }
      const cacheAge = Date.now() - cached.ts
      if (cacheAge > GOODS_CACHE_MAX_STALE_MS) return { restored: false, isFresh: false }

      const rows = (cached.list || []).filter(x => this._isVisibleMarketDoc(x)).map(x => this._mapDocToGood(x))
      this.setData({
        allGoods: rows,
        cloudSkip: Number(cached.nextSkip) || cached.list.length || rows.length,
        cloudHasMore: typeof cached.hasMore === "boolean" ? cached.hasMore : true
      })
      this.initRegionsFromGoods()
      this._fillThumbUrlsFor(rows).catch(() => {})
      const sortRequiresCloudRefresh = !!this._buildListSort().by
      return {
        restored: true,
        isFresh: !sortRequiresCloudRefresh && cacheAge <= GOODS_CACHE_FRESH_MS,
        cacheAge
      }
    } catch (e) {
      return { restored: false, isFresh: false }
    }
  },

  _saveGoodsToCache(list, meta = {}) {
    try {
      const type = meta.type || this.data.activeListingType
      wx.setStorageSync(getGoodsCacheKey(type), {
        ts: Date.now(),
        list,
        nextSkip: Number(meta.nextSkip) || (Array.isArray(list) ? list.length : 0),
        hasMore: typeof meta.hasMore === "boolean" ? meta.hasMore : true
      })
    } catch (e) {}
  },

  _maybeRefreshGoods(force) {
    const now = Date.now()
    if (!force && now - (this._lastRefreshAt || 0) < REFRESH_DEBOUNCE_MS) return
    this._lastRefreshAt = now
    this._fetchFirstPage({ force: !!force, reason: force ? "forceRefresh" : "backgroundRefresh" })
  }
})
