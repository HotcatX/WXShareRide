const contacts = require("../../../utils/compat/rideContacts")
// pages/profile/myTripRequestPassenger/myTripRequestPassenger.js
const rideTelemetry = require("../../../utils/rideTelemetry")
const {
  callTripManage,
  askReason,
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

    showFortLeeCoreTip: false,

    // 信息
    driverInfo: null,
    driverInfoError: '',
    ratedTargetMap: {},
    otherPassengers: [],

    defaultAvatarUrl: '/images/profile.png',

    // 剔除模式
    kickMode: false,
    isRequestCompleted: false,
    refresherTriggered: false,
    refreshHintText: "下拉刷新最新路线信息"
  },

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
    const keys = [
      'fiat house',
      'modern',
      '2050',
      'hudson lights',
      'fort lee 核心区',
      'fort lee核心区',
      'fort lee core'
    ]
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
      showFortLeeCoreTip: false,
      driverInfo: null,
      driverInfoError: '',
      ratedTargetMap: {},
      otherPassengers: [],
      kickMode: false,
      isRequestCompleted: false
    })
  },

  toggleKickMode() {
    this.setData({ kickMode: !this.data.kickMode })
  },

  // ✅ 放置位置：就在 toggleKickMode() 的下面
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

  async onLoad(options) {
    const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight })

    const requestId =
      (options && (options.requestId || options.id || options.tripId || options.tripid)) || ''

    if (!requestId) {
      this.setLoadError('缺少路线ID')
      return
    }
    this.setData({ requestId })

    // ✅ 开启分享
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
    return contacts.load(this, 'request', requestId, 'passenger', { ...options, creatorOnly: true })
  },

  copyDriverWechat(e) {
    const wechat =
      (e.currentTarget.dataset && e.currentTarget.dataset.wechat) ||
      (this.data.driverInfo && this.data.driverInfo.wechatID) ||
      ''
    if (!wechat) return wx.showToast({ title: '未填写', icon: 'none' })
    rideTelemetry.copyContact(this, String(wechat).trim(), 'wechat', 'driver')
  },

  copyPassengerWechat(e) {
    const wechat = (e.currentTarget.dataset && e.currentTarget.dataset.wechat) || ''
    if (!wechat) return wx.showToast({ title: '未填写', icon: 'none' })
    rideTelemetry.copyContact(this, String(wechat).trim(), 'wechat', 'passenger')
  },

  copyZelleAccount(e) {
    const zelle =
      (e.currentTarget.dataset && e.currentTarget.dataset.zelle) ||
      (this.data.driverInfo && this.data.driverInfo.zelleAccount) ||
      ''
    if (!zelle) return wx.showToast({ title: '未填写', icon: 'none' })
    rideTelemetry.copyContact(this, String(zelle).trim(), 'zelle', 'driver')
  },

  onCallPhone(e) {
    const phone = (e.currentTarget.dataset && e.currentTarget.dataset.phone) || ''
    if (!phone) return wx.showToast({ title: '未填写手机号', icon: 'none' })
    rideTelemetry.copyContact(this, String(phone).trim(), 'phone', e.currentTarget.dataset.targetRole || 'unknown')
    wx.showToast({ title: '手机号已复制', icon: 'none' })
  },

  // ===== 剔除司机：仅 kickMode 下可用 =====
  async onKickDriver() {
    const allowed = contacts.actionGuard(this)
    if (!allowed()) return
    if (!this.data.kickMode) return
    const { requestId, driverInfo } = this.data
    if (!driverInfo || !driverInfo.userId) {
      wx.showToast({ title: '当前无司机', icon: 'none' })
      return
    }

    const reason = await askReason({
      title: '剔除司机',
      content: '',
      reasons: [
        '联系不上司机',
        '司机联系方式有误',
        '司机临时改时间/地点',
        '沟通不畅',
        '双方协商取消',
        '其他'
      ],
      placeholder: '理由会发送给该司机',
      confirmText: '剔除'
    })
    if (!reason || !allowed()) return

    try {
      wx.showLoading({ title: '正在处理...', mask: true })
      const result = await callTripManage({ type: 'request', requestId, action: 'kickDriver', targetUserId: driverInfo.userId, reason })
      wx.hideLoading()
      if (!allowed()) return
      if (result && (result.ok || result.success)) {
        removeTripDetailCache('request', requestId)
        markRideListStale()
        wx.showToast({ title: result.recovered ? '已确认上次操作' : '已剔除', icon: 'success' })
        await this.loadRequestDetail(requestId, { force: true, silent: true })
      } else {
        wx.showToast({ title: (result && result.errorMsg) || '操作失败', icon: 'none' })
      }
    } catch (e) {
      wx.hideLoading()
      console.error(e)
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  // ===== 剔除乘客：仅 kickMode 下可用 =====
  async onKickPassenger(e) {
    const allowed = contacts.actionGuard(this)
    if (!allowed()) return
    if (!this.data.kickMode) return
    const { requestId } = this.data
    const target = contacts.target(e)
    const targetId = target.targetUserId
    if (!targetId) return

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
      placeholder: '理由会发送给该乘客',
      confirmText: '剔除'
    })
    if (!reason || !allowed()) return

    try {
      wx.showLoading({ title: '正在处理...', mask: true })
      const result = await callTripManage({ type: 'request', requestId, action: 'kickPassenger', ...target, reason })
      wx.hideLoading()
      if (!allowed()) return
      if (result && (result.ok || result.success)) {
        removeTripDetailCache('request', requestId)
        markRideListStale()
        wx.showToast({ title: result.recovered ? '已确认上次操作' : '已剔除', icon: 'success' })
        await this.loadRequestDetail(requestId, { force: true, silent: true })
      } else {
        wx.showToast({ title: (result && result.errorMsg) || '操作失败', icon: 'none' })
      }
    } catch (e) {
      wx.hideLoading()
      console.error(e)
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  // ===== 创建者退出并删除路线 =====
  async onQuitAndDelete() {
    const allowed = contacts.actionGuard(this)
    if (!allowed()) return
    const { requestId } = this.data
    if (!requestId) return

    const reason = await askReason({
      title: '退出并删除路线',
      content: '',
      reasons: [
        '误创行程',
        '时间/地点填写错误',
        '联系方式有误',
        '本人出行计划有变',
        '已找到其他出行方式',
        '其他'
      ],
      placeholder: '理由会发送给司机和其他乘客',
      confirmText: '删除'
    })
    if (!reason || !allowed()) return

    try {
      wx.showLoading({ title: '正在删除...', mask: true })
      const result = await callTripManage({ type: 'request', requestId, action: 'deleteTrip', reason })
      wx.hideLoading()
      if (!allowed()) return

      if (result && (result.ok || result.success)) {
        removeTripDetailCache('request', requestId)
        markRideListStale()
        wx.showToast({ title: result.recovered ? '已确认上次操作' : '已删除', icon: 'success' })
        setTimeout(() => { if (allowed()) this.goBack() }, 500)
        return
      }

      wx.showModal({
        title: '删除未完成',
        content: (result && result.errorMsg) || '删除未完成，请稍后重试',
        showCancel: false
      })
    } catch (e) {
      wx.hideLoading()
      console.error(e)
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
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
          console.error(e)
          wx.showToast({ title: '操作失败', icon: 'none' })
        }
      }
    })
  },

  async onRateDriver(e) {
    const allowed = contacts.actionGuard(this)
    if (!allowed()) return
    const target = contacts.target(e)
    const targetId = target.targetUserId
    const targetName = (e.currentTarget.dataset && e.currentTarget.dataset.name) || '司机'
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
      targetRole: 'driver',
      targetName,
      ratedTargetMap
    })
    if (ok && allowed()) await this.loadRequestDetail(requestId, { force: true, silent: true })
  },

  onShareAppMessage() {
    const { requestId, fromText, toText, dateText, weekdayText, timeText } = this.data
    const title = `${fromText} → ${toText} ${dateText} ${weekdayText} ${timeText}`.trim()
    return getApp().withReferralShare({
      title: title ? `${title}｜寻找顺路同伴` : '寻找顺路同伴',
      path: `/pages/home/requestDetail/requestDetail?id=${requestId}&fromShare=1`
    })
  },

  onShareTimeline() {
    const { requestId, fromText, toText, dateText, weekdayText, timeText } = this.data
    const title = `${fromText} → ${toText} ${dateText} ${weekdayText} ${timeText}`.trim()
    return getApp().withReferralShare({
      title: title ? `${title}｜寻找顺路同伴` : '寻找顺路同伴',
      query: `id=${requestId}`
    })
  }
})
