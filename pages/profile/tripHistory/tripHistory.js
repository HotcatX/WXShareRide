// pages/profile/tripHistory/tripHistory.js

function cleanText(value) {
  return String(value || '').trim()
}

Page({
  data: {
    historyTrips: [],
    loading: false,
    statusBarHeight: 80,
    pageTitle: '历史行程',
    ratingTripId: '',
    ratingPrompted: false
  },

  async onLoad(options = {}) {
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
    await this.loadHistoryTrips()
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

    const fromAddress =
      trip?._fromAddress ||
      dep0?.address ||
      trip?.fromAddress ||
      trip?.startAddress ||
      trip?.departureAddress ||
      '（未知出发地）'

    const toAddress =
      trip?._toAddress ||
      dest0?.address ||
      trip?.toAddress ||
      trip?.endAddress ||
      trip?.destinationAddress ||
      '（未知目的地）'

    return { _fromAddress: fromAddress, _toAddress: toAddress }
  },

  _buildTimeLabel(trip) {
    // 优先使用 departures[0].date + departures[0].time（你旧版结构）
    const dep0 = this._pickFirstDeparture(trip)
    const date = dep0?.date || ''
    const time = dep0?.time || ''
    const label = `${date} ${time}`.trim()

    // 兼容 Carpool / CarpoolRequest 可能存在的字段
    return (
      label ||
      trip?._timeLabel ||
      trip?.timeLabel ||
      trip?.departureTime ||
      trip?.dateTime ||
      trip?.startTime ||
      trip?.createdAt ||
      ''
    )
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
    return source === 'carpoolrequest' || source === 'request' ? 'request' : 'carpool'
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
  async loadHistoryTrips() {
    this.setData({ loading: true })

    try {
      const res = await wx.cloud.callFunction({ name: 'getMyTripHistory' })

      if (res.result && res.result.ok) {
        const list = Array.isArray(res.result.data) ? res.result.data : []

        // 过滤掉无效项与 missing 占位（避免卡片空白）
        const cleaned = list.filter((item) => item && item._id && !item.missing)

        // 生成新卡片需要的一行字段
        const displayList = cleaned.map((t) => this._formatTripForCard(t))

        this.setData({ historyTrips: displayList })
        this._maybeOpenRatingDetail()
      } else {
        wx.showToast({
          title: res.result?.errorMsg || '历史行程加载失败',
          icon: 'none'
        })
      }
    } catch (err) {
      console.error('加载历史行程失败：', err)
      wx.showToast({ title: '历史行程加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
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
    const { ratingTripId, ratingPrompted, historyTrips } = this.data
    if (!ratingTripId || ratingPrompted || !Array.isArray(historyTrips) || historyTrips.length === 0) return
    const index = historyTrips.findIndex(item => item && item._id === ratingTripId)
    if (index < 0) return
    this.setData({ ratingPrompted: true })
    setTimeout(() => {
      this._openTripDetail(historyTrips[index], ratingTripId)
    }, 240)
  }
})
