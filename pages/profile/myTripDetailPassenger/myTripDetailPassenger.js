// pages/profile/myTripDetailPassenger/myTripDetailPassenger.js
const { showDataError } = require("../../../utils/error")
const {
  callTripManage,
  askReason,
  attachRideStats,
  rateTripUser,
  markRideListStale,
  buildRatedTargetMap,
  isTargetRated,
  formatRidePricePerPerson
} = require("../../../utils/tripManage")

function normalizeSourceType(raw) {
  const value = String(raw || '').toLowerCase()
  return value === 'request' || value === 'carpoolrequest' ? 'request' : 'carpool'
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
    isTripCompleted: false
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

  async getMyOpenid() {
    try {
      const res = await wx.cloud.callFunction({ name: 'login' })
      const oid = (res && res.result && (res.result.openid || res.result.OPENID)) || ''
      return oid
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

  async onPullDownRefresh() {
    try {
      await this.loadTripDetail(this.data.tripId, this.data.sourceType)
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  onCopyText(e) {
    const text = (e.currentTarget.dataset && e.currentTarget.dataset.text) || ''
    if (!text) {
      wx.showToast({ title: '未填写', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: String(text).trim(),
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' })
    })
  },

  // ========== 主加载：按入口来源读取 Carpool 或 CarpoolRequest ==========
  async loadTripDetail(tripId, sourceType = this.data.sourceType) {
    this.setData({ loading: true, loadError: '' })

    try {
      if (sourceType === 'request') {
        const reqRes = await wx.cloud.callFunction({
          name: 'getTripDetail',
          data: { type: 'request', id: tripId }
        })

        const rr = reqRes && reqRes.result ? reqRes.result : null
        const reqOk = !!(rr && (rr.ok || rr.success))
        const reqTrip = reqOk ? (Array.isArray(rr.data) ? rr.data[0] : rr.data) : null

        if (!reqTrip) {
          this.setLoadError((rr && (rr.errorMsg || rr.msg)) || '该路线不存在或已被删除')
          return
        }

        await this.applyRequestTrip(reqTrip, rr)
        return
      }

      const carpoolRes = await wx.cloud.callFunction({
        name: 'getTripDetail',
        data: { type: 'carpool', id: tripId }
      })

      const carpoolOk = !!(carpoolRes.result && carpoolRes.result.success)
      const carpoolTrip = carpoolOk
        ? (Array.isArray(carpoolRes.result.data) ? carpoolRes.result.data[0] : carpoolRes.result.data)
        : null

      if (carpoolTrip) {
        await this.applyCarpoolTrip(carpoolTrip, carpoolRes.result)
        return
      }

      const cr = carpoolRes && carpoolRes.result ? carpoolRes.result : null
      this.setLoadError((cr && (cr.errorMsg || cr.msg)) || '该路线不存在或已被删除')
    } catch (e) {
      console.error('loadTripDetail error:', e)
      showDataError('路线加载失败', e, '路线详情从数据库加载失败，请稍后重试。')
      this.setLoadError('加载失败，请稍后重试')
    }
  },

  // ========== Carpool 场景：只显示司机信息 ==========
  async applyCarpoolTrip(trip, detailResult = {}) {
    const dep0 = (trip.departures && trip.departures[0]) ? trip.departures[0] : {}
    const des0 = (trip.destinations && trip.destinations[0]) ? trip.destinations[0] : {}

    const fromText = dep0.address || ''
    const toText = des0.address || ''

    const rawDate = dep0.date || ''
    const weekdayText = this.getWeekdayCN(rawDate)
    const dateText = this.formatDateNoYear(rawDate)
    const timeText = dep0.time || ''

    const showFortLeeCoreTip = this.containsFortLeeCore(fromText) || this.containsFortLeeCore(toText)
    const rawStatus = String(trip.status || 'open').toLowerCase()
    const isTripCompleted = rawStatus === 'past' || rawStatus === 'close' || rawStatus === 'closed'
    const ratedTargetMap = buildRatedTargetMap(detailResult)
    const displayTrip = {
      ...trip,
      referencePriceText: formatRidePricePerPerson(trip.referencePrice || trip.price || trip.displayPrice)
    }

    // Carpool 的司机一般就是 trip._openid（创建者），也兼容 driver 字段
    const driverOpenid =
      trip._openid || trip.driverOpenid || trip.driverOpenId || trip.driverID || trip.driverId || ''

    let driverInfo = null
    if (driverOpenid) {
      const uRes = await wx.cloud.callFunction({
        name: 'getUserInfoByOpenids',
        data: { openids: [driverOpenid] }
      })
      if (uRes.result && uRes.result.ok) {
        const u = (uRes.result.data && uRes.result.data[0]) ? uRes.result.data[0] : {}
        driverInfo = {
          _openid: driverOpenid,
          name: u.name || '',
          phone: u.phone || '',
          wechatID: u.wechatID || '',
          carNumber: u.carNumber || '',
          zelleName: u.zelleName || '',
          zelleAccount: u.zelleAccount || '',
          avatarUrl: u.avatarUrl || '',
          ...attachRideStats(u, 'driver'),
          hasRated: isTargetRated(ratedTargetMap, driverOpenid)
        }
      }
    }

    this.setData({
      sourceType: 'carpool',
      trip: displayTrip,
      driverInfo,
      ratedTargetMap,

      // Carpool：不展示乘客列表
      otherPassengers: [],
      passengerList: [],

      fromText,
      toText,
      dateText,
      weekdayText,
      timeText,
      showFortLeeCoreTip,
      isTripCompleted,
      loadError: '',
      loading: false
    })
  },

  // ========== CarpoolRequest 场景：显示司机 + 所有加入乘客（不含自己） ==========
  async applyRequestTrip(trip, rr) {
    const dep0 = (trip.departures && trip.departures[0]) ? trip.departures[0] : {}
    const des0 = (trip.destinations && trip.destinations[0]) ? trip.destinations[0] : {}

    const fromText = dep0.address || ''
    const toText = des0.address || ''

    const rawDate = dep0.date || ''
    const weekdayText = this.getWeekdayCN(rawDate)
    const dateText = this.formatDateNoYear(rawDate)
    const timeText = dep0.time || ''

    const showFortLeeCoreTip = this.containsFortLeeCore(fromText) || this.containsFortLeeCore(toText)
    const rawStatus = String(trip.status || 'open').toLowerCase()
    const isTripCompleted = rawStatus === 'past' || rawStatus === 'close' || rawStatus === 'closed'
    const ratedTargetMap = buildRatedTargetMap(rr)
    const displayTrip = {
      ...trip,
      referencePriceText: formatRidePricePerPerson(trip.referencePrice || trip.price || trip.displayPrice)
    }

    // 当前用户 openid：优先 rr.openid，否则调用 login 获取
    const myOpenid = (rr && rr.openid) ? rr.openid : (await this.getMyOpenid())

    // 司机 openid：CarpoolRequest 常见 driverOpenid/driverID（兼容大小写）
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
        driverInfo = {
          _openid: driverOpenid,
          name: u.name || '',
          phone: u.phone || '',
          wechatID: u.wechatID || '',
          carNumber: u.carNumber || '',
          zelleName: u.zelleName || '',
          zelleAccount: u.zelleAccount || '',
          avatarUrl: u.avatarUrl || '',
          ...attachRideStats(u, 'driver'),
          hasRated: isTargetRated(ratedTargetMap, driverOpenid)
        }
      }
    }

    // ✅ 乘客 openids：合并 passengerID + passengerIDs（兼容历史字段），去重
    const a1 = Array.isArray(trip.passengerID) ? trip.passengerID : []
    const a2 = Array.isArray(trip.passengerIDs) ? trip.passengerIDs : []
    const passengerOpenids = Array.from(new Set([...a1, ...a2].filter(Boolean)))

    // ✅ 仅剔除“我自己”，不剔除创建者（创建者也是乘客之一）
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

        // 保持顺序
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
      sourceType: 'request',
      trip: displayTrip,
      driverInfo,
      ratedTargetMap,

      otherPassengers,
      passengerList: otherPassengers, // ✅ 给 WXML 直接照抄 passengerList

      fromText,
      toText,
      dateText,
      weekdayText,
      timeText,
      showFortLeeCoreTip,
      isTripCompleted,
      loadError: '',
      loading: false
    })
  },

  // ====== 复制 ======
  copyDriverWechat() {
    const wechatID = (this.data.driverInfo && this.data.driverInfo.wechatID) || ''
    if (!wechatID) return wx.showToast({ title: '暂无微信号可复制', icon: 'none' })
    wx.setClipboardData({ data: String(wechatID).trim() })
  },

  copyZelleAccount() {
    const zelle = (this.data.driverInfo && this.data.driverInfo.zelleAccount) || ''
    if (!zelle) return wx.showToast({ title: '暂无 Zelle 账号可复制', icon: 'none' })
    wx.setClipboardData({ data: String(zelle).trim() })
  },

  copyPassengerWechat(e) {
    const wechatID = (e.currentTarget.dataset && e.currentTarget.dataset.wechat) || ''
    if (!wechatID) return wx.showToast({ title: '暂无微信号可复制', icon: 'none' })
    wx.setClipboardData({ data: String(wechatID).trim() })
  },

  onCallPhone(e) {
    const phone = (e.currentTarget.dataset && e.currentTarget.dataset.phone) || ''
    if (!phone) return wx.showToast({ title: '未填写手机号', icon: 'none' })
    wx.setClipboardData({ data: String(phone).trim() })
    wx.showToast({ title: '手机号已复制', icon: 'none' })
  },

  // ====== 统一退出：Carpool 或 CarpoolRequest ======
  async onDeleteOrQuit() {
    const { tripId, sourceType } = this.data
    if (!tripId) return

    const reason = await askReason({
      title: '退出路线',
      content: '理由会作为消息发送给相关成员。',
      reasons: [
        '误加行程',
        '本人出行计划有变',
        '时间/地点不合适',
        '联系不上对方',
        '已找到其他出行方式',
        '其他'
      ],
      placeholder: '例如临时有事、时间不合适',
      confirmText: '继续'
    })
    if (!reason) return

    wx.showModal({
      title: '退出路线',
      content: '确认退出该出行计划吗？',
      confirmText: '退出',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm) return
        try {
          const result = await callTripManage({ type: sourceType, tripId, requestId: tripId, action: 'quitTrip', reason })

          if (result && (result.ok || result.success)) {
            wx.showToast({ title: '已退出路线', icon: 'success' })
            setTimeout(() => this.goBack(), 500)
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
    const targetOpenid = (e.currentTarget.dataset && e.currentTarget.dataset.openid) || ''
    const targetName = (e.currentTarget.dataset && e.currentTarget.dataset.name) || '该用户'
    const { tripId, sourceType } = this.data
    if (!targetOpenid) return

    wx.showModal({
      title: '拉黑用户',
      content: `拉黑后，你们将无法加入彼此的拼车路线。确认拉黑${targetName}？`,
      confirmText: '拉黑',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm) return
        try {
          const result = await callTripManage({ type: sourceType, tripId, requestId: tripId, action: 'blockUser', targetOpenid })
          if (result && (result.ok || result.success)) markRideListStale()
          wx.showToast({ title: result && (result.ok || result.success) ? '已拉黑' : ((result && result.errorMsg) || '操作失败'), icon: result && (result.ok || result.success) ? 'success' : 'none' })
        } catch (e2) {
          console.error('blockUser error:', e2)
          wx.showToast({ title: '操作失败', icon: 'none' })
        }
      }
    })
  },

  async onRateDriver(e) {
    const targetOpenid = (e.currentTarget.dataset && e.currentTarget.dataset.openid) || ''
    const targetName = (e.currentTarget.dataset && e.currentTarget.dataset.name) || '司机'
    const { tripId, sourceType, isTripCompleted, ratedTargetMap } = this.data
    if (!isTripCompleted) {
      wx.showToast({ title: '只能评价过往行程', icon: 'none' })
      return
    }
    if (isTargetRated(ratedTargetMap, targetOpenid)) {
      wx.showToast({ title: '已经评价过', icon: 'none' })
      return
    }
    const ok = await rateTripUser({
      type: sourceType,
      tripId,
      targetOpenid,
      targetRole: 'driver',
      targetName,
      ratedTargetMap
    })
    if (ok) await this.loadTripDetail(tripId, sourceType)
  },

  onShareAppMessage() {
    const { tripId, fromText, toText, dateText, weekdayText, timeText, sourceType } = this.data
    const title = `${fromText} → ${toText} ${dateText} ${weekdayText} ${timeText}`.trim() || '查看路线详情'


    // ✅ Carpool：分享公共详情页 tripDetail
    if (sourceType === 'carpool') {
      return getApp().withReferralShare({
        title,
        path: `/pages/home/tripDetail/tripDetail?id=${tripId}`
      })
    }

    // 乘客求车记录分享指向接单详情
    return getApp().withReferralShare({
      title,
      path: `/pages/home/driverPickupDetail/driverPickupDetail?id=${tripId}`
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
      query: `id=${tripId}`
    })
  }

})
