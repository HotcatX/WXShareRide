// pages/profile/tripHistory/tripHistory.js
const followup = require('../../../utils/researchFollowup')
const research = require('../../../utils/researchParticipation')

function cleanText(value) {
  return String(value || '').trim()
}

function historyIdentity() {
  try { return wx.getStorageSync('isGuest') ? '' : cleanText(wx.getStorageSync('openid')) } catch (_) { return '' }
}

Page({
  data: {
    historyTrips: [],
    loading: false,
    statusBarHeight: 80,
    pageTitle: '历史行程',
    ratingTripId: '',
    ratingPrompted: false,
    followupVisible: false,
    followupBusy: false,
    followupError: '',
    followupTime: '',
    followupRoute: '',
    followupQuestion: ''
  },

  async onLoad(options = {}) {
    this._historyDisposed = false
    this._historyActive = false
    const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({
      statusBarHeight: info.statusBarHeight || 80,
      ratingTripId: cleanText(options.rateTripId || options.tripId || options.requestId || options.id)
    })
    await this.loadHistoryTrips()
  },

  goBack() {
    wx.navigateBack()
  },

  async onShow() {
    this._historyActive = true
    this._historyDataFresh = false
    if (this._researchUnsubscribe) this._researchUnsubscribe()
    this._researchUnsubscribe = research.subscribe(() => this._considerFollowup())
    await this.loadHistoryTrips()
  },

  onHide() {
    this._historyActive = false
    if (this._researchUnsubscribe) this._researchUnsubscribe()
    this._researchUnsubscribe = null
    if (this._ratingTimer) clearTimeout(this._ratingTimer)
    this._ratingTimer = null
    followup.hide(this)
  },

  onUnload() {
    this.onHide()
    this._historyDisposed = true
    followup.dispose(this)
  },

  _considerFollowup() {
    if (this._historyLoadedIdentity !== historyIdentity()) { followup.hide(this); return }
    if (!this._historyActive || this._historyDisposed || this.data.loading || this.data.ratingTripId ||
      !this._historyDataFresh) return
    followup.considerTrips(this, this.data.historyTrips)
  },

  onFollowupAnswer(event) {
    const outcome = event && event.currentTarget && event.currentTarget.dataset.outcome
    followup.answer(this, outcome)
  },

  onFollowupClose() { followup.hide(this) },
  onFollowupTouch() {},

  // =========================
  // 数据格式化（用于新卡片样式）
  // =========================
  _pickFirstDeparture(trip) {
    const deps = Array.isArray(trip?.departures) ? trip.departures : []
    return deps[0] || {}
  },

  _pickFirstDestination(trip) {
    const ds = Array.isArray(trip?.destinations) ? trip.destinations : []
    return ds[0] || {}
  },

  _buildFromTo(trip) {
    const dep0 = this._pickFirstDeparture(trip)
    const dest0 = this._pickFirstDestination(trip)

    const fromAddress = trip?._fromAddress || dep0?.address || '（未知出发地）'
    const toAddress = trip?._toAddress || dest0?.address || '（未知目的地）'

    return { _fromAddress: fromAddress, _toAddress: toAddress }
  },

  _buildTimeLabel(trip) {
    const dep0 = this._pickFirstDeparture(trip)
    const date = dep0?.date || ''
    const time = dep0?.time || ''
    const label = `${date} ${time}`.trim()
    return label || trip?._timeLabel || ''
  },

  _buildRoleLabel(trip) {
    const r = trip?.historyRole || trip?.role || ''

    if (r === 'driver_create' || r === 'driver') return '角色：创建路线'
    if (r === 'driver_join') return '角色：加入路线'
    if (r === 'passenger') return '角色：乘客'

    // 兼容有些旧数据 role 可能是 passenger/driver
    if (r === 'passenger') return '角色：乘客'
    return '角色：未知'
  },

  _buildDetailRole(trip) {
    const role = String(trip?.historyRole || trip?.role || '').toLowerCase()
    if (role === 'driver_create' || role === 'drivercreate' || role === 'driver') return 'driverCreate'
    if (role === 'driver_join' || role === 'driverjoin') return 'driverJoin'
    if (role === 'passenger_create' || role === 'passengercreate') return 'passengerCreate'
    return 'passenger'
  },

  _buildSourceType(trip) {
    const source = String(trip?.historySource || trip?.source || '').toLowerCase()
    return source === 'request' ? 'request' : 'carpool'
  },

  _formatTripForCard(trip) {
    const { _fromAddress, _toAddress } = this._buildFromTo(trip)
    return {
      ...trip,
      _fromAddress,
      _toAddress,
      _timeLabel: this._buildTimeLabel(trip),
      _roleLabel: this._buildRoleLabel(trip),
      _detailRole: this._buildDetailRole(trip),
      _sourceType: this._buildSourceType(trip)
    }
  },

  // =========================
  // 拉取历史行程
  // =========================
  loadHistoryTrips() {
    if (this._historyDisposed) return Promise.resolve()
    const identity = historyIdentity()
    if (!identity) {
      this._historyFlight = null
      this._historyDataFresh = false
      followup.hide(this)
      this.setData({ historyTrips: [], loading: false })
      return Promise.resolve()
    }
    if (this._historyFlight && this._historyFlight.identity === identity) return this._historyFlight.promise
    const entry = { identity, promise: null }
    this._historyFlight = entry
    this._historyDataFresh = false
    this.setData({ loading: true })
    const current = () => !this._historyDisposed && this._historyFlight === entry && historyIdentity() === identity
    entry.promise = Promise.resolve().then(() => wx.cloud.callFunction({ name: 'getMyTripHistory' })).then(res => {
      if (!current()) return
      if (res.result && res.result.ok) {
        const list = Array.isArray(res.result.data) ? res.result.data : []

        // 过滤掉无效项与 missing 占位（避免卡片空白）
        const cleaned = list.filter((item) => item && item._id && !item.missing)

        // 生成新卡片需要的一行字段
        const displayList = cleaned.map((t) => this._formatTripForCard(t))

        this._historyLoadedIdentity = identity
        this._historyDataFresh = true
        this.setData({ historyTrips: displayList, loading: false }, () => {
          this._maybeOpenRatingDetail()
          this._considerFollowup()
        })
      } else {
        wx.showToast({
          title: res.result?.errorMsg || '历史行程加载失败',
          icon: 'none'
        })
      }
    }).catch(() => {
      if (current() && this._historyActive) wx.showToast({ title: '历史行程加载失败', icon: 'none' })
    }).finally(() => {
      const canUpdate = current()
      if (this._historyFlight !== entry) return
      this._historyFlight = null
      if (canUpdate) this.setData({ loading: false })
    })
    return entry.promise
  },

  // =========================
  // 卡片点击跳转：复用首页我的行程详情页分流
  // =========================
  _buildDetailUrl(trip = {}, id = trip._id || trip.tripId || '') {
    const role = trip._detailRole || this._buildDetailRole(trip)
    const sourceType = trip._sourceType || this._buildSourceType(trip)

    if (role === 'driverCreate') return `/pages/profile/myTripDetailDriver/myTripDetailDriver?tripId=${id}`
    if (role === 'driverJoin') return `/pages/profile/myRequestDetailDriver/myRequestDetailDriver?tripId=${id}`
    if (role === 'passengerCreate') return `/pages/profile/myTripRequestPassenger/myTripRequestPassenger?id=${id}`
    return `/pages/profile/myTripDetailPassenger/myTripDetailPassenger?tripId=${id}&sourceType=${sourceType}`
  },

  _openTripDetail(trip = {}, id = trip._id || trip.tripId || '') {
    if (!id) {
      wx.showToast({ title: '缺少路线ID', icon: 'none' })
      return
    }
    wx.navigateTo({ url: this._buildDetailUrl(trip, id) })
  },

  goTripDetail(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const index = Number(ds.index)
    const trip = this.data.historyTrips[index] || {}
    this._openTripDetail(trip, ds.id || trip._id || trip.tripId || '')
  },

  _maybeOpenRatingDetail() {
    if (!this._historyActive || this._historyDisposed) return
    const { ratingTripId, ratingPrompted, historyTrips } = this.data
    if (!ratingTripId || ratingPrompted || !Array.isArray(historyTrips) || historyTrips.length === 0) return
    const index = historyTrips.findIndex(item => item && item._id === ratingTripId)
    if (index < 0) return
    this.setData({ ratingPrompted: true })
    this._ratingTimer = setTimeout(() => {
      this._ratingTimer = null
      if (this._historyActive && !this._historyDisposed) this._openTripDetail(historyTrips[index], ratingTripId)
    }, 240)
  }
})
