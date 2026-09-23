const rideTelemetry = require("../../../utils/rideTelemetry")
const LOGIN_PAGE = '/pages/other/login/login'
const DETAIL_REFRESH_INTERVAL = 30 * 1000
const DETAIL_PREVIEW_KEY = "carpoolDetailPreviewV1"
const DETAIL_PREVIEW_TTL = 2 * 60 * 1000
const { blockRideUser, formatRidePricePerPerson, formatRideStats, markRideListStale } = require("../../../utils/tripManage")
const { readTripDetailCache, fetchTripDetail } = require("../../../utils/tripDetailCache")
const { isRouteExpired } = require("../../../utils/routeExpiry")

// ===== 工具函数：把 "2025-12-01" 转成 "周三" =====
function getWeekdayStr(dateStr) {
  if (!dateStr) return ''
  const parts = dateStr.split('-')
  if (parts.length !== 3) return ''
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (!y || !m || !d) return ''
  const dt = new Date(y, m - 1, d)
  const day = dt.getDay()
  const map = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return map[day] || ''
}

function formatDateNoYear(dateStr) {
  if (!dateStr) return ''
  const parts = String(dateStr).split('-')
  if (parts.length !== 3) return ''
  const m = parts[1]
  const d = parts[2]
  return `${Number(m)}月${Number(d)}日`
}

function containsFortLeeCore(addr) {
  if (!addr) return false
  const s = String(addr).toLowerCase()
  const keywords = [
    'fiat house',
    'modern',
    '2050',
    'hudson lights',
    'fort lee 核心区',
    'fort lee核心区',
    'fort lee core'
  ]
  return keywords.some(k => s.includes(k))
}

function cleanOpenid(value) {
  return String(value || '').trim()
}

function extractUserInfoDoc(result = {}) {
  if (!result || typeof result !== 'object') return null
  if (Array.isArray(result.data)) return result.data[0] || null
  if (result.data && typeof result.data === 'object') return result.data
  if (result.userInfo && typeof result.userInfo === 'object') return result.userInfo
  if (result.user && typeof result.user === 'object') return result.user
  return null
}

function getCarpoolDriverOpenid(trip = {}) {
  return cleanOpenid(trip._openid)
}

function getCarpoolPassengerOpenids(trip = {}) {
  const ids = new Set()
  ;(Array.isArray(trip.passengers) ? trip.passengers : []).forEach(item => {
    ids.add(cleanOpenid(item && item._openid))
  })
  ids.delete('')
  return Array.from(ids)
}

Page({
  data: {
    trip: null,
    loading: true,
    loadError: '',
    notFound: false,
    routeExpired: false,
    hasJoined: false,
    isOwner: false,

    statusBarHeight: 80,
    pageTitle: "路线详情",

    toastVisible: false,
    toastText: '',
    toastType: 'success',
    toastIcon: '',

    submitting: false,

    driverInfo: null,
    driverOpenid: '',
    driverCompletedText: '无',
    driverRatingText: '无',
    defaultAvatarUrl: '/images/profile.png',

    departAddress: '',
    destAddress: '',
    formattedDepartTime: '',
    referencePriceText: '',
    carBrandModel: '',

    tripId: '',

    showFortLeeCoreTip: false,

    pickupAddress: "",
    dropoffAddress: "",

    pickupSpotList: [],
    dropoffSpotList: [],

    showPickupOptions: false,
    showDropoffOptions: false,
    refresherTriggered: false,
    refreshHintText: ""
  },

  async loadUserSpots() {
    const openid = wx.getStorageSync("openid")
    if (!openid) return

    const db = wx.cloud.database()
    const res = await db.collection("userInfo").where({ _openid: openid }).limit(1).get()
    const info = res.data[0] || {}

    this.setData({
      pickupSpotList: info.pickupSpot || [],
      dropoffSpotList: info.dropoffSpot || []
    })
  },


  onPullDownRefresh: async function () {
    await this.onDetailRefresherRefresh()
  },

  async onDetailRefresherRefresh() {
    const { tripId, trip } = this.data
    const id = tripId || (trip && trip._id)
    if (!id) {
      wx.stopPullDownRefresh()
      return
    }
    this.setData({ refresherTriggered: true })
    try {
      await this.loadTripDetail(id, { silent: true, force: true })
    } catch (e) {
      console.error('onDetailRefresherRefresh error', e)
    } finally {
      this.setData({ refresherTriggered: false })
      wx.stopPullDownRefresh()
    }
  },

  onShareAppMessage() {
    const { tripId, trip, departAddress, destAddress, formattedDepartTime } = this.data
    const realId = tripId || (trip && trip._id) || ''
    const title = `${departAddress} → ${destAddress} ${formattedDepartTime}`.trim().slice(0, 30)
    return getApp().withReferralShare({
      title: title ? `${title}｜寻找顺路乘客` : '寻找顺路乘客',
      path: `/pages/home/tripDetail/tripDetail?id=${realId}&fromShare=1`,
    })
  },

  onShareTimeline() {
    const { tripId, trip, departAddress, destAddress, formattedDepartTime } = this.data
    const realId = tripId || (trip && trip._id) || ''
    const title = `${departAddress} → ${destAddress} ${formattedDepartTime}`.trim().slice(0, 30)
    return getApp().withReferralShare({
      title: title ? `${title}｜寻找顺路乘客` : '寻找顺路乘客',
      query: `id=${realId}&fromShare=1`
    })
  },

  async onLoad(options) {
    const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight })

    const tripId = (options && (options.id || options.tripId)) || ''
    if (!tripId) {
      this.setLoadError('缺少路线ID')
      return
    }

    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })

    // ✅ 允许游客浏览：不再 onLoad 强制登录
    this.setData({ tripId })
    // Shared/direct entries verify current status before showing any cached details.
    const sharedEntry = options.fromShare === '1' || getCurrentPages().length <= 1
    const hasPreview = !sharedEntry && this.applyCachedPreview(tripId)
    const loadPromise = this.loadTripDetail(tripId, { silent: hasPreview, force: sharedEntry })
    this._detailLoadPromise = loadPromise
    loadPromise.then(
      () => {
        if (this._detailLoadPromise === loadPromise) this._detailLoadPromise = null
      },
      () => {
        if (this._detailLoadPromise === loadPromise) this._detailLoadPromise = null
      }
    )

  },


  async onShow() {
    if (this.checkRouteExpiry()) return
    try {
      await this.loadUserSpots()
    } catch (e) {
      console.warn('loadUserSpots onShow failed:', e)
    }

    // ✅ 从 login 选“游客身份查看”回来的提示
    const tip = wx.getStorageSync('needLoginToast')
    if (tip) {
      wx.removeStorageSync('needLoginToast')
      wx.showToast({ title: tip, icon: 'none', duration: 2000 })
    }

    // 登录/注册资料完成后，恢复用户刚才的加入操作。
    const resumedJoin = await this.resumeJoinAfterLogin()
    if (resumedJoin) return

    // ✅ 登录/完善资料回来后，静默刷新一下按钮状态（hasJoined/isOwner）
    const { tripId } = this.data
    if (!tripId || this.data.loading || this.data.loadError) return
    if (Date.now() - (this._lastDetailLoadedAt || 0) < DETAIL_REFRESH_INTERVAL) return
    this.loadTripDetail(tripId, { silent: true })
  },

  async resumeJoinAfterLogin() {
    const action = wx.getStorageSync('postLoginAction') || {}
    if (!action || action.type !== 'joinCarpool') return false

    const currentId = this.data.tripId || (this.data.trip && this.data.trip._id) || ''
    const actionTripId = String(action.tripId || '')
    if (!currentId || !actionTripId || currentId !== actionTripId) return false

    const openid = wx.getStorageSync('openid') || ''
    if (!openid || this._resumingPostLoginJoin) return false

    this._resumingPostLoginJoin = true
    try {
      // 如果注册资料页通过 redirectTo 回到一个新建的详情页，先等待路线加载完成。
      if (this._detailLoadPromise) await this._detailLoadPromise
      if (this.checkRouteExpiry()) return false
      if (!this.data.trip) {
        await this.loadTripDetail(currentId, { silent: false, force: true })
      }
      if (!this.data.trip) return false

      // 只有资料确实已经写入，并且微信号存在时才自动继续加入。
      const userRes = await wx.cloud.callFunction({ name: 'getUserInfo' })
      const profile = extractUserInfoDoc(userRes.result || {})
      if (!profile || !String(profile.wechatID || '').trim()) return false

      this.setData({
        pickupAddress: String(action.pickupAddress || this.data.pickupAddress || ''),
        dropoffAddress: String(action.dropoffAddress || this.data.dropoffAddress || '')
      })

      wx.removeStorageSync('postLoginAction')
      wx.removeStorageSync('pendingPage')
      await this.joinCarpool()
      return true
    } catch (e) {
      console.error('resumeJoinAfterLogin error:', e)
      return false
    } finally {
      this._resumingPostLoginJoin = false
    }
  },

  onPickupFocus() {
    this.setData({ showPickupOptions: true })
  },
  onDropoffFocus() {
    this.setData({ showDropoffOptions: true })
  },

  onPickupInput(e) {
    this.setData({
      pickupAddress: e.detail.value,
      showPickupOptions: false
    })
  },

  onDropoffInput(e) {
    this.setData({
      dropoffAddress: e.detail.value,
      showDropoffOptions: false
    })
  },

  onPickupOptionTap(e) {
    this.setData({
      pickupAddress: e.currentTarget.dataset.value,
      showPickupOptions: false
    })
  },

  onDropoffOptionTap(e) {
    this.setData({
      dropoffAddress: e.currentTarget.dataset.value,
      showDropoffOptions: false
    })
  },

  onPickupTagSelect(e) {
    const v = String(e.currentTarget.dataset.value || '').trim()
    this.setData({
      pickupAddress: v,
      showPickupOptions: false
    })
  },

  onDropoffTagSelect(e) {
    const v = String(e.currentTarget.dataset.value || '').trim()
    this.setData({
      dropoffAddress: v,
      showDropoffOptions: false
    })
  },


  goBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else wx.reLaunch({ url: '/pages/home/home' })
  },

  goToAvailableCarpools() {
    wx.redirectTo({ url: '/pages/home/carpoolList/carpoolList' })
  },

  checkRouteExpiry() {
    if (this.data.routeExpired) return true
    if (!isRouteExpired(this.data.trip)) return false
    this.setRouteExpired()
    return true
  },

  setRouteExpired() {
    this.setLoadError('')
    this.setData({ routeExpired: true, loadError: '', toastVisible: false,
      pickupAddress: '', dropoffAddress: '', pickupSpotList: [], dropoffSpotList: [],
      referencePriceText: '', showPickupOptions: false, showDropoffOptions: false })
  },

  setLoadError(message, options = {}) {
    this.setData({
      loading: false,
      loadError: message || '路线加载失败，请稍后重试',
      notFound: !!options.notFound,
      routeExpired: false,
      trip: null,
      hasJoined: false,
      isOwner: false,
      driverInfo: null,
      driverOpenid: '',
      driverCompletedText: '无',
      driverRatingText: '无',
      departAddress: '',
      destAddress: '',
      formattedDepartTime: '',
      carBrandModel: '',
      showFortLeeCoreTip: false,
      submitting: false
    })
  },

  showToastBar(text, type = 'success') {
    const icon = type === 'success' ? '✓' : (type === 'warn' ? '!' : '✕')
    this.setData({
      toastVisible: true,
      toastText: text,
      toastType: type,
      toastIcon: icon
    })
    if (this._toastTimer) clearTimeout(this._toastTimer)
    this._toastTimer = setTimeout(() => {
      this.setData({ toastVisible: false })
    }, 2000)
  },

  onUnload() {
    this._detailLoadSequence = (this._detailLoadSequence || 0) + 1
    if (this._toastTimer) clearTimeout(this._toastTimer)
  },

  // =========================
  // ✅ 登录拦截：加入路线前必须登录 + 必要时完善资料
  // =========================
  ensureLoginBeforeJoin() {
    const openid = wx.getStorageSync('openid') || ''
    if (openid) return true

    const { tripId, trip } = this.data
    const id = tripId || (trip && trip._id) || ''
    const pendingUrl = `/pages/home/tripDetail/tripDetail?id=${id}`

    wx.setStorageSync('pendingPage', { url: pendingUrl })
    wx.setStorageSync('postLoginAction', {
      type: 'joinCarpool',
      from: 'tripDetail',
      tripId: id,
      returnUrl: pendingUrl,
      pickupAddress: String(this.data.pickupAddress || ''),
      dropoffAddress: String(this.data.dropoffAddress || '')
    })

    wx.navigateTo({ url: LOGIN_PAGE })
    return false
  },

  ensureLoginForBlock() {
    const openid = wx.getStorageSync('openid') || ''
    if (openid) return true

    const { tripId, trip } = this.data
    const id = tripId || (trip && trip._id) || ''
    wx.setStorageSync('pendingPage', { url: `/pages/home/tripDetail/tripDetail?id=${id}` })
    wx.navigateTo({ url: LOGIN_PAGE })
    return false
  },

  // =========================
  // loadTripDetail
  // =========================
  isFreshPreview(preview, id, type) {
    if (!preview || preview.id !== id || preview.type !== type || !preview.item) return false
    if (!preview.savedAt || Date.now() - Number(preview.savedAt) > DETAIL_PREVIEW_TTL) return false
    return true
  },

  applyCachedPreview(id) {
    let applied = false

    try {
      const cached = wx.getStorageSync(DETAIL_PREVIEW_KEY)
      if (this.isFreshPreview(cached, id, "carpool")) {
        applied = this.applyTripData(cached.item, id, { fromPreview: true })
      }
    } catch (e) {
    }

    try {
      const channel = this.getOpenerEventChannel && this.getOpenerEventChannel()
      if (channel && typeof channel.on === "function") {
        channel.on("routePreview", (preview) => {
          if (this.isFreshPreview(preview, id, "carpool")) {
            this.applyTripData(preview.item, id, { fromPreview: true })
          }
        })
      }
    } catch (e) {
    }

    return applied
  },

  applyTripData(trip, id, options = {}) {
    if (!trip) return false
    if (isRouteExpired(trip)) {
      this.setRouteExpired()
      return true
    }
    // A delayed list preview must not revive a route the detail request has closed.
    if (options.fromPreview && this.data.routeExpired) return true

    const myOpenid = wx.getStorageSync('openid') || ''
    let hasJoined = false
    let isOwner = false

    if (myOpenid) {
      if (trip._openid === myOpenid) isOwner = true
      hasJoined = getCarpoolPassengerOpenids(trip).includes(myOpenid)
    }
    const driverOpenid = getCarpoolDriverOpenid(trip)
    const keepDriverStats = options.fromPreview && this.data.trip &&
      this.data.trip._id === trip._id && this.data.driverOpenid === driverOpenid

    let departAddress = ''
    let destAddress = ''
    let formattedDepartTime = ''
    let carBrandModel = this.data.carBrandModel || ''

    if (!options.fromPreview) carBrandModel = ''

    if (Array.isArray(trip.departures) && trip.departures.length > 0) {
      const d = trip.departures[0]
      departAddress = d.address || ''
      const dateStr = d.date || ''
      const timeStr = d.time || ''
      const weekday = getWeekdayStr(dateStr)
      const dateNoYear = formatDateNoYear(dateStr)
      if (dateNoYear && timeStr) formattedDepartTime = `${dateNoYear} ${weekday} ${timeStr}`
      else if (dateNoYear) formattedDepartTime = `${dateNoYear} ${weekday}`
      else formattedDepartTime = timeStr || ''
    }

    if (Array.isArray(trip.destinations) && trip.destinations.length > 0) {
      destAddress = trip.destinations[0].address || ''
    }

    const showFortLeeCoreTip = containsFortLeeCore(departAddress) || containsFortLeeCore(destAddress)

    this.setData({
      trip,
      loadError: '',
      notFound: false,
      routeExpired: false,
      hasJoined,
      isOwner,
      driverInfo: options.fromPreview ? this.data.driverInfo : null,
      driverCompletedText: keepDriverStats ? this.data.driverCompletedText : '无',
      driverRatingText: keepDriverStats ? this.data.driverRatingText : '无',
      driverOpenid,
      departAddress,
      destAddress,
      formattedDepartTime,
      referencePriceText: formatRidePricePerPerson(trip.referencePrice || trip.price || trip.displayPrice, '价格以司机确认为准'),
      carBrandModel,
      showFortLeeCoreTip,
      loading: false
    }, () => rideTelemetry.detailViewed(this, trip, 'carpool'))

    this._lastDetailLoadedAt = Date.now()
    return true
  },

  applyTripDetailResult(result = {}, id, options = {}) {
    if (!(result.ok || result.success)) {
      const isNotFound = !!result.notFound
      const message = result.errorMsg || result.msg || (isNotFound ? '该路线不存在或已被删除' : '路线加载失败，请稍后重试')
      if (!isNotFound && (this.data.trip || this.data.routeExpired)) {
        if (!options.silentError) this.showToastBar(message, 'error')
        this.setData({ loading: false })
        return false
      }
      this.setLoadError(message, { notFound: isNotFound })
      return false
    }

    const trip = Array.isArray(result.data)
      ? result.data[0]
      : result.data

    if (!trip) {
      this.setLoadError('该路线不存在或已被删除', { notFound: true })
      return false
    }

    this.applyTripData(trip, id)
    if (this.data.routeExpired) return true
    const driverOpenid = getCarpoolDriverOpenid(trip)
    const canShowDriverInfo = this.data.hasJoined || this.data.isOwner
    if (result.driverInfo && result.driverInfo._openid) {
      this.applyDriverInfo(result.driverInfo, trip._id || id)
    } else if (driverOpenid && canShowDriverInfo) {
      this.loadDriverInfo(driverOpenid, trip._id || id)
    }
    this.applyDriverStats(result.driverStats || (result.driverInfo && result.driverInfo.rideStats))
    return true
  },

  async loadTripDetail(id, options = {}) {
    const sequence = this._detailLoadSequence = (this._detailLoadSequence || 0) + 1
    const { silent = false, force = false } = options
    const cached = !force ? readTripDetailCache("carpool", id, { allowStale: true }) : null
    if (cached && this.applyTripDetailResult(cached, id, { silentError: true })) {
      fetchTripDetail("carpool", id, { force: true })
        .then(result => {
          if (sequence === this._detailLoadSequence) this.applyTripDetailResult(result, id, { silentError: true })
        })
        .catch(() => {})
      return
    }

    if (!silent) this.setData({ loading: true, loadError: '', notFound: false })

    try {
      const result = await fetchTripDetail("carpool", id, { force: true })
      if (sequence !== this._detailLoadSequence) return
      this.applyTripDetailResult(result, id)
    } catch (err) {
      if (sequence !== this._detailLoadSequence) return
      if (this.data.trip || this.data.routeExpired) {
        this.showToastBar('网络异常', 'error')
        this.setData({ loading: false })
        return
      }
      console.error('请求错误:', err)
      this.setLoadError('网络异常，请稍后重试')
    }
  },

  applyDriverInfo(driverInfo, id) {
    if (!driverInfo || this.checkRouteExpiry()) return
    const currentId = this.data.tripId || (this.data.trip && this.data.trip._id) || ''
    if (id && currentId && id !== currentId) return

    const parts = []
    if (driverInfo.carBrand) parts.push(driverInfo.carBrand)
    if (driverInfo.carModel) parts.push(driverInfo.carModel)

    this.setData({
      driverInfo,
      carBrandModel: parts.join(' ')
    })
    this.applyDriverStats(driverInfo.rideStats)
  },

  applyDriverStats(rideStats) {
    const stats = rideStats && typeof rideStats === 'object' ? rideStats : {}
    const completed = stats.completedDriverTrips
    const completedNumber = Number(completed)
    const hasCount = (typeof completed === 'number' || (typeof completed === 'string' && completed.trim())) &&
      Number.isSafeInteger(completedNumber) && completedNumber >= 0
    const formatted = formatRideStats(stats, 'driver')
    const rating = Number(formatted.ratingAvg)
    this.setData({
      // Existing counters record completed driver trips, excluding uncompleted listings.
      driverCompletedText: hasCount ? `${completedNumber} 次` : '无',
      driverRatingText: Number.isSafeInteger(formatted.ratingCount) && formatted.ratingCount > 0 && rating > 0 && rating <= 5
        ? formatted.ratingAvg : '无'
    })
  },

  async loadDriverInfo(driverOpenid, id) {
    if (!driverOpenid) return

    try {
      const userRes = await wx.cloud.callFunction({
        name: 'getUserInfoByOpenids',
        data: { openids: [driverOpenid] }
      })

      if (!userRes.result || !userRes.result.ok) return

      const list = userRes.result.data || []
      const driverInfo = list[0] || null
      if (!driverInfo) return

      this.applyDriverInfo(driverInfo, id)
    } catch (e) {
      console.error('tripDetail 查询司机信息失败：', e)
    }
  },

  // =========================
  // 一键加入出行路线（加入必填上下车点 + 写入乘客记录）
  // =========================
  async joinCarpool() {
    if (this.checkRouteExpiry() || !this.data.trip) return
    const { trip, hasJoined, submitting, isOwner, tripId, pickupAddress, dropoffAddress } = this.data

    // const p = String(this.data.pickupAddress || '').trim()
    // const d = String(this.data.dropoffAddress || '').trim()
    // if (!p || !d) {
    //   wx.showToast({ title: '请先填写上车点和下车点', icon: 'none' })
    //   return
    // }

    if (isOwner) {
      wx.showToast({ title: '无法加入自己发布的路线', icon: 'none' })
      return
    }
    if (hasJoined) {
      wx.showToast({ title: '您已成功加入路线', icon: 'none' })
      return
    }
    if (submitting) return

    // ✅ 0) 必填校验：必须填上车点 + 下车点
    const p = String(pickupAddress || '').trim()
    const d = String(dropoffAddress || '').trim()
    if (!p || !d) {
      wx.showToast({ title: '请先填写上车点和下车点', icon: 'none' })
      return
    }

    // ✅ 1) 未登录先去 login，并要求必要时去 addInfo
    if (!this.ensureLoginBeforeJoin()) return

    this.setData({ submitting: true })

    try {
      const openid = wx.getStorageSync('openid') || ''
      if (!openid) {
        wx.showToast({ title: '请先登录', icon: 'none' })
        return
      }

      // 从云端读取当前用户资料（用于写 passengers）
      const userRes = await wx.cloud.callFunction({ name: 'getUserInfo' })
      const userDoc = extractUserInfoDoc(userRes.result || {})

      // 已登录但资料不存在：引导 addInfo
      if (!userDoc) {
        const id = tripId || (trip && trip._id) || ''
        const pendingUrl = `/pages/home/tripDetail/tripDetail?id=${id}`
        wx.setStorageSync('pendingPage', { url: pendingUrl })
        wx.showToast({ title: '请先完善个人信息', icon: 'none' })
        wx.navigateTo({ url: '/pages/profile/addInfo/addInfo?from=login' })
        return
      }

      const userInfo = { ...userDoc, _openid: openid }

      // 微信号校验
      if (!userInfo.wechatID || !String(userInfo.wechatID).trim()) {
        const id = tripId || (trip && trip._id) || ''

        // 保存返回页面
        wx.setStorageSync('pendingPage', {
          url: `/pages/home/tripDetail/tripDetail?id=${id}`
        })

        wx.showModal({
          title: '请完善个人信息',
          content: '加入路线前需要填写微信号，现在前往填写？',
          confirmText: '去填写',
          cancelText: '取消',
          success: (res) => {
            if (res.confirm) {
              wx.navigateTo({
                url: '/pages/profile/editInfo/editInfo'
              })
            }
          }
        })

        this.setData({ submitting: false })
        return
      }

      userInfo.pickupAddress = p
      userInfo.dropoffAddress = d

      const joinRes = await wx.cloud.callFunction({
        name: 'joinTrip',
        data: {
          type: 'carpool',
          tripId: trip._id,
          passengerInfo: {
            ...userInfo,
            pickupAddress: this.data.pickupAddress,
            dropoffAddress: this.data.dropoffAddress
          }
        }
      })

      const cResult = joinRes.result || {}
      if (!cResult.success) {
        wx.showToast({ title: cResult.errorMsg || cResult.msg || '加入路线失败', icon: 'none' })
        return
      }

      markRideListStale()
      wx.showToast({ title: '加入成功', icon: 'success', duration: 2000 })
      this.setData({ hasJoined: true, showPickupOptions: false, showDropoffOptions: false })

      await this.loadTripDetail(trip._id, { silent: true, force: true })

      const pages = getCurrentPages()
      const prevPage = pages[pages.length - 2]
      if (prevPage && typeof prevPage.loadCarpoolList === 'function') {
        prevPage.loadCarpoolList()
      }
    } catch (err) {
      console.error('joinCarpool error:', err)
      wx.showToast({ title: '请求失败，请稍后重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  async onBlockDriver() {
    const { tripId, trip, driverOpenid, driverInfo, isOwner } = this.data
    const targetOpenid = driverOpenid || (trip && trip._openid) || ''
    if (isOwner) {
      wx.showToast({ title: '不能拉黑自己', icon: 'none' })
      return
    }
    if (!targetOpenid) {
      wx.showToast({ title: '缺少拉黑对象', icon: 'none' })
      return
    }
    if (!this.ensureLoginForBlock()) return

    await blockRideUser({
      type: 'carpool',
      tripId: tripId || (trip && trip._id) || '',
      targetOpenid,
      targetName: (driverInfo && (driverInfo.name || driverInfo.nickName)) || '司机'
    })
  },

  copyWeChat() {
    const driverInfo = this.data.driverInfo || {}
    const wechat = driverInfo.wechatID
    if (!wechat) {
      wx.showToast({ title: '司机未填写微信号', icon: 'none' })
      return
    }
    rideTelemetry.copyContact(this, wechat, 'wechat', 'driver', {
      success: () => wx.showToast({ title: '已复制微信号', icon: 'success', duration: 1500 })
    })
  },

  copyPhone() {
    const driverInfo = this.data.driverInfo || {}
    const phone = driverInfo.phone
    if (!phone) {
      wx.showToast({ title: '司机未填写手机号', icon: 'none' })
      return
    }
    rideTelemetry.copyContact(this, phone, 'phone', 'driver', {
      success: () => wx.showToast({ title: '已复制手机号', icon: 'success', duration: 1500 })
    })
  },

  copyZelle() {
    const driverInfo = this.data.driverInfo || {}
    const name = driverInfo.zelleName
    const acc = driverInfo.zelleAccount
    if (!name || !acc) {
      wx.showToast({ title: '司机未完整填写 Zelle 信息', icon: 'none' })
      return
    }
    rideTelemetry.copyContact(this, `${name} ${acc}`, 'zelle', 'driver', {
      success: () => wx.showToast({ title: '已复制 Zelle 信息', icon: 'success', duration: 1500 })
    })
  }
})
