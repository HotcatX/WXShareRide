// pages/home/home.js
const { createTimer, trackDuration, trackEvent } = require("../../utils/analytics")

const HOME_REFRESH_INTERVAL = 30 * 1000
const HOME_STATUS_REFRESH_KEY = 'homeStatusRefreshAtV1'
const HOME_STATUS_REFRESH_INTERVAL = 10 * 60 * 1000

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
    _statusKey: safeStatusKey,
    _statusBadge: statusBadgeMap[safeStatusKey],
  }
}

Page({
  data: {
    // ✅ 司机数据（保留原结构，兼容云函数返回）
    driverCreateTrips: [], // getDriverHomeTripList.createList -> Carpool
    driverJoinTrips: [],   // getDriverHomeTripList.joinList   -> CarpoolRequest

    // ✅ 乘客数据（保留原结构，兼容云函数返回）
    passengerCreateTrips: [], // getPassengerHomeTripList.createList -> CarpoolRequest
    passengerTrips: [],       // getPassengerHomeTripList.joinList   -> Carpool/CarpoolRequest

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

    statusBarHeight: 80,
    pageTitle: '纽约生活',

    publicStats: normalizePublicStats(),

    isLoggedIn: false,

    // ✅ 当前展开块：'create' | 'join' | ''
    expandedSection: '',
  },

  // ✅ 防重复请求：并发锁 + 简单节流（不要放到 data 里）
  _refreshPromise: null,
  _statusRefreshPromise: null,
  _lastRefreshAt: 0,
  _publicStatsTimer: null,

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
    try {
      await this.loadPublicStats()
      await this.refreshHomeData(true)
      await this.loadUnreadCount()
    } catch (e) {
      console.error('onPullDownRefresh error', e)
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  onLoad() {
    trackEvent("page_view", {
      module: "home",
      action: "view",
      source: "home"
    })

    const info = wx.getSystemInfoSync()
    this.setData({ statusBarHeight: info.statusBarHeight })

    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })

    this.loadUnreadCount()

    this.syncLoginState()
    this.loadPublicStats()
  },

  onShow() {
    this.syncLoginState()
    this.startPublicStatsTicker()
    this.refreshHomeData(false)
    this.loadUnreadCount()
  },

  onHide() {
    this.stopPublicStatsTicker()
  },

  onUnload() {
    this.stopPublicStatsTicker()
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

  // =========================
  // 顶部按钮导航（统一）
  // =========================
  goNewTrip() {
    wx.navigateTo({ url: '/pages/home/newTrip/newTrip' })
  },

  goCarpoolList() {
    wx.navigateTo({ url: '/pages/home/carpoolList/carpoolList' })
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
    const startedAt = createTimer()
    try {
      const res = await wx.cloud.callFunction({ name: 'getPublicStats' })
      const data = res && res.result && res.result.data ? res.result.data : {}
      this.setData({ publicStats: normalizePublicStats(data) })
      this.startPublicStatsTicker()
      trackDuration("home_sync", startedAt, {
        module: "home",
        action: "sync",
        result: "success"
      })
    } catch (e) {
      trackDuration("home_sync", startedAt, {
        module: "home",
        action: "sync",
        result: "fail",
        errorCode: e && (e.errMsg || e.message) ? String(e.errMsg || e.message).slice(0, 80) : "unknown"
      })
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
  async refreshHomeData(force = false) {
    if (this._refreshPromise) return this._refreshPromise

    const now = Date.now()
    if (!force && this._lastRefreshAt && now - this._lastRefreshAt < HOME_REFRESH_INTERVAL) {
      return Promise.resolve()
    }

    this.setData({ loading: true })

    this._refreshPromise = this.loadHomeTripLists()
      .then(() => {
        this.refreshHomeStatusInBackground(force)
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
    const startedAt = createTimer()
    await Promise.allSettled([
      this.loadDriverHomeTrips(),
      this.loadPassengerHomeTrips(),
    ])

    const createTrips = sortByDepartTimeAsc([
      ...(this.data.driverCreateTrips || []),
      ...(this.data.passengerCreateTrips || []),
    ])

    const joinTrips = sortByDepartTimeAsc([
      ...(this.data.driverJoinTrips || []),
      ...(this.data.passengerTrips || []),
    ])

    this.setData({ createTrips, joinTrips }, () => {
      this._recomputeHomeShows()
    })

    trackDuration("home_trip_load", startedAt, {
      module: "home",
      action: "load",
      result: "success",
      listCount: createTrips.length + joinTrips.length
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

    this._statusRefreshPromise = Promise.allSettled([
      wx.cloud.callFunction({ name: 'updateMyTripStatusDriver' }),
      wx.cloud.callFunction({ name: 'updateMyTripStatusPassenger' }),
    ]).then((results) => {
      const changedCount = results.reduce((sum, item) => {
        if (!item || item.status !== 'fulfilled') return sum
        const result = item.value && item.value.result ? item.value.result : {}
        return sum +
          Number(result.moved || 0) +
          Number(result.requestUpdated || 0) +
          Number(result.carpoolUpdated || 0)
      }, 0)

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
  // 司机：getDriverHomeTripList
  // =========================
  async loadDriverHomeTrips() {
    try {
      const res = await wx.cloud.callFunction({ name: 'getDriverHomeTripList' })
      const ok = !!(res && res.result && res.result.ok)
      const data = ok ? (res.result.data || {}) : {}

      const createList = Array.isArray(data.createList) ? data.createList : []
      const joinList = Array.isArray(data.joinList) ? data.joinList : []

      const driverCreateTrips = sortByDepartTimeAsc(
        createList.map((item, idx) =>
          wrapTripForCard(item.tripData || item, {
            role: item.role || 'driverCreate',
            from: item.from || 'Carpool',
            idx
          })
        )
      )

      const driverJoinTrips = sortByDepartTimeAsc(
        joinList.map((item, idx) =>
          wrapTripForCard(item.tripData || item, {
            role: item.role || 'driverJoin',
            from: item.from || 'CarpoolRequest',
            idx
          })
        )
      )

      // 注意：这里只更新原始两块，不在这里 recompute（合并后再 recompute）
      this.setData({ driverCreateTrips, driverJoinTrips })
    } catch (e) {
      console.error('loadDriverHomeTrips error', e)
    }
  },

  // =========================
  // 乘客：getPassengerHomeTripList
  // =========================
  async loadPassengerHomeTrips() {
    try {
      const res = await wx.cloud.callFunction({ name: 'getPassengerHomeTripList' })
      const ok = !!(res && res.result && res.result.ok)
      const data = ok ? (res.result.data || {}) : {}

      const createList = Array.isArray(data.createList) ? data.createList : []
      const joinList = Array.isArray(data.joinList) ? data.joinList : []

      const passengerCreateTrips = sortByDepartTimeAsc(
        createList.map((item, idx) =>
          wrapTripForCard(item.tripData || item, {
            role: item.role || 'passengerCreate',
            from: item.from || 'CarpoolRequest',
            idx
          })
        )
      )

      const passengerTrips = sortByDepartTimeAsc(
        joinList.map((item, idx) =>
          wrapTripForCard(item.tripData || item, {
            // 沿用原默认角色，跳转时按 item.from 决定详情来源。
            role: item.role || 'passenger',
            from: item.from || 'Carpool',
            idx
          })
        )
      )

      // 注意：这里只更新原始两块，不在这里 recompute（合并后再 recompute）
      this.setData({ passengerCreateTrips, passengerTrips })
    } catch (e) {
      console.error('loadPassengerHomeTrips error', e)
    }
  },

  // =========================
  // 分享
  // =========================
  onShareAppMessage() {
    return {
      title: '共享出行, 一键往返 NY-NJ',
      path: '/pages/home/home'
    }
  },

  onShareTimeline() {
    return {
      title: '共享出行, 一键往返 NY-NJ',
      query: ''
    }
  },

  // =========================
  // 未读数
  // =========================
  loadUnreadCount() {
    const openid = wx.getStorageSync('openid')
    const isGuest = wx.getStorageSync('isGuest')

    wx.removeTabBarBadge({ index: 1 })

    if (!openid || isGuest) {
      wx.removeTabBarBadge({ index: 2 })
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

        if (count > 0) {
          // ✅ profile = index 2
          wx.setTabBarBadge({
            index: 2,
            text: count > 99 ? '99+' : String(count)
          })
        } else {
          wx.removeTabBarBadge({ index: 2 })
        }
      })
      .catch(err => {
        console.error('home 未读消息统计失败：', err)
      })
  }
})
