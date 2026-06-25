// pages/profile/myRequestDetailDriver/myRequestDetailDriver.js
const {
  callTripManage,
  attachRideStats,
  rateTripUser,
  markRideListStale,
  buildRatedTargetMap,
  isTargetRated,
  formatRidePricePerPerson
} = require("../../../utils/tripManage")

Page({
  data: {
    statusBarHeight: 80,
    pageTitle: '求车详情',

    loading: true,
    loadError: '',
    requestId: '',
    trip: null,

    fromText: '',
    toText: '',
    dateText: '',
    weekdayText: '',
    timeText: '',

    // ✅ 行李数（CarpoolRequest）
    largeLuggageCount: 0,

    // 乘客信息
    passengers: [],
    ratedTargetMap: {},

    // 是否为该路线司机（只有为 true 才展示乘客信息 + 退出按钮）
    isMyRequest: false,
    isRequestCompleted: false,

    showFortLeeCoreTip: false
  },

  // ====== 工具：周几 ======
  getWeekdayCN(dateStr) {
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
  },

  formatDateNoYear(dateStr) {
    if (!dateStr) return ''
    const parts = String(dateStr).split('-')
    if (parts.length !== 3) return ''
    return `${Number(parts[1])}月${Number(parts[2])}日`
  },

  containsFortLeeCore(addr) {
    if (!addr) return false
    const s = String(addr).toLowerCase()
    const keys = ['fiat house', 'modern', '2050', 'hudson lights', 'fort lee 核心区', 'fort lee核心区', 'fort lee core']
    return keys.some(k => s.includes(k))
  },

  goBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else wx.reLaunch({ url: '/pages/home/home' })
  },

  setLoadError(message) {
    this.setData({
      loading: false,
      loadError: message || '加载失败',
      trip: null,
      fromText: '',
      toText: '',
      dateText: '',
      weekdayText: '',
      timeText: '',
      largeLuggageCount: 0,
      passengers: [],
      ratedTargetMap: {},
      isMyRequest: false,
      isRequestCompleted: false,
      showFortLeeCoreTip: false
    })
  },

  async onLoad(options) {
    const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight })

    const requestId =
      (options && (
        options.requestId ||
        options.id ||
        options.requestID ||
        options.tripId ||
        options.tripID ||
        options._id
      )) || ''

    this.setData({ requestId })

    if (!requestId) {
      this.setLoadError('缺少路线ID')
      return
    }

    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })

    await this.loadRequestDetail(requestId)
  },

  async onPullDownRefresh() {
    try {
      await this.loadRequestDetail(this.data.requestId)
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  async loadRequestDetail(requestId) {
    this.setData({ loading: true, loadError: '' })

    try {
      // 1) 读 CarpoolRequest 详情
      const res = await wx.cloud.callFunction({
        name: 'getTripDetail',
        data: { type: 'request', id: requestId }
      })

      // 兼容：有的函数返回 {success:true,data:[...]}，有的返回 {ok:true,data:...}
      const rawResult = res && res.result ? res.result : null
      const success = !!(rawResult && (rawResult.success || rawResult.ok))
      if (!success) {
        this.setLoadError((rawResult && (rawResult.errorMsg || rawResult.msg)) || '加载失败')
        return
      }

      const trip = Array.isArray(rawResult.data) ? rawResult.data[0] : rawResult.data
      if (!trip) {
        this.setLoadError('该求车路线不存在或已被删除')
        return
      }
      const ratedTargetMap = buildRatedTargetMap(rawResult)

      // 2) 基础展示字段
      const dep0 = (trip.departures && trip.departures[0]) ? trip.departures[0] : {}
      const des0 = (trip.destinations && trip.destinations[0]) ? trip.destinations[0] : {}

      const fromText = dep0.address || ''
      const toText = des0.address || ''

      const rawDate = dep0.date || ''
      const weekdayText = this.getWeekdayCN(rawDate)
      const dateText = this.formatDateNoYear(rawDate)
      const timeText = dep0.time || ''

      const showFortLeeCoreTip = this.containsFortLeeCore(fromText) || this.containsFortLeeCore(toText)

      // ✅ 2.1 读取行李数（兼容多个字段名）
      const largeLuggageCount = Number(
        trip.largeLuggageCount ??
        trip.largeBaggageCount ??
        trip.luggageCount ??
        trip.baggageCount ??
        0
      ) || 0

      // 3) 判断是否本路线司机
      const myOpenid = (rawResult && rawResult.openid) ? rawResult.openid : ''
      const driverOpenid = trip.driverOpenid || trip.driverID || trip.driverId || ''
      const isMyRequest = !!(driverOpenid && myOpenid && driverOpenid === myOpenid)
      const rawStatus = String(trip.status || 'open').toLowerCase()
      const isRequestCompleted = rawStatus === 'past' || rawStatus === 'close' || rawStatus === 'closed'
      const displayTrip = {
        ...trip,
        referencePriceText: formatRidePricePerPerson(trip.referencePrice || trip.price || trip.displayPrice)
      }

      // 4) 拉取乘客信息：通过 passengerID（数组）读取 openids
      const passengerOpenids = Array.isArray(trip.passengerID)
        ? trip.passengerID.filter(Boolean)
        : (Array.isArray(trip.passengerIds) ? trip.passengerIds.filter(Boolean) : [])

      let passengers = []
      if (isMyRequest && passengerOpenids.length > 0) {
        const uRes = await wx.cloud.callFunction({
          name: 'getUserInfoByOpenids',
          data: { openids: passengerOpenids }
        })
        if (uRes.result && uRes.result.ok) {
          const list = uRes.result.data || []
          const map = {}
          list.forEach(u => { if (u && u._openid) map[u._openid] = u })

          passengers = passengerOpenids.map(op => {
            const u = map[op] || {}
            return {
              _openid: op,
              name: u.name || '',
              phone: u.phone || '',
              wechatID: u.wechatID || '',
              address: u.address || '',
              avatarUrl: u.avatarUrl || '',
              ...attachRideStats(u, 'passenger'),
              hasRated: isTargetRated(ratedTargetMap, op)
            }
          })
        }
      }

      this.setData({
        trip: displayTrip,
        fromText,
        toText,
        dateText,
        weekdayText,
        timeText,
        showFortLeeCoreTip,

        // ✅ 行李数
        largeLuggageCount,

        isMyRequest,
        isRequestCompleted,
        passengers,
        ratedTargetMap,

        loadError: '',
        loading: false
      })
    } catch (e) {
      console.error('loadRequestDetail error:', e)
      this.setLoadError('加载失败，请稍后重试')
    }
  },

  copyPassengerWechat(e) {
    const wechatID = (e.currentTarget.dataset && e.currentTarget.dataset.wechat) || ''
    if (!wechatID) {
      wx.showToast({ title: '暂无微信号可复制', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: String(wechatID).trim(),
      success: () => wx.showToast({ title: '微信号已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' })
    })
  },

  onCopyPhone(e) {
    const phone = (e.currentTarget.dataset && e.currentTarget.dataset.phone) || ''
    if (!phone) {
      wx.showToast({ title: '未填写手机号', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: String(phone).trim(),
      success: () => wx.showToast({ title: '手机号已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' })
    })
  },

  async onQuitRequest() {
    const { requestId } = this.data
    if (!requestId) return

    wx.showModal({
      title: '退出路线',
      content: '退出后，该求车路线将重新对其他司机开放。确认退出？',
      confirmText: '确定退出',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm) return

        try {
          const result = await callTripManage({ type: 'request', requestId, action: 'quitDriver' })

          const rr = result || {}

          if (!rr.ok) {
            wx.showToast({
              title: rr.errorMsg || '退出失败',
              icon: 'none'
            })
            return
          }

          if (rr && (rr.ok || rr.success)) {
            wx.showToast({ title: '已退出', icon: 'success' })
            setTimeout(() => this.goBack(), 500)
          } else {
            wx.showToast({ title: (rr && rr.errorMsg) || '操作失败', icon: 'none' })
          }
        } catch (e2) {
          console.error('quitRequest error:', e2)
          wx.showToast({ title: '操作失败', icon: 'none' })
        }
      }
    })
  },

  async onBlockUser(e) {
    const targetOpenid = (e.currentTarget.dataset && e.currentTarget.dataset.openid) || ''
    const targetName = (e.currentTarget.dataset && e.currentTarget.dataset.name) || '该用户'
    const { requestId } = this.data
    if (!targetOpenid) return

    wx.showModal({
      title: '拉黑用户',
      content: `拉黑后，你们将无法加入彼此的拼车路线。确认拉黑${targetName}？`,
      confirmText: '拉黑',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm) return
        try {
          const result = await callTripManage({ type: 'request', requestId, action: 'blockUser', targetOpenid })
          if (result && (result.ok || result.success)) markRideListStale()
          wx.showToast({ title: result && (result.ok || result.success) ? '已拉黑' : ((result && result.errorMsg) || '操作失败'), icon: result && (result.ok || result.success) ? 'success' : 'none' })
        } catch (e) {
          console.error('blockUser error:', e)
          wx.showToast({ title: '操作失败', icon: 'none' })
        }
      }
    })
  },

  async onRatePassenger(e) {
    const targetOpenid = (e.currentTarget.dataset && e.currentTarget.dataset.openid) || ''
    const targetName = (e.currentTarget.dataset && e.currentTarget.dataset.name) || '该乘客'
    const { requestId, isRequestCompleted, ratedTargetMap } = this.data
    if (!isRequestCompleted) {
      wx.showToast({ title: '只能评价过往行程', icon: 'none' })
      return
    }
    if (isTargetRated(ratedTargetMap, targetOpenid)) {
      wx.showToast({ title: '已经评价过', icon: 'none' })
      return
    }
    const ok = await rateTripUser({
      type: 'request',
      tripId: requestId,
      targetOpenid,
      targetRole: 'passenger',
      targetName,
      ratedTargetMap
    })
    if (ok) await this.loadRequestDetail(requestId)
  },

  onShareAppMessage() {
    const { requestId, fromText, toText, dateText, weekdayText, timeText } = this.data
    const title = `${fromText} → ${toText} ${dateText} ${weekdayText} ${timeText}`.trim()
    return getApp().withReferralShare({
      title: title ? `${title}｜寻找顺路乘客` : '寻找顺路乘客',
      path: `/pages/home/carpoolRequestDetail/carpoolRequestDetail?id=${requestId}`
    })
  },

  onShareTimeline() {
    const { requestId, fromText, toText, dateText, weekdayText, timeText } = this.data
    const title = `${fromText} → ${toText} ${dateText} ${weekdayText} ${timeText}`.trim()
    return getApp().withReferralShare({
      title: title ? `${title}｜寻找顺路乘客` : '寻找顺路乘客',
      query: `id=${requestId}`
    })
  }
})
