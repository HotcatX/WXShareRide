// pages/market/marketDetail/marketDetail.js
const LOGIN_PAGE = '/pages/other/login/login'
const MARKET_REFRESH_KEY = "market_goods_changed_at"
const MARKET_DETAIL_CACHE_KEY = "market_detail_cache_v2"
const MARKET_DETAIL_CACHE_FRESH_MS = 10 * 60 * 1000

const DETAIL_COPY = {
  goods: {
    navTitle: "商品详情",
    missingTitle: "商品不存在",
    missingDesc: "商品可能已删除或链接已失效。",
    pickupLabel: "可取时间",
    locationLabel: "取货位置",
    descTitle: "商品描述",
    sellerOtherText: "查看卖家其他商品",
    locationActionText: "查看取货位置",
    contactText: "联系购买",
    defaultTitle: "未命名商品",
    defaultCategory: "二手",
    defaultCondition: "成色未填",
    defaultDesc: "卖家暂未填写详细描述。",
    pickupModalTitle: "取货地点"
  },
  sublet: {
    navTitle: "转租详情",
    missingTitle: "房源不存在",
    missingDesc: "房源可能已删除或链接已失效。",
    pickupLabel: "入住/租期",
    locationLabel: "房源位置",
    descTitle: "房源描述",
    sellerOtherText: "查看发布者其他信息",
    locationActionText: "复制微信号",
    contactText: "联系转租",
    defaultTitle: "未命名房源",
    defaultCategory: "转租",
    defaultCondition: "房源",
    defaultDesc: "发布者暂未填写详细描述。",
    pickupModalTitle: "房源位置"
  }
}

function normalizeListingType(value) {
  return String(value || "").toLowerCase() === "sublet" ? "sublet" : "goods"
}

function getDetailCopy(type) {
  return DETAIL_COPY[normalizeListingType(type)] || DETAIL_COPY.goods
}

function formatMarketPrice(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(n % 1 === 0 ? 0 : 2) : '0'
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function formatAmountText(value) {
  const text = normalizeText(value)
  if (!text && text !== "0") return ""
  const n = Number(value)
  if (!Number.isFinite(n)) return text
  return n.toFixed(n % 1 === 0 ? 0 : 2)
}

function buildSubletLeaseText(x = {}) {
  const startText = normalizeText(x.availableStartDate || x.pickupStartDate)
  const endText = normalizeText(x.leaseEndDate || x.pickupEndDate || x.expiresAtText)
  if (startText && endText) return `${startText} 至 ${endText}`
  if (startText) return `${startText}起`
  if (endText) return `${endText}前有效`
  return ""
}

function buildSubletMetaList(x = {}) {
  if (Array.isArray(x.subletMetaList) && x.subletMetaList.length) return x.subletMetaList
  const rows = []
  const depositText = formatAmountText(x.deposit)
  if (depositText) rows.push({ label: "押金", value: `$ ${depositText}` })
  if (x.housingType) rows.push({ label: "房源类型", value: normalizeText(x.housingType) })
  if (x.roomType) rows.push({ label: "房间类型", value: normalizeText(x.roomType) })
  rows.push({ label: "家具", value: x.furnished ? "带家具" : "未标注" })
  rows.push({ label: "水电网", value: x.utilitiesIncluded ? "已包含" : "未包含/未标注" })
  if (x.genderPreference) rows.push({ label: "室友要求", value: normalizeText(x.genderPreference) })
  const roommateCountText = formatAmountText(x.roommateCount)
  if (roommateCountText) rows.push({ label: "室友数", value: `${roommateCountText} 人` })
  return rows
}

function buildDetailItem(x = {}) {
  const listingType = normalizeListingType(x.listingType)
  const copy = getDetailCopy(listingType)
  const title = String(x.title || '').trim() || copy.defaultTitle
  const imageFileIDs = Array.isArray(x.imageFileIDs) ? x.imageFileIDs.filter(Boolean) : []
  const hasOriginalImage = !!(x.imageUrl || x.imageFileID || imageFileIDs.length || (Array.isArray(x.imageUrls) && x.imageUrls.length))
  const fallbackImage = listingType === "sublet" ? "/images/sublease.png" : "/images/market.png"
  const subletLeaseText = buildSubletLeaseText(x)
  const pickupText = listingType === "sublet"
    ? (x.leaseText || subletLeaseText || x.pickupRangeText || x.pickupEndDate || x.expiresAtText || "联系发布者确认")
    : (x.pickupRangeText || x.pickupEndDate || x.expiresAtText || "联系卖家确认")
  const locationText = x.pickup || x.region || (listingType === "sublet" ? "发布者未填写" : "卖家未填写")
  const priceDisplay = listingType === "sublet" ? `${formatMarketPrice(x.price)}/月` : formatMarketPrice(x.price)
  const categoryDisplay = x.category || copy.defaultCategory
  const subletMetaList = listingType === "sublet" ? buildSubletMetaList(x) : []
  const conditionDisplay = listingType === "sublet"
    ? (x.subletSummary || x.roomType || x.housingType || x.availableStartDate || categoryDisplay || copy.defaultCondition)
    : (x.condition || copy.defaultCondition)

  return {
    id: x._id,
    listingType,
    detailPageClass: listingType === "sublet" ? "is-sublet-detail" : "",
    title,
    titleDisplay: title,
    price: x.price,
    priceText: formatMarketPrice(x.price),
    priceDisplay,
    category: categoryDisplay,
    categoryDisplay,
    region: x.region || '',
    condition: conditionDisplay,
    conditionDisplay,
    desc: x.desc || copy.defaultDesc,
    descDisplay: x.desc || copy.defaultDesc,
    postDate: x.postDate || '刚刚发布',
    postDateDisplay: x.postDate || '刚刚发布',
    imageFileID: x.imageFileID || "",
    thumbFileID: x.thumbFileID || "",
    imageFileIDs,
    thumbFileIDs: Array.isArray(x.thumbFileIDs) ? x.thumbFileIDs : [],
    hasImage: hasOriginalImage,
    fallbackImageSrc: x.imageUrl || x.imageFileID || imageFileIDs[0] || fallbackImage,
    fallbackImageTitle: title || (listingType === "sublet" ? "房源图片" : "商品图片"),
    pickupStartDate: x.pickupStartDate || "",
    pickupEndDate: x.pickupEndDate || x.expiresAtText || "",
    pickupRangeText: x.pickupRangeText || "",
    pickupText,
    locationText,
    expireTime: Number(x.expireTime) || 0,
    status: x.status || "online",
    wantCount: x.wantCount || 0,
    wantCountText: listingType === "sublet" ? `${Number(x.wantCount) || 0} 人关注` : `${Number(x.wantCount) || 0} 人想要`,
    viewCount: x.viewCount || 0,
    viewCountText: `${Number(x.viewCount) || 0} 人浏览`,
    _openid: x._openid,
    pickup: x.pickup || x.region || "",
    navTitle: copy.navTitle,
    pickupLabel: copy.pickupLabel,
    locationLabel: copy.locationLabel,
    descTitle: copy.descTitle,
    sellerOtherText: copy.sellerOtherText,
    locationActionText: copy.locationActionText,
    contactText: copy.contactText,
    pickupModalTitle: copy.pickupModalTitle,
    subletMetaList,
    hasSubletMeta: subletMetaList.length > 0
  }
}

function getMarketApiResult(res) {
  const result = res && res.result
  if (!result || result.ok === false) {
    const err = new Error((result && (result.error || result.message)) || "market_api_failed")
    err.code = result && (result.error || result.message)
    throw err
  }
  return result
}

function markMarketGoodsChanged() {
  try {
    wx.setStorageSync(MARKET_REFRESH_KEY, Date.now())
  } catch (e) {}
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

function removeMarketDetailCache(id) {
  const key = String(id || "").trim()
  if (!key) return
  const store = getMarketDetailCacheStore()
  if (!store[key]) return
  delete store[key]
  setMarketDetailCacheStore(store)
}

function normalizeDetailResult(result = {}) {
  const item = result.item || result.data || null
  if (!item || !item._id) return null
  const rawUrls = Array.isArray(result.imgUrls)
    ? result.imgUrls
    : (Array.isArray(item.imageUrls) ? item.imageUrls : [])
  const imgUrls = rawUrls.filter((url, index, arr) => url && arr.indexOf(url) === index)
  return {
    item,
    imgUrls,
    imgUrl: result.imgUrl || item.imageUrl || imgUrls[0] || "",
    isOwner: !!result.isOwner
  }
}

function isMarketNotFoundError(error) {
  const text = String((error && (error.code || error.message || error.errMsg)) || "")
  return text === "not_found" || text === "missing_id" || text.includes("not_found")
}

function buildDefaultSeller(listingType = "goods") {
  return {
    nameDisplay: normalizeListingType(listingType) === "sublet" ? "转租发布者" : "二手卖家",
    avatarDisplay: "/images/profile.png",
    regionDisplay: "区域未填"
  }
}

Page({
  data: {
    statusBarHeight: 0,
    item: null,
    detailNavTitle: "商品详情",
    loading: true,
    notFound: false,
    loadError: false,
    showDetailState: true,
    detailStateTitle: "正在加载内容...",
    detailStateDesc: "请稍候",
    detailCanRetry: false,

    isOwner: false,
    myOpenid: '',
    imgUrl: "",

    imgUrls: [],
    hasImageUrls: false,
    hasMultipleImages: false,

    seller: buildDefaultSeller("goods"),
    sellerWechat: "",
    dockVisibleClass: "dock-hidden"
  },

  onReady() {
    setTimeout(() => {
      this.setData({ dockVisibleClass: "" })
    }, 320)
  },

  // =========================
  // 分享：好友 & 朋友圈
  // =========================
  onShareAppMessage() {
    const { item } = this.data
    const id = (item && item.id) ? item.id : ''
    const title = item
      ? `${item.title || (item.listingType === "sublet" ? "房源" : "商品")}${(item.price !== undefined && item.price !== null) ? ` $${item.price}${item.listingType === "sublet" ? "/月" : ""}` : ''}`
      : '查看市场详情'

    return getApp().withReferralShare({
      title: String(title).trim().slice(0, 30) || '查看市场详情',
      path: `/pages/market/marketDetail/marketDetail?id=${id}`,
    })
  },

  onShareTimeline() {
    const { item } = this.data
    const id = (item && item.id) ? item.id : ''
    const title = item
      ? `${item.title || (item.listingType === "sublet" ? "房源" : "商品")}${(item.price !== undefined && item.price !== null) ? ` $${item.price}${item.listingType === "sublet" ? "/月" : ""}` : ''}`
      : '查看市场详情'

    return getApp().withReferralShare({
      title: String(title).trim().slice(0, 30) || '查看市场详情',
      query: `id=${id}`
    })
  },

  // =========================
  // 登录拦截：联系购买前必须登录
  // =========================
  ensureLoginBeforeContact() {
    const openid = wx.getStorageSync('openid') || ''
    const isGuest = !!wx.getStorageSync('isGuest')

    if (openid && !isGuest) return true

    const id = this.data.item?.id || ''
    const pendingUrl = `/pages/market/marketDetail/marketDetail?id=${id}`

    wx.setStorageSync('pendingPage', { url: pendingUrl })
    wx.setStorageSync('postLoginAction', {
      type: 'requireProfile',
      from: 'marketDetail',
      returnUrl: pendingUrl
    })

    wx.navigateTo({ url: LOGIN_PAGE })
    return false
  },

  async _getSellerWechatByOpenid(openid) {
    if (this.data.sellerWechat) return this.data.sellerWechat

    try {

      const res = await wx.cloud.callFunction({
        name: "getUserInfoByOpenids",
        data: { openids: [openid] }
      })

      const row = res?.result?.data?.[0] || null
      const wechat =
        row?.wechatID ||
        row?.wechatId ||
        row?.wechat ||
        ""

      this.setData({ sellerWechat: wechat })
      return wechat
    } catch (e) {
      console.error(e)
      return ""
    } finally {
    }
  },

  async _resolveAvatarUrl(rawAvatar) {
    if (!rawAvatar) return "/images/profile.png"
    if (/^https?:\/\//i.test(rawAvatar) || rawAvatar.startsWith("/")) return rawAvatar
    if (rawAvatar.startsWith("cloud://")) {
      const res = await wx.cloud.getTempFileURL({ fileList: [rawAvatar] }).catch(() => null)
      return res?.fileList?.[0]?.tempFileURL || "/images/profile.png"
    }
    return rawAvatar
  },

  async fetchSellerProfile(openid, listingType) {
    if (!openid) {
      this.setData({ seller: buildDefaultSeller(listingType) })
      return
    }
    try {
      const res = await wx.cloud.callFunction({
        name: "getUserInfoByOpenids",
        data: { openids: [openid] }
      })
      const row = res?.result?.data?.[0] || {}
      const avatarRaw = normalizeText(row.avatarUrl || row.avatar || row.userInfo?.avatarUrl)
      const seller = {
        nameDisplay: normalizeText(row.name || row.nickName || row.nickname) || buildDefaultSeller(listingType).nameDisplay,
        avatarDisplay: await this._resolveAvatarUrl(avatarRaw),
        regionDisplay: normalizeText(row.bigregion || row.location || row.region || row.address) || "区域未填"
      }
      const wechat = row.wechatID || row.wechatId || row.wechat || ""
      this.setData({ seller, sellerWechat: wechat })
    } catch (e) {
      console.error("fetch seller profile failed:", e)
      this.setData({ seller: buildDefaultSeller(listingType) })
    }
  },

  onLoad(options) {
    const sys = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBarHeight: sys.statusBarHeight || 0 })

    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })

    const id = options?.id
    if (!id) {
      this.setData({
        loading: false,
        notFound: true,
        loadError: false,
        showDetailState: true,
        detailStateTitle: "内容不存在",
        detailStateDesc: "缺少内容 id，无法打开详情。",
        detailCanRetry: false,
        item: null,
        detailNavTitle: "商品详情",
        isOwner: false,
        imgUrls: [],
        imgUrl: "",
        hasImageUrls: false,
        hasMultipleImages: false,
        seller: buildDefaultSeller("goods"),
        sellerWechat: ""
      })
      return
    }
    this.fetchDetail(id)
  },

  onShow() {
    const tip = wx.getStorageSync('needLoginToast')
    if (tip) {
      wx.removeStorageSync('needLoginToast')
      wx.showToast({ title: tip, icon: 'none', duration: 2000 })
    }

    // 重新计算一次 owner（避免登录/退出后状态不一致）
    const myOpenid = wx.getStorageSync('openid') || ''
    const isOwner = !!(myOpenid && this.data.item?._openid && myOpenid === this.data.item._openid)
    this.setData({ myOpenid, isOwner })
  },

  _setDetailState(title, desc, options = {}) {
    const notFound = !!options.notFound
    const loadError = !!options.loadError
    this.setData({
      loading: false,
      notFound,
      loadError,
      showDetailState: true,
      detailStateTitle: title,
      detailStateDesc: desc,
      detailCanRetry: !!options.canRetry,
      item: null,
      detailNavTitle: "商品详情",
      isOwner: false,
      imgUrls: [],
      imgUrl: "",
      hasImageUrls: false,
      hasMultipleImages: false,
      seller: buildDefaultSeller("goods"),
      sellerWechat: ""
    })
  },

  _applyDetailResult(result, options = {}) {
    const normalized = normalizeDetailResult(result)
    if (!normalized) return false

    const detailItem = buildDetailItem(normalized.item)
    const myOpenid = wx.getStorageSync('openid') || ''
    const isOwner = !!(myOpenid && detailItem._openid && myOpenid === detailItem._openid) ||
      (!options.fromCache && !!normalized.isOwner)
    const imgUrls = normalized.imgUrls

    this.setData({
      loading: false,
      notFound: false,
      loadError: false,
      showDetailState: false,
      detailStateTitle: "",
      detailStateDesc: "",
      detailCanRetry: false,
      myOpenid,
      isOwner,
      item: detailItem,
      detailNavTitle: detailItem.navTitle || "商品详情",
      imgUrls,
      imgUrl: normalized.imgUrl,
      hasImageUrls: imgUrls.length > 0,
      hasMultipleImages: imgUrls.length > 1
    })
    this.fetchSellerProfile(detailItem._openid, detailItem.listingType)
    return true
  },

  async fetchDetail(id) {
    const detailId = String(id || "").trim()
    this._lastDetailId = detailId
    const requestToken = `${detailId}|${Date.now()}`
    this._detailRequestToken = requestToken

    const cached = readMarketDetailCache(detailId)
    if (cached) {
      this._applyDetailResult(cached, { fromCache: true })
    } else {
      this.setData({
        loading: true,
        notFound: false,
        loadError: false,
        showDetailState: true,
        detailStateTitle: "正在加载内容...",
        detailStateDesc: "请稍候",
        detailCanRetry: false,
        item: null,
        detailNavTitle: "商品详情",
        isOwner: false,
        imgUrls: [],
        imgUrl: "",
        hasImageUrls: false,
        hasMultipleImages: false,
        seller: buildDefaultSeller("goods"),
        sellerWechat: ""
      })
    }

    try {
      const res = await wx.cloud.callFunction({
        name: "marketApi",
        data: { action: "detail", id: detailId, trackView: true }
      })
      if (this._detailRequestToken !== requestToken) return

      const result = getMarketApiResult(res)
      const normalized = normalizeDetailResult(result)
      if (!normalized) {
        removeMarketDetailCache(detailId)
        this._setDetailState("内容不存在", "内容可能已删除或链接已失效。", { notFound: true })
        return
      }

      writeMarketDetailCache(detailId, result)
      this._applyDetailResult(result)
    } catch (e) {
      if (this._detailRequestToken !== requestToken) return
      console.error(e)
      const notFound = isMarketNotFoundError(e)
      if (notFound) {
        removeMarketDetailCache(detailId)
        this._setDetailState("内容不存在", "内容可能已删除或链接已失效。", { notFound: true })
        return
      }

      if (cached) {
        this.setData({
          loading: false,
          loadError: false,
          showDetailState: false,
          detailCanRetry: false
        })
        return
      }

      this._setDetailState("加载失败", "详情加载失败，请稍后重试。", {
        loadError: true,
        canRetry: true
      })
      wx.showToast({ title: "获取详情失败", icon: "none" })
    }
  },

  onRetryLoad() {
    if (!this._lastDetailId) return
    this.fetchDetail(this._lastDetailId)
  },

  // =========================
  // 本人发布：编辑 / 删除
  // =========================
  onEditItem() {
    if (!this.data.isOwner) {
      wx.showToast({ title: '只能编辑自己发布的内容', icon: 'none' })
      return
    }

    const id = this.data.item?.id
    if (!id) return

    wx.navigateTo({
      url: `/pages/market/marketPost/marketPost?id=${id}&mode=edit&type=${this.data.item?.listingType || "goods"}`
    })
  },

  async onDeleteItem() {
    if (!this.data.isOwner) {
      wx.showToast({ title: '只能删除自己发布的内容', icon: 'none' })
      return
    }

    const id = this.data.item?.id
    if (!id) return

    const ok = await new Promise(resolve => {
      wx.showModal({
        title: '确认删除',
        content: `删除后无法恢复，确定要删除该${this.data.item?.listingType === "sublet" ? "房源" : "商品"}吗？`,
        confirmText: '删除',
        confirmColor: '#E54D42',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false)
      })
    })
    if (!ok) return

    try {
      const res = await wx.cloud.callFunction({
        name: 'marketApi',
        data: { action: "delete", id }
      })
      getMarketApiResult(res)

      markMarketGoodsChanged()
      wx.showToast({ title: '已删除', icon: 'success' })
      wx.navigateBack({ delta: 1 })
    } catch (e) {
      console.error(e)
      wx.showToast({ title: '删除失败', icon: 'none' })
    } finally {
    }
  },

  onBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 })
      return
    }

    // 栈里只有当前页：说明是分享/收藏/redirect 进来的，必须回 tab
    wx.reLaunch({
      url: '/pages/market/market'   // ← 改成你的“主页面/拼车所在 tab 页”
    })
  },

  onViewSellerProfile() {
    const openid = this.data.item?._openid
    if (!openid) return
    wx.navigateTo({ url: `/pages/market/marketSeller/marketSeller?openid=${encodeURIComponent(openid)}&type=${this.data.item?.listingType || "goods"}` })
  },

  onDetailQuickAction() {
    if (this.data.item?.listingType === "sublet") {
      return this.onContactSeller()
    }
    return this.onPickupInfo()
  },

  onPickupInfo() {
    const pickup = this.data.item?.pickup || ''
    if (!pickup) return
    wx.showModal({
      title: this.data.item?.pickupModalTitle || '取货地点',
      content: String(pickup),
      confirmText: '复制',
      cancelText: '关闭',
      success: (r) => {
        if (r.confirm) {
          wx.setClipboardData({
            data: String(pickup),
            success: () => wx.showToast({ title: '已复制', icon: 'success' })
          })
        }
      }
    })
  },

  async onContactSeller() {
    if (!this.ensureLoginBeforeContact()) return
    const openid = this.data.item?._openid
    if (!openid) {
      wx.showToast({ title: "发布者信息缺失", icon: "none" })
      return
    }

    const wechat = await this._getSellerWechatByOpenid(openid)
    if (!wechat) {
      wx.showToast({ title: "未填写微信号", icon: "none" })
      return
    }

    wx.setClipboardData({
      data: wechat,
      success: () => wx.showToast({ title: "微信号已复制", icon: "success" })
    })
  }
})
