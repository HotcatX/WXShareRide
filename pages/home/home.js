const HOME_REFRESH_INTERVAL = 30 * 1000
const HOME_STATUS_REFRESH_KEY = 'homeStatusRefreshAtV1'
const HOME_STATUS_REFRESH_INTERVAL = 10 * 60 * 1000
const { formatRidePriceTag: formatRidePriceTagShared } = require("../../utils/tripManage")
const {
  DEFAULT_CITY_KEY,
  DEFAULT_CITY_LABEL,
  DEFAULT_CITY_TREE,
  RIDE_CITY_STORAGE_KEY,
  normalizeCityTree,
  getCitySnapshot,
  getCountryTabs,
  getCountryGroups,
  getStoredCitySnapshot,
  setStoredCitySnapshot
} = require("../../utils/cityTree")

function isRideServiceCity(cityKey) {
  return String(cityKey || "") === DEFAULT_CITY_KEY
}

// =========================
// 按发车时间排序（date + time）
// =========================
function getDepartTimestamp(trip) {
  const date =
    trip.date ||
    trip.departDate ||
    trip.departureDate ||
    (trip.departures && trip.departures[0] && trip.departures[0].date)

  const time =
    trip.time ||
    trip.departTime ||
    trip.departureTime ||
    (trip.departures && trip.departures[0] && trip.departures[0].time)

  if (!date) return Infinity
  const t = time || '00:00'

  // ✅ 手动解析，避免 iOS new Date("YYYY-MM-DD HH:mm") 兼容性问题
  const [y, m, d] = String(date).split('-').map(n => parseInt(n, 10))
  const [hh, mm] = String(t).split(':').map(n => parseInt(n, 10))

  if (!y || !m || !d) return Infinity
  const H = Number.isFinite(hh) ? hh : 0
  const M = Number.isFinite(mm) ? mm : 0

  return new Date(y, m - 1, d, H, M, 0).getTime()
}

function sortByDepartTimeAsc(list) {
  const now = Date.now()

  return list.slice().sort((a, b) => {
    const ta = getDepartTimestamp(a)
    const tb = getDepartTimestamp(b)

    const aPast = ta < now
    const bPast = tb < now

    // ① 一个过去、一个未来：未来的排前面
    if (aPast !== bPast) {
      return aPast ? 1 : -1
    }

    // ② 同为未来 or 同为过去：按发车时间升序
    return ta - tb
  })
}

function getWeekdayCN(dateStr) {
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

function formatDateCNNoYear(dateStr) {
  if (!dateStr) return ''
  const parts = String(dateStr).split('-')
  if (parts.length !== 3) return ''
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (!m || !d) return ''
  return `${m}月${d}日`
}

function formatStatNumber(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 'N/A'
  return String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function formatRidePriceTag(value) {
  return formatRidePriceTagShared(value)
}

function formatSyncAgo(syncedAt) {
  const ts = Number(syncedAt || 0)
  const diffSeconds = ts ? Math.max(0, Math.floor((Date.now() - ts) / 1000)) : 0
  return `${diffSeconds} 秒前`
}

function normalizePublicStats(raw = {}, syncedAt = Date.now()) {
  const hasServedTrips = raw.servedTrips !== undefined && raw.servedTrips !== null && raw.servedTrips !== ''
  const servedTrips = hasServedTrips ? Number(raw.servedTrips) : null
  return {
    servedTrips,
    servedTripsText: formatStatNumber(servedTrips),
    hasServedTrips: servedTrips !== null && Number.isFinite(servedTrips),
    coverageText: raw.coverageText || 'NY / NJ',
    lastSyncAt: syncedAt,
    lastSyncText: formatSyncAgo(syncedAt)
  }
}

function getHomeNavMetrics() {
  const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
  let navRightReserve = 14

  try {
    const menu = wx.getMenuButtonBoundingClientRect()
    const windowWidth = info.windowWidth || info.screenWidth || 0
    if (menu && windowWidth && menu.left) {
      navRightReserve = Math.max(navRightReserve, windowWidth - menu.left + 8)
    }
  } catch (e) {
  }

  return {
    statusBarHeight: info.statusBarHeight || 0,
    homeTopbarStyle: `padding-right: ${navRightReserve}px;`
  }
}

// 统一把 trip 原始结构包装成 home 卡片可用结构
function wrapTripForCard(raw, opts = {}) {
  const role = opts.role || ''
  const from = opts.from || ''
  const idx = opts.idx || 0

  const dep0 = (Array.isArray(raw.departures) && raw.departures[0]) ? raw.departures[0] : {}
  const dest0 = (Array.isArray(raw.destinations) && raw.destinations[0]) ? raw.destinations[0] : {}

  const fromAddress =
    (raw._fromAddress || raw.fromAddress || raw.from || raw.departure || raw.start || raw.startAddress ||
      dep0.address || dep0.name || dep0.label || dep0.text || '')

  const toAddress =
    (raw._toAddress || raw.toAddress || raw.to || raw.destination || raw.end || raw.endAddress ||
      dest0.address || dest0.name || dest0.label || dest0.text || '')

  const date =
    (raw.date || raw.departDate || raw.departureDate || raw.tripDate || raw.requestDate ||
      dep0.date || dep0.departDate || '')

  const time =
    (raw.time || raw.departTime || raw.departureTime || raw.tripTime || raw.requestTime ||
      dep0.time || dep0.departTime || '')

  const dateCN = formatDateCNNoYear(date)
  const weekday = getWeekdayCN(date)

  const timeLabel =
    raw._timeLabel ||
    (dateCN && weekday && time
      ? `${dateCN} ${weekday} ${time}`
      : (dateCN && weekday
        ? `${dateCN} ${weekday}`
        : (dateCN || time || '')))

  const tripId = raw.carpoolId || raw.tripId || raw._id || raw.docId || raw.id || ''
  const isRequest = from === 'CarpoolRequest'
  const requestPassengerCount =
    raw._requestPassengerCount ||
    raw.passengerCount ||
    raw.passengersCount ||
    (Array.isArray(raw.passengers) ? raw.passengers.length : 0) ||
    1
  const seatText = isRequest
    ? `${requestPassengerCount}人求车`
    : `余位 ${raw.availSeatNum || raw.availableSeats || raw.seatLeft || 0}`
  const priceText = formatRidePriceTag(raw.referencePrice || raw.price || raw.displayPrice || '')

  // ===== 状态识别（past / open / full）=====
  const statusText = raw.statusText || raw.status || raw.requestStatus || raw.state || ''
  const st = String(statusText || '').toLowerCase()

  let statusKey = 'open'
  if (
    st.includes('past') ||
    st.includes('expired') ||
    st.includes('done') ||
    st.includes('close') ||
    st.includes('closed') ||
    st.includes('结束') ||
    st.includes('过期')
  ) {
    statusKey = 'past'
  } else if (st.includes('full') || st.includes('已满') || st.includes('满')) {
    statusKey = 'full'
  }

  // ===== 每个状态对应一张“完整徽章PNG”（含底色+图标+文字）=====
  const statusBadgeMap = {
    past: '/images/past.png',
    open: '/images/open.png',
    full: '/images/full.png',
  }

  const safeStatusKey = statusBadgeMap[statusKey] ? statusKey : 'open'

  return {
    ...raw,
    _id: tripId,
    tripId,
    role,
    from,
    statusText,
    _fromAddress: fromAddress || '(未读取到出发地字段)',
    _toAddress: toAddress || '(未读取到目的地字段)',
    _timeLabel: timeLabel || '(未读取到时间字段)',
    _seatText: seatText,
    _priceText: priceText,
    _statusKey: safeStatusKey,
    _statusBadge: statusBadgeMap[safeStatusKey],
  }
}

Page({
  data: {
    // ✅ 司机数据（保留原结构，兼容云函数返回）
    driverCreateTrips: [],
    driverJoinTrips: [],

    // ✅ 乘客数据（保留原结构，兼容云函数返回）
    passengerCreateTrips: [],
    passengerTrips: [],

    // ✅ 合并后的两块：创建路线 / 加入路线
    createTrips: [],
    joinTrips: [],

    // ✅ 合并后的两块：收起/展开显示列表（收起=1条，展开=全部）
    createShow: [],
    joinShow: [],

    // ✅ 合并后的两块：展开态是否需要滚动（总数>3）
    createScrollable: false,
    joinScrollable: false,

    loading: false,
    refresherTriggered: false,

    statusBarHeight: 80,
    homeTopbarStyle: '',
    pageTitle: '共享出行',
    activeCityKey: DEFAULT_CITY_KEY,
    activeCityLabel: DEFAULT_CITY_LABEL,
    activeCityAliases: [DEFAULT_CITY_LABEL],
    isRideServiceAvailable: true,
    rideDemandSubmitting: false,
    rideDemandRequested: false,
    cityTree: DEFAULT_CITY_TREE,
    cityCountryTabs: getCountryTabs(DEFAULT_CITY_TREE, "US"),
    cityPickerGroups: getCountryGroups(DEFAULT_CITY_TREE, "US", DEFAULT_CITY_KEY),
    cityPickerVisible: false,
    activeCityCountryCode: "US",

    publicStats: normalizePublicStats(),

    isLoggedIn: false,
    customTabMarketBadge: 0,
    customTabProfileBadge: 0,

    // ✅ 当前展开块：'create' | 'join' | ''
    expandedSection: '',
  },

  // ✅ 防重复请求：并发锁 + 简单节流（不要放到 data 里）
  _refreshPromise: null,
  _statusRefreshPromise: null,
  _lastRefreshAt: 0,
  _publicStatsTimer: null,
  _homeShowTimer: null,

  // =========================
  // 合并后的两块：计算 show + scrollable
  // =========================
  _recomputeHomeShows() {
    const expanded = this.data.expandedSection || ''

    // 收起态：只显示 1 条；展开态：显示全部（交给 scroll-view 滚动）
    const pick = (list, key) => {
      const isExpanded = expanded === key
      const arr = Array.isArray(list) ? list : []
      return {
        show: isExpanded ? arr : arr.slice(0, 1),
        scrollable: isExpanded && arr.length > 3
      }
    }

    const c = pick(this.data.createTrips, 'create')
    const j = pick(this.data.joinTrips, 'join')

    this.setData({
      createShow: c.show,
      createScrollable: c.scrollable,
      joinShow: j.show,
      joinScrollable: j.scrollable,
    })
  },

  onToggleSection(e) {
    const key = (e.currentTarget.dataset || {}).key || ''
    if (!key) return

    // 再点一次同一个：收回
    const next = (this.data.expandedSection === key) ? '' : key
    this.setData({ expandedSection: next }, () => {
      this._recomputeHomeShows()
    })
  },

  async onPullDownRefresh() {
    await this.refreshHomeByUser()
    wx.stopPullDownRefresh()
  },

  async onHomeRefresherRefresh() {
    this.setData({ refresherTriggered: true })
    try {
      await this.refreshHomeByUser()
    } finally {
      this.setData({ refresherTriggered: false })
    }
  },

  async refreshHomeByUser() {
    try {
      await this.loadPublicStats()
      await this.refreshHomeData(true)
      await this.loadUnreadCount()
    } catch (e) {
      console.error('refreshHomeByUser error', e)
    }
  },

  onLoad(options) {
    const storedCity = getStoredCitySnapshot(RIDE_CITY_STORAGE_KEY, DEFAULT_CITY_TREE)
    this._applyCityUi((options && options.city) || storedCity.key || DEFAULT_CITY_KEY, { persist: false })
    this.setData(getHomeNavMetrics())

    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })

    this.syncLoginState()
    setTimeout(() => this.loadCityTreeFromCloud(), 120)
    this.scheduleHomeShowRefresh()
  },

  onShow() {
    this.syncLoginState()
    this.startPublicStatsTicker()
    this.scheduleHomeShowRefresh()
  },

  onHide() {
    this.clearHomeShowRefresh()
    this.stopPublicStatsTicker()
  },

  onUnload() {
    this.clearHomeShowRefresh()
    this.stopPublicStatsTicker()
  },

  scheduleHomeShowRefresh() {
    this.clearHomeShowRefresh()
    this._homeShowTimer = setTimeout(() => {
      this._homeShowTimer = null
      if (this.data.isRideServiceAvailable) {
        this.loadPublicStats()
        this.refreshHomeData(true, { forceStatus: false })
      }
      this.loadUnreadCount()
    }, 300)
  },

  clearHomeShowRefresh() {
    if (!this._homeShowTimer) return
    clearTimeout(this._homeShowTimer)
    this._homeShowTimer = null
  },

  syncLoginState() {
    const openid = wx.getStorageSync('openid')
    const isGuest = wx.getStorageSync('isGuest')
    this.setData({ isLoggedIn: !!openid && !isGuest })
  },

  onTapLoginBtn() {
    if (this.data.isLoggedIn) return
    wx.setStorageSync('pendingPage', { url: '/pages/home/home' })
    wx.navigateTo({
      url: '/pages/other/login/login?pending=%2Fpages%2Fhome%2Fhome&from=home'
    })
  },

  _applyCityUi(cityKey = DEFAULT_CITY_KEY, options = {}) {
    const cityTree = normalizeCityTree(options.cityTree || this.data.cityTree || DEFAULT_CITY_TREE)
    const snapshot = getCitySnapshot(cityTree, cityKey || DEFAULT_CITY_KEY)
    const activeCode = options.countryCode || this.data.activeCityCountryCode || "US"

    this.setData({
      activeCityKey: snapshot.key,
      activeCityLabel: snapshot.label,
      activeCityAliases: snapshot.aliases,
      isRideServiceAvailable: isRideServiceCity(snapshot.key),
      rideDemandRequested: false,
      cityTree,
      activeCityCountryCode: activeCode,
      cityCountryTabs: getCountryTabs(cityTree, activeCode),
      cityPickerGroups: getCountryGroups(cityTree, activeCode, snapshot.key)
    })

    if (options.persist !== false) setStoredCitySnapshot(RIDE_CITY_STORAGE_KEY, snapshot)
    return snapshot
  },

  async loadCityTreeFromCloud() {
    try {
      const db = wx.cloud.database()
      let docData = null
      try {
        const doc = await db.collection("cityTree").doc("default").get()
        docData = doc?.data || null
      } catch (e) {}

      if (!docData) {
        const res = await db.collection("cityTree").limit(1).get()
        docData = (res.data || [])[0] || null
      }

      const tree = normalizeCityTree(docData)
      this._applyCityUi(this.data.activeCityKey || DEFAULT_CITY_KEY, { cityTree: tree })
    } catch (e) {
      console.error("cityTree 加载失败：", e)
      this._applyCityUi(this.data.activeCityKey || DEFAULT_CITY_KEY, { cityTree: DEFAULT_CITY_TREE })
    }
  },

  onTapCity() {
    this.setData({ cityPickerVisible: true })
  },

  onCityPickerCancel() {
    this.setData({ cityPickerVisible: false })
  },

  stopTouchMove() {},

  onSelectCityCountry(e) {
    const code = e.currentTarget.dataset.code || "US"
    const cityTree = this.data.cityTree || DEFAULT_CITY_TREE
    this.setData({
      activeCityCountryCode: code,
      cityCountryTabs: getCountryTabs(cityTree, code),
      cityPickerGroups: getCountryGroups(cityTree, code, this.data.activeCityKey || DEFAULT_CITY_KEY)
    })
  },

  onSelectCity(e) {
    const key = e.currentTarget.dataset.key || DEFAULT_CITY_KEY
    const snapshot = this._applyCityUi(key)
    this.setData({ cityPickerVisible: false })
    if (isRideServiceCity(snapshot.key)) {
      this.scheduleHomeShowRefresh()
    }
  },

  async onRequestRideCityService() {
    if (this.data.rideDemandSubmitting || this.data.rideDemandRequested || this.data.isRideServiceAvailable) return
    this.setData({ rideDemandSubmitting: true })
    try {
      const res = await wx.cloud.callFunction({
        name: "rideDemand",
        data: {
          cityKey: this.data.activeCityKey,
          cityLabel: this.data.activeCityLabel,
          cityAliases: this.data.activeCityAliases || [],
          sourcePage: "home"
        }
      })
      if (!res || !res.result || !res.result.success) {
        throw new Error((res && res.result && res.result.errorMsg) || "request_failed")
      }
      this.setData({ rideDemandRequested: true })
      wx.showToast({ title: "已收到请求", icon: "success" })
    } catch (e) {
      console.error("request ride city service failed:", e)
      wx.showToast({ title: "提交失败，请稍后重试", icon: "none" })
    } finally {
      this.setData({ rideDemandSubmitting: false })
    }
  },

  // =========================
  // 顶部按钮导航（统一）
  // =========================
  goNewTrip() {
    if (!this.data.isRideServiceAvailable) {
      wx.showToast({ title: "该地区暂未开通拼车", icon: "none" })
      return
    }
    wx.navigateTo({ url: '/pages/home/newTrip/newTrip' })
  },

  goCarpoolList() {
    wx.navigateTo({ url: `/pages/home/carpoolList/carpoolList?city=${this.data.activeCityKey || DEFAULT_CITY_KEY}` })
  },

  // =========================
  // 统一卡片跳转：根据 item.role 分流到原详情页（其它功能保持不变）
  // =========================
  goUnifiedTripDetail(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const tripId = ds.tripid || ds.id || ''
    const role = String(ds.role || '').toLowerCase()
    const from = String(ds.from || '').toLowerCase()
    const sourceType = from === 'carpoolrequest' ? 'request' : 'carpool'

    if (!tripId) {
      wx.showToast({ title: '缺少路线ID', icon: 'none' })
      return
    }

    // driverCreate -> myTripDetailDriver
    if (role === 'drivercreate') {
      wx.navigateTo({ url: `/pages/profile/myTripDetailDriver/myTripDetailDriver?tripId=${tripId}` })
      return
    }

    // driverJoin -> myRequestDetailDriver
    if (role === 'driverjoin') {
      wx.navigateTo({ url: `/pages/profile/myRequestDetailDriver/myRequestDetailDriver?tripId=${tripId}` })
      return
    }

    if (role === 'passengercreate') {
      wx.navigateTo({ url: `/pages/profile/myTripRequestPassenger/myTripRequestPassenger?id=${tripId}` })
      return
    }

    // passenger / passengerJoin -> myTripDetailPassenger
    wx.navigateTo({ url: `/pages/profile/myTripDetailPassenger/myTripDetailPassenger?tripId=${tripId}&sourceType=${sourceType}` })
  },

  async loadPublicStats() {
    try {
      const res = await wx.cloud.callFunction({ name: 'getPublicStats' })
      const data = res && res.result && res.result.data ? res.result.data : {}
      this.setData({ publicStats: normalizePublicStats(data) })
      this.startPublicStatsTicker()
    } catch (e) {
    }
  },

  startPublicStatsTicker() {
    this.stopPublicStatsTicker()
    this.updatePublicStatsSyncText()
    this._publicStatsTimer = setInterval(() => {
      this.updatePublicStatsSyncText()
    }, 1000)
  },

  stopPublicStatsTicker() {
    if (!this._publicStatsTimer) return
    clearInterval(this._publicStatsTimer)
    this._publicStatsTimer = null
  },

  updatePublicStatsSyncText() {
    const stats = this.data.publicStats || {}
    const lastSyncText = formatSyncAgo(stats.lastSyncAt)
    if (stats.lastSyncText === lastSyncText) return
    this.setData({ 'publicStats.lastSyncText': lastSyncText })
  },

  // =========================
  // ✅ 首页首屏只拉卡片数据；状态更新放后台，避免全屏 loading 卡住操作。
  // =========================
  async refreshHomeData(force = false, options = {}) {
    if (!this.data.isRideServiceAvailable) {
      this.setData({ loading: false })
      return Promise.resolve()
    }

    if (this._refreshPromise) return this._refreshPromise

    const now = Date.now()
    if (!force && this._lastRefreshAt && now - this._lastRefreshAt < HOME_REFRESH_INTERVAL) {
      return Promise.resolve()
    }

    const forceStatus = options.forceStatus === undefined ? force : !!options.forceStatus

    this.setData({ loading: true })

    this._refreshPromise = this.loadHomeTripLists()
      .then(() => {
        this.refreshHomeStatusInBackground(forceStatus)
      })
      .catch((e) => {
        console.error('[home] refreshHomeData error:', e)
      })
      .finally(() => {
        this._lastRefreshAt = Date.now()
        this._refreshPromise = null
        this.setData({ loading: false })
      })

    return this._refreshPromise
  },

  async loadHomeTripLists() {
    const res = await wx.cloud.callFunction({ name: 'getHomeTripList' })
    const ok = !!(res && res.result && res.result.ok)
    if (!ok) {
      const result = res && res.result ? res.result : {}
      throw new Error(result.errorMsg || '获取首页行程失败')
    }
    const data = ok ? (res.result.data || {}) : {}
    const driver = data.driver || {}
    const passenger = data.passenger || {}

    const driverCreateList = Array.isArray(driver.createList) ? driver.createList : []
    const driverJoinList = Array.isArray(driver.joinList) ? driver.joinList : []
    const passengerCreateList = Array.isArray(passenger.createList) ? passenger.createList : []
    const passengerJoinList = Array.isArray(passenger.joinList) ? passenger.joinList : []

    const driverCreateTrips = sortByDepartTimeAsc(
      driverCreateList.map((item, idx) =>
        wrapTripForCard(item.tripData || item, {
          role: item.role || 'driverCreate',
          from: item.from || 'Carpool',
          idx
        })
      )
    )

    const driverJoinTrips = sortByDepartTimeAsc(
      driverJoinList.map((item, idx) =>
        wrapTripForCard(item.tripData || item, {
          role: item.role || 'driverJoin',
          from: item.from || 'CarpoolRequest',
          idx
        })
      )
    )

    const passengerCreateTrips = sortByDepartTimeAsc(
      passengerCreateList.map((item, idx) =>
        wrapTripForCard(item.tripData || item, {
          role: item.role || 'passengerCreate',
          from: item.from || 'CarpoolRequest',
          idx
        })
      )
    )

    const passengerTrips = sortByDepartTimeAsc(
      passengerJoinList.map((item, idx) =>
        wrapTripForCard(item.tripData || item, {
          role: item.role || 'passenger',
          from: item.from || 'Carpool',
          idx
        })
      )
    )

    this.setData({
      driverCreateTrips,
      driverJoinTrips,
      passengerCreateTrips,
      passengerTrips
    })

    const createTrips = sortByDepartTimeAsc([
      ...driverCreateTrips,
      ...passengerCreateTrips,
    ])

    const joinTrips = sortByDepartTimeAsc([
      ...driverJoinTrips,
      ...passengerTrips,
    ])

    this.setData({ createTrips, joinTrips }, () => {
      this._recomputeHomeShows()
    })
  },

  refreshHomeStatusInBackground(force = false) {
    if (this._statusRefreshPromise) return this._statusRefreshPromise

    const now = Date.now()
    const last = Number(wx.getStorageSync(HOME_STATUS_REFRESH_KEY) || 0)
    if (!force && last && now - last < HOME_STATUS_REFRESH_INTERVAL) {
      return Promise.resolve()
    }

    wx.setStorageSync(HOME_STATUS_REFRESH_KEY, now)

    this._statusRefreshPromise = wx.cloud.callFunction({ name: 'syncMyTripStatus' }).then((res) => {
      const result = res && res.result ? res.result : {}
      const changedCount =
        Number(result.moved || 0) +
        Number(result.movedTotal || 0) +
        Number(result.requestUpdated || 0) +
        Number(result.carpoolUpdated || 0)

      if (changedCount > 0) {
        return this.loadHomeTripLists()
      }
      return null
    }).catch((e) => {
    }).finally(() => {
      this._statusRefreshPromise = null
    })

    return this._statusRefreshPromise
  },

  // =========================
  // 分享
  // =========================
  onShareAppMessage() {
    return getApp().withReferralShare({
      title: '共享出行, 一键往返 NY-NJ',
      path: `/pages/home/home?city=${this.data.activeCityKey || DEFAULT_CITY_KEY}`
    })
  },

  onShareTimeline() {
    return getApp().withReferralShare({
      title: '共享出行, 一键往返 NY-NJ',
      query: `city=${this.data.activeCityKey || DEFAULT_CITY_KEY}`
    })
  },

  // =========================
  // 未读数
  // =========================
  loadUnreadCount() {
    const openid = wx.getStorageSync('openid')
    const isGuest = wx.getStorageSync('isGuest')

    wx.setStorageSync('customTabMarketBadge', 0)
    this.setData({ customTabMarketBadge: 0 })

    if (!openid || isGuest) {
      wx.setStorageSync('customTabProfileBadge', 0)
      this.setData({ customTabProfileBadge: 0 })
      return Promise.resolve()
    }

    const db = wx.cloud.database()
    return db.collection('Notifications')
      .where({
        _openid: openid,
        read: false
      })
      .count()
      .then(res => {
        const count = res.total || 0
        wx.setStorageSync('customTabProfileBadge', count)
        this.setData({ customTabProfileBadge: count })
      })
      .catch(err => {
        console.error('home 未读消息统计失败：', err)
      })
  }
})
