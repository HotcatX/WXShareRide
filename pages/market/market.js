// 与 marketPost 保持一致：分类顺序固定
const { createTimer, trackDuration, trackEvent } = require("../../utils/analytics")

const CATEGORY_OPTIONS = ["家具", "厨具", "电器", "服包鞋饰", "电子产品", "运动装备", "其他"]

// ====== Performance / Cache ======
const GOODS_CACHE_KEY = "market_goods_list_cache_v2"
const THUMB_CACHE_KEY = "market_thumburl_cache_v1"
const GOODS_CACHE_MAX_STALE_MS = 24 * 60 * 60 * 1000 // 24h 内先用旧缓存秒开，再后台刷新
const REFRESH_DEBOUNCE_MS = 30 * 1000             // 30 sec
const MARKET_GOODS_LIST_FIELDS = {
  _id: true,
  title: true,
  price: true,
  category: true,
  region: true,
  condition: true,
  postDate: true,
  imageFileID: true,
  thumbFileID: true,
  createTime: true
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
      // imageUrl: 'cloud://xxx/xxx.jpg' // 可选：自定义分享封面
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
      // imageUrl: 'cloud://xxx/xxx.jpg' // 可选
    }
  },

  onTogglePriceSort() {
    const cur = this.data.priceSortOrder || 'none'
    const next = cur === 'none' ? 'asc' : (cur === 'asc' ? 'desc' : 'none')
    this.setData({ priceSortOrder: next })
    // 排序不需要重新拉云端，直接对当前已拉取结果排序+切片即可
    this.applyFilters(true)
  },

  onLoad() {
    trackEvent("page_view", {
      module: "market",
      action: "view",
      source: "market_list"
    })

    this.setData({ statusBarHeight: this._getStatusBarHeight() })

    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })

    this._thumbUrlCache = wx.getStorageSync(THUMB_CACHE_KEY) || {}
    this._lastRefreshAt = 0

    this.initCategoriesFromGoods()
    this.loadRegionTreeFromCloud()

    // 先用缓存秒开，再后台刷新
    this._restoreGoodsFromCache()
    this.applyFilters(true)

    // 后台刷新一次（避免缓存为空）
    this._maybeRefreshGoods(true)
  },

  onShow() {
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
    trackEvent("market_search_submit", {
      module: "market",
      action: "search",
      result: "submit"
    })

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
    trackEvent("market_filter_click", {
      module: "market",
      action: "filter",
      filterName: "category",
      filterValue: cat || "全部"
    })

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
    trackEvent("market_detail_load", {
      module: "market",
      action: "click",
      source: "market_list"
    })
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

  // ====== 地区树（保持你原来的逻辑）======
  async loadRegionTreeFromCloud() {
    const fallback = [{ label: "全部", children: [{ label: "全部", children: ["全部"] }] }]

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
      if (!Array.isArray(tree) || !tree.length) tree = fallback

      // ✅ 确保顶层永远有 “全部”
      const allNode = { label: "全部", children: [{ label: "全部", children: ["全部"] }] }
      if (!tree.some(x => x && x.label === "全部")) {
        tree = [allNode, ...tree]
      }

      const col1 = tree.map(x => x.label)
      const lv1 = tree[0] || fallback[0]
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
      this.setData({
        regionTree: fallback,
        regionPickerValue: [0, 0, 0],
        regionCol1: ["全部"],
        regionCol2: ["全部"],
        regionCol3: ["全部"]
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
    return {
      id: x._id,
      title: x.title,
      price: x.price,
      category: CATEGORY_OPTIONS.includes(x.category) ? x.category : "其他",
      region: x.region,
      condition: x.condition,
      desc: x.desc,
      postDate: x.postDate,

      // 旧字段
      imageFileID: x.imageFileID || "",

      // 新字段（可没有，兼容老数据）
      thumbFileID: x.thumbFileID || "",

      // temp url（优先 thumbFileID，否则 imageFileID）
      thumbUrl: thumbKey ? (this._thumbUrlCache[thumbKey] || "") : ""
    }
  },

  // ====== 构造云端查询条件（类目/地区/关键字）======
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

    // 3) keyword：title/desc 模糊匹配（可选）
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

  // ====== 重点修复：按【当前筛选条件】在云端分页拉取 ======
  async _fetchFirstPage() {
    const startedAt = createTimer()
    try {
      this.setData({ isLoadingGoods: true })

      const db = wx.cloud.database()
      const col = db.collection("market_goods")
      const where = this._buildCloudWhere()

      const res = await this._getMarketGoodsPage(col, where, { limit: INITIAL_LOAD_SIZE })

      const rows = (res.data || []).map(x => this._mapDocToGood(x))

      this.setData({
        // allGoods 代表“当前筛选条件下已加载到前端的全集（分页累积）”
        allGoods: rows,
        cloudSkip: rows.length,
        cloudHasMore: rows.length === INITIAL_LOAD_SIZE
      })

      // ✅ 只缓存“全部 + 无关键字 + 无地区”的列表，避免把“某个类目结果”当成全量缓存
      if (this.data.activeCategory === "全部" && this.data.activeRegion === "全部" && !(this.data.keyword || "").trim()) {
        this._saveGoodsToCache(res.data || [])
      }

      this.initRegionsFromGoods()
      // 云端已筛选，这里只做排序 + 前端切片展示。图片临时链接后台补，不能阻塞首屏。
      this.applyFilters(true)
      trackDuration("market_list_load", startedAt, {
        module: "market",
        action: "load",
        result: "success",
        category: this.data.activeCategory || "全部",
        region: this.data.activeRegion || "全部",
        listCount: rows.length
      })
    } catch (e) {
      console.error(e)
      trackDuration("market_list_load", startedAt, {
        module: "market",
        action: "load",
        result: "fail",
        category: this.data.activeCategory || "全部",
        region: this.data.activeRegion || "全部",
        errorCode: e && (e.errMsg || e.message) ? String(e.errMsg || e.message).slice(0, 80) : "unknown"
      })
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

      const batch = (res.data || []).map(x => this._mapDocToGood(x))
      const all = [...(this.data.allGoods || []), ...batch]

      this.setData({
        allGoods: all,
        cloudSkip: all.length,
        cloudHasMore: (res.data || []).length === CLOUD_PAGE_SIZE
      })

      // 同上：只缓存“全量列表”的结果
      if (this.data.activeCategory === "全部" && this.data.activeRegion === "全部" && !(this.data.keyword || "").trim()) {
        this._saveGoodsToCache([...(wx.getStorageSync(GOODS_CACHE_KEY)?.list || []), ...(res.data || [])])
      }

      this.initRegionsFromGoods()
      this.applyFilters(resetPagingAfterAppend)
    } catch (e) {
      console.error(e)
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

    // price sort（必须在 slice 前做）
    const order = this.data.priceSortOrder || 'none'
    if (order !== 'none') {
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

      const rows = (cached.list || []).map(x => this._mapDocToGood(x))
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
