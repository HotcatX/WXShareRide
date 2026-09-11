const defaultAvatarUrl =
  '/images/profile.png'
const { formatRideStats } = require("../../utils/tripManage")
const PROFILE_REFRESH_INTERVAL = 30 * 1000

function profileIdentity() {
  return wx.getStorageSync('isGuest') ? '' : String(wx.getStorageSync('openid') || '')
}

function readProfileResource(page, resource, key, force, read) {
  const reads = page._profileReads || (page._profileReads = {})
  const previous = reads[resource]
  if (previous && previous.key === key) {
    if (previous.promise) return previous.promise
    const age = Date.now() - previous.at
    if (!force && previous.at && age >= 0 && age < PROFILE_REFRESH_INTERVAL) return Promise.resolve()
  }
  const entry = { key, at: 0, promise: null }
  reads[resource] = entry
  const isCurrent = () => page._profileReads === reads && reads[resource] === entry
  entry.promise = Promise.resolve().then(() => isCurrent() ? read(isCurrent) : false).then(result => {
    if (result !== false && isCurrent()) entry.at = Date.now()
    return result
  }).finally(() => { entry.promise = null })
  return entry.promise
}

function countBlockedUsers(user = {}) {
  const ids = new Set()
  ;(Array.isArray(user.blockedUsers) ? user.blockedUsers : []).forEach(id => {
    if (id) ids.add(String(id))
  })
  ;(Array.isArray(user.blockedUserDetails) ? user.blockedUserDetails : []).forEach(item => {
    if (item && item.openid) ids.add(String(item.openid))
  })
  return ids.size
}

function getProfileNavMetrics() {
  const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync()
  let menuRightSpace = 28

  try {
    if (typeof wx.getMenuButtonBoundingClientRect === 'function') {
      const menu = wx.getMenuButtonBoundingClientRect()
      if (menu && menu.left && info.windowWidth) {
        menuRightSpace = Math.ceil(info.windowWidth - menu.left + 8)
      }
    }
  } catch (e) {
    menuRightSpace = 28
  }

  return {
    statusBarHeight: info.statusBarHeight || 0,
    menuRightSpace
  }
}

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
    driverRatingText: '暂无评分',
    driverCompletedText: '司机完成 0 次',
    passengerRatingText: '暂无评分',
    passengerCompletedText: '已作为乘客 0 次',
    blockedCount: 0,

    statusBarHeight: 80,
    menuRightSpace: 28,
    pageTitle: '个人中心',

    isLoggedIn: false
  },

  onPullDownRefresh() {
    Promise.resolve()
      .then(() => this.refreshAuthAndData({ force: true }))
      .finally(() => wx.stopPullDownRefresh())
  },

  onLoad() {
    this.setData(getProfileNavMetrics())

    // 先用缓存的基础 userInfo（头像/昵称）快速渲染
    const basicUser = wx.getStorageSync('userInfo')
    if (basicUser) {
      this.setData({
        userInfo: basicUser,
        avatarUrl: basicUser.avatarUrl || this.data.avatarUrl,
        name: basicUser.name || this.data.name
      })
    }

    this.scheduleProfileRefresh()
  },

  onShow() {
    this.scheduleProfileRefresh()
  },

  onHide() {
    this.clearProfileRefresh()
  },

  onUnload() {
    this.clearProfileRefresh()
  },

  scheduleProfileRefresh() {
    this.clearProfileRefresh()
    this._profileRefreshTimer = setTimeout(() => {
      this._profileRefreshTimer = null
      this.refreshAuthAndData()
    }, 300)
  },

  clearProfileRefresh() {
    if (!this._profileRefreshTimer) return
    clearTimeout(this._profileRefreshTimer)
    this._profileRefreshTimer = null
  },

  // =========================
  // ✅ 登录态判定 + 数据拉取
  // =========================
  refreshAuthAndData({ force = false } = {}) {
    const openid = wx.getStorageSync('openid') || ''
    const isGuest = wx.getStorageSync('isGuest')

    // ✅ 与 home 一致：openid 存在但 isGuest=true，也视为未登录
    if (!openid || isGuest) {
      this.applyLoggedOutState()
      return Promise.resolve()
    }

    if (this._profileIdentity !== openid) {
      this.applyLoggedOutState()
      this._profileIdentity = openid
    }
    this.setData({ isLoggedIn: true })
    return Promise.all([this.loadUserInfo({ force }), this.loadUnreadCount({ force })])
  },

  profileReadKey() {
    return JSON.stringify([
      profileIdentity(), wx.getStorageSync('rideListShouldRefreshAt') || 0, this._profileEditRevision || 0
    ])
  },

  applyLoggedOutState() {
    this._profileIdentity = ''
    this._profileReads = {}
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
      walletUnreadCount: 0,
      driverRatingText: '暂无评分',
      driverCompletedText: '司机完成 0 次',
      passengerRatingText: '暂无评分',
      passengerCompletedText: '已作为乘客 0 次',
      blockedCount: 0
    })

    wx.setStorageSync('customTabMarketBadge', 0)
    wx.setStorageSync('customTabProfileBadge', 0)
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
  loadUserInfo({ force = true } = {}) {
    if (!profileIdentity()) return Promise.resolve()
    const key = this.profileReadKey()
    return readProfileResource(this, 'user', key, force, async isCurrent => {
        const res = await wx.cloud.callFunction({ name: 'getUserInfo', data: {} })
        if (!isCurrent() || key !== this.profileReadKey()) return false
        const list = (res && res.result && res.result.data) || []

        if (!Array.isArray(list) || list.length === 0) {
          this.applyLoggedOutState()
          return false
        }

        const user = list[0] || {}
        const priceObj = user.customPrice || {}
        const driverStats = formatRideStats(user.rideStats || {}, 'driver')
        const passengerStats = formatRideStats(user.rideStats || {}, 'passenger')

        this.setData({
          isLoggedIn: true,
          userInfo: user,

          avatarUrl: user.avatarUrl || defaultAvatarUrl,
          name: user.name || '',
          wechatID: user.wechatID || '',
          address: user.address || '',

          customPriceNonCore: priceObj.fortLeeNonCore || '',
          customPriceCore: priceObj.fortLeeCore || '',

          region: [
            user.regionState,
            user.regionCounty,
            user.regionArea
          ].filter(Boolean).join(' / '),
          
          apartment: user.Apartment || '',

          driverRatingText: driverStats.ratingCount > 0 ? `${driverStats.ratingAvg} 分` : '暂无评分',
          driverCompletedText: driverStats.completeText,
          passengerRatingText: passengerStats.ratingCount > 0 ? `${passengerStats.ratingAvg} 分` : '暂无评分',
          passengerCompletedText: passengerStats.completeText,
          blockedCount: countBlockedUsers(user)
        })

        wx.setStorageSync('userInfo', user)
      }).catch(err => {
        if (key !== this.profileReadKey()) return
        console.error('getUserInfo 调用失败：', err)
        wx.showToast({ icon: 'none', title: '加载失败' })
      })
  },

  // =========================
  // ✅ 未读消息
  // =========================
  loadUnreadCount({ force = true } = {}) {
    const openid = wx.getStorageSync('openid') || ''
    const isGuest = wx.getStorageSync('isGuest')

    if (!openid || isGuest) {
      this.setData({ unreadCount: 0 })
      wx.setStorageSync('customTabMarketBadge', 0)
      wx.setStorageSync('customTabProfileBadge', 0)
      return Promise.resolve()
    }

    this.setData({ unreadCount: Number(wx.getStorageSync('customTabProfileBadge') || 0) })
    const key = this.profileReadKey()
    return readProfileResource(this, 'unread', key, force, async isCurrent => {
        const r = await wx.cloud.database().collection('Notifications')
          .where({ _openid: openid, read: false }).count()
        if (!isCurrent() || key !== this.profileReadKey()) return false
        const count = (r && r.total) || 0
        this.setData({ unreadCount: count })
        wx.setStorageSync('customTabMarketBadge', 0)
        wx.setStorageSync('customTabProfileBadge', count)
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
    this._profileEditRevision = (this._profileEditRevision || 0) + 1
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

  goBlockList() {
    if (!this.ensureLoggedIn()) return
    wx.navigateTo({ url: '/pages/profile/blockList/blockList' })
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
