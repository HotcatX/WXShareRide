const defaultAvatarUrl =
  'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0'

Page({
  data: {
    avatarUrl: defaultAvatarUrl,
    userInfo: {},

    name: '',
    wechatID: '',
    address: '',
    customPriceNonCore: '',
    customPriceCore: '',

    region: '',
    apartment: '',

    unreadCount: 0,
    walletUnreadCount: 0,

    statusBarHeight: 80,
    pageTitle: '个人中心',

    isLoggedIn: false
  },

  onPullDownRefresh() {
    Promise.resolve()
      .then(() => this.refreshAuthAndData())
      .finally(() => wx.stopPullDownRefresh())
  },

  onLoad() {
    const info = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight })

    // 先用缓存的基础 userInfo（头像/昵称）快速渲染
    const basicUser = wx.getStorageSync('userInfo')
    if (basicUser) {
      this.setData({
        userInfo: basicUser,
        avatarUrl: basicUser.avatarUrl || this.data.avatarUrl,
        name: basicUser.name || this.data.name
      })
    }

    this.refreshAuthAndData()
  },

  onShow() {
    this.refreshAuthAndData()
  },

  // =========================
  // ✅ 登录态判定 + 数据拉取
  // =========================
  refreshAuthAndData() {
    const openid = wx.getStorageSync('openid') || ''
    const isGuest = wx.getStorageSync('isGuest')

    // ✅ 与 home 一致：openid 存在但 isGuest=true，也视为未登录
    if (!openid || isGuest) {
      this.applyLoggedOutState()
      return Promise.resolve()
    }

    this.setData({ isLoggedIn: true })
    this.loadUserInfo()
    return this.loadUnreadCount()
  },

  applyLoggedOutState() {
    this.setData({
      isLoggedIn: false,

      avatarUrl: defaultAvatarUrl,
      userInfo: {},

      name: '',
      wechatID: '',
      address: '',
      customPriceNonCore: '',
      customPriceCore: '',

      region: '',
      apartment: '',

      unreadCount: 0,
      walletUnreadCount: 0
    })

    // 游客态不显示 tabbar badge
    try {
      wx.removeTabBarBadge({ index: 1 })
      wx.removeTabBarBadge({ index: 2 })
    } catch (e) {}
  },

  // =========================
  // ✅ 一键登录：逻辑对齐 home
  // =========================
  onTapLoginBtn() {
    if (this.data.isLoggedIn) return

    // 和 home 一样：写 pendingPage，方便 login 成功后回跳
    wx.setStorageSync('pendingPage', { url: '/pages/profile/profile' })

    wx.navigateTo({
      // ✅ 和 home 一致：带 pending + from
      url: '/pages/other/login/login?pending=%2Fpages%2Fprofile%2Fprofile&from=profile'
    })
  },

  // （保留旧方法：如果别处还在调用）
  goLogin() {
    this.onTapLoginBtn()
  },

  // =========================
  // ✅ 需要登录的统一处理
  // =========================
  ensureLoggedIn() {
    const ok = !!this.data.isLoggedIn
    if (ok) return true

    wx.showModal({
      title: '需要登录',
      content: '该功能需要登录后使用，是否前往登录？',
      confirmText: '去登录',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) this.onTapLoginBtn()
      }
    })
    return false
  },

  // =========================
  // ✅ 读取用户信息（getUserInfo + UI 字段）
  // =========================
  loadUserInfo() {
    wx.cloud.callFunction({
      name: 'getUserInfo',
      data: {},
      success: (res) => {
        const list = (res && res.result && res.result.data) || []

        if (!Array.isArray(list) || list.length === 0) {
          this.applyLoggedOutState()
          return
        }

        const user = list[0] || {}
        const priceObj = user.customPrice || {}

        this.setData({
          isLoggedIn: true,
          userInfo: user,

          avatarUrl: user.avatarUrl || defaultAvatarUrl,
          name: user.name || '',
          wechatID: user.wechatID || '',
          address: user.address || '',

          customPriceNonCore: priceObj.fortLeeNonCore || '',
          customPriceCore: priceObj.fortLeeCore || '',

          region: user.bigregion || '',
          apartment: user.address || ''
        })

        wx.setStorageSync('userInfo', user)
      },
      fail: (err) => {
        console.error('getUserInfo 调用失败：', err)
        this.applyLoggedOutState()
        wx.showToast({ icon: 'none', title: '加载失败' })
      }
    })
  },

  // =========================
  // ✅ 未读消息
  // =========================
  loadUnreadCount() {
    const openid = wx.getStorageSync('openid') || ''
    const isGuest = wx.getStorageSync('isGuest')
    const TAB_MARKET = 1
    const TAB_PROFILE = 2

    if (!openid || isGuest) {
      this.setData({ unreadCount: 0 })
      try {
        wx.removeTabBarBadge({ index: TAB_MARKET })
        wx.removeTabBarBadge({ index: TAB_PROFILE })
      } catch (e) {}
      return Promise.resolve()
    }

    const db = wx.cloud.database()
    return db
      .collection('Notifications')
      .where({
        _openid: openid,
        read: false
      })
      .count()
      .then((r) => {
        const count = (r && r.total) || 0
        this.setData({ unreadCount: count })

        try {
          wx.removeTabBarBadge({ index: TAB_MARKET })

          if (count > 0) {
            wx.setTabBarBadge({
              index: TAB_PROFILE,
              text: count > 99 ? '99+' : String(count)
            })
          } else {
            wx.removeTabBarBadge({ index: TAB_PROFILE })
          }
        } catch (e) {}
      })
      .catch((err) => {
        console.error('查询未读消息失败：', err)
      })
  },

  // =========================
  // 页面跳转（原逻辑保留）
  // =========================
  goEditProfile() {
    if (!this.ensureLoggedIn()) return
    wx.navigateTo({ url: '/pages/profile/editInfo/editInfo?from=profile' })
  },

  goTripHistory() {
    if (!this.ensureLoggedIn()) return
    wx.navigateTo({ url: '/pages/profile/tripHistory/tripHistory' })
  },

  goNotification() {
    if (!this.ensureLoggedIn()) return
    wx.navigateTo({ url: '/pages/profile/notification/notification' })
  },

  goFeedback() {
    wx.navigateTo({ url: '/pages/other/feedback/feedback' })
  },

  goCarpoolTemplate() {
    if (!this.ensureLoggedIn()) return
    wx.navigateTo({ url: '/pages/home/CarpoolTemplateList/CarpoolTemplateList' })
  },

  goSold() {
    if (!this.ensureLoggedIn()) return
    wx.navigateTo({ url: '/pages/market/marketTrade/marketTrade?type=sold' })
  },

  goBought() {
    if (!this.ensureLoggedIn()) return
    wx.navigateTo({ url: '/pages/market/marketTrade/marketTrade?type=bought' })
  },

  goPublished() {
    if (!this.ensureLoggedIn()) return
    wx.navigateTo({ url: '/pages/market/marketMy/marketMy' })
  },

  goPrivacy() {
    wx.navigateTo({ url: '/pages/other/privacy/privacy' })
  }
})
