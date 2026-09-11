// 与 marketPost 保持一致：分类顺序固定
const { showDataError } = require("../../utils/error")
const {
  DEFAULT_REGION_TREE,
  normalizeRegionTree,
  loadRegionTreeConfig,
  readCachedRegionTree,
  writeCachedRegionTree,
  getCityOptions,
  getCitySnapshot,
  findState
} = require("../../utils/Region")

const ALL_AREA_KEY = "all"
const ALL_AREA_LABEL = "全部"
const MARKET_CITY_STORAGE_KEY = "market_city_snapshot_v2"
const {
  readMarketSellerProfiles,
  fetchAndCacheMarketSellerProfiles
} = require("../../utils/marketSellerProfileCache")

const GOODS_CATEGORY_OPTIONS = ["家具", "厨具", "电器", "服包鞋饰", "电子产品", "运动装备", "食品", "其他"]
const SUBLET_CATEGORY_OPTIONS = ["Studio", "1B1B", "2B1B", "2B2B", "3B2B", "其他"]
const LISTING_TYPE_STORAGE_KEY = "market_active_listing_type_v1"
const LISTING_TYPE_CONFIG = {
  goods: {
    type: "goods",
    label: "二手",
    searchPlaceholder: "搜索商品关键词",
    resultTitle: "最新闲置",
    resultUnit: "件",
    priceLabel: "价格",
    emptyTitle: "没有找到商品",
    emptySubtitle: "换个关键词或筛选条件再试试",
    categories: GOODS_CATEGORY_OPTIONS
  },
  sublet: {
    type: "sublet",
    label: "转租",
    searchPlaceholder: "搜索公寓关键词",
    resultTitle: "最新转租",
    resultUnit: "套",
    priceLabel: "月租",
    emptyTitle: "没有找到房源",
    emptySubtitle: "换个区域或关键词再试试",
    categories: SUBLET_CATEGORY_OPTIONS
  }
}

// ====== Performance / Cache ======
const GOODS_CACHE_KEY_PREFIX = "market_goods_list_cache_v13"
const THUMB_CACHE_KEY = "market_thumburl_cache_v1"
const MARKET_AD_CACHE_KEY_PREFIX = "market_ads_cache_v1"
const MARKET_REFRESH_KEY = "market_goods_changed_at"
const MARKET_POST_SUCCESS_FILTER_KEY = "market_post_success_filter_v1"
const GOODS_CACHE_MAX_STALE_MS = 24 * 60 * 60 * 1000 // 24h 内先用旧缓存秒开，再后台刷新
const GOODS_CACHE_FRESH_MS = 5 * 60 * 1000           // 5 分钟内视为新缓存；仍会后台刷新保证进入/切换有新数据
const MARKET_AD_CACHE_FRESH_MS = 10 * 60 * 1000
const REFRESH_DEBOUNCE_MS = 30 * 1000             // 30 sec
const FIRST_PAGE_FETCH_COOLDOWN_MS = 30 * 1000     // 普通返回页面最多沿用 30 秒内成功读取的数据
const MARKET_AD_MIN_GOODS = 3
const MARKET_AD_INSERT_MIN_INDEX = 2
const MARKET_AD_INSERT_MAX_INDEX = 5
const MARKET_DEFAULT_CITY_KEY = "ALL"
const MARKET_DEFAULT_CITY_LABEL = "全部"

const MARKET_LIST_MEMORY_CACHE = {}

function normalizeListingType(value) {
  return String(value || "").toLowerCase() === "sublet" ? "sublet" : "goods"
}

function normalizeSubletCategory(value) {
  const text = String(value || "").trim()
  if (!text) return ""
  const key = text.replace(/[\s/_-]+/g, "").toLowerCase()
  const map = {
    studio: "Studio",
    "1b1b": "1B1B",
    "2b1b": "2B1B",
    "2b2b": "2B2B",
    "3b2b": "3B2B",
    other: "其他",
    others: "其他",
    "其他": "其他"
  }
  return map[key] || (SUBLET_CATEGORY_OPTIONS.includes(text) ? text : "其他")
}

function getListingTypeConfig(type) {
  return LISTING_TYPE_CONFIG[normalizeListingType(type)] || LISTING_TYPE_CONFIG.goods
}

function normalizeObjectCache(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function normalizeAreaKeys(value) {
  const source = Array.isArray(value) ? value : [value]
  const out = []
  const seen = new Set()
  source.forEach(item => {
    const key = String(item || "").trim()
    if (!key || key === ALL_AREA_KEY || seen.has(key)) return
    seen.add(key)
    out.push(key)
  })
  return out
}

function getAreaCacheKey(areaKeys = []) {
  const keys = normalizeAreaKeys(areaKeys).sort()
  return keys.length ? keys.join(",") : ALL_AREA_KEY
}

function getGoodsCacheKey(type, cityKey = MARKET_DEFAULT_CITY_KEY, regionKey = ALL_AREA_KEY) {
  const areaKey = Array.isArray(regionKey) ? getAreaCacheKey(regionKey) : (regionKey || ALL_AREA_KEY)
  return `${GOODS_CACHE_KEY_PREFIX}_${normalizeListingType(type)}_${cityKey || MARKET_DEFAULT_CITY_KEY}_${areaKey}`
}

function readGoodsCacheEntry(type, cityKey = MARKET_DEFAULT_CITY_KEY, regionKey = ALL_AREA_KEY) {
  const key = getGoodsCacheKey(type, cityKey, regionKey)
  const memory = MARKET_LIST_MEMORY_CACHE[key]
  if (memory && Array.isArray(memory.list)) return memory
  try {
    const cached = wx.getStorageSync(key)
    if (cached && Array.isArray(cached.list)) {
      MARKET_LIST_MEMORY_CACHE[key] = cached
      return cached
    }
  } catch (e) {}
  return null
}

function writeGoodsCacheEntry(type, cityKey = MARKET_DEFAULT_CITY_KEY, regionKey = ALL_AREA_KEY, entry = {}) {
  const key = getGoodsCacheKey(type, cityKey, regionKey)
  MARKET_LIST_MEMORY_CACHE[key] = entry
  try {
    wx.setStorageSync(key, entry)
  } catch (e) {}
}

function isGoodsCacheFresh(entry, options = {}) {
  if (!entry || !entry.ts || !Array.isArray(entry.list)) return false
  if (Date.now() - Number(entry.ts) > GOODS_CACHE_FRESH_MS) return false
  const currentChangedAt = Number(options.changedAt || getMarketGoodsChangedAt()) || 0
  const cachedChangedAt = Number(entry.changedAt || 0) || 0
  return !currentChangedAt || cachedChangedAt === currentChangedAt
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
  const areaKey = Array.isArray(filters.regionKeys)
    ? getAreaCacheKey(filters.regionKeys)
    : String(filters.regionKey || ALL_AREA_KEY)
  return [
    normalizeListingType(filters.listingType),
    String(filters.category || "全部"),
    String(filters.cityKey || MARKET_DEFAULT_CITY_KEY),
    areaKey,
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

function takePostSuccessFilter() {
  try {
    const value = wx.getStorageSync(MARKET_POST_SUCCESS_FILTER_KEY)
    wx.removeStorageSync(MARKET_POST_SUCCESS_FILTER_KEY)
    if (!value || typeof value !== "object") return null
    const ts = Number(value.ts) || 0
    if (!ts || Date.now() - ts > 10 * 60 * 1000) return null
    return value
  } catch (e) {
    return null
  }
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

function getMarketViewerKey() {
  const openid = wx.getStorageSync("openid") || ""
  return openid && !wx.getStorageSync("isGuest") ? String(openid) : "guest"
}

function getMarketRequestContext() {
  return `${getMarketViewerKey()}|${getMarketGoodsChangedAt()}`
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

function normalizeMarketCityKey(key = "") {
  return String(key || "").trim().toUpperCase()
}

function buildCityPickerGroups(tree, activeCityKey = "", keyword = "", options = {}) {
  const kw = String(keyword || "").trim().toLowerCase()
  const activeKey = normalizeMarketCityKey(activeCityKey)
  const includeAll = options.includeAll !== false

  const cities = getCityOptions(tree)
    .filter(city => {
      if (!kw) return true
      return [city.key, city.label]
        .map(v => String(v || "").trim().toLowerCase())
        .some(v => v.includes(kw))
    })
    .map(city => ({
      ...city,
      className: normalizeMarketCityKey(city.key) === activeKey ? "active" : ""
    }))

  const finalCities = includeAll
    ? [{ key: "ALL", label: "全部", className: activeKey === "ALL" ? "active" : "" }, ...cities]
    : cities

  return [
    {
      title: "",
      badge: "",
      cities: finalCities
    }
  ].filter(group => group.cities.length)
}

function cityGroupsHaveResults(groups = []) {
  return groups.some(group => Array.isArray(group.cities) && group.cities.length)
}

function buildAreaUiPatch(tree, cityKey = "", activeGroupKey = "", activeAreaKey = "") {
  const normalized = normalizeRegionTree(tree)
  const state = findState(normalized, cityKey)
  const rawGroups = state && Array.isArray(state.groups) ? state.groups : []

  const selectedGroupKey = activeGroupKey || (rawGroups[0] && rawGroups[0].key) || ""
  const selectedGroup = rawGroups.find(group => group.key === selectedGroupKey)

  const groups = rawGroups.map(group => ({
    key: group.key,
    label: group.label || group.key,
    className: group.key === selectedGroupKey ? "active" : ""
  }))

  const areas = selectedGroup && Array.isArray(selectedGroup.areas)
    ? selectedGroup.areas.map(area => {
        const key = typeof area === "object"
          ? String(area.key || area.label || "").trim()
          : String(area || "").trim()
        const label = typeof area === "object"
          ? String(area.label || area.key || "").trim()
          : String(area || "").trim()
        return {
          key,
          label,
          className: key === activeAreaKey ? "active" : ""
        }
      }).filter(item => item.key && item.label)
    : []

  return {
    areaGroupOptions: groups,
    activeAreaGroupKey: selectedGroupKey,
    activeAreaGroupLabel: selectedGroup ? (selectedGroup.label || selectedGroup.key) : "",
    areaOptions: areas
  }
}

function getAreaSelectionMeta(tree, cityKey = "", groupKey = "", areaKey = "") {
  if (!cityKey || cityKey === "ALL") {
    return {
      cityKey: "ALL",
      cityLabel: "全部",
      groupKey: "",
      groupLabel: "",
      areaKey: ALL_AREA_KEY,
      areaLabel: ALL_AREA_LABEL,
      filterRegionKeys: []
    }
  }

  const city = getCitySnapshot(tree, cityKey)
  const cityLabel = city?.label || cityKey
  const patch = buildAreaUiPatch(tree, cityKey, groupKey, areaKey)
  const groupLabel = patch.activeAreaGroupLabel || groupKey || ""
  const area = (patch.areaOptions || []).find(item => item.key === areaKey)
  const areaLabel = area?.label || ""

  return {
    cityKey,
    cityLabel,
    groupKey: patch.activeAreaGroupKey || groupKey || "",
    groupLabel,
    areaKey: areaKey || ALL_AREA_KEY,
    areaLabel: areaLabel || ALL_AREA_LABEL,
    filterRegionKeys: areaKey ? [areaKey] : []
  }
}

function getStoredMarketCitySnapshot(tree) {
  const fallback = { key: "ALL", label: "全部", aliases: [] }

  try {
    const stored = wx.getStorageSync(MARKET_CITY_STORAGE_KEY)
    if (!stored || !stored.key) return fallback

    const key = normalizeMarketCityKey(stored.key)
    if (!key || key === "ALL") return fallback

    // 优先用云端缓存树校验，避免旧缓存里的 ny_nj / 无效 key 继续生效
    const cachedTree = readCachedRegionTree()
    const regionTree = normalizeRegionTree(cachedTree || tree || DEFAULT_REGION_TREE)
    const snapshot = getCitySnapshot(regionTree, key)

    return snapshot && snapshot.key ? snapshot : fallback
  } catch (e) {
    return fallback
  }
}

function setStoredMarketCitySnapshot(snapshot = {}) {
  try {
    wx.setStorageSync(MARKET_CITY_STORAGE_KEY, snapshot)
  } catch (e) {}
}

function formatShortDateText(value) {
  const text = String(value || "").trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return text
  return `${match[2]}-${match[3]}`
}

function timestampMs(value) {
  if (!value) return 0
  if (typeof value === "number") return Number.isFinite(value) ? value : 0
  if (value instanceof Date) return value.getTime()
  if (typeof value === "string") {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : 0
  }
  if (typeof value === "object") {
    if (typeof value.toDate === "function") return value.toDate().getTime()
    if (value.$date) return timestampMs(value.$date)
    if (value.seconds !== undefined) return Number(value.seconds) * 1000
    if (value._seconds !== undefined) return Number(value._seconds) * 1000
  }
  return 0
}

function buildSubletStartText(item = {}) {
  const startText = formatShortDateText(item.availableStartDate || item.pickupStartDate)
  if (!startText) return normalizeSubletCategory(item.roomType || item.category) || "转租"
  return `${startText}起`
}

function compactMarketText(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function buildItemRegionAreaText(item = {}) {
  return compactMarketText(
    item.regionDisplay ||
    item.regionArea ||
    item.location?.regionArea ||
    item.location?.areaLabel ||
    item.region ||
    ""
  )
}

function buildSubletDescText(item = {}) {
  const desc = compactMarketText(item.desc || item.description)
  if (desc) return desc
  const type = normalizeSubletCategory(item.roomType || item.category)
  const region = compactMarketText(item.region)
  return [type, region].filter(Boolean).join(" · ") || "房源信息待补充"
}

function buildSubletMetaText(item = {}) {
  const type = normalizeSubletCategory(item.roomType || item.category)
  const area = buildItemRegionAreaText(item)
  if (type && area && type !== area) return `${type} · ${area}`
  return type || area || "转租房源"
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
    priceText: String(ad.priceText || "").trim(),
    cardDescText: String(ad.subtitle || "").trim(),
    cardMetaText: String(ad.ctaText || "查看").trim() || "查看",
    sellerRoleText: "推荐",
    sellerNameText: "校园推荐",
    sellerAvatar: "/images/profile.png",
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
    marketSearchRowStyle: "",

    activeListingType: "goods",
    searchPlaceholder: LISTING_TYPE_CONFIG.goods.searchPlaceholder,
    emptyTitle: LISTING_TYPE_CONFIG.goods.emptyTitle,
    emptySubtitle: LISTING_TYPE_CONFIG.goods.emptySubtitle,

    // Filters
    keyword: "",
    activeCategory: "全部",
    activeRegion: "ALL",
    activeRegionLabel: "全部",
    activeRegionShortLabel: "全部",
    activeCityKey: "ALL",
    activeCityLabel: "全部",
    activeCityAliases: [],
    priceSortLabel: "默认",
    distanceSortLabel: "按时间",
    activeAreaKey: ALL_AREA_KEY,
    activeAreaKeys: [],
    activeAreaLabel: ALL_AREA_LABEL,
    activeAreaStateKey: "NY",
    activeAreaSectionKey: ALL_AREA_KEY,
    resultTitle: LISTING_TYPE_CONFIG.goods.resultTitle,
    resultCountText: `0 ${LISTING_TYPE_CONFIG.goods.resultUnit}`,
    regions: ["全部"],
    categories: ["全部", ...LISTING_TYPE_CONFIG.goods.categories],
    categoryTabs: buildCategoryTabs(["全部", ...LISTING_TYPE_CONFIG.goods.categories], "全部"),
    categoryPickerVisible: false,
    skeletonItems: [0, 1, 2, 3],

    regionTree: normalizeRegionTree(DEFAULT_REGION_TREE),

    cityPickerGroups: buildCityPickerGroups(DEFAULT_REGION_TREE, "ALL", "", { includeAll: true }),
    cityPickerVisible: false,
    citySearchKeyword: "",
    cityPickerHasResults: true,
    cityPickerEmptyText: "没有找到相关地区",
    
    areaPickerVisible: false,
    areaPickerTitle: "选择区域",
    areaGroupOptions: [],
    activeAreaGroupKey: "",
    activeAreaGroupLabel: "",
    areaOptions: [],

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

  _buildListFilters() {
    const cityKey = this.data.activeCityKey || "ALL"
    const isAllCity = !cityKey || cityKey === "ALL"
  
    const areaSelected = Array.isArray(this.data.activeAreaKeys) && this.data.activeAreaKeys.length > 0
  
    return {
      listingType: this.data.activeListingType,
      category: this.data.activeCategory,
  
      // 左上角大区域筛选：商品记录里的 regionState
      regionState: isAllCity ? "" : cityKey,
  
      // 兼容旧 marketApi 可能还在读 cityKey
      cityKey,
      cityLabel: this.data.activeCityLabel || "全部",
      cityAliases: this.data.activeCityAliases || [],
  
      // 右下角区域筛选：商品记录里的 regionCounty + regionArea
      regionCounty: areaSelected ? (this.data.activeAreaGroupLabel || "") : "",
      regionArea: areaSelected ? (this.data.activeAreaLabel || "") : "",
  
      // 兼容旧字段
      regionKey: this.data.activeAreaKey || ALL_AREA_KEY,
      regionKeys: this.data.activeAreaKeys || [],
      regionLabel: this.data.activeAreaLabel || ALL_AREA_LABEL,
  
      keyword: this.data.keyword
    }
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

  _getTopMetrics() {
    let info = {}
    try {
      info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    } catch (e) {
      info = {}
    }

    let navRightReserve = 12
    try {
      const menu = wx.getMenuButtonBoundingClientRect()
      const windowWidth = info.windowWidth || info.screenWidth || 0
      if (menu && windowWidth && menu.left) {
        navRightReserve = Math.max(navRightReserve, windowWidth - menu.left + 8)
      }
    } catch (e) {
    }

    return {
      statusBarHeight: info.statusBarHeight || this._getStatusBarHeight(),
      marketSearchRowStyle: `padding-right: ${navRightReserve}px;`
    }
  },

  _startMarketBootstrap(args = this._marketBootstrapArgs || {}) {
    if (this._marketBootstrapStarted) return
    this._marketBootstrapStarted = true
    const initialCategory = args.initialCategory || ""
    const initialCity = args.initialCity || "ALL"
    const initialType = args.initialType || getStoredListingType()
    Promise.resolve()
      .then(() => this._bootstrapMarketData(initialCategory, initialCity, initialType))
      .catch(e => {
        this._marketBootstrapStarted = false
        console.error("[market] bootstrap failed:", e)
        showDataError("市场加载失败", e, "市场列表从数据库加载失败，请稍后重试。")
      })
  },

  _applyListingTypeUi(type, options = {}) {
    const listingType = normalizeListingType(type)
    const config = getListingTypeConfig(listingType)
    const categories = ["全部", ...config.categories]
    const requestedCategory = options.category || this.data.activeCategory || "全部"
    const activeCategory = categories.includes(requestedCategory) ? requestedCategory : "全部"

    this.setData({
      activeListingType: listingType,
      searchPlaceholder: config.searchPlaceholder,
      emptyTitle: config.emptyTitle,
      emptySubtitle: config.emptySubtitle,
      categories,
      activeCategory,
      categoryTabs: buildCategoryTabs(categories, activeCategory)
    })
  },

  _applyCityUi(cityKey = "ALL", options = {}) {
    const regionTree = normalizeRegionTree(options.regionTree || this.data.regionTree || DEFAULT_REGION_TREE)
    const normalizedKey = normalizeMarketCityKey(cityKey || "ALL")
  
    if (normalizedKey === "ALL") {
      const snapshot = { key: "ALL", label: "全部", aliases: [] }
      this.setData({
        regionTree,
        activeCityKey: "ALL",
        activeCityLabel: "全部",
        activeCityAliases: [],
        activeRegion: "ALL",
        activeRegionLabel: "全部",
        activeRegionShortLabel: "全部",
        cityPickerGroups: buildCityPickerGroups(regionTree, "ALL", options.keyword || "", { includeAll: true }),
        cityPickerHasResults: true,
        citySearchKeyword: options.keyword || ""
      })
      setStoredMarketCitySnapshot(snapshot)
      return snapshot
    }
  
    const snapshot = getCitySnapshot(regionTree, normalizedKey)

    if (!snapshot || !snapshot.key) {
      return this._applyCityUi("ALL", {
        ...options,
        regionTree
      })
    }

    const citySearchKeyword = typeof options.keyword === "string" ? options.keyword : (this.data.citySearchKeyword || "")
  
    this.setData({
      regionTree,
      activeCityKey: snapshot.key,
      activeCityLabel: snapshot.label,
      activeCityAliases: snapshot.aliases || [],
      activeRegion: snapshot.key,
      activeRegionLabel: snapshot.label,
      activeRegionShortLabel: snapshot.label,
      cityPickerGroups: buildCityPickerGroups(regionTree, snapshot.key, citySearchKeyword, { includeAll: true }),
      cityPickerHasResults: cityGroupsHaveResults(buildCityPickerGroups(regionTree, snapshot.key, citySearchKeyword, { includeAll: true })),
      citySearchKeyword
    })
  
    setStoredMarketCitySnapshot(snapshot)
    return snapshot
  },

  _applyAreaUi(areaKey = ALL_AREA_KEY, options = {}) {
    const regionTree = normalizeRegionTree(options.regionTree || this.data.regionTree || DEFAULT_REGION_TREE)
    const cityKey = options.cityKey || this.data.activeCityKey || "ALL"
    const groupKey = options.groupKey || this.data.activeAreaGroupKey || ""
    const finalAreaKey = areaKey === ALL_AREA_KEY ? "" : areaKey
  
    const patch = cityKey && cityKey !== "ALL"
      ? buildAreaUiPatch(regionTree, cityKey, groupKey, finalAreaKey)
      : { areaGroupOptions: [], activeAreaGroupKey: "", activeAreaGroupLabel: "", areaOptions: [] }
  
    const area = (patch.areaOptions || []).find(item => item.key === finalAreaKey)
    const activeAreaLabel = area ? area.label : ALL_AREA_LABEL
  
    this.setData({
      regionTree,
      activeAreaKey: finalAreaKey || ALL_AREA_KEY,
      activeAreaKeys: finalAreaKey ? [finalAreaKey] : [],
      activeAreaLabel,
      ...patch
    })
  },

  _resetGoodsStateForFetch(extra = {}) {
    this._lastCompletedFirstPage = null
    const next = {
      allGoods: [],
      filteredGoods: [],
      displayGoods: [],
      displayFeed: [],
      cloudSkip: 0,
      cloudHasMore: true,
      canViewMore: false,
      ...extra
    }
    this.setData({
      ...next,
      ...buildMarketListFlags({ ...this.data, ...next })
    })
  },

  _getCurrentListQueryKey() {
    return buildListQueryKey({
      listingType: this.data.activeListingType,
      category: this.data.activeCategory,
      cityKey: this.data.activeCityKey || MARKET_DEFAULT_CITY_KEY,
      regionKey: this.data.activeAreaKey || ALL_AREA_KEY,
      regionKeys: this.data.activeAreaKeys || [],
      keyword: this.data.keyword
    }, this._buildListSort())
  },

  _isActiveGoodsRequest(requestToken, requestKey) {
    return this._activeGoodsRequestToken === requestToken &&
      this._getCurrentListQueryKey() === requestKey &&
      this._activeGoodsRequestContext === getMarketRequestContext()
  },

  _isCurrentListQuery(requestKey) {
    return this._getCurrentListQueryKey() === requestKey
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
    return {
      priceSortOrder: "none",
      priceSortLabel: "默认",
      distanceSortActive: false,
      distanceSortClass: "",
      distanceSortLabel: "按时间"
    }
  },

  _applyPostSuccessFilter(filter = {}) {
    const listingType = normalizeListingType(filter.listingType)
  
    // 发布成功回来以后，不使用新商品自己的 cityKey。
    // 左上角大地区优先沿用用户之前选择的缓存；没有缓存就默认 ALL。
    const storedCity = getStoredMarketCitySnapshot(this.data.regionTree || DEFAULT_REGION_TREE)
    const cityKey = storedCity.key || "ALL"
  
    setStoredListingType(listingType)
    this._userSortTouched = false
    this._applyListingTypeUi(listingType, { category: "全部" })
  
    const snapshot = this._applyCityUi(cityKey)
    this._applyAreaUi(ALL_AREA_KEY, { cityKey: snapshot.key })
  
    this._resetGoodsStateForFetch({
      keyword: "",
      ...this._getDefaultSortPatch()
    })
  
    this.updateMarketHeaderState(0)
    this._lastHandledGoodsChangeAt = getMarketGoodsChangedAt()
    this._fetchFirstPage({ force: true, reason: "postSuccess" })
  },

  _switchListingType(type, options = {}) {
    const listingType = normalizeListingType(type)
    const prevType = this.data.activeListingType || "goods"
    const force = !!options.force
    if (!force && listingType === prevType) {
      setStoredListingType(listingType)
      if (this._marketBootstrapped) {
        this._fetchFirstPage({ force: true, reason: "sameTypeRefresh" })
        this._loadMarketAds()
      } else {
        this._marketBootstrapArgs = {
          ...(this._marketBootstrapArgs || {}),
          initialType: listingType
        }
        this._startMarketBootstrap()
      }
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

    if (!this._marketBootstrapped && !options.allowBeforeBootstrap) {
      this._marketBootstrapArgs = {
        ...(this._marketBootstrapArgs || {}),
        initialType: listingType,
        initialCategory: options.category || "全部"
      }
      this._startMarketBootstrap()
      return
    }

    const cacheState = this._restoreGoodsFromCache()
    if (cacheState.restored) this.applyFilters(true)
    this._fetchFirstPage({
      force: true,
      reason: cacheState.restored ? "switchRefresh" : "switchType"
    })
    this._loadMarketAds()
  },

  onShareAppMessage() {
    const { activeCategory = '', activeCityKey = MARKET_DEFAULT_CITY_KEY, activeListingType = 'goods' } = this.data
    const config = getListingTypeConfig(activeListingType)

    const qs = []
    if (activeListingType !== "goods") qs.push(`type=${encodeURIComponent(activeListingType)}`)
    if (activeCategory && activeCategory !== "全部") qs.push(`cat=${encodeURIComponent(activeCategory)}`)
    if (activeCityKey && activeCityKey !== MARKET_DEFAULT_CITY_KEY) qs.push(`city=${encodeURIComponent(activeCityKey)}`)

    const path = `/pages/market/market${qs.length ? `?${qs.join('&')}` : ''}`

    return getApp().withReferralShare({
      title: `${config.label}｜看看有没有你想要的`,
      path
    })
  },

  onShareTimeline() {
    const { activeCategory = '', activeCityKey = MARKET_DEFAULT_CITY_KEY, activeListingType = 'goods' } = this.data
    const config = getListingTypeConfig(activeListingType)
    const qs = []
    if (activeListingType !== "goods") qs.push(`type=${encodeURIComponent(activeListingType)}`)
    if (activeCategory && activeCategory !== "全部") qs.push(`cat=${encodeURIComponent(activeCategory)}`)
    if (activeCityKey && activeCityKey !== MARKET_DEFAULT_CITY_KEY) qs.push(`city=${encodeURIComponent(activeCityKey)}`)

    return getApp().withReferralShare({
      title: `${config.label}｜看看有没有你想要的`,
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
      distanceSortLabel: '按时间'
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
      distanceSortClass: next ? "active" : "",
      priceSortOrder: next ? "none" : this.data.priceSortOrder,
      priceSortLabel: next ? "默认" : this.data.priceSortLabel,
      distanceSortLabel: next ? "按距离" : "按时间"
    })
    this._resetGoodsStateForFetch()
    this._fetchFirstPage({ force: true, reason: next ? "distanceSort" : "distanceSortOff" })
  },

  onLoad(options = {}) {
    const initialCategory = options.cat ? safeDecode(options.cat) : ""
    const initialCity = options.city ? safeDecode(options.city) : ""
    const initialType = options.type || options.listingType || getStoredListingType()
    const storedCity = getStoredMarketCitySnapshot(DEFAULT_REGION_TREE)

    this.setData(this._getTopMetrics())
    this._applyListingTypeUi(initialType, { category: initialCategory || "全部" })
    this._applyCityUi(initialCity || storedCity.key || "ALL")

    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })

    try {
      this._thumbUrlCache = normalizeObjectCache(wx.getStorageSync(THUMB_CACHE_KEY))
    } catch (e) {
      this._thumbUrlCache = {}
    }
    this._lastRefreshAt = 0
    this._lastHandledGoodsChangeAt = getMarketGoodsChangedAt()
    this._marketViewerKey = getMarketViewerKey()
    this._marketBootstrapped = false
    this._marketBootstrapStarted = false
    this._userSortTouched = false
    this._sellerProfileCache = {}
    this._marketAdSessionSeed = `${Date.now()}_${Math.random().toString(16).slice(2)}`
    this._marketBootstrapArgs = {
      initialCategory,
      initialCity: initialCity || storedCity.key || "ALL",
      initialType
    }

    this._startMarketBootstrap()
  },

  async onShow() {
    const viewerKey = getMarketViewerKey()
    const viewerChanged = this._marketViewerKey !== viewerKey
    this._marketViewerKey = viewerKey
    if (!this._marketBootstrapped) {
      this._startMarketBootstrap()
      return
    }

    const postFilter = takePostSuccessFilter()
    if (postFilter) {
      this._applyPostSuccessFilter(postFilter)
      return
    }

    const storedType = getStoredListingType()
    if (storedType !== this.data.activeListingType) {
      this._switchListingType(storedType, { force: true })
      return
    }

    let locationState = null
    if (this.data.distanceSortActive || viewerChanged) {
      locationState = await this._loadMyLocationFromProfile({
        force: viewerChanged,
        applyDefaultSort: false
      })
    }
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
    return this._fetchFirstPage({ force: viewerChanged, reason: viewerChanged ? "viewerChanged" : "showRefresh" })
  },

  async _bootstrapMarketData(initialCategory = "", initialCity = "ALL", initialType = "goods") {
    this._marketBootstrapped = true

    this._applyListingTypeUi(initialType, { category: initialCategory || "全部" })
    this._applyCityUi(initialCity || "ALL")

    this.loadRegionTreeFromCloud()

    const cacheState = this._restoreGoodsFromCache()
    if (cacheState.restored) this.applyFilters(true)
    this._loadMarketAds()

    this._fetchFirstPage({
      force: true,
      reason: cacheState.restored ? "bootstrapRefresh" : "bootstrapLoad"
    })

    this._loadMyLocationFromProfile({ applyDefaultSort: false }).then(locationState => {
      if (this.data.distanceSortActive && (locationState?.sortChanged || locationState?.locationChanged)) {
        this._resetGoodsStateForFetch()
        this._fetchFirstPage({ force: true, reason: "locationReady" })
      }
    }).catch(() => {})
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
    this._resetGoodsStateForFetch()
    await this._fetchFirstPage({ force: true, reason: "search" })
  },

  onClearKeyword() {
    if (!this.data.keyword) return
    this._resetGoodsStateForFetch({ keyword: "" })
    this._fetchFirstPage({ force: true, reason: "clearKeyword" })
  },

  onResetMarketFilters() {
    this._userSortTouched = false
  
    this._applyAreaUi(ALL_AREA_KEY, {
      cityKey: this.data.activeCityKey || "ALL"
    })
  
    this._resetGoodsStateForFetch({
      keyword: "",
      activeCategory: "全部",
      categoryTabs: buildCategoryTabs(this.data.categories, "全部"),
      categoryPickerVisible: false,
      areaPickerVisible: false,
      ...this._getDefaultSortPatch()
    })
  
    this.updateMarketHeaderState(0)
    this._fetchFirstPage({ force: true, reason: "resetFilters" })
  },

  onOpenCategoryPicker() {
    this.setData({ categoryPickerVisible: true })
  },

  onCategoryPickerCancel() {
    this.setData({ categoryPickerVisible: false })
  },

  onOpenAreaPicker() {
    if (!this.data.activeCityKey || this.data.activeCityKey === "ALL") {
      wx.showToast({
        title: "请先选择左上角的地区",
        icon: "none"
      })
      return
    }
  
    const regionTree = this.data.regionTree || DEFAULT_REGION_TREE
    const patch = buildAreaUiPatch(
      regionTree,
      this.data.activeCityKey,
      this.data.activeAreaGroupKey || "",
      this.data.activeAreaKey === ALL_AREA_KEY ? "" : this.data.activeAreaKey
    )
  
    this.setData({
      areaPickerVisible: true,
      areaPickerTitle: `选择${this.data.activeCityLabel}区域`,
      ...patch
    })
  },
  
  onAreaPickerCancel() {
    this.setData({ areaPickerVisible: false })
  },
  
  onSelectAreaState(e) {
    const key = String(e.currentTarget.dataset.key || "").trim()
    if (!key) return
  
    const patch = buildAreaUiPatch(
      this.data.regionTree || DEFAULT_REGION_TREE,
      this.data.activeCityKey,
      key,
      ""
    )
  
    this.setData({
      activeAreaGroupKey: key,
      activeAreaGroupLabel: patch.activeAreaGroupLabel || key,
      activeAreaKey: ALL_AREA_KEY,
      activeAreaKeys: [],
      activeAreaLabel: ALL_AREA_LABEL,
      ...patch
    })
  },
  
  async onSelectArea(e) {
    const key = String(e.currentTarget.dataset.key || "").trim()
    if (!key) return
  
    const area = (this.data.areaOptions || []).find(item => item.key === key)
    if (!area) return
  
    const areaOptions = (this.data.areaOptions || []).map(item => ({
      ...item,
      className: item.key === key ? "active" : ""
    }))
  
    this._resetGoodsStateForFetch({
      activeAreaKey: key,
      activeAreaKeys: [key],
      activeAreaLabel: area.label,
      areaPickerVisible: false,
      areaOptions
    })
  
    this.updateMarketHeaderState(0)
  
    const cacheState = this._restoreGoodsFromCache()
    if (cacheState.restored) this.applyFilters(true)
  
    await this._fetchFirstPage({ force: true, reason: `area:${key}` })
  },

  async onSelectCat(e) {
    const cat = e.currentTarget.dataset.cat

    this._resetGoodsStateForFetch({
      activeCategory: cat || "全部",
      categoryTabs: buildCategoryTabs(this.data.categories, cat || "全部"),
      categoryPickerVisible: false
    })
    this.updateMarketHeaderState(0)
    await this._fetchFirstPage({ force: true, reason: "category" })
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
    this._preloadMarketDetail(id)
    wx.navigateTo({ url: `/pages/market/marketDetail/marketDetail?id=${id}` })
  },

  onTapSeller(e) {
    const managed = e.currentTarget.dataset.managed
    if (managed === true || managed === "true") {

      wx.showToast({ title: "代发信息以详情为准", icon: "none" })

      wx.showToast({ title: "无信息", icon: "none" })

      return
    }
    const openid = e.currentTarget.dataset.openid
    const type = e.currentTarget.dataset.type || this.data.activeListingType || "goods"
    if (!openid) return
    wx.navigateTo({
      url: `/pages/market/marketSeller/marketSeller?openid=${encodeURIComponent(openid)}&type=${normalizeListingType(type)}`
    })
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

  async loadRegionTreeFromCloud(options = {}) {
    if (!options.force) {
      const cached = readCachedRegionTree()
      if (cached) {
        const tree = normalizeRegionTree(cached)
  
        this._applyCityUi(this.data.activeCityKey || "ALL", {
          regionTree: tree
        })
  
        this._applyAreaUi(this.data.activeAreaKey || ALL_AREA_KEY, {
          regionTree: tree,
          cityKey: this.data.activeCityKey || "ALL"
        })
  
        return tree
      }
    }
  
    try {
      const { tree, fromCloud } = await loadRegionTreeConfig({
        useCache: false
      })
  
      const normalized = normalizeRegionTree(tree)
  
      if (fromCloud) {
        writeCachedRegionTree(normalized)
      }
  
      this._applyCityUi(this.data.activeCityKey || "ALL", {
        regionTree: normalized
      })
  
      this._applyAreaUi(this.data.activeAreaKey || ALL_AREA_KEY, {
        regionTree: normalized,
        cityKey: this.data.activeCityKey || "ALL"
      })
  
      return normalized
  
    } catch (e) {
      console.error("REGION_TREE 加载失败：", e)
  
      const fallback = normalizeRegionTree(DEFAULT_REGION_TREE)
  
      this._applyCityUi(this.data.activeCityKey || "ALL", {
        regionTree: fallback
      })
  
      this._applyAreaUi(this.data.activeAreaKey || ALL_AREA_KEY, {
        regionTree: fallback,
        cityKey: this.data.activeCityKey || "ALL"
      })
  
      return fallback
    }
  },

  onTapRegion() {
    const regionTree = this.data.regionTree || DEFAULT_REGION_TREE
    const cityPickerGroups = buildCityPickerGroups(
      regionTree,
      this.data.activeCityKey || "ALL",
      "",
      { includeAll: true }
    )
  
    this.setData({
      cityPickerVisible: true,
      citySearchKeyword: "",
      cityPickerGroups,
      cityPickerHasResults: cityGroupsHaveResults(cityPickerGroups)
    })
  },
  
  onCityPickerCancel() {
    this.setData({ cityPickerVisible: false, citySearchKeyword: "" })
  },
  
  onCitySearchInput(e) {
    const keyword = (e.detail && e.detail.value) || ""
    const regionTree = this.data.regionTree || DEFAULT_REGION_TREE
    const cityPickerGroups = buildCityPickerGroups(
      regionTree,
      this.data.activeCityKey || "ALL",
      keyword,
      { includeAll: true }
    )
  
    this.setData({
      citySearchKeyword: keyword,
      cityPickerGroups,
      cityPickerHasResults: cityGroupsHaveResults(cityPickerGroups)
    })
  },
  
  async onSelectCity(e) {
    const key = normalizeMarketCityKey(e.currentTarget.dataset.key || "ALL")
    const snapshot = this._applyCityUi(key)
  
    this._applyAreaUi(ALL_AREA_KEY, {
      cityKey: snapshot.key
    })
  
    this._resetGoodsStateForFetch({
      cityPickerVisible: false,
      citySearchKeyword: "",
      areaPickerVisible: false
    })
  
    this.updateMarketHeaderState(0)
  
    const cacheState = this._restoreGoodsFromCache()
    if (cacheState.restored) this.applyFilters(true)
  
    await this._fetchFirstPage({ force: true, reason: `city:${snapshot.key}` })
  },

  // ====== 核心：映射商品（✅缩略图优先）======
  _mapDocToGood(x) {
    const listingType = normalizeListingType(x.listingType)
    const config = getListingTypeConfig(listingType)
    const isSublet = listingType === "sublet"
    const thumbKey = (x.thumbFileID || x.imageFileID || "")
    const hasImage = !!(x.hasImage || x.imageFileID || x.thumbFileID || (Array.isArray(x.imageFileIDs) && x.imageFileIDs.length))
    const title = String(x.title || "").trim() || (isSublet ? "未命名房源" : "未命名商品")
    const priceNumber = Number(x.price)
    const basePriceText = Number.isFinite(priceNumber) ? priceNumber.toFixed(priceNumber % 1 === 0 ? 0 : 2) : "0"
    const category = isSublet
      ? (normalizeSubletCategory(x.category || x.roomType) || "其他")
      : (config.categories.includes(x.category) ? x.category : "其他")
    const displayItem = isSublet ? { ...x, category, roomType: category } : x
    const priceText = isSublet ? `${basePriceText}/月` : basePriceText
    const conditionText = isSublet
      ? buildSubletStartText(displayItem)
      : (x.condition || "成色未填")
    const fallbackImage = isSublet ? "/images/sublease.png" : "/images/market.png"
    const thumbCache = normalizeObjectCache(this._thumbUrlCache)
    this._thumbUrlCache = thumbCache
    const cachedThumbUrl = thumbKey ? (thumbCache[thumbKey] || "") : ""
    const rawImageSrc = compactMarketText(x.imageSrc)
    const imageSrc = x.thumbUrl || cachedThumbUrl || (rawImageSrc && rawImageSrc !== fallbackImage ? rawImageSrc : "") || fallbackImage
    const regionShortText = buildItemRegionAreaText(x)
    const buildingNameText = compactMarketText(x.buildingName || x.location?.buildingName)
    const cardDescText = isSublet
      ? buildSubletDescText(displayItem)
      : compactMarketText(x.desc || x.condition || "卖家暂未填写描述")
    const cardMetaText = isSublet
      ? buildSubletMetaText(displayItem)
      : (compactMarketText(x.condition) || category || "二手")
    const isManagedSeller = x.managedByAdmin === true
    const sellerNameText = compactMarketText(x.sellerName || x.nickName || x.nickname) || (isSublet ? "转租发布者" : "二手卖家")
    const sellerAvatar = compactMarketText(x.sellerAvatar || x.avatarUrl) || "/images/profile.png"
    return this._withDistance({
      id: x._id,
      _openid: x._openid,
      managedByAdmin: isManagedSeller,
      sellerWechat: x.sellerWechat || "",
      sellerPhone: x.sellerPhone || "",
      listingType,
      isSublet,
      cardClass: isSublet ? "market-card--sublet" : "market-card--goods",
      title,
      price: x.price,
      priceText,
      category,
      roomType: isSublet ? category : x.roomType,
      region: x.region,
      regionState: x.regionState || x.location?.regionState || "",
      regionCounty: x.regionCounty || x.location?.regionCounty || "",
      regionArea: x.regionArea || x.location?.regionArea || x.location?.areaLabel || "",
      regionKey: x.regionKey || x.location?.regionKey || "",
      regionDisplay: x.regionDisplay || x.region || "",
      buildingName: buildingNameText,
      buildingNameText,
      location: x.location || {},
      condition: conditionText,
      conditionText,
      desc: x.desc,
      cardDescText,
      cardMetaText,
      regionShortText,
      sellerRoleText: isSublet ? "发布者" : "卖家",
      sellerNameText,
      sellerAvatar,
      viewCount: Number(x.viewCount) || 0,
      createTime: x.createTime,
      updateTime: x.updateTime,
      imageFileID: x.imageFileID || "",
      thumbFileID: x.thumbFileID || "",
      imageFileIDs: Array.isArray(x.imageFileIDs) ? x.imageFileIDs : [],
      thumbFileIDs: Array.isArray(x.thumbFileIDs) ? x.thumbFileIDs : [],
      hasImage,
      pickupStartDate: x.pickupStartDate || "",
      pickupEndDate: x.pickupEndDate || x.expiresAtText || "",
      pickupRangeText: x.pickupRangeText || "",
      expireTime: Number(x.expireTime) || 0,
      status: x.status || "online",

      thumbUrl: x.thumbUrl || cachedThumbUrl,
      imageSrc
    })
  },

  _mapDocsToGoods(rawRows = [], context = "") {
    const rows = []
    ;(Array.isArray(rawRows) ? rawRows : []).forEach(raw => {
      try {
        if (this._isVisibleMarketDoc(raw)) rows.push(this._mapDocToGood(raw))
      } catch (e) {
        console.warn("[market] skip invalid list item:", context, raw && raw._id, e)
      }
    })
    return rows
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

  _hydrateSellerProfilesFromCache(goods = [], options = {}) {
    const rows = Array.isArray(goods) ? goods : []
    const openids = Array.from(new Set(rows
      .filter(item => !(item && item.managedByAdmin && item.sellerNameText))
      .map(item => item && item._openid)
      .filter(Boolean)))
    if (!openids.length) return rows

    this._sellerProfileCache = this._sellerProfileCache || {}
    const cachedProfiles = readMarketSellerProfiles(openids, { allowStale: true })
    Object.keys(cachedProfiles).forEach(openid => {
      const profile = cachedProfiles[openid]
      this._sellerProfileCache[openid] = {
        name: profile.nameDisplay || profile.name || "",
        avatar: profile.avatarDisplay || profile.avatarRaw || "/images/profile.png",
        isFresh: !!profile.isFresh
      }
    })

    const missing = openids.filter(openid => {
      const profile = this._sellerProfileCache[openid]
      return !profile || !profile.isFresh
    })

    if (options.refresh !== false && missing.length) {
      this._refreshSellerProfilesInBackground(missing)
    }

    return this._applySellerProfilesToRows(rows)
  },

  _applySellerProfilesToRows(rows = [], options = {}) {
    let changed = false
    const list = (Array.isArray(rows) ? rows : []).map(item => {
      if (!item || !item._openid) return item
      if (item.managedByAdmin && item.sellerNameText) return item
      const profile = this._sellerProfileCache[item._openid] || {}
      const sellerNameText = profile.name || item.sellerNameText
      const sellerAvatar = profile.avatar || item.sellerAvatar || "/images/profile.png"
      if (sellerNameText !== item.sellerNameText || sellerAvatar !== item.sellerAvatar) changed = true
      return {
        ...item,
        sellerNameText,
        sellerAvatar
      }
    })
    return options.withChanged ? { list, changed } : list
  },

  _refreshSellerProfilesInBackground(openids = []) {
    const targets = Array.from(new Set((Array.isArray(openids) ? openids : []).filter(Boolean)))
    if (!targets.length) return

    this._sellerProfileRefreshInFlight = this._sellerProfileRefreshInFlight || {}
    const todo = targets.filter(openid => !this._sellerProfileRefreshInFlight[openid])
    if (!todo.length) return
    todo.forEach(openid => { this._sellerProfileRefreshInFlight[openid] = true })

    fetchAndCacheMarketSellerProfiles(todo).then(fetched => {
      Object.keys(fetched || {}).forEach(openid => {
        const profile = fetched[openid]
        this._sellerProfileCache[openid] = {
          name: profile.nameDisplay || profile.name || "",
          avatar: profile.avatarDisplay || profile.avatarRaw || "/images/profile.png",
          isFresh: true
        }
      })

      const hydrated = this._applySellerProfilesToRows(this.data.allGoods || [], { withChanged: true })
      if (!hydrated.changed) return
      this.setData({ allGoods: hydrated.list })
      this.applyFilters(false)
    }).catch(e => {
      console.error("refresh seller profiles failed:", e)
    }).finally(() => {
      todo.forEach(openid => { delete this._sellerProfileRefreshInFlight[openid] })
    })
  },

  _getAdSeedBase(goods = []) {
    const firstIds = goods.slice(0, 8).map(item => item.id || "").join(",")
    return [
      this._marketAdSessionSeed || "",
      this.data.activeListingType,
      this.data.activeCategory,
      this.data.activeCityKey,
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
    const activeListingType = normalizeListingType(this.data.activeListingType)
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
    const normalizedAd = normalizeMarketAd(ad)
    next.splice(slot, 0, {
      ...normalizedAd,
      adListingType: activeListingType,
      adCompact: activeListingType === "goods",
      cardClass: activeListingType === "sublet" ? "market-card--sublet" : "market-card--goods"
    })
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

    const locationCacheKey = `${openid}|${JSON.stringify((wx.getStorageSync("userInfo") || {}).location || null)}`
    const cachedLocation = this._locationProfileCache
    const useCache = !options.force && cachedLocation && cachedLocation.key === locationCacheKey &&
      Date.now() - cachedLocation.at >= 0 && Date.now() - cachedLocation.at < FIRST_PAGE_FETCH_COOLDOWN_MS
    try {
      let user
      if (useCache) {
        user = cachedLocation.user
      } else {
        this._locationProfileRequests = this._locationProfileRequests || {}
        let request = this._locationProfileRequests[locationCacheKey]
        if (!request) {
          request = Promise.resolve().then(() => wx.cloud.callFunction({ name: "getUserInfo" }))
            .finally(() => {
              if (this._locationProfileRequests[locationCacheKey] === request) delete this._locationProfileRequests[locationCacheKey]
            })
          this._locationProfileRequests[locationCacheKey] = request
        }
        const res = await request
        user = (res?.result?.data || [])[0] || {}
        const currentLocationKey = `${getMarketViewerKey()}|${JSON.stringify((wx.getStorageSync("userInfo") || {}).location || null)}`
        if (currentLocationKey !== locationCacheKey) return { locationChanged: false, sortChanged: false }
        this._locationProfileCache = { key: locationCacheKey, at: Date.now(), user }
      }
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

  _requestMarketList(data, requestKey) {
    this._marketListRequests = this._marketListRequests || {}
    if (this._marketListRequests[requestKey]) return this._marketListRequests[requestKey]
    const task = Promise.resolve().then(() => wx.cloud.callFunction({ name: "marketApi", data }))
      .finally(() => {
        if (this._marketListRequests[requestKey] === task) delete this._marketListRequests[requestKey]
      })
    this._marketListRequests[requestKey] = task
    return task
  },

  _fetchFirstPage(options = {}) {
    const filters = this._buildListFilters()
    const sort = this._buildListSort()
    const requestKey = buildListQueryKey(filters, sort)
    const context = getMarketRequestContext()
    const scopedKey = `${context}|${requestKey}|first`
    const pending = this._firstPageActiveRequest
    // A forced refresh bypasses freshness, never an identical request in progress.
    if (pending && pending.key === scopedKey && this._isActiveGoodsRequest(pending.token, requestKey)) {
      return pending.promise
    }
    const recent = this._lastCompletedFirstPage
    if (!options.force && recent && recent.key === scopedKey &&
      Date.now() - recent.at >= 0 && Date.now() - recent.at < FIRST_PAGE_FETCH_COOLDOWN_MS) {
      return Promise.resolve(false)
    }

    const requestToken = this._goodsRequestSequence = (this._goodsRequestSequence || 0) + 1
    this._activeGoodsRequestToken = requestToken
    this._activeGoodsRequestContext = context
    const promise = this._loadFirstPageResult(filters, sort, requestKey, requestToken, scopedKey)
    this._firstPageActiveRequest = { key: scopedKey, token: requestToken, promise }
    return promise
  },

  async _loadFirstPageResult(filters, sort, requestKey, requestToken, scopedKey) {
    try {
      this.setData({
        isLoadingGoods: true,
        isLoadingMore: false,
        ...buildMarketListFlags({ ...this.data, isLoadingGoods: true, isLoadingMore: false })
      })

      const res = await this._requestMarketList({
        action: "list", filters, sort, skip: 0, limit: INITIAL_LOAD_SIZE, fastList: true
      }, scopedKey)
      const result = getMarketApiResult(res)
      if (!this._isActiveGoodsRequest(requestToken, requestKey)) return false

      const rawRows = result.items || result.data || []
      const rows = this._hydrateSellerProfilesFromCache(
        this._mapDocsToGoods(rawRows, "firstPage")
      )

      this.setData({
        allGoods: rows,
        cloudSkip: result.nextSkip || rawRows.length,
        cloudHasMore: !!result.hasMore
      })

      if (!sort.by && filters.category === "全部" && !String(filters.keyword || "").trim()) {
        this._saveGoodsToCache(rawRows, {
          type: filters.listingType,
          cityKey: filters.cityKey,
          regionKey: getAreaCacheKey(filters.regionKeys || filters.regionKey),
          nextSkip: result.nextSkip || rawRows.length,
          hasMore: !!result.hasMore
        })
      }

      this.initRegionsFromGoods()
      this.applyFilters(true)
      this._lastCompletedFirstPage = { key: scopedKey, at: Date.now() }
      return true
    } catch (e) {
      if (!this._isActiveGoodsRequest(requestToken, requestKey)) return false
      this._lastCompletedFirstPage = null
      console.error(e)
      showDataError("市场加载失败", e, "市场列表从数据库加载失败，请稍后重试。")
      return false
    } finally {
      if (this._firstPageActiveRequest?.token === requestToken) this._firstPageActiveRequest = null
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
    const filters = this._buildListFilters()
    const sort = this._buildListSort()
    const requestKey = buildListQueryKey(filters, sort)
    const requestToken = this._goodsRequestSequence = (this._goodsRequestSequence || 0) + 1
    this._activeGoodsRequestToken = requestToken
    this._activeGoodsRequestContext = getMarketRequestContext()

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
          limit: CLOUD_PAGE_SIZE,
          fastList: true
        }
      })
      const result = getMarketApiResult(res)
      if (!this._isActiveGoodsRequest(requestToken, requestKey)) return false

      const rawBatch = result.items || result.data || []
      const batch = this._hydrateSellerProfilesFromCache(
        this._mapDocsToGoods(rawBatch, "nextPage")
      )
      const all = [...(this.data.allGoods || []), ...batch]

      this.setData({
        allGoods: all,
        cloudSkip: result.nextSkip || (skip + rawBatch.length),
        cloudHasMore: !!result.hasMore
      })

      if (!sort.by && filters.category === "全部" && !String(filters.keyword || "").trim()) {
        const regionCacheKey = getAreaCacheKey(filters.regionKeys || filters.regionKey)
        const cached = readGoodsCacheEntry(filters.listingType, filters.cityKey, regionCacheKey) || {}
        this._saveGoodsToCache([...(cached.list || []), ...rawBatch], {
          type: filters.listingType,
          cityKey: filters.cityKey,
          regionKey: regionCacheKey,
          nextSkip: result.nextSkip || (skip + rawBatch.length),
          hasMore: !!result.hasMore
        })
      }

      this.initRegionsFromGoods()
      this.applyFilters(resetPagingAfterAppend, { minDisplayCount })
      return true
    } catch (e) {
      if (!this._isActiveGoodsRequest(requestToken, requestKey)) return false
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
    if (!(this.data.displayGoods || []).length && !(this.data.filteredGoods || []).length) return

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
    this._preloadMarketDetails(next)
  },

  // ====== 展示侧过滤/排序（云端已筛选，这里只做排序 + 前端切片）======
  applyFilters(resetPaging = false, options = {}) {
    const { allGoods, pageSize } = this.data
    const minDisplayCount = Math.max(0, Number(options.minDisplayCount) || 0)
    const activeListingType = normalizeListingType(this.data.activeListingType)

    const selectedState = this.data.activeCityKey || "ALL"
    const selectedCounty = this.data.activeAreaGroupLabel || ""
    const selectedArea = this.data.activeAreaLabel || ""
    
    const filtered = [...(allGoods || [])].filter(item => {
      if (normalizeListingType(item && item.listingType) !== activeListingType) return false
    
      if (selectedState && selectedState !== "ALL") {
        const itemState = String(item.regionState || item.location?.regionState || "").trim().toUpperCase()
        if (itemState !== String(selectedState).trim().toUpperCase()) return false
      }
    
      if (this.data.activeAreaKeys && this.data.activeAreaKeys.length) {
        const itemCounty = String(item.regionCounty || item.location?.regionCounty || "").trim()
        const itemArea = String(item.regionArea || item.location?.regionArea || item.location?.areaLabel || "").trim()
        const itemRegionText = String(item.regionDisplay || item.region || "").trim()
      
        if (selectedCounty && itemCounty && itemCounty !== selectedCounty) return false
      
        if (selectedArea && selectedArea !== ALL_AREA_LABEL) {
          const matchedArea =
            itemArea === selectedArea ||
            itemRegionText.includes(selectedArea)
      
          if (!matchedArea) return false
        }
      }
    
      return true
    })

    // sort（必须在 slice 前做）
    if (this.data.distanceSortActive) {
      filtered.sort((a, b) => {
        const da = Number.isFinite(a.distanceMiles) ? a.distanceMiles : Number.POSITIVE_INFINITY
        const db = Number.isFinite(b.distanceMiles) ? b.distanceMiles : Number.POSITIVE_INFINITY
        if (da !== db) return da - db
        return timestampMs(b.createTime) - timestampMs(a.createTime)
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

    this._fillThumbUrlsFor(display, this._getCurrentListQueryKey()).catch(() => {})
  },

  updateMarketHeaderState(count) {
    const activeCategory = this.data.activeCategory || "全部"
    const activeCityLabel = this.data.activeCityLabel || MARKET_DEFAULT_CITY_LABEL
    const config = getListingTypeConfig(this.data.activeListingType)
    this.setData({
      resultTitle: activeCategory === "全部" ? config.resultTitle : activeCategory,
      resultCountText: `${Number(count) || 0} ${config.resultUnit}`,
      activeRegionLabel: activeCityLabel,
      activeRegionShortLabel: activeCityLabel
    })
  },

  // ====== thumb temp url ======
  async _fillThumbUrlsFor(goodsList, stateKey = "") {
    this._thumbUrlCache = normalizeObjectCache(this._thumbUrlCache)
    const list = goodsList || []
    const collectFileIDs = (g = {}) => {
      const id = g.thumbFileID ||
        g.imageFileID ||
        (Array.isArray(g.thumbFileIDs) ? g.thumbFileIDs[0] : "") ||
        (Array.isArray(g.imageFileIDs) ? g.imageFileIDs[0] : "")
      const text = String(id || "").trim()
      return text ? [text] : []
    }
    const missing = Array.from(new Set(
      list
        .flatMap(g => g ? collectFileIDs(g) : [])
        .filter(Boolean)
        .filter(fileID => !this._thumbUrlCache[fileID])
    ))

    if (missing.length) {
      this._thumbUrlRequests = this._thumbUrlRequests || new Map()
      const targets = missing.filter(fileID => !this._thumbUrlRequests.has(fileID))
      for (let i = 0; i < targets.length; i += 50) {
        const chunk = targets.slice(i, i + 50)
        const request = Promise.resolve().then(() => wx.cloud.getTempFileURL({ fileList: chunk }))
          .then(result => {
            ;(result.fileList || []).forEach(file => {
              if (file.fileID && file.tempFileURL) this._thumbUrlCache[file.fileID] = file.tempFileURL
            })
          }).catch(error => console.error("getTempFileURL failed:", error))
        chunk.forEach(fileID => {
          const task = request.finally(() => {
            if (this._thumbUrlRequests.get(fileID) === task) this._thumbUrlRequests.delete(fileID)
          })
          this._thumbUrlRequests.set(fileID, task)
        })
      }
      await Promise.all(missing.map(fileID => this._thumbUrlRequests.get(fileID)))
      try { wx.setStorageSync(THUMB_CACHE_KEY, this._thumbUrlCache) } catch (e) {}
    }

    if (stateKey && this._getCurrentListQueryKey() !== stateKey) return

    let changed = false
    const attachThumbUrl = (g) => {
      if (!g) return g
      const fileIDs = collectFileIDs(g)
      const resolvedUrls = fileIDs.map(fileID => this._thumbUrlCache[fileID]).filter(Boolean)
      if (!resolvedUrls.length) return g
      if (g.thumbUrl === resolvedUrls[0] && g.imageSrc === resolvedUrls[0]) return g
      changed = true
      return {
        ...g,
        thumbUrl: resolvedUrls[0],
        imageSrc: resolvedUrls[0]
      }
    }

    const nextAll = (this.data.allGoods || []).map(attachThumbUrl)
    const nextDisplay = (this.data.displayGoods || []).map(attachThumbUrl)
    if (!changed) return
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
      const stateKey = this._getCurrentListQueryKey()
      const cached = readGoodsCacheEntry(
        this.data.activeListingType,
        this.data.activeCityKey || MARKET_DEFAULT_CITY_KEY,
        getAreaCacheKey(this.data.activeAreaKeys || [])
      )
      if (!cached || !cached.ts || !Array.isArray(cached.list)) return { restored: false, isFresh: false }
      const cacheAge = Date.now() - cached.ts
      if (cacheAge > GOODS_CACHE_MAX_STALE_MS) return { restored: false, isFresh: false }
      const currentChangedAt = getMarketGoodsChangedAt()
      const cacheChanged = !!currentChangedAt && Number(cached.changedAt || 0) !== currentChangedAt

      const rows = this._hydrateSellerProfilesFromCache(
        this._mapDocsToGoods(cached.list || [], "cacheRestore")
      )
      this.setData({
        allGoods: rows,
        cloudSkip: Number(cached.nextSkip) || cached.list.length || rows.length,
        cloudHasMore: typeof cached.hasMore === "boolean" ? cached.hasMore : true
      })
      this.initRegionsFromGoods()
      this._fillThumbUrlsFor(rows, stateKey).catch(() => {})
      const sortRequiresCloudRefresh = !!this._buildListSort().by
      return {
        restored: true,
        isFresh: !sortRequiresCloudRefresh && !cacheChanged && isGoodsCacheFresh(cached, { changedAt: currentChangedAt }),
        cacheAge
      }
    } catch (e) {
      return { restored: false, isFresh: false }
    }
  },

  _saveGoodsToCache(list, meta = {}) {
    try {
      const type = meta.type || this.data.activeListingType
      const cityKey = meta.cityKey || this.data.activeCityKey || MARKET_DEFAULT_CITY_KEY
      const regionKey = meta.regionKey || getAreaCacheKey(this.data.activeAreaKeys || [])
      writeGoodsCacheEntry(type, cityKey, regionKey, {
        ts: Date.now(),
        changedAt: getMarketGoodsChangedAt(),
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
