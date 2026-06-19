// 与 marketPost 保持一致：分类顺序固定
const { showDataError } = require("../../utils/error")

const CATEGORY_OPTIONS = ["家具", "厨具", "电器", "服包鞋饰", "电子产品", "运动装备", "其他"]

// ====== Performance / Cache ======
const GOODS_CACHE_KEY = "market_goods_list_cache_v4"
const THUMB_CACHE_KEY = "market_thumburl_cache_v1"
const GOODS_CACHE_MAX_STALE_MS = 24 * 60 * 60 * 1000 // 24h 内先用旧缓存秒开，再后台刷新
const REFRESH_DEBOUNCE_MS = 30 * 1000             // 30 sec
const MARKET_GOODS_LIST_FIELDS = {
  _id: true,
  title: true,
  price: true,
  category: true,
  region: true,
  location: true,
  condition: true,
  postDate: true,
  imageFileID: true,
  thumbFileID: true,
  imageFileIDs: true,
  thumbFileIDs: true,
  hasImage: true,
  pickupStartDate: true,
  pickupEndDate: true,
  pickupRangeText: true,
  expireTime: true,
  expiresAtText: true,
  status: true,
  createTime: true
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
  if (miles < 0.1) return "0.1 mi内"
  if (miles < 10) return `${miles.toFixed(1)} mi`
  return `${Math.round(miles)} mi`
}

// 云端分页：小程序端单次 get 实际上最多 20
const CLOUD_PAGE_SIZE = 20
const INITIAL_LOAD_SIZE = 8                         // 首屏只拉当前可见数量


Page({
  data: {
    statusBarHeight: 0,

    // Filters
    keyword: "",
    activeCategory: "全部",
    activeRegion: "全部",
    regions: ["全部"],
    categories: ["全部", ...CATEGORY_OPTIONS],

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
    pageSize: 8,
    canViewMore: true,

    // Cloud pagination state
    cloudSkip: 0,
    cloudHasMore: true,
    isLoadingGoods: false,

    priceSortOrder: 'none', // 'none' | 'asc' | 'desc'
    distanceSortActive: false,
    myLocation: null
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

  onShareAppMessage() {
    // 这里把当前筛选状态带上（按你现有字段改）
    const { selectedCategory = '', selectedRegion = '' } = this.data

    const qs = []
    if (selectedCategory) qs.push(`cat=${encodeURIComponent(selectedCategory)}`)
    if (selectedRegion) qs.push(`region=${encodeURIComponent(selectedRegion)}`)

    const path = `/pages/market/market${qs.length ? `?${qs.join('&')}` : ''}`

    return {
      title: '二手市场｜看看有没有你想要的',
      path
    }
  },

  onShareTimeline() {
    const { selectedCategory = '', selectedRegion = '' } = this.data
    const query = {}
    if (selectedCategory) query.cat = selectedCategory
    if (selectedRegion) query.region = selectedRegion

    return {
      title: '二手市场｜看看有没有你想要的',
      query
    }
  },

  onTogglePriceSort() {
    const cur = this.data.priceSortOrder || 'none'
    const next = cur === 'none' ? 'asc' : (cur === 'asc' ? 'desc' : 'none')
    this.setData({ priceSortOrder: next, distanceSortActive: false })
    // 排序不需要重新拉云端，直接对当前已拉取结果排序+切片即可
    this.applyFilters(true)
  },

  async onToggleDistanceSort() {
    const next = !this.data.distanceSortActive
    if (next && !hasLatLng(this.data.myLocation || {})) {
      await this._loadMyLocationFromProfile()
    }

    if (next && !hasLatLng(this.data.myLocation || {})) {
      wx.showModal({
        title: "请先设置定位",
        content: "需要在个人资料里选择精确定位后，才能按距离排序。",
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
      priceSortOrder: next ? "none" : this.data.priceSortOrder
    })
    this.applyFilters(true)
  },

  onLoad() {
    this.setData({ statusBarHeight: this._getStatusBarHeight() })

    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })

    this._thumbUrlCache = wx.getStorageSync(THUMB_CACHE_KEY) || {}
    this._lastRefreshAt = 0

    this.initCategoriesFromGoods()
    this.loadRegionTreeFromCloud()
    this._loadMyLocationFromProfile()

    // 先用缓存秒开，再后台刷新
    this._restoreGoodsFromCache()
    this.applyFilters(true)

    // 后台刷新一次（避免缓存为空）
    this._maybeRefreshGoods(true)
  },

  onShow() {
    this._loadMyLocationFromProfile()
    this._maybeRefreshGoods(false)
  },

  onPullDownRefresh() {
    // 下拉刷新：强制重新拉第一页（按当前筛选条件）
    Promise.resolve()
      .then(() => this._fetchFirstPage())
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
      cloudSkip: 0,
      cloudHasMore: true,
      canViewMore: true
    })
    await this._fetchFirstPage()
  },

  async onSelectCat(e) {
    const cat = e.currentTarget.dataset.cat

    // 切类目：云端 where(category=xxx) + 分页拉取
    this.setData({
      activeCategory: cat || "全部",
      allGoods: [],
      filteredGoods: [],
      displayGoods: [],
      cloudSkip: 0,
      cloudHasMore: true,
      canViewMore: true
    })
    await this._fetchFirstPage()
  },

  onTapItem(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/market/marketDetail/marketDetail?id=${id}` })
  },

  onMyGoods() {
    wx.navigateTo({ url: "/pages/market/marketMy/marketMy" })
  },

  onSellIdle() {
    wx.navigateTo({ url: "/pages/market/marketPost/marketPost" })
  },

  stopTouchMove() {},

  // ====== 分类初始化 ======
  initCategoriesFromGoods() {
    const categories = ["全部", ...CATEGORY_OPTIONS]
    this.setData({
      categories,
      activeCategory: categories.includes(this.data.activeCategory) ? this.data.activeCategory : "全部"
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
    const v = e.detail.value || [0, 0, 0]
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
    const [v0, v1, v2] = this.data.regionPickerValue || [0, 0, 0]
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
      regionPickerVisible: false,

      allGoods: [],
      filteredGoods: [],
      displayGoods: [],
      cloudSkip: 0,
      cloudHasMore: true,
      canViewMore: true
    })
    // 切换地区后：按新筛选条件重新拉第一页
    this._fetchFirstPage()
  },

  // ====== 核心：映射商品（✅缩略图优先）======
  _mapDocToGood(x) {
    const thumbKey = (x.thumbFileID || x.imageFileID || "")
    const hasImage = !!(x.hasImage || x.imageFileID || x.thumbFileID || (Array.isArray(x.imageFileIDs) && x.imageFileIDs.length))
    return this._withDistance({
      id: x._id,
      title: x.title,
      price: x.price,
      category: CATEGORY_OPTIONS.includes(x.category) ? x.category : "其他",
      region: x.region,
      location: x.location || {},
      condition: x.condition,
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

      // temp url（优先 thumbFileID，否则 imageFileID）
      thumbUrl: thumbKey ? (this._thumbUrlCache[thumbKey] || "") : ""
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

  async _loadMyLocationFromProfile() {
    const openid = wx.getStorageSync("openid") || ""
    const isGuest = !!wx.getStorageSync("isGuest")
    if (!openid || isGuest) {
      this.setData({ myLocation: null, distanceSortActive: false })
      return null
    }

    try {
      const res = await wx.cloud.callFunction({ name: "getUserInfo" })
      const user = (res?.result?.data || [])[0] || {}
      const location = user.location || {}
      const myLocation = hasLatLng(location) ? location : null
      this.setData({ myLocation })
      this._refreshGoodsDistance()
      return myLocation
    } catch (e) {
      return null
    }
  },

  _refreshGoodsDistance() {
    const allGoods = (this.data.allGoods || []).map(g => this._withDistance(g))
    this.setData({ allGoods })
    this.applyFilters(false)
  },

  _isVisibleMarketDoc(x) {
    if (!x) return false
    const status = String(x.status || "online").toLowerCase()
    if (status === "deleted" || status === "offline" || status === "expired" || status === "sold") return false
    const expireTime = Number(x.expireTime) || 0
    if (expireTime && expireTime <= Date.now()) return false
    return true
  },

  _buildCloudWhere() {
    const db = wx.cloud.database()
    const _ = db.command

    const { activeCategory, activeRegion, keyword } = this.data
    const where = {}

    // 1) category 精确匹配（“全部”不加条件）
    if (activeCategory && activeCategory !== "全部") {
      where.category = activeCategory
    }

    // 2) region：支持 “xxx / yyy / 全部” 前缀匹配
    if (activeRegion && activeRegion !== "全部") {
      if ((activeRegion || "").endsWith("/ 全部")) {
        const prefix = activeRegion.replace(/\/\s*全部\s*$/, "/")
        // startsWith：用正则前缀实现（注意转义）
        const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        where.region = db.RegExp({ regexp: `^${esc}`, options: "i" })
      } else {
        where.region = activeRegion
      }
    }

    const kw = (keyword || "").trim()
    if (kw) {
      const safe = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const reg = db.RegExp({ regexp: safe, options: "i" })
      where[_.or] = [{ title: reg }, { desc: reg }]
    }

    return where
  },

  _getMarketGoodsPage(col, where, options = {}) {
    let query = col.where(where)
    if (typeof query.field === "function") {
      query = query.field(MARKET_GOODS_LIST_FIELDS)
    }
    if (options.order !== false) {
      query = query.orderBy("createTime", "desc")
    }
    if (options.skip) {
      query = query.skip(options.skip)
    }
    return query.limit(options.limit || CLOUD_PAGE_SIZE).get()
  },

  async _fetchFirstPage() {
    try {
      this.setData({ isLoadingGoods: true })

      const db = wx.cloud.database()
      const col = db.collection("market_goods")
      const where = this._buildCloudWhere()

      const res = await this._getMarketGoodsPage(col, where, { limit: INITIAL_LOAD_SIZE })

      const rawRows = res.data || []
      const rows = rawRows.filter(x => this._isVisibleMarketDoc(x)).map(x => this._mapDocToGood(x))

      this.setData({
        // allGoods 代表“当前筛选条件下已加载到前端的全集（分页累积）”
        allGoods: rows,
        cloudSkip: rawRows.length,
        cloudHasMore: rawRows.length === INITIAL_LOAD_SIZE
      })

      if (this.data.activeCategory === "全部" && this.data.activeRegion === "全部" && !(this.data.keyword || "").trim()) {
        this._saveGoodsToCache(res.data || [])
      }

      this.initRegionsFromGoods()
      // 云端已筛选，这里只做排序 + 前端切片展示。图片链接后台补，不能阻塞首屏。
      this.applyFilters(true)
    } catch (e) {
      console.error(e)
      showDataError("商品加载失败", e, "商品列表从数据库加载失败，请稍后重试。")
    } finally {
      this.setData({ isLoadingGoods: false })
    }
  },

  async _fetchNextPage(resetPagingAfterAppend = false) {
    if (!this.data.cloudHasMore) return
    if (this.data.isLoadingGoods) return

    try {
      this.setData({ isLoadingGoods: true })

      const db = wx.cloud.database()
      const col = db.collection("market_goods")
      const where = this._buildCloudWhere()

      const res = await this._getMarketGoodsPage(col, where, {
        skip: this.data.cloudSkip || 0,
        limit: CLOUD_PAGE_SIZE
      })

      const rawBatch = res.data || []
      const batch = rawBatch.filter(x => this._isVisibleMarketDoc(x)).map(x => this._mapDocToGood(x))
      const all = [...(this.data.allGoods || []), ...batch]

      this.setData({
        allGoods: all,
        cloudSkip: (this.data.cloudSkip || 0) + rawBatch.length,
        cloudHasMore: rawBatch.length === CLOUD_PAGE_SIZE
      })

      // 同上：只缓存“全量列表”的结果
      if (this.data.activeCategory === "全部" && this.data.activeRegion === "全部" && !(this.data.keyword || "").trim()) {
        this._saveGoodsToCache([...(wx.getStorageSync(GOODS_CACHE_KEY)?.list || []), ...(res.data || [])])
      }

      this.initRegionsFromGoods()
      this.applyFilters(resetPagingAfterAppend)
    } catch (e) {
      console.error(e)
      showDataError("商品加载失败", e, "商品列表从数据库加载失败，请稍后重试。")
    } finally {
      this.setData({ isLoadingGoods: false })
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
    this.setData({
      displayGoods: next,
      canViewMore: next.length < filtered.length || !!this.data.cloudHasMore
    })

    // 如果本地不够了，继续拉云端
    if (next.length >= filtered.length - 2) {
      this._fetchNextPage()
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
  applyFilters(resetPaging = false) {
    const { allGoods, pageSize } = this.data

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
      display = filtered.slice(0, pageSize)
      canViewMore = filtered.length > pageSize
    } else {
      const cur = (this.data.displayGoods || []).length
      display = filtered.slice(0, cur)
      canViewMore = filtered.length > cur
    }

    this.setData({
      filteredGoods: filtered,
      displayGoods: display,
      // 既要考虑本地还有没展示的，也要考虑云端还有未拉取的
      canViewMore: canViewMore || !!this.data.cloudHasMore
    })

    this._fillThumbUrlsFor(display).catch(() => {})
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
      return { ...g, thumbUrl: url }
    }

    const nextAll = (this.data.allGoods || []).map(attachThumbUrl)
    const nextDisplay = (this.data.displayGoods || []).map(attachThumbUrl)
    this.setData({
      allGoods: nextAll,
      displayGoods: nextDisplay
    })
  },

  // ====== 缓存 ======
  _restoreGoodsFromCache() {
    try {
      const cached = wx.getStorageSync(GOODS_CACHE_KEY)
      if (!cached || !cached.ts || !Array.isArray(cached.list)) return false
      const cacheAge = Date.now() - cached.ts
      if (cacheAge > GOODS_CACHE_MAX_STALE_MS) return false

      const rows = (cached.list || []).filter(x => this._isVisibleMarketDoc(x)).map(x => this._mapDocToGood(x))
      this.setData({
        allGoods: rows,
        cloudSkip: rows.length,
        cloudHasMore: true
      })
      this.initRegionsFromGoods()
      this._fillThumbUrlsFor(rows).catch(() => {})
      return true
    } catch (e) {
      return false
    }
  },

  _saveGoodsToCache(list) {
    try {
      wx.setStorageSync(GOODS_CACHE_KEY, { ts: Date.now(), list })
    } catch (e) {}
  },

  _maybeRefreshGoods(force) {
    const now = Date.now()
    if (!force && now - (this._lastRefreshAt || 0) < REFRESH_DEBOUNCE_MS) return
    this._lastRefreshAt = now
    this._fetchFirstPage()
  }
})
