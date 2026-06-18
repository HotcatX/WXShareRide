// pages/profile/myTripDetailDriver/myTripDetailDriver.js
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

  async callUpdateCarpoolStatusSafely() {
    const { tripId } = this.data
    if (!tripId) return

    try {
      await wx.cloud.callFunction({
        name: 'updateCarpoolStatus',
        data: { ids: [tripId] }
      })
    } catch (e) {
      console.warn('updateCarpoolStatus 调用失败（不阻断主流程）：', e)
    }
  },

  goBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else wx.switchTab({ url: '/pages/home/home' })
  },

  async onLoad(options) {
    console.log('myTripDetailDriver onLoad options =', options)

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

  // ✅ 关键改动：不再 callFunction(getCarpoolDetail)，改为直接读 Carpool
  async loadTripDetail(tripId) {
    this.setData({ loading: true })

    const db = wx.cloud.database()
    const _ = db.command
  
    try {
      console.log('[loadTripDetail] input tripId =', tripId)
  
      // 1) 优先按 docId 读取（tripId 必须是 Carpool 的 _id）
      let trip = null
      try {
        const docRes = await db.collection('Carpool').doc(tripId).get()
        trip = docRes && docRes.data ? docRes.data : null
      } catch (e) {
        console.warn('[loadTripDetail] doc get failed:', e)
      }
  
      // 2) 兜底：如果传进来的不是 _id，则尝试用常见字段查一次
      if (!trip) {
        const whereRes = await db.collection('Carpool')
          .where(
            _.or([
              { tripId: tripId },   // 如果你库里有 tripId 字段
              { driverID: tripId }  // 如果你传的是 driverID
            ])
          )
          .limit(1)
          .get()
  
        trip = (whereRes && whereRes.data && whereRes.data.length > 0) ? whereRes.data[0] : null
      }
  
      // 3) 读不到就直接退出（关键：避免 trip.passengers 报错）
      if (!trip) {
        console.error('[loadTripDetail] NOT FOUND. tripId=', tripId)
        wx.showToast({ title: '未找到该路线（ID不匹配）', icon: 'none' })
        this.setData({ loading: false, trip: null, passengers: [] })
        return
      }
  
      console.log('[loadTripDetail] FOUND. _id=', trip._id, 'passengersLen=', Array.isArray(trip.passengers) ? trip.passengers.length : 'not array')
  
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

          // ✅ 昵称/微信/手机：从 userInfo 补全（没有就用 passenger 自带的兜底）
          name: u.name || u.nickName || p.name || p.nickName || '',
          nickName: u.nickName || p.nickName || '',
          wechatID: u.wechatID || p.wechatID || '',
          phone: u.phone || p.phone || '',

          // ✅ 头像：userInfo 优先，其次 passenger 自带
          avatarUrl: u.avatarUrl || p.avatarUrl || '',

          // 其他你 passenger 记录里可能要用的字段也保留
          joinedAt: p.joinedAt || ''
        }
      })

      console.log('[loadTripDetail] passengers merged =', passengers)

      this.setData({
        trip,
        passengers,
        fromText,
        toText,
        dateText,
        weekdayText,
        timeText,
        showFortLeeCoreTip,
        loading: false
      })

    } catch (e) {
      console.error('loadTripDetail error:', e)
      wx.showToast({ title: '加载失败', icon: 'none' })
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

    wx.showModal({
      title: '剔除乘客',
      content: '确认将该乘客从出行计划中移除吗？',
      confirmText: '确定',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm) return

        try {
          const res = await wx.cloud.callFunction({
            name: 'editMyTripDetailDriver',
            data: { tripId, action: 'kickPassenger', targetOpenid }
          })

          if (res.result && res.result.ok) {
            await this.callUpdateCarpoolStatusSafely()
            wx.showToast({ title: '已剔除', icon: 'success' })
            await this.loadTripDetail(tripId)
          } else {
            wx.showToast({ title: (res.result && res.result.errorMsg) || '操作失败', icon: 'none' })
          }
        } catch (e2) {
          console.error('kickPassenger error:', e2)
          wx.showToast({ title: '操作失败', icon: 'none' })
        }
      }
    })
  },

  async onDeleteOrQuit() {
    const { tripId } = this.data
    if (!tripId) return

    wx.showModal({
      title: '删除路线',
      content: '删除后，所有乘客将无法再看到此出行记录，确认删除？',
      confirmText: '确定',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm) return
        try {
          const res = await wx.cloud.callFunction({
            name: 'editMyTripDetailDriver',
            data: { tripId }
          })

          if (res.result && res.result.ok) {
            await this.callUpdateCarpoolStatusSafely()
            wx.showToast({ title: '已删除路线', icon: 'success' })
            setTimeout(() => this.goBack(), 500)
          } else {
            wx.showToast({ title: (res.result && res.result.errorMsg) || '操作失败', icon: 'none' })
          }
        } catch (e2) {
          console.error('deleteTrip error:', e2)
          wx.showToast({ title: '操作失败', icon: 'none' })
        }
      }
    })
  },

  onShareAppMessage() {
    const { tripId, fromText, toText, dateText, weekdayText, timeText } = this.data
    const title = `${fromText} → ${toText} ${dateText} ${weekdayText} ${timeText}`.trim()
    return {
      title: title ? `${title}｜寻找顺路乘客` : '寻找顺路乘客',
      path: `/pages/home/tripDetail/tripDetail?id=${tripId}`
    }
  },

  onShareTimeline() {
    const { tripId, fromText, toText, dateText, weekdayText, timeText } = this.data
    const title = `${fromText} → ${toText} ${dateText} ${weekdayText} ${timeText}`.trim()
    return {
      title: title ? `${title}｜寻找顺路乘客` : '寻找顺路乘客',
      query: `id=${tripId}`
    }
  }
})
