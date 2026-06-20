// pages/market/marketDetail/marketDetail.js
const LOGIN_PAGE = '/pages/other/login/login'
const MARKET_REFRESH_KEY = "market_goods_changed_at"

function formatMarketPrice(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(n % 1 === 0 ? 0 : 2) : '0'
}

function buildDetailItem(x = {}) {
  const title = String(x.title || '').trim() || '未命名商品'
  const pickupText = x.pickupRangeText || x.pickupEndDate || x.expiresAtText || '联系卖家确认'
  const locationText = x.pickup || x.region || '卖家未填写'
  const hasImage = !!(x.hasImage || x.imageFileID || x.thumbFileID || (Array.isArray(x.imageFileIDs) && x.imageFileIDs.length))

  return {
    id: x._id,
    title,
    titleDisplay: title,
    price: x.price,
    priceText: formatMarketPrice(x.price),
    priceDisplay: formatMarketPrice(x.price),
    category: x.category || '二手',
    categoryDisplay: x.category || '二手',
    region: x.region || '',
    condition: x.condition || '成色未填',
    conditionDisplay: x.condition || '成色未填',
    desc: x.desc || '卖家暂未填写详细描述。',
    descDisplay: x.desc || '卖家暂未填写详细描述。',
    postDate: x.postDate || '刚刚发布',
    postDateDisplay: x.postDate || '刚刚发布',
    imageFileID: x.imageFileID || "",
    thumbFileID: x.thumbFileID || "",
    imageFileIDs: Array.isArray(x.imageFileIDs) ? x.imageFileIDs : [],
    thumbFileIDs: Array.isArray(x.thumbFileIDs) ? x.thumbFileIDs : [],
    hasImage,
    fallbackImageSrc: x.imageFileID || x.thumbFileID || '/images/market.png',
    fallbackImageTitle: title || '商品图片',
    pickupStartDate: x.pickupStartDate || "",
    pickupEndDate: x.pickupEndDate || x.expiresAtText || "",
    pickupRangeText: x.pickupRangeText || "",
    pickupText,
    locationText,
    expireTime: Number(x.expireTime) || 0,
    status: x.status || "online",
    wantCount: x.wantCount || 0,
    wantCountText: `${Number(x.wantCount) || 0} 人想要`,
    viewCount: x.viewCount || 0,
    viewCountText: `${Number(x.viewCount) || 0} 人浏览`,
    _openid: x._openid,
    pickup: x.pickup || x.region || ""
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

function isMarketNotFoundError(error) {
  const text = String((error && (error.code || error.message || error.errMsg)) || "")
  return text === "not_found" || text === "missing_id" || text.includes("not_found")
}

Page({
  data: {
    statusBarHeight: 0,
    item: null,
    loading: true,
    notFound: false,
    loadError: false,
    showDetailState: true,
    detailStateTitle: "正在加载商品...",
    detailStateDesc: "请稍候",
    detailCanRetry: false,

    // ✅ 是否本人发布（用于显示编辑/删除）
    isOwner: false,
    myOpenid: '',

    // 兼容旧逻辑：保留 imgUrl
    imgUrl: "",

    imgUrls: [],
    hasImageUrls: false,
    hasMultipleImages: false,

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
      ? `${item.title || '商品'}${(item.price !== undefined && item.price !== null) ? ` $${item.price}` : ''}`
      : '查看商品详情'

    return getApp().withReferralShare({
      title: String(title).trim().slice(0, 30) || '查看商品详情',
      path: `/pages/market/marketDetail/marketDetail?id=${id}`,
    })
  },

  onShareTimeline() {
    const { item } = this.data
    const id = (item && item.id) ? item.id : ''
    const title = item
      ? `${item.title || '商品'}${(item.price !== undefined && item.price !== null) ? ` $${item.price}` : ''}`
      : '查看商品详情'

    return getApp().withReferralShare({
      title: String(title).trim().slice(0, 30) || '查看商品详情',
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
        detailStateTitle: "商品不存在",
        detailStateDesc: "缺少商品 id，无法打开详情。",
        detailCanRetry: false,
        item: null,
        isOwner: false,
        imgUrls: [],
        imgUrl: "",
        hasImageUrls: false,
        hasMultipleImages: false
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

  async fetchDetail(id) {
    this._lastDetailId = id
    this.setData({
      loading: true,
      notFound: false,
      loadError: false,
      showDetailState: true,
      detailStateTitle: "正在加载商品...",
      detailStateDesc: "请稍候",
      detailCanRetry: false,
      item: null,
      isOwner: false,
      imgUrls: [],
      imgUrl: "",
      hasImageUrls: false,
      hasMultipleImages: false
    })

    try {
      const res = await wx.cloud.callFunction({
        name: "marketApi",
        data: { action: "detail", id }
      })
      const result = getMarketApiResult(res)
      const x = result.item || result.data || null
      if (!x || !x._id) {
        this.setData({
          loading: false,
          notFound: true,
          loadError: false,
          showDetailState: true,
          detailStateTitle: "商品不存在",
          detailStateDesc: "商品可能已删除或链接已失效。",
          detailCanRetry: false,
          item: null,
          isOwner: false,
          imgUrls: [],
          imgUrl: "",
          hasImageUrls: false,
          hasMultipleImages: false
        })
        return
      }
      const imgUrls = Array.isArray(result.imgUrls) ? result.imgUrls : (Array.isArray(x.imageUrls) ? x.imageUrls : [])

      const myOpenid = wx.getStorageSync('openid') || ''
      const isOwner = !!result.isOwner

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
        item: buildDetailItem(x),
        imgUrls,
        imgUrl: result.imgUrl || x.imageUrl || imgUrls[0] || "",
        hasImageUrls: imgUrls.length > 0,
        hasMultipleImages: imgUrls.length > 1
      })
    } catch (e) {
      console.error(e)
      const notFound = isMarketNotFoundError(e)
      this.setData({
        loading: false,
        notFound,
        loadError: !notFound,
        showDetailState: true,
        detailStateTitle: notFound ? "商品不存在" : "加载失败",
        detailStateDesc: notFound ? "商品可能已删除或链接已失效。" : "商品详情加载失败，请稍后重试。",
        detailCanRetry: !notFound,
        item: null,
        isOwner: false,
        imgUrls: [],
        imgUrl: "",
        hasImageUrls: false,
        hasMultipleImages: false
      })
      if (!notFound) wx.showToast({ title: "获取详情失败", icon: "none" })
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
      wx.showToast({ title: '只能编辑自己发布的商品', icon: 'none' })
      return
    }

    const id = this.data.item?.id
    if (!id) return

    wx.navigateTo({
      url: `/pages/market/marketPost/marketPost?id=${id}&mode=edit`
    })
  },

  async onDeleteItem() {
    if (!this.data.isOwner) {
      wx.showToast({ title: '只能删除自己发布的商品', icon: 'none' })
      return
    }

    const id = this.data.item?.id
    if (!id) return

    const ok = await new Promise(resolve => {
      wx.showModal({
        title: '确认删除',
        content: '删除后无法恢复，确定要删除该商品吗？',
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

  onViewSellerOther() {
    if (!this.ensureLoginBeforeContact()) return
    const openid = this.data.item?._openid
    if (!openid) return
    wx.navigateTo({ url: `/pages/market/marketSeller/marketSeller?openid=${openid}` })
  },

  // =========================
  // 联系购买：兼容旧 wxml 里的 onContactBuy
  // =========================
  onContactBuy() {
    return this.onContactSeller()
  },

  onPickupInfo() {
    const pickup = this.data.item?.pickup || ''
    if (!pickup) return
    wx.showModal({
      title: '取货地点',
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
      wx.showToast({ title: "卖家信息缺失", icon: "none" })
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
