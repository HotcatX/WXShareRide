// pages/home/carpoolRequestDetail/carpoolRequestDetail.js
const LOGIN_PAGE = '/pages/other/login/login'
const DETAIL_REFRESH_INTERVAL = 30 * 1000
const { blockRideUser, formatRidePricePerPerson } = require("../../../utils/tripManage")

// 乘客上限（CarpoolRequest 固定 4）
const MAX_PASSENGERS = 4

function getWeekdayStr(dateStr) {
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
}

function formatDateNoYear(dateStr) {
  if (!dateStr) return ''
  const parts = String(dateStr).split('-')
  if (parts.length !== 3) return ''
  return `${Number(parts[1])}月${Number(parts[2])}日`
}

function normalizepassengerID(raw) {
  return Array.isArray(raw) ? raw.filter(Boolean).map(x => String(x)) : []
}

Page({
  data: {
    statusBarHeight: 80,
    pageTitle: '路线详情',

    loading: true,
    loadError: '',
    submitting: false,

    tripId: '',
    trip: null,

    departAddress: '',
    destAddress: '',
    formattedDepartTime: '',
    referencePriceText: '',

    seatLeft: 0,

    // 用户信息（可能为空：游客）
    myOpenid: '',
    ownerOpenid: '',
    driverOpenid: '',

    isOwner: false,
    joinedByMe: false,
    isFull: false,
    isClosed: false,

    isDriver: false,

    // ✅ 不再展示司机/其他乘客信息（保留字段避免 WXML/其他引用报错）
    driverInfo: null,
    passengerList: [],
    defaultAvatarUrl: '/images/profile.png'
  },

  async onLoad(options) {
    const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight })

    const id = (options && options.id) || ''
    if (!id) {
      this.setLoadError('缺少路线ID')
      return
    }

    // ✅ 允许游客浏览：不再 onLoad 强制跳 login
    const myOpenid = wx.getStorageSync('openid') || ''
    this.setData({ tripId: id, myOpenid })
    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })
    await this.loadTripDetail(id)
  },

  onShow() {
    // ✅ 从 login “游客身份查看”返回时的提示
    const tip = wx.getStorageSync('needLoginToast')
    if (tip) {
      wx.removeStorageSync('needLoginToast')
      wx.showToast({ title: tip, icon: 'none', duration: 2000 })
    }

    // ✅ 登录/完善资料回来后刷新状态（按钮会变化）
    const myOpenid = wx.getStorageSync('openid') || ''
    this.setData({ myOpenid })

    const { tripId } = this.data
    if (!tripId || this.data.loading) return
    if (Date.now() - (this._lastDetailLoadedAt || 0) < DETAIL_REFRESH_INTERVAL) return
    this.loadTripDetail(tripId, { silent: true })
  },

  async onPullDownRefresh() {
    try {
      const { tripId } = this.data
      if (tripId) await this.loadTripDetail(tripId, { silent: true })
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  goBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else wx.reLaunch({ url: '/pages/home/home' })
  },

  // 系统默认 toast
  showToast(text, icon = 'none', duration = 1800) {
    wx.showToast({ title: text, icon, duration })
  },

  setLoadError(message) {
    this.setData({
      loading: false,
      loadError: message || '加载失败',
      trip: null,
      departAddress: '',
      destAddress: '',
      formattedDepartTime: '',
      seatLeft: 0,
      ownerOpenid: '',
      driverOpenid: '',
      isOwner: false,
      joinedByMe: false,
      isFull: false,
      isClosed: true,
      isDriver: false,
      driverInfo: null,
      passengerList: []
    })
  },

  // =========================
  // ✅ 登录+完善资料拦截（仅在“加入”动作触发）
  // =========================
  ensureLoginBeforeJoin() {
    const openid = wx.getStorageSync('openid') || ''
    if (openid) return true

    const { tripId } = this.data
    const pendingUrl = `/pages/home/carpoolRequestDetail/carpoolRequestDetail?id=${tripId}`

    wx.setStorageSync('pendingPage', { url: pendingUrl })
    wx.setStorageSync('postLoginAction', {
      type: 'requireProfile',
      from: 'carpoolRequestDetail',
      returnUrl: pendingUrl
    })

    wx.navigateTo({ url: LOGIN_PAGE })
    return false
  },

  ensureLoginForBlock() {
    const openid = wx.getStorageSync('openid') || ''
    if (openid) return true

    const { tripId } = this.data
    wx.setStorageSync('pendingPage', { url: `/pages/home/carpoolRequestDetail/carpoolRequestDetail?id=${tripId}` })
    wx.navigateTo({ url: LOGIN_PAGE })
    return false
  },

  /**
   * 拉取 CarpoolRequest 详情（允许游客）：
   * - 计算顶部展示字段 + seatLeft + status
   * - 若已登录：额外计算 isOwner / joinedByMe / isDriver
   * - ✅ 不再读取司机/其他乘客信息
   */
  async loadTripDetail(id, options = {}) {
    const { silent = false } = options
    if (!silent) this.setData({ loading: true, loadError: '' })

    try {
      const res = await wx.cloud.callFunction({
        name: 'getTripDetail',
        data: { type: 'request', id }
      })

      if (!res.result || !res.result.success) {
        const msg = (res.result && (res.result.errorMsg || res.result.msg)) || '加载失败'
        this.setLoadError(msg)
        return
      }

      const trip = res.result.data
      if (!trip) {
        this.setLoadError('该求车路线不存在或已被删除')
        return
      }

      // 1) 顶部展示字段
      let departAddress = ''
      let destAddress = ''
      let formattedDepartTime = ''

      if (Array.isArray(trip.departures) && trip.departures.length > 0) {
        const d = trip.departures[0]
        departAddress = d.address || ''
        const dateStr = d.date || ''
        const timeStr = (d.time || '').slice(0, 5)

        const weekday = getWeekdayStr(dateStr)
        const dateNoYear = formatDateNoYear(dateStr)

        if (dateNoYear && timeStr) formattedDepartTime = `${dateNoYear} ${weekday} ${timeStr}`
        else if (dateNoYear) formattedDepartTime = `${dateNoYear} ${weekday}`
        else formattedDepartTime = timeStr || ''
      }

      if (Array.isArray(trip.destinations) && trip.destinations.length > 0) {
        destAddress = trip.destinations[0].address || ''
      }

      // 2) owner / driver openid
      const ownerOpenid = trip.openid || trip._openid || ''
      const driverOpenid = trip.driverOpenid || ''

      // 3) passengerID
      const passengerID = normalizepassengerID(trip.passengerID)

      // 4) 人数与余位
      const passengerCount =
        Number.isFinite(Number(trip.passengerCount))
          ? Number(trip.passengerCount)
          : passengerID.length

      const seatLeft = Math.max(0, MAX_PASSENGERS - passengerCount)
      const isFull = seatLeft <= 0

      // 5) 状态：只要不是 open 就视为不可加入
      const rawStatus = String(trip.status || 'open').toLowerCase()
      const st = rawStatus
      const isClosed = st !== 'open'

      // 6) 已登录才计算“我是谁”
      const myOpenid = wx.getStorageSync('openid') || ''
      const isOwner = !!(ownerOpenid && myOpenid && ownerOpenid === myOpenid)
      const isDriver = !!(driverOpenid && myOpenid && driverOpenid === myOpenid)
      const joinedByMe = !!(myOpenid && passengerID.includes(myOpenid))
      const referencePriceText = formatRidePricePerPerson(trip.referencePrice || trip.price || trip.displayPrice, '价格待定')

      this.setData({
        trip,
        departAddress,
        destAddress,
        formattedDepartTime,
        referencePriceText,
        seatLeft,

        myOpenid,
        ownerOpenid,
        driverOpenid,

        isOwner,
        isDriver,
        joinedByMe,
        isFull,
        isClosed,

        // ✅ 不再展示信息
        driverInfo: null,
        passengerList: [],

        loadError: '',
        loading: false
      })
      this._lastDetailLoadedAt = Date.now()
    } catch (err) {
      console.error('loadTripDetail error:', err)
      this.setLoadError('网络异常，请稍后重试')
    }
  },

  // =========================
  // ✅ 乘客加入 CarpoolRequest
  // 变更：
  // 1) 未登录 -> login + 必要时 addInfo
  // 2) 不显示司机/其他乘客，成功后直接跳首页
  // =========================
  async joinAsPassenger() {
    const { tripId, submitting, isOwner, joinedByMe, isFull, isClosed, isDriver, trip } = this.data
    if (!tripId) return
    if (submitting) return

    // ✅ 先做登录 + 完善资料拦截
    if (!this.ensureLoginBeforeJoin()) return

    // 刷新一次 openid（刚登录回来）
    const myOpenid = wx.getStorageSync('openid') || ''
    this.setData({ myOpenid })

    // 防误操作
    if (isOwner) {
      this.showToast('不能加入自己发布的求车', 'none')
      return
    }
    if (isDriver) {
      this.showToast('你已是该路线司机，无法作为乘客加入', 'none')
      return
    }
    if (joinedByMe) {
      this.showToast('你已加入该求车', 'none')
      return
    }

    const st = String((trip && trip.status) || 'open')
    if (st !== 'open') {
      this.showToast(`当前状态不可加入：${st}`, 'none')
      return
    }
    if (isClosed) {
      this.showToast('该求车已结束', 'none')
      return
    }
    if (isFull) {
      this.showToast('该求车已满员', 'none')
      return
    }

    this.setData({ submitting: true })

    try {
      const ret = await wx.cloud.callFunction({
        name: 'joinTrip',
        data: { type: 'request', requestId: tripId }
      })

      if (ret.result && ret.result.success) {
        // ✅ 不展示任何成员信息，直接回首页
        this.showToast('加入成功', 'success', 1200)
        setTimeout(() => {
          wx.reLaunch({ url: '/pages/home/home' })
        }, 1200)
        return
      }

      const msg = (ret.result && ret.result.errorMsg) ? ret.result.errorMsg : '加入失败'
      this.showToast(msg, 'none')
    } catch (e) {
      console.error('joinTrip request error:', e)
      this.showToast('加入失败', 'none')
    } finally {
      this.setData({ submitting: false })
    }
  },

  async onBlockRequestOwner() {
    const { tripId, ownerOpenid, isOwner, trip } = this.data
    if (isOwner) {
      this.showToast('不能拉黑自己', 'none')
      return
    }
    if (!ownerOpenid) {
      this.showToast('缺少拉黑对象', 'none')
      return
    }
    if (!this.ensureLoginForBlock()) return

    await blockRideUser({
      type: 'request',
      requestId: tripId,
      tripId,
      targetOpenid: ownerOpenid,
      targetName: (trip && (trip.name || trip.nickName)) || '求车发布者'
    })
  },

  onShareAppMessage() {
    const { tripId, departAddress, destAddress, formattedDepartTime } = this.data
    const title = `${departAddress} → ${destAddress} ${formattedDepartTime}`.trim().slice(0, 30)
    return getApp().withReferralShare({
      title: title ? `${title}｜寻找顺路乘客` : '寻找顺路乘客',
      // ✅ 导向本页面
      path: `/pages/home/carpoolRequestDetail/carpoolRequestDetail?id=${tripId}`
    })
  },

  onShareTimeline() {
    const { tripId, departAddress, destAddress, formattedDepartTime } = this.data
    const title = `${departAddress} → ${destAddress} ${formattedDepartTime}`.trim().slice(0, 30)
    return getApp().withReferralShare({
      title: title ? `${title}｜寻找顺路乘客` : '寻找顺路乘客',
      // ✅ 朋友圈用 query
      query: `id=${tripId}`
    })
  }


})
