// pages/profile/myTripDetailDriver/myTripDetailDriver.js
const { showDataError } = require("../../../utils/error")
const { callTripManage, askReason, attachRideStats, rateTripUser } = require("../../../utils/tripManage")

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
    kickMode: false,
    isTripCompleted: false,

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

  async onPullDownRefresh() {
    try {
      await this.loadTripDetail(this.data.tripId)
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  async loadTripDetail(tripId) {
    this.setData({ loading: true })

    const db = wx.cloud.database()

    try {
      const docRes = await db.collection('Carpool').doc(tripId).get()
      const trip = docRes && docRes.data ? docRes.data : null

      if (!trip) {
        console.error('[loadTripDetail] NOT FOUND. tripId=', tripId)
        wx.showToast({ title: '未找到该路线（ID不匹配）', icon: 'none' })
        this.setData({ loading: false, trip: null, passengers: [] })
        return
      }

      // ===== 解析抬头信息 =====
      const dep0 = (trip.departures && trip.departures[0]) ? trip.departures[0] : {}
      const des0 = (trip.destinations && trip.destinations[0]) ? trip.destinations[0] : {}

      const fromText = dep0.address || ''
      const toText = des0.address || ''

      const rawDate = dep0.date || ''
      const weekdayText = this.getWeekdayCN(rawDate)
      const dateText = this.formatDateNoYear(rawDate)
      const timeText = dep0.time || ''

      const showFortLeeCoreTip = this.containsFortLeeCore(fromText) || this.containsFortLeeCore(toText)
      const rawStatus = String(trip.status || '').toLowerCase()
      const status = rawStatus === 'close' || rawStatus === 'closed' ? 'past' : rawStatus
      const isTripCompleted = status === 'past'

      // ===== 乘客：Carpool.passengers + 通过 _openid 补全 userInfo（微信/手机/昵称）=====
      const rawPassengers = Array.isArray(trip.passengers) ? trip.passengers.filter(Boolean) : []
      const openids = rawPassengers.map(p => p && p._openid).filter(Boolean)

      // 1) 调云函数批量取 userInfo（分批，避免 in 限制/超长）
      let userMap = {}
      if (openids.length > 0) {
        const chunkSize = 20
        const allUsers = []

        for (let i = 0; i < openids.length; i += chunkSize) {
          const chunk = openids.slice(i, i + chunkSize)

          const res = await wx.cloud.callFunction({
            name: 'getUserInfoByOpenids',   // ✅ 改成你真实云函数名
            data: { openids: chunk }
          })

          const list = res && res.result && res.result.data
          if (Array.isArray(list)) allUsers.push(...list)
        }

        allUsers.forEach(u => {
          if (u && u._openid) userMap[u._openid] = u
        })
      }

      // 2) 合并：保留 Carpool.passengers 的 pickup/dropoff；userInfo 补全 name/wechat/phone/avatar
      const passengers = rawPassengers.map(p => {
        const u = userMap[p._openid] || {}

        return {
          _openid: p._openid,

          // ✅ 上/下车点：永远以 Carpool.passengers 为准
          pickupAddress: p.pickupAddress || p.pickUpAddress || '',
          dropoffAddress: p.dropoffAddress || p.dropOffAddress || '',

          // ✅ 昵称/微信/手机：从 userInfo 补全（没有就用 passenger 自带信息）
          name: u.name || u.nickName || p.name || p.nickName || '',
          nickName: u.nickName || p.nickName || '',
          wechatID: u.wechatID || p.wechatID || '',
          phone: u.phone || p.phone || '',
          ...attachRideStats(u, 'passenger'),

          // ✅ 头像：userInfo 优先，其次 passenger 自带
          avatarUrl: u.avatarUrl || p.avatarUrl || '',

          // 其他你 passenger 记录里可能要用的字段也保留
          joinedAt: p.joinedAt || ''
        }
      })

      this.setData({
        trip,
        passengers,
        fromText,
        toText,
        dateText,
        weekdayText,
        timeText,
        isTripCompleted,
        kickMode: isTripCompleted ? false : this.data.kickMode,
        showFortLeeCoreTip,
        loading: false
      })

    } catch (e) {
      console.error('loadTripDetail error:', e)
      showDataError('路线加载失败', e, '路线详情从数据库加载失败，请稍后重试。')
      this.setData({ loading: false })
    }
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

    wx.setClipboardData({
      data: val,
      success: () => wx.showToast({ title: '已复制', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' })
    })
  },

  async onKickPassenger(e) {
    const targetOpenid = (e.currentTarget.dataset && e.currentTarget.dataset.openid) || ''
    const { tripId } = this.data
    if (!targetOpenid || !tripId) return

    const reason = await askReason({
      title: '剔除乘客',
      content: '理由会作为消息发送给该乘客。',
      placeholder: '例如长期未回复、信息不匹配',
      confirmText: '剔除'
    })
    if (!reason) return

    try {
      wx.showLoading({ title: '正在处理...', mask: true })
      const result = await callTripManage({ type: 'carpool', tripId, action: 'kickPassenger', targetOpenid, reason })
      wx.hideLoading()
      if (result && (result.ok || result.success)) {
        wx.showToast({ title: '已剔除', icon: 'success' })
        await this.loadTripDetail(tripId)
      } else {
        wx.showToast({ title: (result && result.errorMsg) || '操作失败', icon: 'none' })
      }
    } catch (e2) {
      wx.hideLoading()
      console.error('kickPassenger error:', e2)
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  async onCompleteTrip() {
    const { tripId, isTripCompleted } = this.data
    if (!tripId || isTripCompleted) return

    wx.showModal({
      title: '结束路线',
      content: '结束后路线将从公开拼车列表移除，并进入你和乘客的历史行程。确认结束？',
      confirmText: '结束',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm) return

        try {
          wx.showLoading({ title: '正在结束...', mask: true })
          const result = await callTripManage({ type: 'carpool', tripId, action: 'completeTrip' })

          wx.hideLoading()
          if (result && (result.ok || result.success)) {
            wx.showToast({ title: '已结束路线', icon: 'success' })
            await this.loadTripDetail(tripId)
          } else {
            wx.showToast({ title: (result && result.errorMsg) || '操作失败', icon: 'none' })
          }
        } catch (e2) {
          wx.hideLoading()
          console.error('completeTrip error:', e2)
          wx.showToast({ title: '操作失败', icon: 'none' })
        }
      }
    })
  },

  async onDeleteOrQuit() {
    const { tripId } = this.data
    if (!tripId) return

    const reason = await askReason({
      title: '删除路线',
      content: '理由会作为消息发送给已加入乘客。',
      placeholder: '例如临时取消、路线调整',
      confirmText: '删除'
    })
    if (!reason) return

    try {
      wx.showLoading({ title: '正在删除...', mask: true })
      const result = await callTripManage({ type: 'carpool', tripId, action: 'deleteTrip', reason })
      wx.hideLoading()
      if (result && (result.ok || result.success)) {
        wx.showToast({ title: '已删除路线', icon: 'success' })
        setTimeout(() => this.goBack(), 500)
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
    const targetOpenid = (e.currentTarget.dataset && e.currentTarget.dataset.openid) || ''
    const targetName = (e.currentTarget.dataset && e.currentTarget.dataset.name) || '该用户'
    const { tripId } = this.data
    if (!targetOpenid) return

    wx.showModal({
      title: '拉黑用户',
      content: `拉黑后，你们将无法加入彼此的拼车路线。确认拉黑${targetName}？`,
      confirmText: '拉黑',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm) return
        try {
          const result = await callTripManage({ type: 'carpool', tripId, action: 'blockUser', targetOpenid })
          wx.showToast({ title: result && (result.ok || result.success) ? '已拉黑' : ((result && result.errorMsg) || '操作失败'), icon: result && (result.ok || result.success) ? 'success' : 'none' })
        } catch (e2) {
          console.error('blockUser error:', e2)
          wx.showToast({ title: '操作失败', icon: 'none' })
        }
      }
    })
  },

  async onRatePassenger(e) {
    const targetOpenid = (e.currentTarget.dataset && e.currentTarget.dataset.openid) || ''
    const targetName = (e.currentTarget.dataset && e.currentTarget.dataset.name) || '该乘客'
    const { tripId, isTripCompleted } = this.data
    if (!isTripCompleted) {
      wx.showToast({ title: '只能评价过往行程', icon: 'none' })
      return
    }
    await rateTripUser({
      type: 'carpool',
      tripId,
      targetOpenid,
      targetRole: 'passenger',
      targetName
    })
  },

  onShareAppMessage() {
    const { tripId, fromText, toText, dateText, weekdayText, timeText } = this.data
    const title = `${fromText} → ${toText} ${dateText} ${weekdayText} ${timeText}`.trim()
    return getApp().withReferralShare({
      title: title ? `${title}｜寻找顺路乘客` : '寻找顺路乘客',
      path: `/pages/home/tripDetail/tripDetail?id=${tripId}`
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
