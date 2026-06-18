// pages/profile/myTripDetailPassenger/myTripDetailPassenger.js
Page({
  data: {
    statusBarHeight: 80,
    pageTitle: '路线详情',

    loading: true,
    tripId: '',
    trip: null,

    sourceType: 'carpool', // 'carpool' | 'request'

    fromText: '',
    toText: '',
    dateText: '',
    weekdayText: '',
    timeText: '',

    driverInfo: null,

    // CarpoolRequest：显示除自己外的其他乘客
    otherPassengers: [],
    passengerList: [],

    defaultAvatarUrl: '/images/default_avatar.png',

    showFortLeeCoreTip: false
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

  async callUpdateStatusesSafely() {
    try { await wx.cloud.callFunction({ name: 'updateCarpoolStatus' }) } catch (e) {}
    try { await wx.cloud.callFunction({ name: 'updateCarpoolRequestStatus' }) } catch (e) {}
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
    else wx.switchTab({ url: '/pages/home/home' })
  },

  async onLoad(options) {
    const info = wx.getSystemInfoSync()
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

  async onPullDownRefresh() {
    try {
      await this.loadTripDetail(this.data.tripId)
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

  // ========== 主加载：先 Carpool，失败 fallback CarpoolRequest ==========
  async loadTripDetail(tripId) {
    this.setData({ loading: true })
    wx.showLoading({ title: '加载中...' })

    try {
      // ---- A) 先查 Carpool ----
      const carpoolRes = await wx.cloud.callFunction({
        name: 'getCarpoolDetail',
        data: { id: tripId }
      })

      const carpoolOk = !!(carpoolRes.result && carpoolRes.result.success)
      const carpoolTrip = carpoolOk
        ? (Array.isArray(carpoolRes.result.data) ? carpoolRes.result.data[0] : carpoolRes.result.data)
        : null

      if (carpoolTrip) {
        wx.hideLoading()
        await this.applyCarpoolTrip(carpoolTrip)
        return
      }

      // ---- B) fallback 查 CarpoolRequest ----
      const reqRes = await wx.cloud.callFunction({
        name: 'getCarpoolRequestDetail',
        data: { id: tripId }
      })

      wx.hideLoading()

      const rr = reqRes && reqRes.result ? reqRes.result : null
      const reqOk = !!(rr && (rr.ok || rr.success))
      const reqTrip = reqOk ? (Array.isArray(rr.data) ? rr.data[0] : rr.data) : null

      if (!reqTrip) {
        wx.showToast({ title: '未找到该路线', icon: 'none' })
        this.setData({ loading: false })
        return
      }

      await this.applyRequestTrip(reqTrip, rr)
    } catch (e) {
      wx.hideLoading()
      console.error('loadTripDetail error:', e)
      wx.showToast({ title: '加载失败', icon: 'none' })
      this.setData({ loading: false })
    }
  },

  // ========== Carpool 场景：只显示司机信息 ==========
  async applyCarpoolTrip(trip) {
    const dep0 = (trip.departures && trip.departures[0]) ? trip.departures[0] : {}
    const des0 = (trip.destinations && trip.destinations[0]) ? trip.destinations[0] : {}

    const fromText = dep0.address || ''
    const toText = des0.address || ''

    const rawDate = dep0.date || ''
    const weekdayText = this.getWeekdayCN(rawDate)
    const dateText = this.formatDateNoYear(rawDate)
    const timeText = dep0.time || ''

    const showFortLeeCoreTip = this.containsFortLeeCore(fromText) || this.containsFortLeeCore(toText)

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
          avatarUrl: u.avatarUrl || ''
        }
      }
    }

    this.setData({
      sourceType: 'carpool',
      trip,
      driverInfo,

      // Carpool：不展示乘客列表
      otherPassengers: [],
      passengerList: [],

      fromText,
      toText,
      dateText,
      weekdayText,
      timeText,
      showFortLeeCoreTip,
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

    // 当前用户 openid：优先 rr.openid，否则 login 兜底
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
          avatarUrl: u.avatarUrl || ''
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

    // 调试用：如果仍不对，打开这两行看云函数返回数量
    // console.log('DEBUG filteredOpenids:', filteredOpenids, 'passengerCount:', trip.passengerCount)

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
            address: u.address || ''
          }
        })
      }
    }

    this.setData({
      sourceType: 'request',
      trip,
      driverInfo,

      otherPassengers,
      passengerList: otherPassengers, // ✅ 给 WXML 直接照抄 passengerList

      fromText,
      toText,
      dateText,
      weekdayText,
      timeText,
      showFortLeeCoreTip,
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
    const { tripId } = this.data
    if (!tripId) return

    wx.showModal({
      title: '退出路线',
      content: '确认退出该出行计划吗？',
      confirmText: '确定',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: '处理中...' })
        try {
          const res = await wx.cloud.callFunction({
            name: 'editMyTripDetailPassenger',
            data: { tripId }
          })
          wx.hideLoading()

          if (res.result && res.result.ok) {
            await this.callUpdateStatusesSafely()
            wx.showToast({ title: '已退出路线', icon: 'success' })
            setTimeout(() => this.goBack(), 500)
          } else {
            wx.showToast({ title: (res.result && res.result.errorMsg) || '操作失败', icon: 'none' })
          }
        } catch (e2) {
          wx.hideLoading()
          console.error('quitTrip error:', e2)
          wx.showToast({ title: '操作失败', icon: 'none' })
        }
      }
    })
  },

  onShareAppMessage() {
    const { tripId, fromText, toText, dateText, weekdayText, timeText, sourceType } = this.data
    const title = `${fromText} → ${toText} ${dateText} ${weekdayText} ${timeText}`.trim() || '查看路线详情'

  
    // ✅ Carpool：分享公共详情页 tripDetail
    if (sourceType === 'carpool') {
      return {
        title,
        path: `/pages/home/tripDetail/tripDetail?id=${tripId}`
      }
    }
  
    // ✅ CarpoolRequest：分享指向 driverPickupList
    return {
      title,
      path: `/pages/home/driverPickupDetail/driverPickupDetail?id=${tripId}`
    }
  },
  
  onShareTimeline() {
    const { tripId, fromText, toText, dateText, weekdayText, timeText, sourceType } = this.data
    const title = `${fromText} → ${toText} ${dateText} ${weekdayText} ${timeText}`.trim()
  
    if (sourceType === 'carpool') {
      return {
        title: title ? `${title}｜寻找顺路乘客` : '寻找顺路乘客',
        query: `id=${tripId}`
      }
    }
  
    return {
      title: title ? `${title}｜寻找顺路司机` : '寻找顺路司机',
      query: `id=${tripId}`
    }
  }
  
})
