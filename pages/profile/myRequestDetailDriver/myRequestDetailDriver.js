const contacts = require("../../../utils/compat/rideContacts")
// pages/profile/myRequestDetailDriver/myRequestDetailDriver.js
const rideTelemetry = require("../../../utils/rideTelemetry")
const {
  callTripManage,
  rateTripUser,
  markRideListStale,
  isTargetRated
} = require("../../../utils/tripManage")
const { removeTripDetailCache } = require("../../../utils/tripDetailCache")

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
    passengersLoading: false,
    passengersError: '',
    passengerSummaryText: '',
    ratedTargetMap: {},

    // 是否为该路线司机（只有为 true 才展示乘客信息 + 退出按钮）
    isMyRequest: false,
    isRequestCompleted: false,

    showFortLeeCoreTip: false,
    refresherTriggered: false,
    refreshHintText: "下拉刷新最新路线信息"
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
      passengersLoading: false,
      passengersError: '',
      passengerSummaryText: '',
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

    await this.loadRequestDetail(requestId, { force: true })
  },

  onShow() {
    contacts.onShow(this, () => this.loadRequestDetail(this.data.requestId))
    rideTelemetry.pageVisible(this)
    if (!this.data.loading && !this.data.loadError && this.data.trip) {
      rideTelemetry.detailViewed(this, this.data.trip, 'request', 'history')
    }
  },

  onHide() {
    contacts.onHide(this)
    rideTelemetry.pageHidden(this)
  },

  async onPullDownRefresh() {
    await this.onDetailRefresherRefresh()
  },

  onUnload() {
    contacts.onUnload(this)
    rideTelemetry.pageHidden(this)
    this._pageUnloaded = true
  },

  async onDetailRefresherRefresh() {
    this.setData({ refresherTriggered: true })
    try {
      await this.loadRequestDetail(this.data.requestId, { force: true, silent: true })
    } finally {
      if (!this._pageUnloaded) this.setData({ refresherTriggered: false })
      wx.stopPullDownRefresh()
    }
  },

  async loadRequestDetail(requestId, options = {}) {
    return contacts.load(this, 'request', requestId, 'driver', options)
  },

  onRetryPassengerInfo() {
    return this.loadRequestDetail(this.data.requestId, { force: true, silent: true })
  },

  copyPassengerWechat(e) {
    const wechatID = (e.currentTarget.dataset && e.currentTarget.dataset.wechat) || ''
    if (!wechatID) {
      wx.showToast({ title: '暂无微信号可复制', icon: 'none' })
      return
    }
    rideTelemetry.copyContact(this, String(wechatID).trim(), 'wechat', 'passenger', {
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
    rideTelemetry.copyContact(this, String(phone).trim(), 'phone', 'passenger', {
      success: () => wx.showToast({ title: '手机号已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' })
    })
  },

  async onQuitRequest() {
    const allowed = contacts.actionGuard(this)
    if (!allowed()) return
    const { requestId } = this.data
    if (!requestId) return

    wx.showModal({
      title: '退出路线',
      content: '退出后，该求车路线将重新对其他司机开放。确认退出？',
      confirmText: '确定退出',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm || !allowed()) return

        try {
          const result = await callTripManage({ type: 'request', requestId, action: 'quitDriver' })
          if (!allowed()) return

          const rr = result || {}

          if (!rr.ok) {
            wx.showToast({
              title: rr.errorMsg || '退出失败',
              icon: 'none'
            })
            return
          }

          if (rr && (rr.ok || rr.success)) {
            removeTripDetailCache('request', requestId)
            markRideListStale()
            wx.showToast({ title: result.recovered ? '已确认上次操作' : '已退出', icon: 'success' })
            setTimeout(() => { if (allowed()) this.goBack() }, 500)
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
    const allowed = contacts.actionGuard(this)
    if (!allowed()) return
    const target = contacts.target(e)
    const targetId = target.targetUserId
    const targetName = (e.currentTarget.dataset && e.currentTarget.dataset.name) || '该用户'
    const { requestId } = this.data
    if (!targetId) return

    wx.showModal({
      title: '拉黑用户',
      content: `拉黑后，你们将无法加入彼此的路线。确认拉黑${targetName}？`,
      confirmText: '拉黑',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm || !allowed()) return
        try {
          const result = await callTripManage({ type: 'request', requestId, action: 'blockUser', ...target })
          if (!allowed()) return
          if (result && (result.ok || result.success)) markRideListStale()
          wx.showToast({ title: result && (result.ok || result.success) ? (result.recovered ? '已确认上次操作' : '已拉黑') : ((result && result.errorMsg) || '操作失败'), icon: result && (result.ok || result.success) ? 'success' : 'none' })
        } catch (e) {
          console.error('blockUser error:', e)
          wx.showToast({ title: '操作失败', icon: 'none' })
        }
      }
    })
  },

  async onRatePassenger(e) {
    const allowed = contacts.actionGuard(this)
    if (!allowed()) return
    const target = contacts.target(e)
    const targetId = target.targetUserId
    const targetName = (e.currentTarget.dataset && e.currentTarget.dataset.name) || '该乘客'
    const { requestId, isRequestCompleted, ratedTargetMap } = this.data
    if (!isRequestCompleted) {
      wx.showToast({ title: '只能评价过往行程', icon: 'none' })
      return
    }
    if (isTargetRated(ratedTargetMap, targetId)) {
      wx.showToast({ title: '已经评价过', icon: 'none' })
      return
    }
    const ok = await rateTripUser({
      type: 'request',
      tripId: requestId,
      ...target,
      targetRole: 'passenger',
      targetName,
      ratedTargetMap
    })
    if (ok && allowed()) await this.loadRequestDetail(requestId, { force: true, silent: true })
  },

  onShareAppMessage() {
    const { requestId, fromText, toText, dateText, weekdayText, timeText } = this.data
    const title = `${fromText} → ${toText} ${dateText} ${weekdayText} ${timeText}`.trim()
    return getApp().withReferralShare({
      title: title ? `${title}｜寻找顺路乘客` : '寻找顺路乘客',
      path: `/pages/home/requestDetail/requestDetail?id=${requestId}&fromShare=1`
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
