const LOGIN_PAGE = '/pages/other/login/login'
const DETAIL_REFRESH_INTERVAL = 30 * 1000
const DETAIL_PREVIEW_KEY = "carpoolDetailPreviewV1"
const DETAIL_PREVIEW_TTL = 2 * 60 * 1000
const { callTripManage, blockRideUser, formatRidePricePerPerson } = require("../../../utils/tripManage")

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

function normalizePassengerID(raw) {
  return Array.isArray(raw) ? raw.filter(Boolean).map(x => String(x)) : []
}

Page({
  data: {
    statusBarHeight: 80,
    pageTitle: '路线详情',

    loading: true,
    loadError: '',

    // 两个按钮独立 submitting（避免一个按钮 loading 影响另一个）
    submittingDriver: false,
    submittingPassenger: false,

    tripId: '',
    trip: null,

    departAddress: '',
    destAddress: '',
    formattedDepartTime: '',
    referencePriceText: '',

    // 乘客加入用
    seatLeft: 0,

    // 登录态/身份
    myOpenid: '',
    ownerOpenid: '',
    driverOpenid: '',

    isOwner: false,

    // 乘客侧状态
    joinedByMe: false,     // 我是否已作为乘客加入
    isFull: false,
    isClosed: false,

    // 司机侧状态
    isAccepted: false,     // 是否已有司机接单/或状态不为 open
    acceptedByMe: false,   // 我是否就是该司机

    // 顶部横向提示条（你 WXML 里有 toastVisible）
    toastVisible: false,
    toastType: '',         // success / warning / error（你自己在 wxss 定义）
    toastIcon: '',
    toastText: ''
  },

  async onLoad(options) {
    const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight })

    const id = (options && options.id) || ''
    if (!id) {
      this.setLoadError('缺少路线ID')
      return
    }

    // ✅ 允许游客浏览
    const myOpenid = wx.getStorageSync('openid') || ''
    this.setData({ tripId: id, myOpenid })

    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })
    const hasPreview = this.applyCachedPreview(id)
    this.loadTripDetail(id, { silent: hasPreview })
  },

  onShow() {
    // ✅ 从 login “游客身份查看”返回时的提示
    const tip = wx.getStorageSync('needLoginToast')
    if (tip) {
      wx.removeStorageSync('needLoginToast')
      wx.showToast({ title: tip, icon: 'none', duration: 2000 })
    }

    // ✅ 登录/完善资料回来后刷新
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

  // 系统 toast（简单）
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
      isAccepted: false,
      acceptedByMe: false,
      submittingDriver: false,
      submittingPassenger: false
    })
  },

  // 顶部条 toast（如果你想用 ui-toast 这一套）
  showTopToast(text, type = 'success', icon = '✓', duration = 1800) {
    this.setData({
      toastVisible: true,
      toastText: text,
      toastType: type,
      toastIcon: icon
    })
    setTimeout(() => {
      this.setData({ toastVisible: false })
    }, duration)
  },

  // =========================
  // ✅ 登录+完善资料拦截（仅在点击按钮时触发）
  // =========================
  ensureLoginBeforeAction(actionFrom) {
    const openid = wx.getStorageSync('openid') || ''
    if (openid) return true

    const { tripId } = this.data
    const pendingUrl = `/pages/home/requestDetail/requestDetail?id=${tripId}`

    wx.setStorageSync('pendingPage', { url: pendingUrl })
    wx.setStorageSync('postLoginAction', {
      type: 'requireProfile',
      from: actionFrom,     // 'requestDetail:accept' / 'requestDetail:join'
      returnUrl: pendingUrl
    })

    wx.navigateTo({ url: LOGIN_PAGE })
    return false
  },

  ensureLoginForBlock() {
    const openid = wx.getStorageSync('openid') || ''
    if (openid) return true

    const { tripId } = this.data
    wx.setStorageSync('pendingPage', { url: `/pages/home/requestDetail/requestDetail?id=${tripId}` })
    wx.navigateTo({ url: LOGIN_PAGE })
    return false
  },

  isFreshPreview(preview, id, type) {
    if (!preview || preview.id !== id || preview.type !== type || !preview.item) return false
    if (!preview.savedAt || Date.now() - Number(preview.savedAt) > DETAIL_PREVIEW_TTL) return false
    return true
  },

  applyCachedPreview(id) {
    let applied = false

    try {
      const cached = wx.getStorageSync(DETAIL_PREVIEW_KEY)
      if (this.isFreshPreview(cached, id, "request")) {
        applied = this.applyRequestData(cached.item)
      }
    } catch (e) {
    }

    try {
      const channel = this.getOpenerEventChannel && this.getOpenerEventChannel()
      if (channel && typeof channel.on === "function") {
        channel.on("routePreview", (preview) => {
          if (this.isFreshPreview(preview, id, "request")) {
            this.applyRequestData(preview.item)
          }
        })
      }
    } catch (e) {
    }

    return applied
  },

  applyRequestData(trip, options = {}) {
    if (!trip) return false

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
    const passengerID = normalizePassengerID(trip.passengerID)
    const joinedAll = passengerID

    // 4) 人数与余位（后端如果给 passengerCount 优先用）
    const passengerCount =
      Number.isFinite(Number(trip.passengerCount))
        ? Number(trip.passengerCount)
        : joinedAll.length

    const seatLeft = Math.max(0, MAX_PASSENGERS - passengerCount)
    const isFull = seatLeft <= 0

    // 5) 状态
    const rawStatus = String(trip.status || 'open').toLowerCase()
    const st = rawStatus
    const isClosed = st !== 'open'

    // 6) 已登录才计算“我是谁”
    const myOpenid = wx.getStorageSync('openid') || ''
    const isOwner = !!(ownerOpenid && myOpenid && ownerOpenid === myOpenid)
    const joinedByMe = !!(myOpenid && joinedAll.includes(myOpenid))

    // 7) 司机接单状态（保持与 driverPickupDetail 一致）
    const isAccepted = !!driverOpenid || (trip.status && String(trip.status) !== 'open')
    const acceptedByMe = !!(driverOpenid && myOpenid && driverOpenid === myOpenid)

    this.setData({
      trip,
      departAddress,
      destAddress,
      formattedDepartTime,
      referencePriceText: formatRidePricePerPerson(trip.referencePrice || trip.price || trip.displayPrice, '价格待定'),

      seatLeft,
      myOpenid,
      ownerOpenid,
      driverOpenid,

      isOwner,
      joinedByMe,
      isFull,
      isClosed,

      isAccepted,
      acceptedByMe,

      loadError: '',
      loading: false
    })

    this._lastDetailLoadedAt = Date.now()
    return true
  },

  async loadTripDetail(id, options = {}) {
    const { silent = false } = options
    if (!silent) this.setData({ loading: true, loadError: '' })

    try {
      const res = await wx.cloud.callFunction({
        name: 'getTripDetail',
        data: { type: 'request', id }
      })

      if (!res.result || !res.result.success) {
        if (this.data.trip && !(res.result && res.result.notFound)) {
          return
        }
        const msg = (res.result && (res.result.errorMsg || res.result.msg)) || '加载失败'
        this.setLoadError(msg)
        return
      }

      const trip = res.result.data
      if (!trip) {
        this.setLoadError('该求车路线不存在或已被删除')
        return
      }

      this.applyRequestData(trip)
    } catch (err) {
      if (this.data.trip) {
        return
      }
      console.error('loadTripDetail error:', err)
      this.setLoadError('网络异常，请稍后重试')
    }
  },

  // =========================
  // =========================
  // 乘客加入
  // =========================
  // =========================
  async joinAsPassenger() {
    const {
      tripId,
      trip,
      isOwner,
      joinedByMe,
      isFull,
      isClosed,
      acceptedByMe,
      submittingPassenger
    } = this.data

    if (!tripId) return
    if (submittingPassenger) return

    // ✅ 登录 + 完善资料拦截
    if (!this.ensureLoginBeforeAction('requestDetail:join')) return

    // 刷新 openid（刚登录回来）
    const myOpenid = wx.getStorageSync('openid') || ''
    this.setData({ myOpenid })

    // 防误操作
    if (isOwner) return this.showToast('不能加入自己发布的求车', 'none')
    if (acceptedByMe) return this.showToast('你已是该路线司机，无法作为乘客加入', 'none')
    if (joinedByMe) return this.showToast('你已加入该路线', 'none')

    const st = String((trip && trip.status) || 'open')
    if (st !== 'open') return this.showToast(`当前状态不可加入：${st}`, 'none')
    if (isClosed) return this.showToast('该路线已结束', 'none')
    if (isFull) return this.showToast('该路线已满员', 'none')

    this.setData({ submittingPassenger: true })

    try {
      const ret = await wx.cloud.callFunction({
        name: 'joinTrip',
        data: { type: 'request', requestId: tripId }
      })

      if (ret.result && ret.result.success) {
        this.showToast('加入成功', 'success', 1200)
        setTimeout(() => {
          wx.reLaunch({ url: '/pages/home/home' })
        }, 1200)
        return
      }

      const msg = (ret.result && ret.result.errorMsg) ? ret.result.errorMsg : '加入失败'
      this.showToast(msg, 'none')
    } catch (e) {
      console.error('joinAsPassenger error:', e)
      this.showToast('加入失败', 'none')
    } finally {
      this.setData({ submittingPassenger: false })
    }
  },

  // =========================
  // ✅ 司机加入（tripManage）
  // =========================
  async acceptRequest() {
    const {
      tripId,
      trip,
      isAccepted,
      acceptedByMe,
      isOwner,
      joinedByMe,
      submittingDriver
    } = this.data

    if (!tripId) return
    if (submittingDriver) return

    // ✅ 登录 + 完善资料拦截
    if (!this.ensureLoginBeforeAction('requestDetail:accept')) return

    // 刷新 openid（刚登录回来）
    const myOpenid = wx.getStorageSync('openid') || ''
    this.setData({ myOpenid })

    // 规则1：自己不能接自己
    if (isOwner) return this.showToast('不能成为自己求车的司机', 'none')

    // 规则2：已作为乘客加入，不能接单
    if (joinedByMe) return this.showToast('你已作为乘客加入该路线，无法再接单', 'none')

    // 已被接单
    if (isAccepted) {
      if (acceptedByMe) this.showToast('你已成为该路线司机', 'none')
      else this.showToast('已被其他司机接单', 'none')
      return
    }

    this.setData({ submittingDriver: true })

    try {
      const result = await callTripManage({ type: 'request', requestId: tripId, action: 'acceptRequest' })

      if (result && (result.success || result.ok)) {
        this.showToast('接单成功', 'success', 1200)
        setTimeout(() => {
          wx.reLaunch({ url: '/pages/home/home' })
        }, 1200)
        return
      }

      const msg = (result && result.errorMsg) ? result.errorMsg : '接单失败'
      this.showToast(msg, 'none')
    } catch (e) {
      console.error('acceptRequest error:', e)
      this.showToast('接单失败', 'none')
    } finally {
      this.setData({ submittingDriver: false })
    }
  },

  async onBlockRequestOwner() {
    const { tripId, ownerOpenid, isOwner, trip } = this.data
    if (isOwner) return this.showToast('不能拉黑自己', 'none')
    if (!ownerOpenid) return this.showToast('缺少拉黑对象', 'none')
    if (!this.ensureLoginForBlock()) return

    await blockRideUser({
      type: 'request',
      requestId: tripId,
      tripId,
      targetOpenid: ownerOpenid,
      targetName: (trip && (trip.name || trip.nickName)) || '求车发布者'
    })
  },

  // =========================
  // 分享：统一导向 requestDetail
  // =========================
  onShareAppMessage() {
    const { tripId, departAddress, destAddress, formattedDepartTime } = this.data
    const title = `${departAddress} → ${destAddress} ${formattedDepartTime}`.trim().slice(0, 30)
    return getApp().withReferralShare({
      title: title ? `${title}｜路线详情` : '路线详情',
      path: `/pages/home/requestDetail/requestDetail?id=${tripId}`
    })
  },

  onShareTimeline() {
    const { tripId, departAddress, destAddress, formattedDepartTime } = this.data
    const title = `${departAddress} → ${destAddress} ${formattedDepartTime}`.trim().slice(0, 30)
    return getApp().withReferralShare({
      title: title ? `${title}｜路线详情` : '路线详情',
      query: `id=${tripId}`
    })
  }
})
