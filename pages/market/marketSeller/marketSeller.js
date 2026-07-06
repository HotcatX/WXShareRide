const LOGIN_PAGE = '/pages/other/login/login'
const {
  readMarketSellerProfile,
  fetchAndCacheMarketSellerProfiles
} = require("../../../utils/marketSellerProfileCache")
const MARKET_REFRESH_KEY = "market_goods_changed_at"
const SELLER_GOODS_CACHE_KEY_PREFIX = "market_seller_goods_cache_v1"
const SELLER_GOODS_CACHE_FRESH_MS = 10 * 60 * 1000
const SELLER_GOODS_CACHE_MAX_STALE_MS = 24 * 60 * 60 * 1000
const LISTING_TYPE_CONFIG = {
  goods: {
    label: "二手",
    navTitle: "卖家主页",
    bioTitle: "卖家介绍",
    goodsTitle: "正在出售",
    emptyTitle: "暂无在售商品",
    emptySubtitle: "可以稍后再回来看看",
    unit: "件",
    shareTitle: "二手商品",
    shareRole: "卖家",
    contactMissing: "卖家未填写联系方式",
    fallbackTitle: "未命名商品",
    fallbackImage: "/images/market.png",
    metaFallback: "闲置"
  },
  sublet: {
    label: "转租",
    navTitle: "发布者主页",
    bioTitle: "发布者介绍",
    goodsTitle: "正在转租",
    emptyTitle: "暂无转租房源",
    emptySubtitle: "可以稍后再回来看看",
    unit: "套",
    shareTitle: "转租房源",
    shareRole: "发布者",
    contactMissing: "发布者未填写联系方式",
    fallbackTitle: "未命名房源",
    fallbackImage: "/images/sublease.png",
    metaFallback: "转租"
  }
}

function normalizeListingType(value) {
  return String(value || "").toLowerCase() === "sublet" ? "sublet" : "goods"
}

function getListingTypeConfig(type) {
  return LISTING_TYPE_CONFIG[normalizeListingType(type)] || LISTING_TYPE_CONFIG.goods
}

function buildListingTypeTabs(activeType) {
  return ["goods", "sublet"].map(type => ({
    type,
    label: LISTING_TYPE_CONFIG[type].label,
    selectedClass: normalizeListingType(activeType) === type ? "selected" : ""
  }))
}

function safeDecodeURIComponent(value) {
  const text = String(value || "")
  try {
    return decodeURIComponent(text)
  } catch (e) {
    return text
  }
}

function formatMarketPrice(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(n % 1 === 0 ? 0 : 2) : "0"
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function buildSellerDisplay(seller = {}) {
  return {
    ...seller,
    avatarInitialDisplay: seller.avatarInitial || "卖",
    nameDisplay: seller.name || "未设置昵称",
    apartmentDisplay: seller.apartment || "",
    bioDisplay: seller.bio || "发布者暂未填写个人简介。"
  }
}

function buildSellerFromProfile(profile = {}) {
  return buildSellerDisplay({
    name: profile.nameDisplay || profile.name || "未设置昵称",
    avatarInitial: profile.avatarInitial || String(profile.nameDisplay || profile.name || "卖").slice(0, 1),
    region: profile.regionDisplay || profile.region || "区域未填",
    apartment: profile.apartmentDisplay || profile.apartment || "",
    wechatID: profile.wechatID || "",
    phone: profile.phone || "",
    bio: profile.bio || "",
    avatarUrl: profile.avatarRaw || "",
    avatarDisplay: profile.avatarDisplay || ""
  })
}

function buildContactText(seller = {}) {
  if (seller.wechatID) return "复制微信号"
  if (seller.phone) return "复制手机号"
  return "暂无联系方式"
}

function getMarketApiResult(res) {
  const result = res && res.result
  if (!result || result.ok === false) {
    throw new Error((result && (result.error || result.message)) || "market_api_failed")
  }
  return result
}

function getMarketGoodsChangedAt() {
  try {
    return Number(wx.getStorageSync(MARKET_REFRESH_KEY)) || 0
  } catch (e) {
    return 0
  }
}

function getSellerGoodsCacheKey(openid, type) {
  return `${SELLER_GOODS_CACHE_KEY_PREFIX}_${String(openid || "").trim()}_${normalizeListingType(type)}`
}

function readSellerGoodsCache(openid, type) {
  const key = getSellerGoodsCacheKey(openid, type)
  if (!openid) return null
  try {
    const cached = wx.getStorageSync(key)
    if (!cached || !cached.ts || !Array.isArray(cached.rows)) return null
    if (Date.now() - Number(cached.ts) > SELLER_GOODS_CACHE_MAX_STALE_MS) return null
    const changedAt = getMarketGoodsChangedAt()
    if (changedAt && Number(cached.changedAt || 0) !== changedAt) return null
    return cached
  } catch (e) {
    return null
  }
}

function writeSellerGoodsCache(openid, type, rows = []) {
  const key = getSellerGoodsCacheKey(openid, type)
  if (!openid || !Array.isArray(rows)) return
  try {
    wx.setStorageSync(key, {
      ts: Date.now(),
      changedAt: getMarketGoodsChangedAt(),
      rows
    })
  } catch (e) {}
}

function buildSellerGood(x = {}) {
  const listingType = normalizeListingType(x.listingType)
  const config = getListingTypeConfig(listingType)
  const title = String(x.title || '').trim() || config.fallbackTitle
  const imageKey = x.thumbFileID || x.imageFileID || ""
  const priceText = formatMarketPrice(x.price)
  const fallbackImage = config.fallbackImage
  const imageSrc = x.imageSrc || x.thumbUrl || imageKey || fallbackImage
  const metaText = listingType === "sublet"
    ? (x.leaseText || x.availableStartDate || x.roomType || x.category || config.metaFallback)
    : (x.condition || x.pickupEndDate || config.metaFallback)
  const descText = compactText(x.desc || metaText)
  return {
    id: x._id,
    listingType,
    cardClass: listingType === "sublet" ? "seller-listing--sublet" : "",
    title,
    price: x.price,
    priceText,
    priceDisplay: listingType === "sublet" ? `${priceText}/月` : priceText,
    metaText,
    descText,
    imageFileID: x.imageFileID || "",
    thumbFileID: x.thumbFileID || "",
    hasImage: !!(x.hasImage || x.imageFileID || x.thumbFileID || (Array.isArray(x.imageFileIDs) && x.imageFileIDs.length)),
    imageSrc,
    thumbUrl: x.thumbUrl || ""
  }
}

Page({
  data: {
    statusBarHeight: 0,
    activeListingType: "goods",
    listingTypeTabs: buildListingTypeTabs("goods"),
    navTitle: LISTING_TYPE_CONFIG.goods.navTitle,
    bioTitle: LISTING_TYPE_CONFIG.goods.bioTitle,
    sellerOpenid: "",
    seller: {
      name: "",
      region: "",
      apartment: "",
      wechatID: "",
      phone: "",
      bio: "",
      avatarUrl: "",
      avatarDisplay: "",
      avatarInitialDisplay: "卖",
      nameDisplay: "未设置昵称",
      apartmentDisplay: "公寓未填",
      bioDisplay: "发布者暂未填写个人简介。"
    },
    goods: [],
    hasGoods: false,
    goodsCountText: "0 件",
    goodsTitleMain: LISTING_TYPE_CONFIG.goods.goodsTitle,
    emptyTitle: LISTING_TYPE_CONFIG.goods.emptyTitle,
    emptySubtitle: LISTING_TYPE_CONFIG.goods.emptySubtitle,
    contactText: "暂无联系方式",
    dockVisibleClass: "dock-hidden"
  },

  onReady() {
    setTimeout(() => {
      this.setData({ dockVisibleClass: "" })
    }, 320)
  },

  onLoad(options) {
    const sys = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const activeListingType = normalizeListingType(options?.type || options?.listingType)
    const config = getListingTypeConfig(activeListingType)
    this.setData({
      statusBarHeight: sys.statusBarHeight || 0,
      activeListingType,
      listingTypeTabs: buildListingTypeTabs(activeListingType),
      navTitle: config.navTitle,
      bioTitle: config.bioTitle,
      goodsTitleMain: config.goodsTitle,
      emptyTitle: config.emptyTitle,
      emptySubtitle: config.emptySubtitle
    })

    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })

    const openid = options?.openid ? safeDecodeURIComponent(options.openid) : ""
    if (!openid) {
      wx.showToast({ title: "缺少发布者openid", icon: "none" })
      return
    }
    this.setData({ sellerOpenid: openid })

    this.fetchSellerInfo(openid)
    this.fetchSellerGoods(openid)
  },

  onShareAppMessage() {
    const { sellerOpenid, seller } = this.data
    const config = getListingTypeConfig(this.data.activeListingType)
    const title = seller?.name ? `看看 ${seller.name} 的${config.shareTitle}` : `查看${config.shareRole}${config.shareTitle}`
    return getApp().withReferralShare({
      title,
      path: `/pages/market/marketSeller/marketSeller?openid=${encodeURIComponent(sellerOpenid || '')}&type=${this.data.activeListingType || "goods"}`
    })
  },

  onShareTimeline() {
    const { sellerOpenid, seller } = this.data
    const config = getListingTypeConfig(this.data.activeListingType)
    const title = seller?.name ? `看看 ${seller.name} 的${config.shareTitle}` : `查看${config.shareRole}${config.shareTitle}`
    return getApp().withReferralShare({
      title,
      query: `openid=${encodeURIComponent(sellerOpenid || '')}&type=${this.data.activeListingType || "goods"}`
    })
  },

  onBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 })
      return
    }

    // 栈里只有当前页：说明是分享/收藏/redirect 进来的，必须回 tab
    wx.reLaunch({
      url: '/pages/market/market'
    })
  },

  // ✅ 复制联系方式前必须登录（允许游客浏览页面，但不能复制）
  ensureLoginBeforeCopy() {
    const openid = wx.getStorageSync('openid') || ''
    const isGuest = !!wx.getStorageSync('isGuest')

    // 已登录且非游客：放行
    if (openid && !isGuest) return true

    const sellerOpenid = this.data.sellerOpenid || ''
    const pendingUrl = `/pages/market/marketSeller/marketSeller?openid=${encodeURIComponent(sellerOpenid)}&type=${this.data.activeListingType || "goods"}`

    wx.setStorageSync('pendingPage', { url: pendingUrl })
    wx.setStorageSync('postLoginAction', {
      type: 'requireProfile',
      from: 'marketSeller',
      returnUrl: pendingUrl
    })

    wx.navigateTo({ url: LOGIN_PAGE })
    return false
  },

  async fetchSellerInfo(openid) {
    const cached = readMarketSellerProfile(openid, { allowStale: true })
    if (cached) {
      const sellerDisplay = buildSellerFromProfile(cached)
      this.setData({
        seller: sellerDisplay,
        contactText: buildContactText(sellerDisplay)
      })
      if (cached.isFresh) return
    }

    try {
      const profiles = await fetchAndCacheMarketSellerProfiles([openid])
      const profile = profiles && profiles[openid]
      if (!profile) return
      const sellerDisplay = buildSellerFromProfile(profile)
      this.setData({
        seller: sellerDisplay,
        contactText: buildContactText(sellerDisplay)
      })
    } catch (e) {
      console.error("fetchSellerInfo error", e)
      if (!cached) wx.showToast({ title: "获取发布者信息失败", icon: "none" })
    }
  },

  _applySellerGoodsRows(rows = []) {
    const goods = (Array.isArray(rows) ? rows : [])
      .filter(x => this._isVisibleMarketDoc(x))
      .map(buildSellerGood)

    this.setData({
      goods,
      hasGoods: goods.length > 0,
      goodsCountText: `${goods.length} ${getListingTypeConfig(this.data.activeListingType).unit}`
    })
  },

  async fetchSellerGoods(openid, options = {}) {
    const listingType = normalizeListingType(options.type || this.data.activeListingType)
    const cached = readSellerGoodsCache(openid, listingType)
    if (cached) {
      this._applySellerGoodsRows(cached.rows)
      const fresh = Date.now() - Number(cached.ts || 0) <= SELLER_GOODS_CACHE_FRESH_MS
      if (fresh && !options.force) return
    }

    try {
      const PAGE = 50
      const MAX_TOTAL = 1000

      let rows = []
      let skip = 0

      while (true) {
        const res = await wx.cloud.callFunction({
          name: "marketApi",
          data: {
            action: "sellerList",
            openid,
            listingType,
            filters: { listingType },
            skip,
            limit: PAGE
          }
        })
        const result = getMarketApiResult(res)

        const batch = result.items || result.data || []
        rows = rows.concat(batch)

        if (!result.hasMore || batch.length < PAGE) break
        skip = result.nextSkip || (skip + batch.length)
        if (rows.length >= MAX_TOTAL) break
      }

      writeSellerGoodsCache(openid, listingType, rows)
      if (normalizeListingType(this.data.activeListingType) === listingType && this.data.sellerOpenid === openid) {
        this._applySellerGoodsRows(rows)
      }
    } catch (e) {
      console.error("fetchSellerGoods error", e)
      if (!cached) wx.showToast({ title: "获取发布列表失败", icon: "none" })
    }
  },

  onSelectListingType(e) {
    const type = normalizeListingType(e.currentTarget.dataset.type)
    if (type === this.data.activeListingType) return
    const config = getListingTypeConfig(type)
    this.setData({
      activeListingType: type,
      listingTypeTabs: buildListingTypeTabs(type),
      navTitle: config.navTitle,
      bioTitle: config.bioTitle,
      goodsTitleMain: config.goodsTitle,
      emptyTitle: config.emptyTitle,
      emptySubtitle: config.emptySubtitle,
      goods: [],
      hasGoods: false,
      goodsCountText: `0 ${config.unit}`
    })
    if (this.data.sellerOpenid) this.fetchSellerGoods(this.data.sellerOpenid)
  },

  _isVisibleMarketDoc(x) {
    if (!x) return false
    const status = String(x.status || "online").toLowerCase()
    if (status === "deleted" || status === "offline" || status === "expired" || status === "sold") return false
    const expireTime = Number(x.expireTime) || 0
    if (expireTime && expireTime <= Date.now()) return false
    return true
  },

  onOpenGood(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/market/marketDetail/marketDetail?id=${id}` })
  },

  onCopyContact() {
    if (!this.ensureLoginBeforeCopy()) return
    const { wechatID, phone } = this.data.seller || {}
    const val = wechatID || phone || ""
    if (!val) {
      wx.showToast({ title: getListingTypeConfig(this.data.activeListingType).contactMissing, icon: "none" })
      return
    }
    wx.setClipboardData({
      data: val,
      success: () => {
        wx.showToast({
          title: wechatID ? "已复制微信号" : "已复制手机号",
          icon: "success"
        })
      }
    })
  }
})
