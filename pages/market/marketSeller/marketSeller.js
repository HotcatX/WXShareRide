const LOGIN_PAGE = '/pages/other/login/login'

Page({
  data: {
    statusBarHeight: 0,
    sellerOpenid: "",
    seller: {
      name: "",
      region: "",
      apartment: "",
      wechatID: "",
      phone: "",
      bio: "",
      avatarUrl: "",
      avatarDisplay: "" // 真正用于 <image src=""> 的地址（http 或 tempURL）
    },
    goods: []
  },

  onLoad(options) {
    const sys = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: sys.statusBarHeight || 0 })

    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })

    const openid = options?.openid ? decodeURIComponent(options.openid) : ""
    if (!openid) {
      wx.showToast({ title: "缺少卖家openid", icon: "none" })
      return
    }
    this.setData({ sellerOpenid: openid })

    this.fetchSellerInfo(openid)
    this.fetchSellerGoods(openid)
  },

  onShareAppMessage() {
    const { sellerOpenid, seller } = this.data
    const title = seller?.name ? `看看 ${seller.name} 的二手商品` : '查看卖家二手商品'
    return {
      title,
      path: `/pages/market/marketSeller/marketSeller?openid=${encodeURIComponent(sellerOpenid || '')}`
    }
  },

  onShareTimeline() {
    const { sellerOpenid, seller } = this.data
    const title = seller?.name ? `看看 ${seller.name} 的二手商品` : '查看卖家二手商品'
    return {
      title,
      query: `openid=${encodeURIComponent(sellerOpenid || '')}`
    }
  },

  onBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 })
      return
    }
  
    // 栈里只有当前页：说明是分享/收藏/redirect 进来的，必须回 tab
    wx.switchTab({
      url: '/pages/market/market'   // ← 改成你的“主页面/拼车所在 tab 页”
    })
  },
  
  // ✅ 复制联系方式前必须登录（允许游客浏览页面，但不能复制）
  ensureLoginBeforeCopy() {
    const openid = wx.getStorageSync('openid') || ''
    const isGuest = !!wx.getStorageSync('isGuest')

    // 已登录且非游客：放行
    if (openid && !isGuest) return true

    const sellerOpenid = this.data.sellerOpenid || ''
    const pendingUrl = `/pages/market/marketSeller/marketSeller?openid=${encodeURIComponent(sellerOpenid)}`

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
    try {
      const res = await wx.cloud.callFunction({
        name: "getUserInfoByOpenids",
        data: { openids: [openid] }
      })

      const u = res?.result?.data?.[0] || {}

      // 1) 头像字段容错：你表里是 avatarUrl（截图里就是这个）
      const rawAvatar =
        u.avatarUrl ||
        u.avatar ||
        u.userInfo?.avatarUrl ||
        ""

      // 2) 组装 seller 基础信息
      const seller = {
        name: u.name || u.nickName || u.nickname || "未设置昵称",
        region: u.bigregion || u.location || u.region || "",
        apartment: u.address || u.dorm || u.addr || u.apartment || "",
        wechatID: u.wechatID || u.wechat || "",
        phone: u.phone || "",
        bio: u.bio || u.intro || u.signature || "",
        avatarUrl: rawAvatar,
        avatarDisplay: ""
      }

      // 3) 把 cloud:// 头像转成可展示的临时 https URL
      seller.avatarDisplay = await this._resolveAvatarUrl(rawAvatar)

      this.setData({ seller })
    } catch (e) {
      console.error("fetchSellerInfo error", e)
      wx.showToast({ title: "获取卖家信息失败", icon: "none" })
    }
  },

  async _resolveAvatarUrl(rawAvatar) {
    if (!rawAvatar) return ""

    // 已经是 http(s)（getUserInfo/getUserProfile 的 avatarUrl 一般是 https）
    if (/^https?:\/\//i.test(rawAvatar)) return rawAvatar

    // cloud fileID：cloud://xxx
    if (typeof rawAvatar === "string" && rawAvatar.startsWith("cloud://")) {
      try {
        const tmp = await wx.cloud.getTempFileURL({ fileList: [rawAvatar] })
        return tmp?.fileList?.[0]?.tempFileURL || ""
      } catch (e) {
        console.error("resolve avatar temp url error", e)
        return ""
      }
    }

    // 其它情况（比如你自己存了相对路径等）
    return rawAvatar
  },

  async fetchSellerGoods(openid) {
    try {
      const db = wx.cloud.database()
      const PAGE = 20
      const MAX_TOTAL = 1000
  
      let rows = []
      let skip = 0
  
      while (true) {
        const res = await db.collection("market_goods")
          .where({ _openid: openid })
          .orderBy("createTime", "desc")
          .skip(skip)
          .limit(PAGE)
          .get()
  
        const batch = res.data || []
        rows = rows.concat(batch)
  
        if (batch.length < PAGE) break
        skip += PAGE
        if (rows.length >= MAX_TOTAL) break
      }
  
      let goods = rows.filter(x => this._isVisibleMarketDoc(x)).map(x => ({
        id: x._id,
        title: x.title,
        price: x.price,
        imageFileID: x.imageFileID || "",
        thumbFileID: x.thumbFileID || "",
        hasImage: !!(x.hasImage || x.imageFileID || x.thumbFileID || (Array.isArray(x.imageFileIDs) && x.imageFileIDs.length)),
        thumbUrl: ""
      }))
  
      const fileIDs = goods.map(g => g.thumbFileID || g.imageFileID).filter(Boolean)
      if (fileIDs.length) {
        const urlMap = await this._batchGetTempUrl(fileIDs)
        goods = goods.map(g => ({
          ...g,
          thumbUrl: urlMap[g.thumbFileID || g.imageFileID] || ""
        }))
      }
  
      this.setData({ goods })
    } catch (e) {
      console.error("fetchSellerGoods error", e)
      wx.showToast({ title: "获取卖家商品失败", icon: "none" })
    }
  },  

  _isVisibleMarketDoc(x) {
    if (!x) return false
    const status = String(x.status || "online").toLowerCase()
    if (status === "deleted" || status === "offline" || status === "expired") return false
    const expireTime = Number(x.expireTime) || 0
    if (expireTime && expireTime <= Date.now()) return false
    return true
  },

  async _batchGetTempUrl(fileIDs) {
    const uniq = Array.from(new Set(fileIDs))
    const map = {}
    const chunkSize = 50

    for (let i = 0; i < uniq.length; i += chunkSize) {
      const chunk = uniq.slice(i, i + chunkSize)
      const res = await wx.cloud.getTempFileURL({ fileList: chunk })
      ;(res.fileList || []).forEach(it => {
        if (it.fileID && it.tempFileURL) map[it.fileID] = it.tempFileURL
      })
    }
    return map
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
      wx.showToast({ title: "卖家未填写联系方式", icon: "none" })
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
