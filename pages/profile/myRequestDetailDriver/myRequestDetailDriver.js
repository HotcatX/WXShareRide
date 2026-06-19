// pages/profile/myRequestDetailDriver/myRequestDetailDriver.js

Page({
  data: {
    statusBarHeight: 80,
    pageTitle: '求车详情',

    loading: true,
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

    // 是否为该路线司机（只有为 true 才展示乘客信息 + 退出按钮）
    isMyRequest: false,

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
    else wx.switchTab({ url: '/pages/home/home' })
  },

  async onLoad(options) {
    const info = wx.getSystemInfoSync()
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
    this.setData({ loading: true })

    try {
      // 1) 读 CarpoolRequest 详情
      const res = await wx.cloud.callFunction({
        name: 'getCarpoolRequestDetail',
        data: { id: requestId }
      })

      // 兼容：有的函数返回 {success:true,data:[...]}，有的返回 {ok:true,data:...}
      const rawResult = res && res.result ? res.result : null
      const success = !!(rawResult && (rawResult.success || rawResult.ok))
      if (!success) {
        wx.showToast({ title: (rawResult && (rawResult.errorMsg || rawResult.msg)) || '加载失败', icon: 'none' })
        this.setData({ loading: false })
        return
      }

      const trip = Array.isArray(rawResult.data) ? rawResult.data[0] : rawResult.data
      if (!trip) {
        wx.showToast({ title: '未找到该路线', icon: 'none' })
        this.setData({ loading: false })
        return
      }

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
              avatarUrl: u.avatarUrl || ''
            }
          })
        }
      }

      this.setData({
        trip,
        fromText,
        toText,
        dateText,
        weekdayText,
        timeText,
        showFortLeeCoreTip,

        // ✅ 行李数
        largeLuggageCount,

        isMyRequest,
        passengers,

        loading: false
      })
    } catch (e) {
      console.error('loadRequestDetail error:', e)
      wx.showToast({ title: '加载失败', icon: 'none' })
      this.setData({ loading: false })
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
          const res = await wx.cloud.callFunction({
            name: 'editMyRequestDetailDriver',
            data: { requestId, action: 'quit' }
          })

          console.log('【quit】cloud res =', res)
          const rr = res && res.result ? res.result : {}

          if (!rr.ok) {
            console.log('【quit】debug =', rr.debug)
            wx.showToast({
              title: (rr.debug && (rr.debug.errMsg || rr.debug.message)) || rr.errorMsg || '退出失败',
              icon: 'none'
            })
            return
          }


          if (res.result && res.result.ok) {
            wx.showToast({ title: '已退出', icon: 'success' })
            setTimeout(() => this.goBack(), 500)
          } else {
            wx.showToast({ title: (res.result && res.result.errorMsg) || '操作失败', icon: 'none' })
          }
        } catch (e2) {
          console.error('quitRequest error:', e2)
          wx.showToast({ title: '操作失败', icon: 'none' })
        }
      }
    })
  },

  onShareAppMessage() {
    const { requestId, fromText, toText, dateText, weekdayText, timeText } = this.data
    const title = `${fromText} → ${toText} ${dateText} ${weekdayText} ${timeText}`.trim()
    return {
      title: title ? `${title}｜寻找顺路乘客` : '寻找顺路乘客',
      path: `/pages/home/carpoolRequestDetail/carpoolRequestDetail?id=${requestId}`
    }
  },

  onShareTimeline() {
    const { requestId, fromText, toText, dateText, weekdayText, timeText } = this.data
    const title = `${fromText} → ${toText} ${dateText} ${weekdayText} ${timeText}`.trim()
    return {
      title: title ? `${title}｜寻找顺路乘客` : '寻找顺路乘客',
      query: `id=${requestId}`
    }
  }
})
