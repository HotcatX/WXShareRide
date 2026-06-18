// pages/market/marketDetail/marketDetail.js
const LOGIN_PAGE = '/pages/other/login/login'

Page({
  data: {
    statusBarHeight: 0,
    item: null,

    // ✅ 是否本人发布（用于显示编辑/删除）
    isOwner: false,
    myOpenid: '',

    // 兼容旧逻辑：保留 imgUrl
    imgUrl: "",

    // ✅ 新增：多图 temp urls
    imgUrls: [],

    sellerWechat: ""
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

    return {
      title: String(title).trim().slice(0, 30) || '查看商品详情',
      path: `/pages/market/marketDetail/marketDetail?id=${id}`,
    }
  },

  onShareTimeline() {
    const { item } = this.data
    const id = (item && item.id) ? item.id : ''
    const title = item
      ? `${item.title || '商品'}${(item.price !== undefined && item.price !== null) ? ` $${item.price}` : ''}`
      : '查看商品详情'

    return {
      title: String(title).trim().slice(0, 30) || '查看商品详情',
      query: `id=${id}`
    }
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
    const sys = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: sys.statusBarHeight || 0 })

    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })

    const id = options?.id
    if (!id) {
      wx.showToast({ title: "缺少商品id", icon: "none" })
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

  // ✅ 把 fileID 数组转 temp urls（优先 imageFileIDs，回退 imageFileID）
  async _buildTempUrls(x) {
    const arr = Array.isArray(x.imageFileIDs) ? x.imageFileIDs.filter(Boolean) : []
    const fileIds = arr.length > 0
      ? arr
      : (x.imageFileID ? [x.imageFileID] : [])

    if (fileIds.length === 0) {
      this.setData({ imgUrls: [], imgUrl: "" })
      return
    }

    const tmp = await wx.cloud.getTempFileURL({ fileList: fileIds })
    const urls = (tmp.fileList || [])
      .map(z => z?.tempFileURL)
      .filter(Boolean)

    this.setData({
      imgUrls: urls,
      imgUrl: urls[0] || ""
    })
  },

  async fetchDetail(id) {
    try {
      const db = wx.cloud.database()
      const res = await db.collection("market_goods").doc(id).get()
      const x = res.data

      const myOpenid = wx.getStorageSync('openid') || ''
      const isOwner = !!(myOpenid && x?._openid && myOpenid === x._openid)

      this.setData({
        myOpenid,
        isOwner,
        item: {
          id: x._id,
          title: x.title,
          price: x.price,
          category: x.category,
          region: x.region,
          condition: x.condition,
          desc: x.desc,
          postDate: x.postDate,

          // ✅ 旧字段保留
          imageFileID: x.imageFileID || "",

          // ✅ 新字段：多图数组（详情轮播用）
          imageFileIDs: Array.isArray(x.imageFileIDs) ? x.imageFileIDs : [],

          // 你原来的字段
          wantCount: x.wantCount || 0,
          viewCount: x.viewCount || 0,
          _openid: x._openid,
          pickup: x.pickup || x.region || ""
        }
      })

      await this._buildTempUrls(x)
    } catch (e) {
      console.error(e)
      wx.showToast({ title: "获取详情失败", icon: "none" })
    }
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

    // ✅ 约定：marketPost 支持携带 id 进入编辑模式（你那边若用别的参数名，改这里就行）
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

      // 1) 先删云存储图片（失败也不影响删除文档）
      const fileIds = [
        ...(Array.isArray(this.data.item?.imageFileIDs) ? this.data.item.imageFileIDs : []),
        this.data.item?.imageFileID
      ].filter(Boolean)

      if (fileIds.length > 0) {
        try {
          await wx.cloud.deleteFile({ fileList: fileIds })
        } catch (e) {
          console.warn('[deleteFile] ignored:', e)
        }
      }

      // 2) 再删数据库文档
      const db = wx.cloud.database()
      await db.collection('market_goods').doc(id).remove()

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
    wx.switchTab({
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
