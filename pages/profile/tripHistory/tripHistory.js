// pages/profile/tripHistory/tripHistory.js

Page({
  data: {
    historyTrips: [],
    loading: false,
    statusBarHeight: 80,
    pageTitle: '历史行程'
  },

  async onLoad() {
    const info = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight || 80 })
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

    // 兜底：兼容 Carpool / CarpoolRequest 可能存在的字段
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
    // 你云函数里建议返回 historyRole: driver_create | driver_join | passenger
    const r = trip?.historyRole || trip?.role || ''

    if (r === 'driver_create' || r === 'driver') return '角色：创建路线'
    if (r === 'driver_join') return '角色：加入路线'
    if (r === 'passenger') return '角色：乘客'

    // 兜底：有些旧数据 role 可能是 passenger/driver
    if (r === 'passenger') return '角色：乘客'
    return '角色：未知'
  },

  _formatTripForCard(trip) {
    const { _fromAddress, _toAddress } = this._buildFromTo(trip)

    return {
      ...trip,
      _fromAddress,
      _toAddress,
      _timeLabel: this._buildTimeLabel(trip),
      _roleLabel: this._buildRoleLabel(trip)
    }
  },

  // =========================
  // 拉取历史行程
  // =========================
  async loadHistoryTrips() {
    this.setData({ loading: true })
    wx.showLoading({ title: '加载历史行程...' })

    try {
      const res = await wx.cloud.callFunction({ name: 'getMyTripHistory' })
      console.log('getMyTripHistory 调用结果：', res)

      if (res.result && res.result.ok) {
        const list = Array.isArray(res.result.data) ? res.result.data : []

        // 过滤掉无效项与 missing 占位（避免卡片空白）
        const cleaned = list.filter((item) => item && item._id && !item.missing)

        // 生成新卡片需要的一行字段
        const displayList = cleaned.map((t) => this._formatTripForCard(t))

        this.setData({ historyTrips: displayList })
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
      wx.hideLoading()
    }
  },

  // =========================
  // 卡片点击跳转（按你项目实际详情页修改）
  // =========================
  // goTripDetail(e) {
  //   const id = e?.currentTarget?.dataset?.id
  //   if (!id) return

  //   // 你可以按实际路由改这里：
  //   // 例如：wx.navigateTo({ url: `/pages/home/tripDetail/tripDetail?id=${id}` })
  //   wx.navigateTo({
  //     url: `/pages/home/tripDetail/tripDetail?id=${id}`
  //   })
  // }
})
