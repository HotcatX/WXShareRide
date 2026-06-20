// pages/profile/myTripRequestPassenger/myTripRequestPassenger.js
const {
  callTripManage,
  askReason,
  attachRideStats,
  rateTripUser,
  markRideListStale,
  buildRatedTargetMap,
  isTargetRated
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

    showFortLeeCoreTip: false,

    // 身份
    myOpenid: '',
    creatorOpenid: '',

    // 信息
    driverInfo: null,
    ratedTargetMap: {},
    otherPassengers: [],

    defaultAvatarUrl: '/images/profile.png',

    // 剔除模式
    kickMode: false,
    isRequestCompleted: false
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

  async getMyOpenid() {
    try {
      const res = await wx.cloud.callFunction({ name: 'login' })
      return (res && res.result && (res.result.openid || res.result.OPENID)) || ''
    } catch (e) {
      return ''
    }
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

    wx.setClipboardData({
      data: val,
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

      const rr = res && res.result ? res.result : null
      const ok = !!(rr && (rr.ok || rr.success))
      if (!ok) {
        this.setLoadError((rr && (rr.errorMsg || rr.msg)) || '加载失败')
        return
      }

      const trip = Array.isArray(rr.data) ? rr.data[0] : rr.data
      if (!trip) {
        this.setLoadError('该求车路线不存在或已被删除')
        return
      }

      // ✅ myOpenid 必须可靠：云函数不返回则调用 login 获取
      const myOpenid = rr.openid || (await this.getMyOpenid()) || ''
      const creatorOpenid = trip._openid || trip.creatorOpenid || trip.passengerOpenid || ''
      const rawStatus = String(trip.status || 'open').toLowerCase()
      const isRequestCompleted = rawStatus === 'past' || rawStatus === 'close' || rawStatus === 'closed'
      const ratedTargetMap = buildRatedTargetMap(rr)

      // 基础字段
      const dep0 = (trip.departures && trip.departures[0]) ? trip.departures[0] : {}
      const des0 = (trip.destinations && trip.destinations[0]) ? trip.destinations[0] : {}

      const fromText = dep0.address || ''
      const toText = des0.address || ''

      const rawDate = dep0.date || ''
      const weekdayText = this.getWeekdayCN(rawDate)
      const dateText = this.formatDateNoYear(rawDate)
      const timeText = dep0.time || ''

      const showFortLeeCoreTip =
        this.containsFortLeeCore(fromText) || this.containsFortLeeCore(toText)

      // 2) 司机信息（若已接单）
      const driverOpenid =
        trip.driverOpenid || trip.driverOpenId || trip.driverID || trip.driverId || trip.driver || ''
      let driverInfo = null
      if (driverOpenid) {
        const uRes = await wx.cloud.callFunction({
          name: 'getUserInfoByOpenids',
          data: { openids: [driverOpenid] }
        })
        if (uRes.result && uRes.result.ok) {
          const u = (uRes.result.data && uRes.result.data[0]) ? uRes.result.data[0] : {}
          // ✅ 对齐 myTripDetailPassenger 的司机字段
          driverInfo = {
            _openid: driverOpenid,
            name: u.name || '',
            phone: u.phone || '',
            wechatID: u.wechatID || '',
            avatarUrl: u.avatarUrl || '',
            carNumber: u.carNumber || '',
            carBrand: u.carBrand || '',
            carModel: u.carModel || '',
            zelleName: u.zelleName || '',
            zelleAccount: u.zelleAccount || '',
            ...attachRideStats(u, 'driver'),
            hasRated: isTargetRated(ratedTargetMap, driverOpenid)
          }
        }
      }

      // 3) 其他乘客：显示除“我本人”以外所有加入乘客（兼容 passengerID/passengerIDs）
      const a1 = Array.isArray(trip.passengerID) ? trip.passengerID : []
      const a2 = Array.isArray(trip.passengerIDs) ? trip.passengerIDs : []
      const passengerOpenids = Array.from(new Set([...a1, ...a2].filter(Boolean)))

      const filteredOpenids = passengerOpenids.filter(op => {
        if (!op) return false
        if (myOpenid && op === myOpenid) return false
        return true
      })

      let otherPassengers = []
      if (filteredOpenids.length > 0) {
        const pRes = await wx.cloud.callFunction({
          name: 'getUserInfoByOpenids',
          data: { openids: filteredOpenids }
        })
        if (pRes.result && pRes.result.ok) {
          const list = pRes.result.data || []
          const map = {}
          list.forEach(u => { if (u && u._openid) map[u._openid] = u })

          otherPassengers = filteredOpenids.map(op => {
            const u = map[op] || {}
            return {
              _openid: op,
              name: u.name || '',
              phone: u.phone || '',
              wechatID: u.wechatID || '',
              avatarUrl: u.avatarUrl || '',
              address: u.address || '',
              ...attachRideStats(u, 'passenger')
            }
          })
        }
      }

      this.setData({
        trip,
        myOpenid,
        creatorOpenid,
        fromText,
        toText,
        dateText,
        weekdayText,
        timeText,
        showFortLeeCoreTip,
        driverInfo,
        ratedTargetMap,
        otherPassengers,
        isRequestCompleted,
        kickMode: isRequestCompleted ? false : this.data.kickMode,
        loadError: '',
        loading: false
      })
    } catch (e) {
      console.error('loadRequestDetail error:', e)
      this.setLoadError('加载失败，请稍后重试')
    }
  },

  // ===== 复制/电话：复制到剪贴板 =====
  // （以下为你原有函数：保留不影响，但当前 WXML 已改用 onCopyText + data-text）
  copyDriverWechat(e) {
    const wechat =
      (e.currentTarget.dataset && e.currentTarget.dataset.wechat) ||
      (this.data.driverInfo && this.data.driverInfo.wechatID) ||
      ''
    if (!wechat) return wx.showToast({ title: '未填写', icon: 'none' })
    wx.setClipboardData({ data: String(wechat).trim() })
  },

  copyPassengerWechat(e) {
    const wechat = (e.currentTarget.dataset && e.currentTarget.dataset.wechat) || ''
    if (!wechat) return wx.showToast({ title: '未填写', icon: 'none' })
    wx.setClipboardData({ data: String(wechat).trim() })
  },

  copyZelleAccount(e) {
    const zelle =
      (e.currentTarget.dataset && e.currentTarget.dataset.zelle) ||
      (this.data.driverInfo && this.data.driverInfo.zelleAccount) ||
      ''
    if (!zelle) return wx.showToast({ title: '未填写', icon: 'none' })
    wx.setClipboardData({ data: String(zelle).trim() })
  },

  onCallPhone(e) {
    const phone = (e.currentTarget.dataset && e.currentTarget.dataset.phone) || ''
    if (!phone) return wx.showToast({ title: '未填写手机号', icon: 'none' })
    wx.setClipboardData({ data: String(phone).trim() })
    wx.showToast({ title: '手机号已复制', icon: 'none' })
  },

  // ===== 剔除司机：仅 kickMode 下可用 =====
  async onKickDriver() {
    if (!this.data.kickMode) return
    const { requestId, driverInfo } = this.data
    if (!driverInfo || !driverInfo._openid) {
      wx.showToast({ title: '当前无司机', icon: 'none' })
      return
    }

    const reason = await askReason({
      title: '剔除司机',
      content: '理由会作为消息发送给该司机。',
      placeholder: '例如沟通不畅、临时调整',
      confirmText: '剔除'
    })
    if (!reason) return

    try {
      wx.showLoading({ title: '正在处理...', mask: true })
      const result = await callTripManage({ type: 'request', requestId, action: 'kickDriver', reason })
      wx.hideLoading()
      if (result && (result.ok || result.success)) {
        wx.showToast({ title: '已剔除', icon: 'success' })
        await this.loadRequestDetail(requestId)
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
    if (!this.data.kickMode) return
    const { requestId } = this.data
    const targetOpenid = (e.currentTarget.dataset && e.currentTarget.dataset.openid) || ''
    if (!targetOpenid) return

    const reason = await askReason({
      title: '剔除乘客',
      content: '理由会作为消息发送给该乘客。',
      placeholder: '例如信息不匹配、长期未回复',
      confirmText: '剔除'
    })
    if (!reason) return

    try {
      wx.showLoading({ title: '正在处理...', mask: true })
      const result = await callTripManage({ type: 'request', requestId, action: 'kickPassenger', targetOpenid, reason })
      wx.hideLoading()
      if (result && (result.ok || result.success)) {
        wx.showToast({ title: '已剔除', icon: 'success' })
        await this.loadRequestDetail(requestId)
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
    const { requestId } = this.data
    if (!requestId) return

    const reason = await askReason({
      title: '退出并删除路线',
      content: '理由会作为消息发送给司机和已加入乘客。',
      placeholder: '例如临时取消、时间变更',
      confirmText: '删除'
    })
    if (!reason) return

    try {
      wx.showLoading({ title: '正在删除...', mask: true })
      const result = await callTripManage({ type: 'request', requestId, action: 'deleteTrip', reason })
      wx.hideLoading()

      if (result && (result.ok || result.success)) {
        wx.showToast({ title: '已删除', icon: 'success' })
        setTimeout(() => this.goBack(), 500)
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
          console.error(e)
          wx.showToast({ title: '操作失败', icon: 'none' })
        }
      }
    })
  },

  async onRateDriver(e) {
    const targetOpenid = (e.currentTarget.dataset && e.currentTarget.dataset.openid) || ''
    const targetName = (e.currentTarget.dataset && e.currentTarget.dataset.name) || '司机'
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
      targetRole: 'driver',
      targetName,
      ratedTargetMap
    })
    if (ok) await this.loadRequestDetail(requestId)
  },

  onShareAppMessage() {
    const { requestId, fromText, toText, dateText, weekdayText, timeText } = this.data
    const title = `${fromText} → ${toText} ${dateText} ${weekdayText} ${timeText}`.trim()
    return getApp().withReferralShare({
      title: title ? `${title}｜寻找顺路司机` : '寻找顺路司机',
      path: `/pages/home/driverPickupDetail/driverPickupDetail?id=${requestId}`
    })
  },

  onShareTimeline() {
    const { requestId, fromText, toText, dateText, weekdayText, timeText } = this.data
    const title = `${fromText} → ${toText} ${dateText} ${weekdayText} ${timeText}`.trim()
    return getApp().withReferralShare({
      title: title ? `${title}｜寻找顺路司机` : '寻找顺路司机',
      query: `id=${requestId}`
    })
  }
})
