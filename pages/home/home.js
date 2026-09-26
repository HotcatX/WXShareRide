const HOME_REFRESH_INTERVAL = 30 * 1000
const PUBLIC_STATS_CACHE_KEY = 'homePublicStatsCacheV1'
const PUBLIC_STATS_CACHE_TTL = 24 * 60 * 60 * 1000
const HOME_STATUS_REFRESH_KEY = 'homeStatusRefreshAtV1'
const HOME_STATUS_REFRESH_INTERVAL = 10 * 60 * 1000
const RIDE_LIST_REFRESH_KEY = 'rideListShouldRefreshAt'
const MAX_TIMEOUT_MS = 2147483647
const { formatRidePriceTag: formatRidePriceTagShared, markRideListStale } = require("../../utils/tripManage")
const rideTime = require("../../utils/rideTime")
const community = require("../../utils/community")
const publicStatsClient = require("../../utils/publicStatsClient")
const {
  DEFAULT_CITY_TREE,
  RIDE_DEFAULT_CITY_KEY,
  RIDE_CITY_STORAGE_KEY,
  loadCityTreeConfig,
  normalizeCityTree,
  getCitySnapshot,
  getCountryTabs,
  getCountryGroups,
  cityGroupsHaveResults,
  getStoredCitySnapshot,
  isRideServiceCityKey,
  normalizeRideDisplayCityKey,
  setStoredCitySnapshot
} = require("../../utils/cityTree")

const RIDE_CITY_PICKER_HINT = "找不到你的城市？可以联系开发者请求开通该区域。当前优先服务纽约/新泽西。"
const RIDE_DEFAULT_CITY_SNAPSHOT = getCitySnapshot(DEFAULT_CITY_TREE, RIDE_DEFAULT_CITY_KEY)

function homeIdentity() {
  return wx.getStorageSync('isGuest') ? '' : String(wx.getStorageSync('openid') || '')
}

function readPublicStatsCache() {
  try {
    const entry = wx.getStorageSync(PUBLIC_STATS_CACHE_KEY)
    if (!entry || entry.version !== 1 || !Number.isSafeInteger(entry.syncedAt) || entry.syncedAt <= 0) return null
    const age = Date.now() - entry.syncedAt
    const data = entry.data
    if (age < 0 || age >= PUBLIC_STATS_CACHE_TTL || !data ||
      !Number.isSafeInteger(data.servedTrips) || data.servedTrips < 0 || typeof data.coverageText !== 'string') return null
    return entry
  } catch (_) { return null }
}

// Cache only completed reads. A changed identity or mutation revision starts a
// separate request, so an old in-flight response cannot satisfy a fresh return.
function readHomeResource(page, resource, key, force, read) {
  const reads = page._homeReads || (page._homeReads = {})
  const previous = reads[resource]
  if (previous && previous.key === key) {
    if (previous.promise) return previous.promise
    const age = Date.now() - previous.at
    if (!force && previous.at && age >= 0 && age < HOME_REFRESH_INTERVAL) return Promise.resolve()
  }
  const entry = { key, at: 0, promise: null }
  reads[resource] = entry
  const isCurrent = () => page._homeReads === reads && reads[resource] === entry
  entry.promise = Promise.resolve().then(() => isCurrent() ? read(isCurrent) : false).then(result => {
    if (result !== false && isCurrent()) entry.at = Date.now()
    return result
  }).finally(() => { entry.promise = null })
  return entry.promise
}

// =========================
// 按发车时间排序（date + time）
// =========================
function getDepartTimestamp(trip) {
  const savedMs = Number(trip && trip.departureAtMs)
  if (Number.isFinite(savedMs) && savedMs > 0) return savedMs
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

  const timestamp = rideTime.parseRideDateTime(String(date), String(t))
  return Number.isFinite(timestamp) ? timestamp : Infinity
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
  const map = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return map[rideTime.getRideWeekday(dateStr)] || ''
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

function normalizePublicStats(raw = {}) {
  const hasServedTrips = raw.servedTrips !== undefined && raw.servedTrips !== null && raw.servedTrips !== ''
  const servedTrips = hasServedTrips ? Number(raw.servedTrips) : null
  return {
    servedTrips,
    servedTripsText: formatStatNumber(servedTrips),
    hasServedTrips: servedTrips !== null && Number.isFinite(servedTrips),
    coverageText: raw.coverageText || 'NY / NJ'
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

  const fromAddress = raw._fromAddress || dep0.address || ''
  const toAddress = raw._toAddress || dest0.address || ''
  const date = dep0.date || ''
  const time = dep0.time || ''

  const dateCN = formatDateCNNoYear(date)
  const weekday = getWeekdayCN(date)

  const timeLabel =
    raw._timeLabel ||
    (dateCN && weekday && time
      ? `${dateCN} ${weekday} ${time}`
      : (dateCN && weekday
        ? `${dateCN} ${weekday}`
        : (dateCN || time || '')))

  const tripId = raw.tripId || raw._id || ''
  const isRequest = from === 'request'
  const requestPassengerCount =
    raw.passengerCount ||
    1
  const seatText = isRequest
    ? `${requestPassengerCount}人求车`
    : `余位 ${raw.availSeatNum || 0}`
  const priceText = formatRidePriceTag(raw.referencePrice || raw.price || raw.displayPrice || '')

  // ===== 状态识别（past / open / full）=====
  const statusText = raw.status || ''
  const st = String(statusText || '').toLowerCase()

  let statusKey = 'open'
  if (
    st.includes('past') ||
    st.includes('expired') ||
    st.includes('done') ||
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
    pageTitle: '共享生活',
    activeCityKey: RIDE_DEFAULT_CITY_SNAPSHOT.key,
    activeCityLabel: RIDE_DEFAULT_CITY_SNAPSHOT.label,
    activeCityAliases: RIDE_DEFAULT_CITY_SNAPSHOT.aliases,
    isRideServiceAvailable: true,
    rideDemandSubmitting: false,
    rideDemandRequested: false,
    cityTree: DEFAULT_CITY_TREE,
    cityCountryTabs: getCountryTabs(DEFAULT_CITY_TREE, "US"),
    cityPickerGroups: getCountryGroups(DEFAULT_CITY_TREE, "US", RIDE_DEFAULT_CITY_KEY),
    cityPickerVisible: false,
    activeCityCountryCode: "US",
    citySearchKeyword: "",
    cityPickerHasResults: true,
    cityPickerEmptyText: "没有找到相关城市",
    cityPickerHintText: RIDE_CITY_PICKER_HINT,

    publicStats: normalizePublicStats(),
    communityGroupLoading: false,
    communityNoticeVisible: false,
    communityNotice: null,

    isLoggedIn: false,
    customTabMarketBadge: 0,
    customTabProfileBadge: 0,

    // ✅ 当前展开块：'create' | 'join' | ''
    expandedSection: '',
  },

  // 请求状态不参与页面渲染。
  _statusRefreshPromise: null,
  _homeShowTimer: null,
  _communityActive: false,
  _communityRequestVersion: 0,
  _announcementShownOnVisit: false,
  _skipNextAnnouncementShow: false,
  _communityNoticeManual: false,
  _communityNoticeExpiryTimer: null,
  _communityNoticeExpiryVersion: 0,

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
    this.syncLoginState()
    try {
      await Promise.all([
        this.refreshCommunityConfig({ force: true }),
        this.loadPublicStats({ force: true }),
        this.refreshHomeData(true),
        this.loadUnreadCount({ force: true })
      ])
    } catch (e) {
      console.error('refreshHomeByUser error', e)
    }
  },

  onLoad(options) {
    const storedCity = getStoredCitySnapshot(RIDE_CITY_STORAGE_KEY, DEFAULT_CITY_TREE, RIDE_DEFAULT_CITY_KEY)
    this._applyCityUi((options && options.city) || storedCity.key || RIDE_DEFAULT_CITY_KEY, { persist: false })
    this.setData(getHomeNavMetrics())

    wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })

    this.syncLoginState()
    setTimeout(() => this.loadCityTreeFromCloud(), 120)
    this.scheduleHomeShowRefresh()
  },

  onShow() {
    this._communityActive = true
    this._announcementShownOnVisit = !!this._skipNextAnnouncementShow
    this._skipNextAnnouncementShow = false
    this.setData({ communityGroupLoading: false })
    this.syncLoginState()
    this.scheduleHomeShowRefresh()
    this.refreshCommunityConfig()
  },

  onHide() {
    this._communityActive = false
    this._communityRequestVersion += 1
    this.onCommunityNoticeClose()
    this.clearHomeShowRefresh()
  },

  onUnload() {
    this._communityActive = false
    this._communityRequestVersion += 1
    this.clearCommunityNoticeExpiry()
    this.clearHomeShowRefresh()
  },

  scheduleHomeShowRefresh() {
    this.clearHomeShowRefresh()
    this._homeShowTimer = setTimeout(() => {
      this._homeShowTimer = null
      if (this.data.isRideServiceAvailable) {
        this.loadPublicStats()
        this.refreshHomeData(false, { forceStatus: false })
      }
      this.loadUnreadCount()
    }, 300)
  },

  clearHomeShowRefresh() {
    if (!this._homeShowTimer) return
    clearTimeout(this._homeShowTimer)
    this._homeShowTimer = null
  },

  clearCommunityNoticeExpiry() {
    this._communityNoticeExpiryVersion += 1
    if (this._communityNoticeExpiryTimer !== null) {
      clearTimeout(this._communityNoticeExpiryTimer)
      this._communityNoticeExpiryTimer = null
    }
  },

  scheduleCommunityNoticeExpiry(config, notice) {
    this.clearCommunityNoticeExpiry()
    const endAt = notice && notice.endAt
    if (!Number.isSafeInteger(endAt) || endAt <= 0) return
    const version = this._communityNoticeExpiryVersion
    const id = notice.id
    const checkExpiry = () => {
      // A callback already queued before cancellation cannot close a newer notice.
      if (version !== this._communityNoticeExpiryVersion) return
      this._communityNoticeExpiryTimer = null
      if (!this._communityActive || !this.data.communityNoticeVisible ||
        !this.data.communityNotice || this.data.communityNotice.id !== id) return
      const remaining = endAt - community.getCommunityNow(config)
      if (remaining <= 0) {
        this.onCommunityNoticeClose()
        return
      }
      // Longer validity windows must be split to avoid setTimeout overflow.
      this._communityNoticeExpiryTimer = setTimeout(checkExpiry, Math.min(MAX_TIMEOUT_MS, Math.ceil(remaining)))
    }
    checkExpiry()
  },

  async refreshCommunityConfig({ force = false } = {}) {
    const version = ++this._communityRequestVersion
    try {
      const config = await community.loadCommunityConfig({ force, maxAgeMs: HOME_REFRESH_INTERVAL })
      if (!this._communityActive || version !== this._communityRequestVersion) return
      const notice = community.getAvailableAnnouncement(config)
      // An updated or disabled notice must not leave an old modal on screen.
      if (this.data.communityNoticeVisible) {
        if (!notice || (!this._communityNoticeManual && !notice.enabled) ||
          notice.id !== this.data.communityNotice.id) {
          this.onCommunityNoticeClose()
        } else {
          this.setData({ communityNotice: notice })
          this.scheduleCommunityNoticeExpiry(config, notice)
        }
        return
      }
      if (this._announcementShownOnVisit || this.data.cityPickerVisible ||
        this.data.communityGroupLoading || !this.data.isRideServiceAvailable ||
        !community.shouldShowAnnouncement(config)) return
      // Persist before showing so a failed storage write cannot cause repeat popups.
      if (!community.recordAnnouncementShown(config)) return
      this._announcementShownOnVisit = true
      this._communityNoticeManual = false
      this.setData({ communityNotice: notice, communityNoticeVisible: true })
      this.scheduleCommunityNoticeExpiry(config, notice)
    } catch (e) {
      // Configuration outages must not interrupt the ride page or show stale notices.
      if (this._communityActive && version === this._communityRequestVersion) {
        this.onCommunityNoticeClose()
      }
    }
  },

  onCommunityNoticeClose() {
    this.clearCommunityNoticeExpiry()
    this._communityNoticeManual = false
    this.setData({ communityNoticeVisible: false, communityNotice: null })
  },

  onAnnouncementPreview() {
    this._skipNextAnnouncementShow = true
    this.onCommunityNoticeClose()
  },

  async onJoinCommunityGroup() {
    if (this.data.communityGroupLoading) return
    this._announcementShownOnVisit = true
    const version = ++this._communityRequestVersion
    this.setData({ communityGroupLoading: true })
    try {
      const config = await community.loadCommunityConfig({ force: true })
      if (!this._communityActive || version !== this._communityRequestVersion) return
      const notice = community.getAvailableAnnouncement(config)
      if (!notice) {
        wx.showToast({ title: '内容暂不可用，请稍后再试', icon: 'none' })
        return
      }
      this._communityNoticeManual = true
      this.setData({ communityNotice: notice, communityNoticeVisible: true })
      this.scheduleCommunityNoticeExpiry(config, notice)
    } catch (e) {
      if (this._communityActive && version === this._communityRequestVersion) {
        wx.showToast({ title: '暂时无法加载，请稍后重试', icon: 'none' })
      }
    } finally {
      if (this._communityActive) this.setData({ communityGroupLoading: false })
    }
  },

  syncLoginState() {
    const identity = homeIdentity()
    if (this._homeIdentity !== identity) {
      this._homeIdentity = identity
      this._homeReads = this._homeReads || {}
      delete this._homeReads.trips
      delete this._homeReads.unread
      this._statusRefreshPromise = null
      this._statusRefreshIdentity = ''
      this.setData({
        driverCreateTrips: [], driverJoinTrips: [], passengerCreateTrips: [], passengerTrips: [],
        createTrips: [], joinTrips: [], createShow: [], joinShow: [], customTabProfileBadge: 0, loading: false
      })
    }
    this.setData({ isLoggedIn: !!identity })
  },

  homeReadKey() {
    return JSON.stringify([homeIdentity(), this.data.activeCityKey, wx.getStorageSync(RIDE_LIST_REFRESH_KEY) || 0])
  },

  onTapLoginBtn() {
    if (this.data.isLoggedIn) return
    wx.setStorageSync('pendingPage', { url: '/pages/home/home' })
    wx.navigateTo({
      url: '/pages/other/login/login?pending=%2Fpages%2Fhome%2Fhome&from=home'
    })
  },

  _applyCityUi(cityKey = RIDE_DEFAULT_CITY_KEY, options = {}) {
    const cityTree = normalizeCityTree(options.cityTree || this.data.cityTree || DEFAULT_CITY_TREE)
    const snapshot = getCitySnapshot(cityTree, normalizeRideDisplayCityKey(cityKey || RIDE_DEFAULT_CITY_KEY))
    const activeCode = options.countryCode || this.data.activeCityCountryCode || "US"
    const citySearchKeyword = typeof options.keyword === "string" ? options.keyword : (this.data.citySearchKeyword || "")
    const cityPickerGroups = getCountryGroups(cityTree, activeCode, snapshot.key, { keyword: citySearchKeyword })

    this.setData({
      activeCityKey: snapshot.key,
      activeCityLabel: snapshot.label,
      activeCityAliases: snapshot.aliases,
      isRideServiceAvailable: isRideServiceCityKey(snapshot.key),
      rideDemandRequested: false,
      cityTree,
      activeCityCountryCode: activeCode,
      cityCountryTabs: getCountryTabs(cityTree, activeCode),
      cityPickerGroups,
      cityPickerHasResults: cityGroupsHaveResults(cityPickerGroups),
      citySearchKeyword
    })

    if (options.persist !== false) setStoredCitySnapshot(RIDE_CITY_STORAGE_KEY, snapshot)
    return snapshot
  },

  async loadCityTreeFromCloud() {
    try {
      const tree = await loadCityTreeConfig()
  
      if (!tree.length) {
        throw new Error("cityTree 数据为空")
      }
  
      this._applyCityUi(
        this.data.activeCityKey || RIDE_DEFAULT_CITY_KEY,
        { cityTree: tree }
      )
  
      return tree
  
    } catch (e) {
      console.error("cityTree 加载失败：", e)
  
      const tree = normalizeCityTree(DEFAULT_CITY_TREE)
  
      this._applyCityUi(
        this.data.activeCityKey || RIDE_DEFAULT_CITY_KEY,
        { cityTree: tree }
      )
  
      return tree
    }
  },

  onTapCity() {
    const cityTree = this.data.cityTree || DEFAULT_CITY_TREE
    const cityPickerGroups = getCountryGroups(
      cityTree,
      this.data.activeCityCountryCode || "US",
      this.data.activeCityKey || RIDE_DEFAULT_CITY_KEY
    )
    this.setData({
      cityPickerVisible: true,
      citySearchKeyword: "",
      cityPickerGroups,
      cityPickerHasResults: cityGroupsHaveResults(cityPickerGroups)
    })
  },

  onCityPickerCancel() {
    this.setData({ cityPickerVisible: false, citySearchKeyword: "" })
  },

  stopTouchMove() {},

  onCitySearchInput(e) {
    const keyword = (e.detail && e.detail.value) || ""
    const cityTree = this.data.cityTree || DEFAULT_CITY_TREE
    const cityPickerGroups = getCountryGroups(
      cityTree,
      this.data.activeCityCountryCode || "US",
      this.data.activeCityKey || RIDE_DEFAULT_CITY_KEY,
      { keyword }
    )
    this.setData({
      citySearchKeyword: keyword,
      cityPickerGroups,
      cityPickerHasResults: cityGroupsHaveResults(cityPickerGroups)
    })
  },

  onSelectCityCountry(e) {
    const code = e.currentTarget.dataset.code || "US"
    const cityTree = this.data.cityTree || DEFAULT_CITY_TREE
    const citySearchKeyword = this.data.citySearchKeyword || ""
    const cityPickerGroups = getCountryGroups(cityTree, code, this.data.activeCityKey || RIDE_DEFAULT_CITY_KEY, {
      keyword: citySearchKeyword
    })
    this.setData({
      activeCityCountryCode: code,
      cityCountryTabs: getCountryTabs(cityTree, code),
      cityPickerGroups,
      cityPickerHasResults: cityGroupsHaveResults(cityPickerGroups)
    })
  },

  onSelectCity(e) {
    const key = e.currentTarget.dataset.key || RIDE_DEFAULT_CITY_KEY
    const snapshot = this._applyCityUi(key)
    this.setData({ cityPickerVisible: false, citySearchKeyword: "" })
    if (isRideServiceCityKey(snapshot.key)) {
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
    this.navigateToNewTrip('driver')
  },

  goRequestTrip() {
    this.navigateToNewTrip('passenger')
  },

  navigateToNewTrip(mode) {
    if (!this.data.isRideServiceAvailable) {
      wx.showToast({ title: "该地区暂未开通", icon: "none" })
      return
    }
    const url = mode === 'passenger'
      ? '/pages/home/newTrip/newTrip?mode=passenger'
      : '/pages/home/newTrip/newTrip'
    wx.navigateTo({ url })
  },

  goCarpoolList() {
    wx.navigateTo({ url: `/pages/home/carpoolList/carpoolList?city=${this.data.activeCityKey || RIDE_DEFAULT_CITY_KEY}` })
  },

  // =========================
  // 统一卡片跳转：根据 item.role 分流到原详情页（其它功能保持不变）
  // =========================
  goUnifiedTripDetail(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const tripId = ds.tripid || ds.id || ''
    const role = String(ds.role || '').toLowerCase()
    const from = String(ds.from || '').toLowerCase()
    const sourceType = from === 'request' ? 'request' : 'carpool'

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

  async loadPublicStats({ force = false } = {}) {
    try {
      const context = publicStatsClient.getPublicStatsReadContext()
      const previous = this._homeReads && this._homeReads.stats
      const pending = previous && previous.key === context.key && previous.promise
      if (!force && !pending) {
        const cached = readPublicStatsCache()
        if (cached) {
          this._publicStatsReadDiagnostic = { source: 'local-cache' }
          this.setData({ publicStats: normalizePublicStats(cached.data) })
          return
        }
      }
      // Public totals have a separate persistent TTL and do not change when a
      // local ride mutation or login invalidates the personal lists.
      await readHomeResource(this, 'stats', context.key, true, async isCurrent => {
        const read = await publicStatsClient.loadPublicStats(context)
        if (!isCurrent() || !publicStatsClient.isPublicStatsReadCurrent(context)) return false
        this._publicStatsReadDiagnostic = read.diagnostic
        const res = read.response
        if (!res || !res.result || res.result.success !== true) throw new Error('获取社区统计失败')
        const syncedAt = Date.now()
        const stats = normalizePublicStats(res.result.data || {})
        // Both read transports share the original 24-hour public cache.
        if (stats.hasServedTrips) {
          try {
            wx.setStorageSync(PUBLIC_STATS_CACHE_KEY, {
              version: 1, syncedAt,
              data: { servedTrips: Math.floor(stats.servedTrips), coverageText: String(stats.coverageText || '') }
            })
          } catch (_) {}
        }
        this.setData({ publicStats: stats })
      })
    } catch (e) {
    }
  },

  // =========================
  // ✅ 首页首屏只拉卡片数据；状态更新放后台，避免全屏 loading 卡住操作。
  // =========================
  async refreshHomeData(force = false, options = {}) {
    if (!this.data.isRideServiceAvailable || !homeIdentity()) {
      this.setData({ loading: false })
      return Promise.resolve()
    }
    const key = this.homeReadKey()
    const forceStatus = options.forceStatus === undefined ? force : !!options.forceStatus
    try {
      await readHomeResource(this, 'trips', key, force, async isCurrent => {
        this.setData({ loading: true })
        try {
          const loaded = await this.loadHomeTripLists(key, isCurrent)
          if (loaded !== false) this.refreshHomeStatusInBackground(forceStatus)
          return loaded
        } finally {
          if (isCurrent() && key === this.homeReadKey()) this.setData({ loading: false })
        }
      })
    } catch (e) {
      console.error('[home] refreshHomeData error:', e)
    }
  },

  async loadHomeTripLists(key = this.homeReadKey(), isCurrent = () => true) {
    const res = await wx.cloud.callFunction({ name: 'getHomeTripList' })
    if (!isCurrent() || key !== this.homeReadKey()) return false
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
          from: item.from || 'carpool',
          idx
        })
      )
    )

    const driverJoinTrips = sortByDepartTimeAsc(
      driverJoinList.map((item, idx) =>
        wrapTripForCard(item.tripData || item, {
          role: item.role || 'driverJoin',
          from: item.from || 'request',
          idx
        })
      )
    )

    const passengerCreateTrips = sortByDepartTimeAsc(
      passengerCreateList.map((item, idx) =>
        wrapTripForCard(item.tripData || item, {
          role: item.role || 'passengerCreate',
          from: item.from || 'request',
          idx
        })
      )
    )

    const passengerTrips = sortByDepartTimeAsc(
      passengerJoinList.map((item, idx) =>
        wrapTripForCard(item.tripData || item, {
          role: item.role || 'passenger',
          from: item.from || 'carpool',
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
    const identity = homeIdentity()
    if (!identity) return Promise.resolve()
    if (this._statusRefreshPromise && this._statusRefreshIdentity === identity) return this._statusRefreshPromise

    const now = Date.now()
    const statusKey = `${HOME_STATUS_REFRESH_KEY}:${identity}`
    const last = Number(wx.getStorageSync(statusKey) || 0)
    if (!force && last && now - last >= 0 && now - last < HOME_STATUS_REFRESH_INTERVAL) {
      return Promise.resolve()
    }

    this._statusRefreshIdentity = identity
    const request = wx.cloud.callFunction({ name: 'syncMyTripStatus' }).then((res) => {
      const result = res && res.result ? res.result : {}
      if (!(result.ok || result.success) || identity !== homeIdentity() || this._statusRefreshPromise !== request) return null
      wx.setStorageSync(statusKey, Date.now())
      const changedCount =
        Number(result.moved || 0) +
        Number(result.movedTotal || 0) +
        Number(result.requestUpdated || 0) +
        Number(result.carpoolUpdated || 0)

      if (changedCount > 0) {
        markRideListStale()
        return this.loadHomeTripLists(this.homeReadKey(), () => this._statusRefreshPromise === request)
      }
      return null
    }).catch((e) => {
    }).finally(() => {
      if (this._statusRefreshPromise === request) this._statusRefreshPromise = null
    })
    this._statusRefreshPromise = request
    return request
  },

  // =========================
  // 分享
  // =========================
  onShareAppMessage() {
    return getApp().withReferralShare({
      title: '共享出行, 一键往返 NY-NJ',
      path: `/pages/home/home?city=${this.data.activeCityKey || RIDE_DEFAULT_CITY_KEY}`
    })
  },

  onShareTimeline() {
    return getApp().withReferralShare({
      title: '共享出行, 一键往返 NY-NJ',
      query: `city=${this.data.activeCityKey || RIDE_DEFAULT_CITY_KEY}`
    })
  },

  // =========================
  // 未读数
  // =========================
  loadUnreadCount({ force = false } = {}) {
    const openid = wx.getStorageSync('openid')
    const isGuest = wx.getStorageSync('isGuest')

    wx.setStorageSync('customTabMarketBadge', 0)
    this.setData({ customTabMarketBadge: 0 })

    if (!openid || isGuest) {
      wx.setStorageSync('customTabProfileBadge', 0)
      this.setData({ customTabProfileBadge: 0 })
      return Promise.resolve()
    }

    // Notification pages already keep the local badge in sync after marking read.
    this.setData({ customTabProfileBadge: Number(wx.getStorageSync('customTabProfileBadge') || 0) })
    const key = this.homeReadKey()
    return readHomeResource(this, 'unread', key, force, async isCurrent => {
        const res = await wx.cloud.database().collection('Notifications')
          .where({ _openid: openid, read: false }).count()
        if (!isCurrent() || key !== this.homeReadKey()) return false
        const count = res.total || 0
        wx.setStorageSync('customTabProfileBadge', count)
        this.setData({ customTabProfileBadge: count })
      })
      .catch(err => {
        console.error('home 未读消息统计失败：', err)
      })
  }
})
