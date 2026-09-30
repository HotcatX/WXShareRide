const rides = require("../../../utils/compat/rides")
const profileApi = require("../../../utils/compat/profile")
const accountKey = () => `${wx.getStorageSync("isGuest") ? "guest" : "user"}:${wx.getStorageSync("openid") || ""}`
const rideTelemetry = require("../../../utils/rideTelemetry")
const LOGIN_PAGE = '/pages/other/login/login'
const DETAIL_REFRESH_INTERVAL = 30 * 1000
const { callTripManage, blockRideUser, formatRidePricePerPerson, markRideListStale } = require("../../../utils/tripManage")
const { fetchTripDetail, removeTripDetailCache } = require("../../../utils/tripDetailCache")
const { isRouteExpired } = require("../../../utils/routeExpiry")

function getWeekdayStr(dateStr) {
  if (!dateStr) return ''
  const parts = String(dateStr).split('-')
  if (parts.length !== 3) return ''
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (!y || !m || !d) return ''
  const dt = new Date(y, m - 1, d)
  const map = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return map[dt.getDay()] || ''
}

function formatDateNoYear(dateStr) {
  if (!dateStr) return ''
  const parts = String(dateStr).split('-')
  if (parts.length !== 3) return ''
  return `${Number(parts[1])}月${Number(parts[2])}日`
}

Page({
  data: {
    statusBarHeight: 80,
    pageTitle: '路线详情',

    loading: true,
    loadError: '',
    routeExpired: false,

    // 两个按钮独立 submitting（避免一个按钮 loading 影响另一个）
    submittingDriver: false,
    submittingPassenger: false,

    tripId: '',
    trip: null,

    departAddress: '',
    destAddress: '',
    formattedDepartTime: '',
    referencePriceText: '',

    // 乘客加入用
    seatLeft: 0,

    // 登录态/身份
    myOpenid: '',
    ownerOpenid: '',
    driverOpenid: '',

    isOwner: false,

    // 乘客侧状态
    joinedByMe: false,     // 我是否已作为乘客加入
    isFull: false,
    isClosed: false,

    // 司机侧状态
    isAccepted: false,     // 是否已有司机接单；乘客满员不代表已有司机
    acceptedByMe: false,   // 我是否就是该司机

    // 顶部横向提示条（你 WXML 里有 toastVisible）
    toastVisible: false,
    toastType: '',         // success / warning / error（你自己在 wxss 定义）
    toastIcon: '',
    toastText: '',
    refresherTriggered: false,
    refreshHintText: ""
  },

  async onLoad(options) {
    this._disposed = false
    this._detailAccount = accountKey()
    const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight })

    const id = (options && options.id) || ''
    if (!id) {
      this.setLoadError('缺少路线ID')
      return
    }

    // ✅ 允许游客浏览
    const myOpenid = wx.getStorageSync('openid') || ''
    this.setData({ tripId: id, myOpenid })

    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })
    const sharedEntry = options.fromShare === '1' || getCurrentPages().length <= 1
    this.loadTripDetail(id, { force: sharedEntry })
  },

  onShow() {
    const changedAccount = this._detailAccount !== undefined && this._detailAccount !== accountKey()
    this._detailAccount = accountKey()
    if (changedAccount) {
      this._detailLoadSequence = (this._detailLoadSequence || 0) + 1
      this.setData({ trip: null, driverInfo: null, isOwner: false, hasJoined: false, joinedByMe: false, acceptedByMe: false,
        driverUserId: '', ownerUserId: '', driverOpenid: '', ownerOpenid: '', pickupSpotList: [], dropoffSpotList: [] })
      this._lastDetailLoadedAt = 0
      if (this.data.tripId) this.loadTripDetail(this.data.tripId, { silent: true, force: true })
    }
    if (rides.isBackendEnabled()) {
      if (this._imageRefreshTimer) clearInterval(this._imageRefreshTimer)
      this._imageRefreshTimer = setInterval(() => {
        if (!this._disposed && this.data.tripId && !this.data.loading) this.loadTripDetail(this.data.tripId, { silent: true, force: true })
      }, 240000)
    }
    if (this.checkRouteExpiry()) return
    // ✅ 从 login “游客身份查看”返回时的提示
    const tip = wx.getStorageSync('needLoginToast')
    if (tip) {
      wx.removeStorageSync('needLoginToast')
      wx.showToast({ title: tip, icon: 'none', duration: 2000 })
    }

    // ✅ 登录/完善资料回来后刷新
    const myOpenid = wx.getStorageSync('openid') || ''
    this.setData({ myOpenid })

    const { tripId } = this.data
    if (!tripId || this.data.loading) return
    if (Date.now() - (this._lastDetailLoadedAt || 0) < DETAIL_REFRESH_INTERVAL) return
    this.loadTripDetail(tripId, { silent: true })
  },

  async onPullDownRefresh() {
    await this.onDetailRefresherRefresh()
  },

  onHide() {
    if (this._imageRefreshTimer) clearInterval(this._imageRefreshTimer)
    this._imageRefreshTimer = null
  },

  onUnload() {
    this._disposed = true
    if (this._imageRefreshTimer) clearInterval(this._imageRefreshTimer)
    if (this._redirectTimer) clearTimeout(this._redirectTimer)
    this._detailLoadSequence = (this._detailLoadSequence || 0) + 1
  },

  async onDetailRefresherRefresh() {
    this.setData({ refresherTriggered: true })
    try {
      const { tripId } = this.data
      if (tripId) await this.loadTripDetail(tripId, { silent: true, force: true })
    } finally {
      if (!this._disposed) { this.setData({ refresherTriggered: false }); wx.stopPullDownRefresh() }
    }
  },

  goBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else wx.reLaunch({ url: '/pages/home/home' })
  },

  goToAvailableCarpools() {
    wx.redirectTo({ url: '/pages/home/carpoolList/carpoolList' })
  },

  checkRouteExpiry() {
    if (this.data.routeExpired) return true
    if (!isRouteExpired(this.data.trip)) return false
    this.setRouteExpired()
    return true
  },

  setRouteExpired() {
    this.setLoadError('')
    this.setData({ routeExpired: true, loadError: '', toastVisible: false, referencePriceText: '' })
  },

  // 系统 toast（简单）
  showToast(text, icon = 'none', duration = 1800) {
    wx.showToast({ title: text, icon, duration })
  },

  setLoadError(message) {
    this.setData({
      loading: false,
      loadError: message || '加载失败',
      routeExpired: false,
      trip: null,
      departAddress: '',
      destAddress: '',
      formattedDepartTime: '',
      seatLeft: 0,
      ownerOpenid: '',
      ownerUserId: '',
      driverOpenid: '',
      isOwner: false,
      joinedByMe: false,
      isFull: false,
      isClosed: true,
      isAccepted: false,
      acceptedByMe: false,
      submittingDriver: false,
      submittingPassenger: false
    })
  },

  // 顶部条 toast（如果你想用 ui-toast 这一套）
  showTopToast(text, type = 'success', icon = '✓', duration = 1800) {
    this.setData({
      toastVisible: true,
      toastText: text,
      toastType: type,
      toastIcon: icon
    })
    setTimeout(() => {
      this.setData({ toastVisible: false })
    }, duration)
  },

  // =========================
  // ✅ 登录+完善资料拦截（仅在点击按钮时触发）
  // =========================
  ensureLoginBeforeAction(actionFrom) {
    const openid = wx.getStorageSync('openid') || ''
    if (openid && !wx.getStorageSync('isGuest')) return true

    const { tripId } = this.data
    const pendingUrl = `/pages/home/requestDetail/requestDetail?id=${tripId}`

    wx.setStorageSync('pendingPage', { url: pendingUrl })
    wx.setStorageSync('postLoginAction', {
      type: 'requireProfile',
      from: actionFrom,     // 'requestDetail:accept' / 'requestDetail:join'
      returnUrl: pendingUrl
    })

    wx.navigateTo({ url: LOGIN_PAGE })
    return false
  },

  ensureLoginForBlock() {
    const openid = wx.getStorageSync('openid') || ''
    if (openid && !wx.getStorageSync('isGuest')) return true

    const { tripId } = this.data
    wx.setStorageSync('pendingPage', { url: `/pages/home/requestDetail/requestDetail?id=${tripId}` })
    wx.navigateTo({ url: LOGIN_PAGE })
    return false
  },

  async ensureWechatBeforeAction() {
    const openid = wx.getStorageSync('openid') || ''
    if (!openid) return false
  
    const owner = accountKey()
    const isCurrent = () => !this._disposed && owner === accountKey()
    const localUserInfo = wx.getStorageSync('userInfo') || {}
    try {
      const response = await profileApi.getUserInfo()
      if (!isCurrent()) return false
      const user = profileApi.legacyDocument(response)
      const wechatID = String(
        (user && (user.wechatID || user.wechatId || user.wechat)) || ''
      ).trim()
  
      if (wechatID) {
        // 顺便同步回本地，避免下次重复误判
        wx.setStorageSync('userInfo', {
          ...localUserInfo,
          ...user,
          wechatID
        })
        return true
      }
  
      const { tripId } = this.data
      const pendingUrl = `/pages/home/requestDetail/requestDetail?id=${tripId}`

      wx.setStorageSync('pendingPage', {
        url: pendingUrl
      })

      wx.showModal({
        title: '请完善个人信息',
        content: '加入或接单前需要填写微信号，现在前往填写？',
        confirmText: '去填写',
        cancelText: '取消',
        success: (res) => {
          if (res.confirm && isCurrent()) {
            wx.navigateTo({
              url: '/pages/profile/editInfo/editInfo'
            })
          }
        }
      })

      return false

    } catch (err) {
      if (!isCurrent()) return false
      console.error('ensureWechatBeforeAction error:', err)
  
      wx.showToast({
        title: '请先完善微信号',
        icon: 'none'
      })
  
      return false
    }
  },

  applyRequestData(trip) {
    if (!trip) return false
    if (isRouteExpired(trip)) {
      this.setRouteExpired()
      return true
    }

    // 1) 顶部展示字段
    let departAddress = ''
    let destAddress = ''
    let formattedDepartTime = ''

    if (Array.isArray(trip.departures) && trip.departures.length > 0) {
      const d = trip.departures[0]
      departAddress = d.address || ''
      const dateStr = d.date || ''
      const timeStr = (d.time || '').slice(0, 5)

      const weekday = getWeekdayStr(dateStr)
      const dateNoYear = formatDateNoYear(dateStr)

      if (dateNoYear && timeStr) formattedDepartTime = `${dateNoYear} ${weekday} ${timeStr}`
      else if (dateNoYear) formattedDepartTime = `${dateNoYear} ${weekday}`
      else formattedDepartTime = timeStr || ''
    }

    if (Array.isArray(trip.destinations) && trip.destinations.length > 0) {
      destAddress = trip.destinations[0].address || ''
    }

    const seatLeft = trip.availableSeats
    const isFull = seatLeft <= 0

    // 5) 状态
    const rawStatus = String(trip.status || 'open').toLowerCase()
    const closedStatusList = ['past', 'closed', 'cancelled', 'canceled', 'deleted', 'finished', 'completed']
    const isClosed = closedStatusList.includes(rawStatus)

    // 6) 已登录才计算“我是谁”
    const myOpenid = wx.getStorageSync('openid') || ''
    const isOwner = trip.viewer?.isCreator === true
    const joinedByMe = trip.viewer?.role === 'passenger'

    // 7) 司机接单状态（保持与 driverPickupDetail 一致）
    const isAccepted = trip.hasDriver
    const acceptedByMe = trip.viewer?.role === 'driver'

    this.setData({
      trip,
      departAddress,
      destAddress,
      formattedDepartTime,
      referencePriceText: formatRidePricePerPerson(trip.referencePrice || trip.price || trip.displayPrice, '价格待定'),

      seatLeft,
      myOpenid,
      ownerOpenid: '',
      ownerUserId: trip.creatorUserId || '',
      driverOpenid: '',

      isOwner,
      joinedByMe,
      isFull,
      isClosed,

      isAccepted,
      acceptedByMe,

      loadError: '',
      routeExpired: false,
      loading: false
    }, () => rideTelemetry.detailViewed(this, trip, 'request'))

    this._lastDetailLoadedAt = Date.now()
    return true
  },

  async loadTripDetail(id, options = {}) {
    const sequence = this._detailLoadSequence = (this._detailLoadSequence || 0) + 1
    const { silent = false } = options
    if (!silent) this.setData({ loading: true, loadError: '' })

    try {
      const result = await fetchTripDetail("request", id, { force: true })
      if (sequence !== this._detailLoadSequence) return
      this.applyRequestDetailResult(result, id)
    } catch (err) {
      if (sequence !== this._detailLoadSequence) return
      this.setLoadError(err.message || '路线加载失败，请重试')
    }
  },

  applyRequestDetailResult(result = {}, id, options = {}) {
    if (!result || !(result.ok || result.success)) {
      if ((this.data.trip || this.data.routeExpired) && !(result && result.notFound)) {
        this.setData({ loading: false })
        return false
      }
      const msg = (result && (result.errorMsg || result.msg)) || '加载失败'
      this.setLoadError(msg)
      return false
    }

    const trip = Array.isArray(result.data) ? result.data[0] : result.data
    if (!trip) {
      this.setLoadError('该求车路线不存在或已被删除')
      return false
    }

    return this.applyRequestData(trip)
  },

  // 乘客加入
  async joinAsPassenger() {
    if (this.checkRouteExpiry() || !this.data.trip) return
    const {
      tripId,
      trip,
      isOwner,
      joinedByMe,
      isFull,
      isClosed,
      acceptedByMe,
      submittingPassenger
    } = this.data

    if (!tripId) return
    if (submittingPassenger) return

    // ✅ 登录 + 完善资料拦截
    if (!this.ensureLoginBeforeAction('requestDetail:join')) return

    // 刷新 openid（刚登录回来）
    const myOpenid = wx.getStorageSync('openid') || ''
    this.setData({ myOpenid })

    // 防误操作
    if (isOwner) return this.showToast('不能加入自己发布的求车', 'none')
    if (acceptedByMe) return this.showToast('你已是该路线司机，无法作为乘客加入', 'none')
    if (joinedByMe) return this.showToast('你已加入该路线', 'none')

    if (isClosed) return this.showToast('该路线已结束', 'none')
    if (isFull) return this.showToast('该路线已满员', 'none')

    const owner = accountKey()
    const isCurrent = () => !this._disposed && owner === accountKey()
    if (!(await this.ensureWechatBeforeAction()) || !isCurrent()) return

    this.setData({ submittingPassenger: true })

    try {
      const ret = await rides.joinTrip({ type: 'request', requestId: tripId })
      if (!isCurrent()) return

      if (ret.result && ret.result.success) {
        removeTripDetailCache('request', tripId)
        markRideListStale()
        this.showToast(ret.result.recovered ? '已确认上次操作' : '加入成功', 'success', 1200)
        this._redirectTimer = setTimeout(() => {
          if (!isCurrent()) return
          wx.reLaunch({ url: '/pages/home/home' })
        }, 1200)
        return
      }

      const msg = (ret.result && ret.result.errorMsg) ? ret.result.errorMsg : '加入失败'
      this.showToast(msg, 'none')
    } catch (e) {
      if (!isCurrent()) return
      console.error('joinAsPassenger error:', e)
      this.showToast('加入失败', 'none')
    } finally {
      if (isCurrent()) this.setData({ submittingPassenger: false })
    }
  },

  // =========================
  // ✅ 司机加入（tripManage）
  // =========================
  async acceptRequest() {
    if (this.checkRouteExpiry() || !this.data.trip) return
    const {
      tripId,
      trip,
      isAccepted,
      acceptedByMe,
      isOwner,
      joinedByMe,
      isClosed,
      submittingDriver
    } = this.data

    if (!tripId) return
    if (submittingDriver) return

    // ✅ 登录 + 完善资料拦截
    if (!this.ensureLoginBeforeAction('requestDetail:accept')) return

    // 刷新 openid（刚登录回来）
    const myOpenid = wx.getStorageSync('openid') || ''
    this.setData({ myOpenid })

    // 规则1：自己不能接自己
    if (isOwner) return this.showToast('不能成为自己求车的司机', 'none')

    // 规则2：已作为乘客加入，不能接单
    if (joinedByMe) return this.showToast('你已作为乘客加入该路线，无法再接单', 'none')
    if (isClosed) return this.showToast('该路线已结束', 'none')

    // 已被接单
    if (isAccepted) {
      if (acceptedByMe) this.showToast('你已成为该路线司机', 'none')
      else this.showToast('已被其他司机接单', 'none')
      return
    }

    if (!this.ensureLoginBeforeAction('requestDetail:accept')) return
    const owner = accountKey()
    const isCurrent = () => !this._disposed && owner === accountKey()
    if (!(await this.ensureWechatBeforeAction()) || !isCurrent()) return

    this.setData({ submittingDriver: true })

    try {
      const result = await callTripManage({ type: 'request', requestId: tripId, action: 'acceptRequest' })
      if (!isCurrent()) return

      if (result && result.ok !== false && result.success !== false &&
          (result.success === true || result.ok === true)) {
        removeTripDetailCache('request', tripId)
        markRideListStale()
        this.showToast(result.recovered ? '已确认上次操作' : '接单成功', 'success', 1200)
        this.openAcceptedDriverDetail()
        return
      }

      const msg = (result && result.errorMsg) ? result.errorMsg : '接单失败'
      this.showToast(msg, 'none')
    } catch (e) {
      if (!isCurrent()) return
      console.error('acceptRequest error:', e)
      this.showToast('接单失败', 'none')
    } finally {
      if (isCurrent()) this.setData({ submittingDriver: false })
    }
  },

  openAcceptedDriverDetail() {
    const { tripId } = this.data
    if (tripId) wx.redirectTo({ url: `/pages/profile/myRequestDetailDriver/myRequestDetailDriver?requestId=${encodeURIComponent(tripId)}` })
  },

  async onBlockRequestOwner() {
    const { tripId, isOwner, trip } = this.data
    if (isOwner) return this.showToast('不能拉黑自己', 'none')
    const targetUserId = trip?.creatorUserId || ''
    if (!targetUserId) return this.showToast('缺少拉黑对象', 'none')
    if (!this.ensureLoginForBlock()) return

    await blockRideUser({
      type: 'request',
      requestId: tripId,
      tripId,
      targetUserId,
      targetName: (trip && (trip.name || trip.nickName)) || '求车发布者'
    })
  },

  // =========================
  // 分享：统一导向 requestDetail
  // =========================
  onShareAppMessage() {
    const { tripId, departAddress, destAddress, formattedDepartTime } = this.data
    const title = `${departAddress} → ${destAddress} ${formattedDepartTime}`.trim().slice(0, 30)
    return getApp().withReferralShare({
      title: title ? `${title}｜路线详情` : '路线详情',
      path: `/pages/home/requestDetail/requestDetail?id=${tripId}&fromShare=1`
    })
  },

  onShareTimeline() {
    const { tripId, departAddress, destAddress, formattedDepartTime } = this.data
    const title = `${departAddress} → ${destAddress} ${formattedDepartTime}`.trim().slice(0, 30)
    return getApp().withReferralShare({
      title: title ? `${title}｜路线详情` : '路线详情',
      query: `id=${tripId}&fromShare=1`
    })
  }
})
