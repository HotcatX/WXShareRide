// 与 marketPost 保持一致：分类顺序固定
const { showDataError } = require("../../utils/error")
const {
  DEFAULT_CITY_TREE,
  MARKET_CITY_STORAGE_KEY,
  loadCityTreeConfig,
  normalizeCityTree,
  getCitySnapshot,
  getCountryTabs,
  getCountryGroups,
  cityGroupsHaveResults,
  getStoredCitySnapshot,
  setStoredCitySnapshot
} = require("../../utils/cityTree")
const {
  readMarketSellerProfiles,
  fetchAndCacheMarketSellerProfiles
} = require("../../utils/marketSellerProfileCache")
const {
  ALL_AREA_KEY,
  ALL_AREA_LABEL,
  DEFAULT_REGION_TREE,
  normalizeRegionTree,
  buildItemRegionAreaText,
  buildAreaSectionTabs,
  buildAreaSections,
  resolveAreaPanelSectionKey,
  loadRegionTreeConfig,
  readCachedRegionTree,
  writeCachedRegionTree
} = require("../../utils/regionTree")

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
const MARKET_DETAIL_CACHE_KEY = "market_detail_cache_v3"
const MARKET_AD_CACHE_KEY_PREFIX = "market_ads_cache_v1"
const MARKET_REFRESH_KEY = "market_goods_changed_at"
const MARKET_POST_SUCCESS_FILTER_KEY = "market_post_success_filter_v1"
const GOODS_CACHE_MAX_STALE_MS = 24 * 60 * 60 * 1000 // 24h 内先用旧缓存秒开，再后台刷新
const GOODS_CACHE_FRESH_MS = 5 * 60 * 1000           // 5 分钟内视为新缓存；仍会后台刷新保证进入/切换有新数据
const MARKET_DETAIL_CACHE_FRESH_MS = 10 * 60 * 1000
const MARKET_AD_CACHE_FRESH_MS = 10 * 60 * 1000
const REFRESH_DEBOUNCE_MS = 30 * 1000             // 30 sec
const FIRST_PAGE_FETCH_COOLDOWN_MS = 8 * 1000      // 同一筛选条件短时间防重复请求
const MARKET_DETAIL_PRELOAD_LIMIT = 3
const MARKET_AD_MIN_GOODS = 3
const MARKET_AD_INSERT_MIN_INDEX = 2
const MARKET_AD_INSERT_MAX_INDEX = 5
const MARKET_DEFAULT_CITY_KEY = "ny_nj"
const MARKET_DEFAULT_CITY_LABEL = "纽约/新泽西"
const MARKET_CITY_PICKER_HINT = "找不到你的城市？可以联系开发者请求加入，或先选择“其他城市”，系统会按你填写的位置和距离排序。"
const CITY_REGION_STATE_KEYS = {
  ny_nj: ["NY_NJ"],
  ny: ["NY_NJ"],
  nj: ["NY_NJ"],
  boston: ["MA"],
  philadelphia: ["PA"],
  dc: ["DC"],
  la: ["CA"],
  bay_area: ["CA"],
  seattle: ["WA"],
  san_diego: ["CA"],
  chicago: ["IL"],
  ann_arbor: ["MI"],
  champaign: ["IL"],
  columbus: ["OH"],
  dallas: ["TX"],
  houston: ["TX"],
  atlanta: ["GA"],
  miami: ["FL"],
  orlando: ["FL"],
  austin: ["TX"]
}
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

function getMarketDetailCacheStore() {
  try {
    return wx.getStorageSync(MARKET_DETAIL_CACHE_KEY) || {}
  } catch (e) {
    return {}
  }
}

function setMarketDetailCacheStore(store = {}) {
  try {
    wx.setStorageSync(MARKET_DETAIL_CACHE_KEY, store)
  } catch (e) {}
}

function readMarketDetailCache(id) {
  const key = String(id || "").trim()
  if (!key) return null
  const entry = getMarketDetailCacheStore()[key]
  if (!entry || !entry.ts || !entry.result) return null
  if (Date.now() - entry.ts > MARKET_DETAIL_CACHE_FRESH_MS) return null
  if ((Number(entry.changedAt) || 0) !== getMarketGoodsChangedAt()) return null
  const item = entry.result.item || entry.result.data || null
  if (!item || item._id !== key) return null
  return entry.result
}

function writeMarketDetailCache(id, result) {
  const key = String(id || "").trim()
  const item = result && (result.item || result.data)
  if (!key || !item || item._id !== key) return
  const store = getMarketDetailCacheStore()
  store[key] = {
    ts: Date.now(),
    changedAt: getMarketGoodsChangedAt(),
    result
  }
  const keys = Object.keys(store)
  if (keys.length > 60) {
    keys
      .sort((a, b) => (Number(store[a]?.ts) || 0) - (Number(store[b]?.ts) || 0))
      .slice(0, keys.length - 60)
      .forEach(oldKey => delete store[oldKey])
  }
  setMarketDetailCacheStore(store)
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

function getAreaStatesForCity(tree, cityKey = MARKET_DEFAULT_CITY_KEY) {
  const normalized = normalizeRegionTree(tree)
  const stateKeys = CITY_REGION_STATE_KEYS[cityKey] || []
  if (!stateKeys.length) return []

  const byKey = new Map(normalized.map(state => [state.key, state]))
  return stateKeys.map(key => byKey.get(key)).filter(Boolean)
}

function isImplicitAllStateArea(area = {}, state = {}) {
  const stateKey = String(state.key || "").toLowerCase()
  const areaKey = String(area.key || "").toLowerCase()
  return !!stateKey && areaKey === `${stateKey}_all`
}

function findAreaInTree(tree, areaKey = ALL_AREA_KEY, cityKey = MARKET_DEFAULT_CITY_KEY) {
  if (!areaKey || areaKey === ALL_AREA_KEY) return null
  const normalized = getAreaStatesForCity(tree, cityKey)
  for (const state of normalized) {
    const area = (state.areas || []).find(item => item.key === areaKey)
    if (area && isImplicitAllStateArea(area, state)) return null
    if (area) return { state, area }
  }
  return null
}

function getAreaSelectionMeta(tree, areaKeys = [], cityKey = MARKET_DEFAULT_CITY_KEY) {
  const validKeys = []
  const labels = []
  normalizeAreaKeys(areaKeys).forEach(key => {
    const match = findAreaInTree(tree, key, cityKey)
    if (!match || validKeys.includes(match.area.key)) return
    validKeys.push(match.area.key)
    labels.push(match.area.label)
  })
  return {
    keys: validKeys,
    activeKey: validKeys[0] || ALL_AREA_KEY,
    label: labels.length === 0
      ? ALL_AREA_LABEL
      : (labels.length === 1 ? labels[0] : `已选${labels.length}个`),
    labels
  }
}

function getAreaStateKey(tree, activeStateKey = "NY", cityKey = MARKET_DEFAULT_CITY_KEY) {
  const states = getAreaStatesForCity(tree, cityKey)
  return states.some(state => state.key === activeStateKey)
    ? activeStateKey
    : (states[0]?.key || "NY")
}

function buildAreaStateTabs(tree, activeStateKey = "NY", cityKey = MARKET_DEFAULT_CITY_KEY) {
  const states = getAreaStatesForCity(tree, cityKey)
  const selectedKey = getAreaStateKey(tree, activeStateKey, cityKey)
  return states.map(state => ({
    key: state.key,
    label: state.label,
    className: state.key === selectedKey ? "active" : ""
  }))
}

function buildAreaOptions(tree, activeStateKey = "NY", activeAreaKey = ALL_AREA_KEY, cityKey = MARKET_DEFAULT_CITY_KEY) {
  const states = getAreaStatesForCity(tree, cityKey)
  const selectedKey = getAreaStateKey(tree, activeStateKey, cityKey)
  const state = states.find(item => item.key === selectedKey) || states[0] || { areas: [] }
  const explicitAreas = (state.areas || []).filter(area => !isImplicitAllStateArea(area, state))
  const selectedAreaKeys = normalizeAreaKeys(activeAreaKey)
  return [
    { key: ALL_AREA_KEY, label: ALL_AREA_LABEL },
    ...explicitAreas
  ].map(area => ({
    ...area,
    className: area.key === ALL_AREA_KEY
      ? (!selectedAreaKeys.length ? "active" : "")
      : (selectedAreaKeys.includes(area.key) ? "active" : "")
  }))
}

function buildAreaUiPatch(tree, activeStateKey = "NY", activeAreaKey = ALL_AREA_KEY, cityKey = MARKET_DEFAULT_CITY_KEY, activeSectionKey = "") {
  const nextStateKey = getAreaStateKey(tree, activeStateKey, cityKey)
  const stateTabs = buildAreaStateTabs(tree, nextStateKey, cityKey)
  const optionAreaKeys = normalizeAreaKeys(activeAreaKey)
    .filter(key => !!findAreaInTree(tree, key, cityKey))
  const areaOptions = buildAreaOptions(tree, nextStateKey, optionAreaKeys, cityKey)
  const areaSectionKey = resolveAreaPanelSectionKey(areaOptions, activeSectionKey, optionAreaKeys)
  return {
    activeAreaStateKey: nextStateKey,
    areaStateTabs: stateTabs,
    areaOptions,
    activeAreaSectionKey: areaSectionKey,
    areaSectionTabs: buildAreaSectionTabs(areaOptions, areaSectionKey, optionAreaKeys),
    areaSections: buildAreaSections(areaOptions, { visibleSectionKey: areaSectionKey }),
    areaHasStateTabs: stateTabs.length > 1
  }
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
    activeRegion: MARKET_DEFAULT_CITY_KEY,
    activeRegionLabel: MARKET_DEFAULT_CITY_LABEL,
    activeRegionShortLabel: MARKET_DEFAULT_CITY_LABEL,
    activeCityKey: MARKET_DEFAULT_CITY_KEY,
    activeCityLabel: MARKET_DEFAULT_CITY_LABEL,
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

    cityTree: DEFAULT_CITY_TREE,
    cityCountryTabs: getCountryTabs(DEFAULT_CITY_TREE, "US"),
    cityPickerGroups: getCountryGroups(DEFAULT_CITY_TREE, "US", MARKET_DEFAULT_CITY_KEY, { includeAll: false }),
    cityPickerVisible: false,
    activeCityCountryCode: "US",
    citySearchKeyword: "",
    cityPickerHasResults: true,
    cityPickerEmptyText: "没有找到相关城市",
    cityPickerHintText: MARKET_CITY_PICKER_HINT,
    areaTree: DEFAULT_REGION_TREE,
    areaStateTabs: buildAreaStateTabs(DEFAULT_REGION_TREE, "NY"),
    areaOptions: buildAreaOptions(DEFAULT_REGION_TREE, "NY", ALL_AREA_KEY),
    areaSectionTabs: buildAreaSectionTabs(buildAreaOptions(DEFAULT_REGION_TREE, "NY", ALL_AREA_KEY), ALL_AREA_KEY),
    areaSections: buildAreaSections(buildAreaOptions(DEFAULT_REGION_TREE, "NY", ALL_AREA_KEY), { visibleSectionKey: ALL_AREA_KEY }),
    areaHasStateTabs: true,
    areaPickerVisible: false,

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
    const initialCity = args.initialCity || MARKET_DEFAULT_CITY_KEY
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

  _applyCityUi(cityKey = MARKET_DEFAULT_CITY_KEY, options = {}) {
    const cityTree = normalizeCityTree(options.cityTree || this.data.cityTree || DEFAULT_CITY_TREE)
    const normalizedCityKey = cityKey === "all" ? MARKET_DEFAULT_CITY_KEY : cityKey
    const snapshot = getCitySnapshot(cityTree, normalizedCityKey || MARKET_DEFAULT_CITY_KEY)
    const activeCountryCode = options.countryCode || this.data.activeCityCountryCode || "US"
    const citySearchKeyword = typeof options.keyword === "string" ? options.keyword : (this.data.citySearchKeyword || "")
    const cityPickerGroups = getCountryGroups(cityTree, activeCountryCode, snapshot.key, {
      includeAll: false,
      keyword: citySearchKeyword
    })

    this.setData({
      cityTree,
      activeCityKey: snapshot.key,
      activeCityLabel: snapshot.label,
      activeCityAliases: snapshot.aliases,
      activeRegion: snapshot.key,
      activeRegionLabel: snapshot.label,
      activeRegionShortLabel: snapshot.label,
      activeCityCountryCode: activeCountryCode,
      cityCountryTabs: getCountryTabs(cityTree, activeCountryCode),
      cityPickerGroups,
      cityPickerHasResults: cityGroupsHaveResults(cityPickerGroups),
      citySearchKeyword
    })
    setStoredCitySnapshot(MARKET_CITY_STORAGE_KEY, snapshot)
    return snapshot
  },

  _applyAreaUi(areaKey = ALL_AREA_KEY, options = {}) {
    const areaTree = normalizeRegionTree(options.areaTree || this.data.areaTree || DEFAULT_REGION_TREE)
    const cityKey = options.cityKey || this.data.activeCityKey || MARKET_DEFAULT_CITY_KEY
    const selection = getAreaSelectionMeta(areaTree, areaKey, cityKey)
    const firstMatch = findAreaInTree(areaTree, selection.activeKey, cityKey)
    const activeStateKey = getAreaStateKey(areaTree, options.stateKey || firstMatch?.state?.key || this.data.activeAreaStateKey || "NY", cityKey)
    const activeSectionKey = options.sectionKey || (selection.keys.length ? "" : (this.data.activeAreaSectionKey || ALL_AREA_KEY))

    this.setData({
      areaTree,
      activeAreaKey: selection.activeKey,
      activeAreaKeys: selection.keys,
      activeAreaLabel: selection.label,
      ...buildAreaUiPatch(areaTree, activeStateKey, selection.keys, cityKey, activeSectionKey)
    })
  },

  _resetGoodsStateForFetch(extra = {}) {
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
      this._getCurrentListQueryKey() === requestKey
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
    const cityKey = String(filter.cityKey || MARKET_DEFAULT_CITY_KEY).trim() || MARKET_DEFAULT_CITY_KEY

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
    this._prefetchSiblingListingType()
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
    const storedCity = getStoredCitySnapshot(MARKET_CITY_STORAGE_KEY, DEFAULT_CITY_TREE, MARKET_DEFAULT_CITY_KEY)

    this.setData(this._getTopMetrics())
    this._applyListingTypeUi(initialType, { category: initialCategory || "全部" })
    this._applyCityUi(initialCity || storedCity.key || MARKET_DEFAULT_CITY_KEY)

    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })

    try {
      this._thumbUrlCache = normalizeObjectCache(wx.getStorageSync(THUMB_CACHE_KEY))
    } catch (e) {
      this._thumbUrlCache = {}
    }
    this._lastRefreshAt = 0
    this._lastHandledGoodsChangeAt = getMarketGoodsChangedAt()
    this._marketBootstrapped = false
    this._marketBootstrapStarted = false
    this._userSortTouched = false
    this._sellerProfileCache = {}
    this._marketAdSessionSeed = `${Date.now()}_${Math.random().toString(16).slice(2)}`
    this._marketBootstrapArgs = {
      initialCategory,
      initialCity: initialCity || storedCity.key || MARKET_DEFAULT_CITY_KEY,
      initialType
    }

    this._startMarketBootstrap()
  },

  async onShow() {
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
    if (this.data.distanceSortActive) {
      locationState = await this._loadMyLocationFromProfile({
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
    this._fetchFirstPage({ force: true, reason: "showRefresh" })
  },

  async _bootstrapMarketData(initialCategory = "", initialCity = MARKET_DEFAULT_CITY_KEY, initialType = "goods") {
    this._marketBootstrapped = true

    this._applyListingTypeUi(initialType, { category: initialCategory || "全部" })
    this._applyCityUi(initialCity || MARKET_DEFAULT_CITY_KEY)

    this.loadCityTreeFromCloud()
    this.loadRegionTreeFromCloud()

    const cacheState = this._restoreGoodsFromCache()
    if (cacheState.restored) this.applyFilters(true)
    this._loadMarketAds()
    this._prefetchSiblingListingType()

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
    const areaTree = this.data.areaTree || DEFAULT_REGION_TREE
    const cityKey = this.data.activeCityKey || MARKET_DEFAULT_CITY_KEY
    const activeStateKey = getAreaStateKey(areaTree, this.data.activeAreaStateKey || "NY", cityKey)
    this._resetGoodsStateForFetch({
      keyword: "",
      activeCategory: "全部",
      categoryTabs: buildCategoryTabs(this.data.categories, "全部"),
      activeAreaKey: ALL_AREA_KEY,
      activeAreaKeys: [],
      activeAreaLabel: ALL_AREA_LABEL,
      activeAreaSectionKey: ALL_AREA_KEY,
      areaPickerVisible: false,
      ...buildAreaUiPatch(areaTree, activeStateKey, ALL_AREA_KEY, cityKey, ALL_AREA_KEY),
      categoryPickerVisible: false,
      ...this._getDefaultSortPatch()
    })
    this._fetchFirstPage({ force: true, reason: "resetFilters" })
  },

  onOpenCategoryPicker() {
    this.setData({ categoryPickerVisible: true })
  },

  onCategoryPickerCancel() {
    this.setData({ categoryPickerVisible: false })
  },

  onOpenAreaPicker() {
    const areaTree = this.data.areaTree || DEFAULT_REGION_TREE
    const cityKey = this.data.activeCityKey || MARKET_DEFAULT_CITY_KEY
    const activeStateKey = getAreaStateKey(areaTree, this.data.activeAreaStateKey || "NY", cityKey)
    const activeSectionKey = (this.data.activeAreaKeys || []).length
      ? (this.data.activeAreaSectionKey === ALL_AREA_KEY ? "" : (this.data.activeAreaSectionKey || ""))
      : (this.data.activeAreaSectionKey || ALL_AREA_KEY)
    this.setData({
      areaPickerVisible: true,
      ...buildAreaUiPatch(areaTree, activeStateKey, this.data.activeAreaKeys || [], cityKey, activeSectionKey)
    })
  },

  onAreaPickerCancel() {
    this.setData({ areaPickerVisible: false })
  },

  onSelectAreaState(e) {
    const key = e.currentTarget.dataset.key || "NY"
    const areaTree = this.data.areaTree || DEFAULT_REGION_TREE
    const cityKey = this.data.activeCityKey || MARKET_DEFAULT_CITY_KEY
    this.setData({
      activeAreaStateKey: key,
      ...buildAreaUiPatch(areaTree, key, this.data.activeAreaKeys || [], cityKey, this.data.activeAreaSectionKey || ALL_AREA_KEY)
    })
  },

  async onSelectAreaSection(e) {
    const key = e.currentTarget.dataset.key || ALL_AREA_KEY
    const areaTree = this.data.areaTree || DEFAULT_REGION_TREE
    const cityKey = this.data.activeCityKey || MARKET_DEFAULT_CITY_KEY
    const activeStateKey = getAreaStateKey(areaTree, this.data.activeAreaStateKey || "NY", cityKey)
    if (key !== ALL_AREA_KEY) {
      this.setData({
        ...buildAreaUiPatch(areaTree, activeStateKey, this.data.activeAreaKeys || [], cityKey, key)
      })
      return
    }

    const selection = getAreaSelectionMeta(areaTree, [], cityKey)
    this._resetGoodsStateForFetch({
      activeAreaKey: selection.activeKey,
      activeAreaKeys: selection.keys,
      activeAreaLabel: selection.label,
      areaPickerVisible: true,
      ...buildAreaUiPatch(areaTree, activeStateKey, selection.keys, cityKey, ALL_AREA_KEY)
    })
    this.updateMarketHeaderState(0)
    const cacheState = this._restoreGoodsFromCache()
    if (cacheState.restored) this.applyFilters(true)
    await this._fetchFirstPage({ force: true, reason: "area:all" })
  },

  async onSelectArea(e) {
    const key = e.currentTarget.dataset.key || ALL_AREA_KEY
    const areaTree = this.data.areaTree || DEFAULT_REGION_TREE
    const cityKey = this.data.activeCityKey || MARKET_DEFAULT_CITY_KEY
    const match = key === ALL_AREA_KEY ? null : findAreaInTree(areaTree, key, cityKey)
    const currentKeys = normalizeAreaKeys(this.data.activeAreaKeys || this.data.activeAreaKey)
    let nextKeys = []
    if (match) {
      nextKeys = currentKeys.includes(match.area.key)
        ? currentKeys.filter(item => item !== match.area.key)
        : [...currentKeys, match.area.key]
    }
    const selection = getAreaSelectionMeta(areaTree, nextKeys, cityKey)
    const activeAreaStateKey = getAreaStateKey(areaTree, match ? match.state.key : (this.data.activeAreaStateKey || "NY"), cityKey)
    const activeAreaSectionKey = selection.keys.length
      ? (match ? (match.area.sectionKey || this.data.activeAreaSectionKey || "") : "")
      : ALL_AREA_KEY

    this._resetGoodsStateForFetch({
      activeAreaKey: selection.activeKey,
      activeAreaKeys: selection.keys,
      activeAreaLabel: selection.label,
      areaPickerVisible: true,
      ...buildAreaUiPatch(areaTree, activeAreaStateKey, selection.keys, cityKey, activeAreaSectionKey)
    })
    this.updateMarketHeaderState(0)
    const cacheState = this._restoreGoodsFromCache()
    if (cacheState.restored) this.applyFilters(true)
    await this._fetchFirstPage({ force: true, reason: `area:${getAreaCacheKey(selection.keys)}` })
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

  async loadCityTreeFromCloud() {
    try {
      const tree = await loadCityTreeConfig()
      this._applyCityUi(this.data.activeCityKey || MARKET_DEFAULT_CITY_KEY, { cityTree: tree })
      return tree
    } catch (e) {
      console.error("cityTree 加载失败：", e)
      const tree = normalizeCityTree(DEFAULT_CITY_TREE)
      this._applyCityUi(this.data.activeCityKey || MARKET_DEFAULT_CITY_KEY, { cityTree: tree })
      return tree
    }
  },

  async loadRegionTreeFromCloud(options = {}) {
    if (!options.force) {
      const cached = readCachedRegionTree()
      if (cached) {
        this._applyAreaUi(this.data.activeAreaKeys || [], { areaTree: cached })
        return cached
      }
    }

    try {
      const { tree, fromCloud } = await loadRegionTreeConfig(options)
      if (fromCloud) writeCachedRegionTree(tree)
      this._applyAreaUi(this.data.activeAreaKeys || [], { areaTree: tree })
      return tree
    } catch (e) {
      console.error("regionTree 加载失败：", e)
      const tree = normalizeRegionTree(DEFAULT_REGION_TREE)
      this._applyAreaUi(this.data.activeAreaKeys || [], { areaTree: tree })
      return tree
    }
  },

  onTapRegion() {
    const cityTree = this.data.cityTree || DEFAULT_CITY_TREE
    const cityPickerGroups = getCountryGroups(
      cityTree,
      this.data.activeCityCountryCode || "US",
      this.data.activeCityKey || MARKET_DEFAULT_CITY_KEY,
      { includeAll: false }
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
    const cityTree = this.data.cityTree || DEFAULT_CITY_TREE
    const cityPickerGroups = getCountryGroups(
      cityTree,
      this.data.activeCityCountryCode || "US",
      this.data.activeCityKey || MARKET_DEFAULT_CITY_KEY,
      { includeAll: false, keyword }
    )
    this.setData({
      citySearchKeyword: keyword,
      cityPickerGroups,
      cityPickerHasResults: cityGroupsHaveResults(cityPickerGroups)
    })
  },

  onSelectCityCountry(e) {
    const code = e.currentTarget.dataset.code || "US"
    const cityTree = this.data.cityTree || DEFAULT_CITY_TREE
    const citySearchKeyword = this.data.citySearchKeyword || ""
    const cityPickerGroups = getCountryGroups(cityTree, code, this.data.activeCityKey || MARKET_DEFAULT_CITY_KEY, {
      includeAll: false,
      keyword: citySearchKeyword
    })
    this.setData({
      activeCityCountryCode: code,
      cityCountryTabs: getCountryTabs(cityTree, code),
      cityPickerGroups,
      cityPickerHasResults: cityGroupsHaveResults(cityPickerGroups)
    })
  },

  onSelectCity(e) {
    const key = e.currentTarget.dataset.key || MARKET_DEFAULT_CITY_KEY
    const snapshot = this._applyCityUi(key)
    this._applyAreaUi(ALL_AREA_KEY, { cityKey: snapshot.key })

    this._resetGoodsStateForFetch({ cityPickerVisible: false, citySearchKeyword: "" })
    this.updateMarketHeaderState(0)
    const cacheState = this._restoreGoodsFromCache()
    if (cacheState.restored) this.applyFilters(true)
    this._fetchFirstPage({ force: true, reason: `city:${snapshot.key}` })
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
      cityKey: this.data.activeCityKey || MARKET_DEFAULT_CITY_KEY,
      cityLabel: this.data.activeCityLabel || MARKET_DEFAULT_CITY_LABEL,
      cityAliases: this.data.activeCityAliases || [],
      regionKey: this.data.activeAreaKey || ALL_AREA_KEY,
      regionKeys: this.data.activeAreaKeys || [],
      regionLabel: this.data.activeAreaLabel || ALL_AREA_LABEL,
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
          limit: INITIAL_LOAD_SIZE,
          fastList: true
        }
      })
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
      this._prefetchSiblingListingType(filters)
      return true
    } catch (e) {
      if (!this._isActiveGoodsRequest(requestToken, requestKey)) return false
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
      cityKey: this.data.activeCityKey || MARKET_DEFAULT_CITY_KEY,
      cityLabel: this.data.activeCityLabel || MARKET_DEFAULT_CITY_LABEL,
      cityAliases: this.data.activeCityAliases || [],
      regionKey: this.data.activeAreaKey || ALL_AREA_KEY,
      regionKeys: this.data.activeAreaKeys || [],
      regionLabel: this.data.activeAreaLabel || ALL_AREA_LABEL,
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

  _prefetchSiblingListingType(baseFilters = {}) {
    const activeType = normalizeListingType(baseFilters.listingType || this.data.activeListingType)
    const siblingType = activeType === "goods" ? "sublet" : "goods"
    const cityKey = baseFilters.cityKey || this.data.activeCityKey || MARKET_DEFAULT_CITY_KEY
    const regionKeys = normalizeAreaKeys(baseFilters.regionKeys || this.data.activeAreaKeys || [])
    const regionKey = getAreaCacheKey(regionKeys)
    const cached = readGoodsCacheEntry(siblingType, cityKey, regionKey)
    if (isGoodsCacheFresh(cached)) return

    const filters = {
      listingType: siblingType,
      category: "全部",
      cityKey,
      cityLabel: this.data.activeCityLabel || MARKET_DEFAULT_CITY_LABEL,
      cityAliases: this.data.activeCityAliases || [],
      regionKey: regionKeys[0] || ALL_AREA_KEY,
      regionKeys,
      regionLabel: this.data.activeAreaLabel || ALL_AREA_LABEL,
      keyword: ""
    }
    const requestKey = buildListQueryKey(filters, {})
    this._marketPrefetchInFlight = this._marketPrefetchInFlight || {}
    if (this._marketPrefetchInFlight[requestKey]) return

    this._marketPrefetchInFlight[requestKey] = true
    setTimeout(() => {
      wx.cloud.callFunction({
        name: "marketApi",
        data: {
          action: "list",
          filters,
          sort: {},
          skip: 0,
          limit: INITIAL_LOAD_SIZE,
          fastList: true
        }
      }).then(res => {
        const result = getMarketApiResult(res)
        const rawRows = result.items || result.data || []
        if (!rawRows.length) return
        this._saveGoodsToCache(rawRows, {
          type: siblingType,
          cityKey,
          regionKey,
          nextSkip: result.nextSkip || rawRows.length,
          hasMore: !!result.hasMore
        })
        const sellerOpenids = Array.from(new Set(rawRows.map(item => item && item._openid).filter(Boolean)))
        if (sellerOpenids.length) fetchAndCacheMarketSellerProfiles(sellerOpenids).catch(() => {})
      }).catch(e => {
        console.warn("[market] sibling prefetch failed:", e)
      }).finally(() => {
        delete this._marketPrefetchInFlight[requestKey]
      })
    }, 600)
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

    const filtered = [...(allGoods || [])].filter(item =>
      normalizeListingType(item && item.listingType) === activeListingType
    )

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
    this._preloadMarketDetails(display)
  },

  _preloadMarketDetail(id) {
    const key = String(id || "").trim()
    if (!key || readMarketDetailCache(key)) return Promise.resolve(false)

    this._detailPreloadInFlight = this._detailPreloadInFlight || {}
    if (this._detailPreloadInFlight[key]) return this._detailPreloadInFlight[key]

    const task = wx.cloud.callFunction({
      name: "marketApi",
      data: { action: "detail", id: key }
    }).then(res => {
      const result = getMarketApiResult(res)
      const item = result.item || result.data || null
      if (item && item._id === key) {
        writeMarketDetailCache(key, result)
        if (item._openid) fetchAndCacheMarketSellerProfiles([item._openid]).catch(() => {})
        return true
      }
      return false
    }).catch(e => {
      console.warn("market detail preload failed:", e)
      return false
    }).finally(() => {
      delete this._detailPreloadInFlight[key]
    })

    this._detailPreloadInFlight[key] = task
    return task
  },

  _preloadMarketDetails(goods = [], limit = MARKET_DETAIL_PRELOAD_LIMIT) {
    this._detailPreloadScheduled = this._detailPreloadScheduled || {}
    const ids = Array.from(new Set((Array.isArray(goods) ? goods : [])
      .filter(item => item && !item.isAd)
      .map(item => String(item.id || item._id || "").trim())
      .filter(Boolean)))
      .slice(0, limit)

    ids.forEach((id, index) => {
      if (this._detailPreloadScheduled[id] || readMarketDetailCache(id)) return
      this._detailPreloadScheduled[id] = true
      setTimeout(() => {
        delete this._detailPreloadScheduled[id]
        this._preloadMarketDetail(id)
      }, 1600 + index * 260)
    })
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
      if (!rows.length) return { restored: false, isFresh: false }
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
