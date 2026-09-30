const contacts = require("../../../utils/compat/rideContacts")
// pages/profile/myTripDetailPassenger/myTripDetailPassenger.js
const rideTelemetry = require("../../../utils/rideTelemetry")
const {
  callTripManage,
  askReason,
  rateTripUser,
  markRideListStale,
  isTargetRated
} = require("../../../utils/tripManage")

function normalizeSourceType(raw) {
  const value = String(raw || '').toLowerCase()
  return value === 'request' ? 'request' : 'carpool'
}


Page({
  data: {
    statusBarHeight: 80,
    pageTitle: '路线详情',

    loading: true,
    loadError: '',
    tripId: '',
    trip: null,

    sourceType: 'carpool', // 'carpool' | 'request'

    fromText: '',
    toText: '',
    dateText: '',
    weekdayText: '',
    timeText: '',

    driverInfo: null,
    ratedTargetMap: {},

    // CarpoolRequest：显示除自己外的其他乘客
    otherPassengers: [],
    passengerList: [],

    defaultAvatarUrl: '/images/profile.png',

    showFortLeeCoreTip: false,
    isTripCompleted: false,
    refresherTriggered: false,
    refreshHintText: "下拉刷新最新路线信息"
  },

  // --------- 日期格式 ---------
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
      driverInfo: null,
      ratedTargetMap: {},
      otherPassengers: [],
      passengerList: [],
      showFortLeeCoreTip: false,
      isTripCompleted: false
    })
  },

  async onLoad(options) {
    const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight })

    const tripId = (options && (options.tripId || options.id)) || ''
    if (!tripId) {
      this.setLoadError('缺少路线ID')
      return
    }
    const sourceType = normalizeSourceType(options && (options.sourceType || options.type || options.from))
    this.setData({ tripId, sourceType })

    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })

    await this.loadTripDetail(tripId, sourceType)
  },

  onShow() {
    contacts.onShow(this, () => this.loadTripDetail(this.data.tripId, this.data.sourceType))
    rideTelemetry.pageVisible(this)
    if (!this.data.loading && !this.data.loadError && this.data.trip) {
      rideTelemetry.detailViewed(this, this.data.trip, this.data.sourceType, 'history')
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
      await this.loadTripDetail(this.data.tripId, this.data.sourceType, { force: true, silent: true })
    } finally {
      this.setData({ refresherTriggered: false })
      wx.stopPullDownRefresh()
    }
  },

  onCopyText(e) {
    const text = (e.currentTarget.dataset && e.currentTarget.dataset.text) || ''
    if (!text) {
      wx.showToast({ title: '未填写', icon: 'none' })
      return
    }
    rideTelemetry.copyContact(this, String(text).trim(), e.currentTarget.dataset.channel, e.currentTarget.dataset.targetRole, {
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' })
    })
  },

  // ========== 主加载：按入口来源读取 Carpool 或 CarpoolRequest ==========
  async loadTripDetail(tripId, sourceType = this.data.sourceType, options = {}) {
    return contacts.load(this, sourceType, tripId, 'passenger', options)
  },

  copyDriverWechat() {
    const wechatID = (this.data.driverInfo && this.data.driverInfo.wechatID) || ''
    if (!wechatID) return wx.showToast({ title: '暂无微信号可复制', icon: 'none' })
    rideTelemetry.copyContact(this, String(wechatID).trim(), 'wechat', 'driver')
  },

  copyZelleAccount() {
    const zelle = (this.data.driverInfo && this.data.driverInfo.zelleAccount) || ''
    if (!zelle) return wx.showToast({ title: '暂无 Zelle 账号可复制', icon: 'none' })
    rideTelemetry.copyContact(this, String(zelle).trim(), 'zelle', 'driver')
  },

  copyPassengerWechat(e) {
    const wechatID = (e.currentTarget.dataset && e.currentTarget.dataset.wechat) || ''
    if (!wechatID) return wx.showToast({ title: '暂无微信号可复制', icon: 'none' })
    rideTelemetry.copyContact(this, String(wechatID).trim(), 'wechat', 'passenger')
  },

  onCallPhone(e) {
    const phone = (e.currentTarget.dataset && e.currentTarget.dataset.phone) || ''
    if (!phone) return wx.showToast({ title: '未填写手机号', icon: 'none' })
    rideTelemetry.copyContact(this, String(phone).trim(), 'phone', e.currentTarget.dataset.targetRole || 'unknown')
    wx.showToast({ title: '手机号已复制', icon: 'none' })
  },

  // ====== 统一退出：Carpool 或 CarpoolRequest ======
  async onDeleteOrQuit() {
    const allowed = contacts.actionGuard(this)
    if (!allowed()) return
    const { tripId, sourceType } = this.data
    if (!tripId) return

    const reason = await askReason({
      title: '退出路线',
      content: '',
      reasons: [
        '误加行程',
        '本人出行计划有变',
        '时间/地点不合适',
        '联系不上对方',
        '已找到其他出行方式',
        '其他'
      ],
      placeholder: '理由会发送给相关成员',
      confirmText: '继续'
    })
    if (!reason || !allowed()) return

    wx.showModal({
      title: '退出路线',
      content: '确认退出该出行计划吗？',
      confirmText: '退出',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm || !allowed()) return
        try {
          const result = await callTripManage({ type: sourceType, tripId, requestId: tripId, action: 'quitTrip', reason })
          if (!allowed()) return

          if (result && (result.ok || result.success)) {
            wx.showToast({ title: result.recovered ? '已确认上次操作' : '已退出路线', icon: 'success' })
            setTimeout(() => { if (allowed()) this.goBack() }, 500)
          } else {
            wx.showToast({ title: (result && result.errorMsg) || '操作失败', icon: 'none' })
          }
        } catch (e2) {
          console.error('quitTrip error:', e2)
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
    const { tripId, sourceType } = this.data
    if (!targetId) return

    wx.showModal({
      title: '拉黑用户',
      content: `拉黑后，你们将无法加入彼此的路线。确认拉黑${targetName}？`,
      confirmText: '拉黑',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm || !allowed()) return
        try {
          const result = await callTripManage({ type: sourceType, tripId, requestId: tripId, action: 'blockUser', ...target })
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

  async onRateDriver(e) {
    const allowed = contacts.actionGuard(this)
    if (!allowed()) return
    const target = contacts.target(e)
    const targetId = target.targetUserId
    const targetName = (e.currentTarget.dataset && e.currentTarget.dataset.name) || '司机'
    const { tripId, sourceType, isTripCompleted, ratedTargetMap } = this.data
    if (!isTripCompleted) {
      wx.showToast({ title: '只能评价过往行程', icon: 'none' })
      return
    }
    if (isTargetRated(ratedTargetMap, targetId)) {
      wx.showToast({ title: '已经评价过', icon: 'none' })
      return
    }
    const ok = await rateTripUser({
      type: sourceType,
      tripId,
      ...target,
      targetRole: 'driver',
      targetName,
      ratedTargetMap
    })
    if (ok && allowed()) await this.loadTripDetail(tripId, sourceType, { force: true, silent: true })
  },

  onShareAppMessage() {
    const { tripId, fromText, toText, dateText, weekdayText, timeText, sourceType } = this.data
    const title = `${fromText} → ${toText} ${dateText} ${weekdayText} ${timeText}`.trim() || '查看路线详情'


    // ✅ Carpool：分享公共详情页 tripDetail
    if (sourceType === 'carpool') {
      return getApp().withReferralShare({
        title,
        path: `/pages/home/tripDetail/tripDetail?id=${tripId}&fromShare=1`
      })
    }

    // 乘客求车记录分享指向接单详情
    return getApp().withReferralShare({
      title,
      path: `/pages/home/requestDetail/requestDetail?id=${tripId}&fromShare=1`
    })
  },

  onShareTimeline() {
    const { tripId, fromText, toText, dateText, weekdayText, timeText, sourceType } = this.data
    const title = `${fromText} → ${toText} ${dateText} ${weekdayText} ${timeText}`.trim()

    if (sourceType === 'carpool') {
      return getApp().withReferralShare({
        title: title ? `${title}｜寻找顺路乘客` : '寻找顺路乘客',
        query: `id=${tripId}`
      })
    }

    return getApp().withReferralShare({
      title: title ? `${title}｜寻找顺路司机` : '寻找顺路司机',
      query: `id=${tripId}&sourceType=request`
    })
  }

})
