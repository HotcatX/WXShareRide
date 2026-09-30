const contacts = require("../../../utils/compat/rideContacts")
// pages/profile/myTripDetailDriver/myTripDetailDriver.js
const rideTelemetry = require("../../../utils/rideTelemetry")
const {
  callTripManage,
  askReason,
  rateTripUser,
  markRideListStale,
  isTargetRated
} = require("../../../utils/tripManage")

Page({
  data: {
    statusBarHeight: 80,
    pageTitle: '路线详情',

    loading: true,
    tripId: '',
    trip: null,

    fromText: '',
    toText: '',
    dateText: '',
    weekdayText: '',
    timeText: '',

    passengers: [],
    passengersLoading: false,
    ratedTargetMap: {},
    kickMode: false,
    isTripCompleted: false,

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

  async onLoad(options) {
    const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight })

    const tripId = (options && (options.tripId || options.id)) || ''
    if (!tripId) {
      wx.showToast({ title: '缺少路线ID', icon: 'none' })
      this.setData({ loading: false })
      return
    }
    this.setData({ tripId })

    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })

    await this.loadTripDetail(tripId)
  },

  onShow() {
    contacts.onShow(this, () => this.loadTripDetail(this.data.tripId))
    rideTelemetry.pageVisible(this)
    if (!this.data.loading && !this.data.loadError && this.data.trip) {
      rideTelemetry.detailViewed(this, this.data.trip, 'carpool', 'history')
    }
  },

  onHide() {
    contacts.onHide(this)
    rideTelemetry.pageHidden(this)
  },

  onUnload() {
    contacts.onUnload(this)
    rideTelemetry.pageHidden(this)
  },

  async onPullDownRefresh() {
    await this.onDetailRefresherRefresh()
  },

  async onDetailRefresherRefresh() {
    this.setData({ refresherTriggered: true })
    try {
      await this.loadTripDetail(this.data.tripId, { force: true, silent: true })
    } finally {
      this.setData({ refresherTriggered: false })
      wx.stopPullDownRefresh()
    }
  },

  async loadTripDetail(tripId, options = {}) {
    return contacts.load(this, 'carpool', tripId, 'driver', { ...options, creatorOnly: true })
  },

  toggleKickMode() {
    this.setData({ kickMode: !this.data.kickMode })
  },

  onCopyText(e) {
    const text = (e.currentTarget.dataset && e.currentTarget.dataset.text) || ''
    const val = String(text).trim()

    if (!val) {
      wx.showToast({ title: '暂无可复制内容', icon: 'none' })
      return
    }

    rideTelemetry.copyContact(this, val, e.currentTarget.dataset.channel, e.currentTarget.dataset.targetRole, {
      success: () => wx.showToast({ title: '已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' })
    })
  },

  async onKickPassenger(e) {
    const allowed = contacts.actionGuard(this)
    if (!allowed()) return
    const target = contacts.target(e)
    const targetId = target.targetUserId
    const { tripId } = this.data
    if (!targetId || !tripId) return

    const reason = await askReason({
      title: '剔除乘客',
      content: '',
      reasons: [
        '联系不上乘客',
        '乘客联系方式有误',
        '上下车地点不合适',
        '乘客临时改时间/地点',
        '双方协商取消',
        '其他'
      ],
      placeholder: '理由会发送给已加入乘客',
      confirmText: '剔除'
    })
    if (!reason || !allowed()) return

    try {
      wx.showLoading({ title: '正在处理...', mask: true })
      const result = await callTripManage({ type: 'carpool', tripId, action: 'kickPassenger', ...target, reason })
      wx.hideLoading()
      if (!allowed()) return
      if (result && (result.ok || result.success)) {
        wx.showToast({ title: result.recovered ? '已确认上次操作' : '已剔除', icon: 'success' })
        await this.loadTripDetail(tripId, { force: true, silent: true })
      } else {
        wx.showToast({ title: (result && result.errorMsg) || '操作失败', icon: 'none' })
      }
    } catch (e2) {
      wx.hideLoading()
      console.error('kickPassenger error:', e2)
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  async onDeleteOrQuit() {
    const allowed = contacts.actionGuard(this)
    if (!allowed()) return
    const { tripId } = this.data
    if (!tripId) return

    const reason = await askReason({
      title: '删除路线',
      content: '',
      reasons: [
        '误创行程',
        '时间/地点填写错误',
        '联系方式有误',
        '本人出行计划有变',
        '双方协商取消',
        '其他'
      ],
      placeholder: '理由会发送给已加入乘客',
      confirmText: '删除'
    })
    if (!reason || !allowed()) return

    try {
      wx.showLoading({ title: '正在删除...', mask: true })
      const result = await callTripManage({ type: 'carpool', tripId, action: 'deleteTrip', reason })
      wx.hideLoading()
      if (!allowed()) return
      if (result && (result.ok || result.success)) {
        wx.showToast({ title: result.recovered ? '已确认上次操作' : '已删除路线', icon: 'success' })
        setTimeout(() => { if (allowed()) this.goBack() }, 500)
      } else {
        wx.showToast({ title: (result && result.errorMsg) || '操作失败', icon: 'none' })
      }
    } catch (e2) {
      wx.hideLoading()
      console.error('deleteTrip error:', e2)
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  async onBlockUser(e) {
    const allowed = contacts.actionGuard(this)
    if (!allowed()) return
    const target = contacts.target(e)
    const targetId = target.targetUserId
    const targetName = (e.currentTarget.dataset && e.currentTarget.dataset.name) || '该用户'
    const { tripId } = this.data
    if (!targetId) return

    wx.showModal({
      title: '拉黑用户',
      content: `拉黑后，你们将无法加入彼此的路线。确认拉黑${targetName}？`,
      confirmText: '拉黑',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm || !allowed()) return
        try {
          const result = await callTripManage({ type: 'carpool', tripId, action: 'blockUser', ...target })
          if (!allowed()) return
          if (result && (result.ok || result.success)) markRideListStale()
          wx.showToast({ title: result && (result.ok || result.success) ? (result.recovered ? '已确认上次操作' : '已拉黑') : ((result && result.errorMsg) || '操作失败'), icon: result && (result.ok || result.success) ? 'success' : 'none' })
        } catch (e2) {
          console.error('blockUser error:', e2)
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
    const { tripId, isTripCompleted, ratedTargetMap } = this.data
    if (!isTripCompleted) {
      wx.showToast({ title: '只能评价过往行程', icon: 'none' })
      return
    }
    if (isTargetRated(ratedTargetMap, targetId)) {
      wx.showToast({ title: '已经评价过', icon: 'none' })
      return
    }
    const ok = await rateTripUser({
      type: 'carpool',
      tripId,
      ...target,
      targetRole: 'passenger',
      targetName,
      ratedTargetMap
    })
    if (ok && allowed()) await this.loadTripDetail(tripId, { force: true, silent: true })
  },

  onShareAppMessage() {
    const { tripId, fromText, toText, dateText, weekdayText, timeText } = this.data
    const title = `${fromText} → ${toText} ${dateText} ${weekdayText} ${timeText}`.trim()
    return getApp().withReferralShare({
      title: title ? `${title}｜寻找顺路乘客` : '寻找顺路乘客',
      path: `/pages/home/tripDetail/tripDetail?id=${tripId}&fromShare=1`
    })
  },

  onShareTimeline() {
    const { tripId, fromText, toText, dateText, weekdayText, timeText } = this.data
    const title = `${fromText} → ${toText} ${dateText} ${weekdayText} ${timeText}`.trim()
    return getApp().withReferralShare({
      title: title ? `${title}｜寻找顺路乘客` : '寻找顺路乘客',
      query: `id=${tripId}`
    })
  }
})
