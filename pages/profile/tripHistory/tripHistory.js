// pages/profile/tripHistory/tripHistory.js
const { loadRideHistory } = require('../../../utils/compat/rideHistory')
const followup = require('../../../utils/tripFollowup')
const { callTripManage } = require('../../../utils/compat/rides')

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
    ratingStars: [1, 2, 3, 4, 5],
    feedbackThanks: false
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
    await this.loadHistoryTrips()
  },

  onHide() {
    this._historyActive = false
    this._feedbackRead = null
  },

  onUnload() {
    this.onHide()
    this._historyDisposed = true
    followup.dispose(this)
  },

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

    if (['driver_create', 'driver_join', 'driver'].includes(r)) return '司机'
    if (['passenger', 'passenger_create'].includes(r)) return '乘客'
    return '同行'
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
    const roleLabel = this._buildRoleLabel(trip)
    const eligible = !!followup.eligibleTrip(trip, historyIdentity(), Date.now(), true)
    return {
      ...trip,
      _fromAddress,
      _toAddress,
      _timeLabel: this._buildTimeLabel(trip),
      _roleLabel: roleLabel,
      _roleKind: roleLabel === '司机' ? 'driver' : roleLabel === '乘客' ? 'passenger' : 'unknown',
      _feedbackEligible: eligible,
      _feedbackReady: false,
      _feedbackBusy: false,
      _feedbackStatus: eligible ? '读取中' : '',
      _feedbackTone: 'pending',
      _feedbackOutcome: null,
      _feedbackOccurredAt: 0,
      _feedbackAssumed: false,
      _myRating: trip.myRating || 0,
      _showRating: false,
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
    if (this._historyAccount !== identity) {
      this._historyAccount = identity
      this._feedbackRead = null
      this.setData({ historyTrips: [] })
    }
    if (!identity) {
      this._historyFlight = null
      this.setData({ historyTrips: [], loading: false })
      return Promise.resolve()
    }
    if (this._historyFlight && this._historyFlight.identity === identity) return this._historyFlight.promise
    const entry = { identity, promise: null }
    this._historyFlight = entry
    this.setData({ loading: true })
    const current = () => !this._historyDisposed && this._historyFlight === entry && historyIdentity() === identity
    entry.promise = Promise.resolve().then(() => loadRideHistory(identity)).then(res => {
      if (!current()) return
      if (res.result && res.result.ok) {
        const list = Array.isArray(res.result.data) ? res.result.data : []

        // 过滤掉无效项与 missing 占位（避免卡片空白）
        const cleaned = list.filter((item) => item && item._id && !item.missing)

        // 生成新卡片需要的一行字段
        const displayList = cleaned.map((t) => this._formatTripForCard(t))

        this.setData({ historyTrips: displayList, loading: false }, () => {
          this._maybeOpenRatingDetail()
          this._loadFeedback()
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

  stopCardTap() {},

  _feedbackView(trip, outcome) {
    const confirmed = outcome.source === 'self_report'
    const canRate = trip._roleKind === 'passenger' && !!trip.driverUserId
    return { ...trip, _feedbackReady: true, _feedbackBusy: false, _feedbackError: '',
      _feedbackOutcome: outcome.outcome, _feedbackAssumed: outcome.source === 'dismissed_default',
      _feedbackOccurredAt: outcome.occurredAt,
      _showRating: confirmed && canRate,
      _feedbackStatus: !confirmed ? '待确认' : canRate && !trip._myRating ? '待评分' : '已完成',
      _feedbackTone: !confirmed ? 'pending' : canRate && !trip._myRating ? 'rating' : 'done' }
  },

  _patchTrip(id, update) {
    this.setData({ historyTrips: this.data.historyTrips.map(trip => trip._id === id ? { ...trip, ...update } : trip) })
  },

  async _loadFeedback() {
    if (!this._historyActive || this._historyDisposed || !historyIdentity() || this._historyAccount !== historyIdentity()) return
    const entry = { account: historyIdentity(), trips: this.data.historyTrips }
    this._feedbackRead = entry
    const current = () => this._feedbackRead === entry && this._historyActive && !this._historyDisposed && historyIdentity() === entry.account
    let outcomes
    try { outcomes = await followup.readHistoryOutcomes(entry.trips) } catch (_) { outcomes = null }
    if (!current()) return
    this._feedbackRead = null
    this.setData({ historyTrips: this.data.historyTrips.map(trip => {
      if (!trip._feedbackEligible) return trip
      const result = Array.isArray(outcomes) && outcomes.find(item => item.tripKey === trip._id)
      if (!result) return { ...trip, _feedbackReady: false, _feedbackStatus: '待读取', _feedbackError: '暂未读取回访记录，请重试' }
      return this._feedbackView(trip, result)
    }) })
  },

  retryFeedback() {
    if (this._feedbackRead) return
    this._loadFeedback()
  },

  onHistoryAnswer(event) {
    const { id, outcome } = event?.currentTarget?.dataset || {}
    const trip = this.data.historyTrips.find(item => item._id === id)
    if (!this._historyActive || this._historyDisposed || this._historyAccount !== historyIdentity() || !trip || !trip._feedbackEligible || !trip._feedbackReady || trip._feedbackBusy ||
      !['yes', 'no'].includes(outcome)) return
    if (!trip._feedbackAssumed && trip._feedbackOutcome === outcome) return
    const result = followup.reportHistory(trip, outcome, this)
    if (!result.ok) { this._patchTrip(id, { _feedbackError: '暂未保存，请重试' }); return }
    this._patchTrip(id, { ...this._feedbackView(trip, result), _feedbackPulse: true })
  },

  async onHistoryRate(event) {
    const { id, score: rawScore } = event?.currentTarget?.dataset || {}, score = Number(rawScore)
    const trip = this.data.historyTrips.find(item => item._id === id), account = historyIdentity()
    if (!account || account !== this._historyAccount || !this._historyActive || this._historyDisposed || !trip || !trip._showRating || trip._myRating || trip._feedbackBusy ||
      trip._roleKind !== 'passenger' || !trip.driverUserId || !Number.isInteger(score) || score < 1 || score > 5) return
    this._patchTrip(id, { _feedbackBusy: true, _feedbackError: '', _feedbackPulse: false })
    try {
      const result = await callTripManage({ action: 'rateUser', type: trip._sourceType, tripId: id, targetUserId: trip.driverUserId, targetRole: 'driver', score })
      if (historyIdentity() !== account || this._historyDisposed || !this._historyActive) return
      // Retry may confirm an earlier score; always render the actual receipt.
      if (!result?.ok || result.data?.rideId !== id || result.data?.targetId !== trip.driverUserId ||
        !Number.isInteger(result.data?.score) || result.data.score < 1 || result.data.score > 5) throw Error('INVALID_RESPONSE')
      this._patchTrip(id, { _myRating: result.data.score, _feedbackBusy: false, _feedbackStatus: '已完成', _feedbackTone: 'done', _feedbackPulse: true })
      followup.thank(this)
    } catch (error) {
      if (historyIdentity() === account && !this._historyDisposed && this._historyActive) this._patchTrip(id, {
        _feedbackBusy: false, _feedbackError: error?.code === 'ALREADY_RATED' ? '您已评价，请刷新查看' : '评价暂未保存，请重试' })
    }
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
    this.setData({ ratingPrompted: true, scrollIntoTrip: `history-trip-${index}` })
  }
})
