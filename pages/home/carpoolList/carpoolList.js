const { showDataError } = require("../../../utils/error")
const { formatRidePriceTag } = require("../../../utils/tripManage")
const {
  DEFAULT_CITY_KEY,
  DEFAULT_CITY_LABEL,
  DEFAULT_CITY_TREE,
  RIDE_CITY_STORAGE_KEY,
  normalizeCityTree,
  getCitySnapshot,
  getCountryTabs,
  getCountryGroups,
  cityGroupsHaveResults,
  getStoredCitySnapshot,
  setStoredCitySnapshot,
  textMatchesCity
} = require("../../../utils/cityTree")

const LIST_FETCH_LIMIT = 80
const LIST_REFRESH_INTERVAL = 30 * 1000
const OPTION_CACHE_KEY = "carpoolListFilterOptionsV1"
const OPTION_CACHE_TTL = 24 * 60 * 60 * 1000
const STATUS_REFRESH_KEY = "carpoolListStatusRefreshAtV1"
const STATUS_REFRESH_INTERVAL = 10 * 60 * 1000
const TRIP_EXPIRE_GRACE = 30 * 60 * 1000
const LIST_CACHE_KEY = "carpoolListDataV1"
const LIST_CACHE_TTL = 10 * 60 * 1000
const LIST_REFRESH_KEY = "rideListShouldRefreshAt"
const DETAIL_PREVIEW_KEY = "carpoolDetailPreviewV1"
const RIDE_CITY_PICKER_HINT = "找不到你的城市？可以联系开发者请求开通该区域。当前拼车优先服务纽约/新泽西。"

function isRideServiceCity(cityKey) {
  return String(cityKey || "") === DEFAULT_CITY_KEY
}

const DEFAULT_FROM_PLACES = [
  "Manhattan",
  "哥大/Columbia",
  "NYU",
  "Fordham",
  "JFK",
  "LGA",
  "EWR",
  "Fort Lee",
  "Jersey City",
  "Hoboken"
]

const DEFAULT_TO_PLACES = [
  "Manhattan",
  "哥大/Columbia",
  "NYU",
  "Fordham",
  "JFK",
  "LGA",
  "EWR",
  "Fort Lee",
  "Jersey City",
  "Hoboken",
  "Brooklyn",
  "Queens"
]

Page({
  data: {
    loading: true,
    hasLoadedOnce: false,
    loadingText: "正在加载附近路线...",
    refresherTriggered: false,

    statusBarHeight: 80,
    pageTitle: "线路列表",
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
    citySearchKeyword: "",
    cityPickerHasResults: true,
    cityPickerEmptyText: "没有找到相关城市",
    cityPickerHintText: RIDE_CITY_PICKER_HINT,

    // 筛选
    fromFilterOptions: ["全部", "其他"],
    fromFilterIndex: -1,
    toFilterOptions: ["全部", "其他"],
    toFilterIndex: -1,
    enableToLinkage: true,

    fromPlaceList: [],
    toPlaceList: [],

    timeFilterOptions: ["今天", "明天", "其他"],
    timeFilterIndex: -1,

    todayDateStr: "",
    tomorrowDateStr: "",

    // 原始两类数据
    originalCarpoolList: [],
    originalRequestList: [],

    // 分组后的渲染数据
    // 现在每个 group 里会有统一按时间排序的 items
    dayGroups: []
  },

  _listLoadingPromise: null,
  _optionsLoading: false,
  _statusRefreshing: false,
  _loadedOnceAt: 0,
  _initFilterFromShare: null,

  onLoad(options) {
    const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const storedCity = getStoredCitySnapshot(RIDE_CITY_STORAGE_KEY, DEFAULT_CITY_TREE)
    this._applyCityUi((options && options.city) || storedCity.key || DEFAULT_CITY_KEY, { persist: false })

    // 允许分享
    wx.showShareMenu({
      withShareTicket: true,
      menus: ['shareAppMessage', 'shareTimeline']
    })

    // 今日/明日
    const today = new Date()
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000)
    const fmt = (d) => {
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, "0")
      const day = String(d.getDate()).padStart(2, "0")
      return `${y}-${m}-${day}`
    }

    // 读取分享带来的筛选参数（先暂存，等 options 列表加载完再 set）
    const from = options && options.from != null ? Number(options.from) : -1
    const to = options && options.to != null ? Number(options.to) : -1
    const time = options && options.time != null ? Number(options.time) : -1
    this._initFilterFromShare = { from, to, time }

    const cachedOptions = this.getCachedFilterOptions()
    const defaultOptions = cachedOptions || this.buildFilterOptionData(DEFAULT_FROM_PLACES, DEFAULT_TO_PLACES)

    this.setData({
      statusBarHeight: info.statusBarHeight,
      todayDateStr: fmt(today),
      tomorrowDateStr: fmt(tomorrow),
      ...defaultOptions
    }, () => {
      this.applyShareFilters(false, () => {
        if (!this.data.isRideServiceAvailable) {
          this.setData({
            loading: false,
            hasLoadedOnce: true,
            originalCarpoolList: [],
            originalRequestList: [],
            dayGroups: []
          })
          setTimeout(() => this.loadCityTreeFromCloud(), 120)
          if (!cachedOptions) setTimeout(() => this.loadFromToOptionsFromDBMerged(), 200)
          return
        }
        this.loadBothLists({ showLoading: true }).then(() => {
          setTimeout(() => this.loadCityTreeFromCloud(), 120)
          if (!cachedOptions) setTimeout(() => this.loadFromToOptionsFromDBMerged(), 200)
          setTimeout(() => this.refreshStatusInBackground(false), 800)
        })
      })
    })
  },

  onShow() {
    // onLoad 已经负责首屏；返回页面时只做轻量刷新，避免重复卡首屏。
    if (!this.data.hasLoadedOnce) return
    if (!this.data.isRideServiceAvailable) {
      this.setData({
        loading: false,
        dayGroups: [],
        originalCarpoolList: [],
        originalRequestList: []
      })
      return
    }
    const refreshAt = this.getRideListRefreshAt()
    if (refreshAt && refreshAt > this._loadedOnceAt) {
      this.clearListCache()
      this.loadBothLists({ showLoading: false })
      return
    }
    if (Date.now() - this._loadedOnceAt < LIST_REFRESH_INTERVAL) return
    this.loadBothLists({ showLoading: false })
  },

  getRideListRefreshAt() {
    try {
      return Number(wx.getStorageSync(LIST_REFRESH_KEY) || 0)
    } catch (e) {
      return 0
    }
  },

  clearListCache() {
    try {
      wx.removeStorageSync(LIST_CACHE_KEY)
    } catch (e) {
    }
  },

  _applyCityUi(cityKey = DEFAULT_CITY_KEY, options = {}) {
    const cityTree = normalizeCityTree(options.cityTree || this.data.cityTree || DEFAULT_CITY_TREE)
    const snapshot = getCitySnapshot(cityTree, cityKey || DEFAULT_CITY_KEY)
    const activeCode = options.countryCode || this.data.activeCityCountryCode || "US"
    const citySearchKeyword = typeof options.keyword === "string" ? options.keyword : (this.data.citySearchKeyword || "")
    const cityPickerGroups = getCountryGroups(cityTree, activeCode, snapshot.key, { keyword: citySearchKeyword })
    const update = {
      activeCityKey: snapshot.key,
      activeCityLabel: snapshot.label,
      activeCityAliases: snapshot.aliases,
      cityTree,
      activeCityCountryCode: activeCode,
      cityCountryTabs: getCountryTabs(cityTree, activeCode),
      cityPickerGroups,
      cityPickerHasResults: cityGroupsHaveResults(cityPickerGroups),
      citySearchKeyword,
      isRideServiceAvailable: isRideServiceCity(snapshot.key),
      rideDemandRequested: false
    }

    if (options.persist !== false) setStoredCitySnapshot(RIDE_CITY_STORAGE_KEY, snapshot)
    this.setData(update)
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
    const cityTree = this.data.cityTree || DEFAULT_CITY_TREE
    const cityPickerGroups = getCountryGroups(
      cityTree,
      this.data.activeCityCountryCode || "US",
      this.data.activeCityKey || DEFAULT_CITY_KEY
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
      this.data.activeCityKey || DEFAULT_CITY_KEY,
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
    const cityPickerGroups = getCountryGroups(cityTree, code, this.data.activeCityKey || DEFAULT_CITY_KEY, {
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
    const key = e.currentTarget.dataset.key || DEFAULT_CITY_KEY
    const snapshot = this._applyCityUi(key)
    const serviceAvailable = isRideServiceCity(snapshot.key)
    this.clearListCache()
    this.setData({
      cityPickerVisible: false,
      citySearchKeyword: "",
      dayGroups: [],
      originalCarpoolList: [],
      originalRequestList: [],
      loading: serviceAvailable,
      hasLoadedOnce: !serviceAvailable
    }, () => {
      if (!serviceAvailable) return
      this.loadBothLists({ showLoading: false }).then(() => {
        this.applyAllFiltersAndGroup()
      })
    })
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
          sourcePage: "carpoolList"
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

  buildFilterOptionData(fromList, toList) {
    const fromPlaceList = this.uniqNonEmpty(fromList)
    const toPlaceList = this.uniqNonEmpty(toList)

    return {
      fromPlaceList,
      toPlaceList,
      fromFilterOptions: ["全部", ...fromPlaceList, "其他"],
      toFilterOptions: ["全部", ...toPlaceList, "其他"]
    }
  },

  getCachedFilterOptions() {
    try {
      const cached = wx.getStorageSync(OPTION_CACHE_KEY)
      if (!cached || !cached.savedAt) return null
      if (Date.now() - Number(cached.savedAt) > OPTION_CACHE_TTL) return null

      const fromList = Array.isArray(cached.fromPlaceList) ? cached.fromPlaceList : []
      const toList = Array.isArray(cached.toPlaceList) ? cached.toPlaceList : []
      if (!fromList.length && !toList.length) return null

      return this.buildFilterOptionData(
        [...DEFAULT_FROM_PLACES, ...fromList],
        [...DEFAULT_TO_PLACES, ...toList]
      )
    } catch (e) {
      return null
    }
  },

  cacheFilterOptions(fromPlaceList, toPlaceList) {
    try {
      wx.setStorageSync(OPTION_CACHE_KEY, {
        savedAt: Date.now(),
        fromPlaceList,
        toPlaceList
      })
    } catch (e) {
    }
  },

  restoreCachedLists() {
    try {
      const cached = wx.getStorageSync(LIST_CACHE_KEY)
      if (!cached || !cached.savedAt) return false
      const refreshAt = this.getRideListRefreshAt()
      if (refreshAt && refreshAt >= Number(cached.savedAt)) return false
      if ((cached.cityKey || DEFAULT_CITY_KEY) !== (this.data.activeCityKey || DEFAULT_CITY_KEY)) return false
      if (Date.now() - Number(cached.savedAt) > LIST_CACHE_TTL) return false

      const carpoolList = (Array.isArray(cached.carpoolList) ? cached.carpoolList : [])
        .map(item => this.decorateTripCommon(item, "carpool"))
        .filter(item => this.shouldShowTrip(item))
      const requestList = (Array.isArray(cached.requestList) ? cached.requestList : [])
        .map(item => this.decorateTripCommon(item, "request"))
        .filter(item => this.shouldShowTrip(item))
      if (!carpoolList.length && !requestList.length) return false

      this.setData({
        originalCarpoolList: carpoolList,
        originalRequestList: requestList,
        loading: false,
        hasLoadedOnce: true
      }, () => this.applyAllFiltersAndGroup())

      this._loadedOnceAt = Number(cached.savedAt) || Date.now()
      return true
    } catch (e) {
      return false
    }
  },

  cacheLoadedLists(carpoolList, requestList) {
    try {
      wx.setStorageSync(LIST_CACHE_KEY, {
        savedAt: Date.now(),
        cityKey: this.data.activeCityKey || DEFAULT_CITY_KEY,
        carpoolList: Array.isArray(carpoolList) ? carpoolList : [],
        requestList: Array.isArray(requestList) ? requestList : []
      })
      wx.removeStorageSync(LIST_REFRESH_KEY)
    } catch (e) {
    }
  },

  getSelectedOption(options, index) {
    if (!Array.isArray(options) || index < 0 || index >= options.length) return null
    return options[index]
  },

  applyFilterOptionData(optionData) {
    const currentFrom = this.getSelectedOption(this.data.fromFilterOptions, this.data.fromFilterIndex)
    const currentTo = this.getSelectedOption(this.data.toFilterOptions, this.data.toFilterIndex)

    const fromIndex = currentFrom ? optionData.fromFilterOptions.indexOf(currentFrom) : -1
    const toIndex = currentTo ? optionData.toFilterOptions.indexOf(currentTo) : -1

    this.setData({
      ...optionData,
      fromFilterIndex: fromIndex >= 0 ? fromIndex : -1,
      toFilterIndex: toIndex >= 0 ? toIndex : -1
    }, () => {
      this.applyShareFilters(true, () => {
        if (this.data.hasLoadedOnce) this.applyAllFiltersAndGroup()
      })
    })
  },

  applyShareFilters(consume, callback) {
    if (!this._initFilterFromShare) {
      if (callback) callback()
      return
    }

    const { from, to, time } = this._initFilterFromShare
    const next = {}

    if (from >= 0 && from < this.data.fromFilterOptions.length) {
      next.fromFilterIndex = from
    }
    if (to >= 0 && to < this.data.toFilterOptions.length) {
      next.toFilterIndex = to
    }
    if (time >= 0 && time < this.data.timeFilterOptions.length) {
      next.timeFilterIndex = time
    }

    const done = () => {
      if (consume) this._initFilterFromShare = null
      if (callback) callback()
    }

    if (Object.keys(next).length) {
      this.setData(next, done)
    } else {
      done()
    }
  },

  goBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) {
      wx.navigateBack()
    } else {
      wx.reLaunch({ url: '/pages/home/home' })
    }
  },

  // =========================
  // 分享（带筛选条件）
  // =========================
  onShareAppMessage() {
    const { fromFilterIndex, toFilterIndex, timeFilterIndex, activeCityKey } = this.data
    const query = `city=${activeCityKey || DEFAULT_CITY_KEY}&from=${fromFilterIndex}&to=${toFilterIndex}&time=${timeFilterIndex}`
    return getApp().withReferralShare({
      title: '拼车/求车线路列表',
      path: `/pages/home/carpoolList/carpoolList?${query}`
    })
  },

  onShareTimeline() {
    const { fromFilterIndex, toFilterIndex, timeFilterIndex, activeCityKey } = this.data
    return getApp().withReferralShare({
      title: '拼车/求车线路列表',
      query: `city=${activeCityKey || DEFAULT_CITY_KEY}&from=${fromFilterIndex}&to=${toFilterIndex}&time=${timeFilterIndex}`
    })
  },

  // =========================
  // 地点库：合并 Departure/Arrival 与 Departure_Request/Arrival_Request
  // =========================
  extractPlacesFromDoc(doc) {
    if (!doc || typeof doc !== "object") return []
    return Object.keys(doc)
      .filter((k) => k && k !== "_id")
      .map((k) => String(k).trim())
      .filter(Boolean)
  },

  uniqNonEmpty(arr) {
    const seen = new Set()
    const out = []
    ;(arr || []).forEach((x) => {
      const s = String(x || "").trim()
      if (!s) return
      if (seen.has(s)) return
      seen.add(s)
      out.push(s)
    })
    return out
  },

  async loadFromToOptionsFromDBMerged() {
    if (this._optionsLoading) return
    this._optionsLoading = true

    try {
      const db = wx.cloud.database()
      const [dep1, arr1, dep2, arr2] = await Promise.all([
        db.collection("Departure").get(),
        db.collection("Arrival").get(),
        db.collection("Departure_Request").get(),
        db.collection("Arrival_Request").get()
      ])

      const depDocs = [...(dep1.data || []), ...(dep2.data || [])]
      const arrDocs = [...(arr1.data || []), ...(arr2.data || [])]

      const fromRaw = depDocs.flatMap((doc) => this.extractPlacesFromDoc(doc))
      const toRaw = arrDocs.flatMap((doc) => this.extractPlacesFromDoc(doc))

      const fromList = this.uniqNonEmpty([...DEFAULT_FROM_PLACES, ...fromRaw])
      const toList = this.uniqNonEmpty([...DEFAULT_TO_PLACES, ...toRaw])

      this.cacheFilterOptions(fromList, toList)
      this.applyFilterOptionData(this.buildFilterOptionData(fromList, toList))
    } catch (e) {
      console.error("loadFromToOptionsFromDBMerged error", e)
      if (!this.data.fromPlaceList.length || !this.data.toPlaceList.length) {
        this.applyFilterOptionData(this.buildFilterOptionData(DEFAULT_FROM_PLACES, DEFAULT_TO_PLACES))
      }
    } finally {
      this._optionsLoading = false
    }
  },

  // =========================
  // 状态刷新 + 列表加载
  // =========================
  async refreshStatusAndReload() {
    await this.loadBothLists({ showLoading: !this.data.hasLoadedOnce })
    this.refreshStatusInBackground(true)
  },

  refreshStatusInBackground(force) {
    if (!this.data.isRideServiceAvailable) return Promise.resolve()
    if (this._statusRefreshing) return Promise.resolve()

    const now = Date.now()
    const last = Number(wx.getStorageSync(STATUS_REFRESH_KEY) || 0)
    if (!force && last && now - last < STATUS_REFRESH_INTERVAL) {
      return Promise.resolve()
    }

    this._statusRefreshing = true
    wx.setStorageSync(STATUS_REFRESH_KEY, now)

    const carpoolIds = (this.data.originalCarpoolList || [])
      .map(item => item && item._id)
      .filter(Boolean)
      .slice(0, 100)
    const requestIds = (this.data.originalRequestList || [])
      .map(item => item && item._id)
      .filter(Boolean)
      .slice(0, 100)
    if (!carpoolIds.length && !requestIds.length) {
      this._statusRefreshing = false
      return Promise.resolve()
    }

    return wx.cloud.callFunction({
      name: "syncTripStatus",
      data: { type: "all", carpoolIds, requestIds }
    }).then((res) => {
      const result = res && res.result ? res.result : {}
      const updatedCount = Number(result.totalUpdated || 0) || (
        Number(result.totalUpdatedCarpool || 0) +
        Number(result.totalUpdatedCarpoolRequest || 0)
      )

      if (updatedCount > 0) {
        return this.loadBothLists({ showLoading: false })
      }
      return null
    }).catch((e) => {
    }).finally(() => {
      this._statusRefreshing = false
    })
  },

  // =========================
  // 时间/日期辅助
  // =========================
  getFirstDeparture(trip) {
    if (!trip || !trip.departures || !trip.departures.length) return null
    return trip.departures[0]
  },

  getTripDateTimeString(trip) {
    const dep = this.getFirstDeparture(trip)
    if (!dep || !dep.date || !dep.time) return ""
    return `${dep.date} ${dep.time}`
  },

  getTripTimestamp(trip) {
    const savedMs = Number(trip && trip.departureAtMs)
    if (Number.isFinite(savedMs) && savedMs > 0) return savedMs

    const dep = this.getFirstDeparture(trip)
    if (!dep || !dep.date || !dep.time) return Number.MAX_SAFE_INTEGER

    const dt = new Date(`${dep.date}T${dep.time}`)
    const ts = dt.getTime()
    return Number.isNaN(ts) ? Number.MAX_SAFE_INTEGER : ts
  },

  getTripExpireTimestamp(trip) {
    const savedMs = Number(trip && (trip.latestDepartureAtMs || trip.departureAtMs))
    if (Number.isFinite(savedMs) && savedMs > 0) return savedMs
    return this.getTripTimestamp(trip)
  },

  sortByDateTime(a, b) {
    const ta = this.getTripTimestamp(a)
    const tb = this.getTripTimestamp(b)

    if (ta !== tb) return ta - tb

    // 时间完全一致时，再按类型稳定排序，但不再强制 carpool 全局在前
    // 这里只是为了结果稳定
    const aType = a && a._type ? a._type : ""
    const bType = b && b._type ? b._type : ""
    return String(aType).localeCompare(String(bType))
  },

  formatMonthDayWeek(dateStr) {
    if (!dateStr) return ""
    const weekMap = ["日", "一", "二", "三", "四", "五", "六"]
    const dObj = new Date(`${dateStr}T00:00:00`)
    if (isNaN(dObj.getTime())) return dateStr
    const m = dObj.getMonth() + 1
    const d = dObj.getDate()
    const w = weekMap[dObj.getDay()]
    return `${m}月${d}日 周${w}`
  },

  formatTimeOnly(timeStr) {
    if (!timeStr) return ""
    return String(timeStr).slice(0, 5)
  },

  normalizeTripStatus(status) {
    const value = String(status || "open").toLowerCase()
    return value
  },

  getTripPriceText(raw) {
    const value = raw && (raw.referencePrice || raw.price || raw.displayPrice)
    return formatRidePriceTag(value)
  },

  decorateTripCommon(trip, type) {
    const dep = this.getFirstDeparture(trip)
    const currentDate = dep && dep.date ? dep.date : ""
    const currentTime = dep && dep.time ? dep.time : ""
    trip.status = this.normalizeTripStatus(trip.status)

    trip._type = type
    trip._date = currentDate
    trip._timeLabel = currentTime ? this.formatTimeOnly(currentTime) : ""

    trip._fromAddress = dep && dep.address ? dep.address : ""
    const firstDest = (trip.destinations || []).find(
      d => d && String(d.address || "").trim()
    )
    trip._toAddress = firstDest ? (firstDest.address || "") : ""
    trip._priceText = this.getTripPriceText(trip)

    if (type === "request") {
      trip._requestPassengerCount =
        typeof trip.passengerCount === "number"
          ? trip.passengerCount
          : (typeof trip.requestPassengerCount === "number"
              ? trip.requestPassengerCount
              : 1)
      trip._rightLabel = "求车线路"
    } else {
      trip._rightLabel = "拼车线路"
    }

    return trip
  },

  async hydrateMissingPriceTexts(carpoolList, requestList) {
    const listPairs = [
      { type: "carpool", items: carpoolList || [] },
      { type: "request", items: requestList || [] }
    ]

    const hasMissingPrice = listPairs.some(pair =>
      pair.items.some(item => item && item._id && !item._priceText)
    )
    if (!hasMissingPrice) return false

    try {
      const res = await wx.cloud.callFunction({
        name: "getTripList",
        data: {
          type: "all",
          limit: LIST_FETCH_LIMIT,
          quick: false,
          cityKey: this.data.activeCityKey || DEFAULT_CITY_KEY,
          cityLabel: this.data.activeCityLabel || DEFAULT_CITY_LABEL,
          cityAliases: this.data.activeCityAliases || []
        }
      })
      const result = res && res.result ? res.result : {}
      if (!result.success) return false

      const data = result.data || {}
      const carpoolFull = Array.isArray(data.carpool) ? data.carpool : (Array.isArray(result.carpoolList) ? result.carpoolList : [])
      const requestFull = Array.isArray(data.request) ? data.request : (Array.isArray(result.requestList) ? result.requestList : [])
      const priceMap = {
        carpool: new Map(),
        request: new Map()
      }

      carpoolFull.forEach(item => {
        const price = this.getTripPriceText(item)
        if (item && item._id && price) priceMap.carpool.set(item._id, price)
      })
      requestFull.forEach(item => {
        const price = this.getTripPriceText(item)
        if (item && item._id && price) priceMap.request.set(item._id, price)
      })

      let changed = false
      listPairs.forEach(pair => {
        pair.items.forEach(item => {
          if (!item || !item._id || item._priceText) return
          const price = priceMap[pair.type].get(item._id)
          if (!price) return
          item._priceText = price
          changed = true
        })
      })

      return changed
    } catch (err) {
      console.warn("hydrateMissingPriceTexts failed:", err)
      return false
    }
  },

  shouldShowTrip(trip) {
    if (!trip) return false

    const status = this.normalizeTripStatus(trip.status)
    if (status === "past") return false

    const ts = this.getTripExpireTimestamp(trip)
    if (!ts || ts === Number.MAX_SAFE_INTEGER) return false

    return ts + TRIP_EXPIRE_GRACE >= Date.now()
  },

  // =========================
  // 拉两类列表 + 排序 + 过滤 + 分组
  // =========================
  async loadBothLists(options = {}) {
    if (!this.data.isRideServiceAvailable) {
      this.setData({
        loading: false,
        hasLoadedOnce: true,
        originalCarpoolList: [],
        originalRequestList: [],
        dayGroups: []
      })
      return Promise.resolve()
    }

    if (this._listLoadingPromise) return this._listLoadingPromise

    let showLoading = options.showLoading !== false && !this.data.hasLoadedOnce
    if (showLoading && this.restoreCachedLists()) {
      showLoading = false
    }

    if (showLoading) {
      this.setData({
        loading: true,
        loadingText: "正在加载附近路线..."
      })
    } else {
      wx.showNavigationBarLoading()
    }

    this._listLoadingPromise = this._loadBothListsImpl(showLoading)
      .finally(() => {
        this._listLoadingPromise = null
        if (!showLoading) wx.hideNavigationBarLoading()
      })

    return this._listLoadingPromise
  },

  async _loadBothListsImpl(showLoading) {
    const requestCityKey = this.data.activeCityKey || DEFAULT_CITY_KEY
    try {
      const cityFilters = {
        cityKey: requestCityKey,
        cityLabel: this.data.activeCityLabel || DEFAULT_CITY_LABEL,
        cityAliases: this.data.activeCityAliases || []
      }
      const res = await wx.cloud.callFunction({
        name: "getTripList",
        data: { type: "all", limit: LIST_FETCH_LIMIT, quick: true, fastOnly: true, ...cityFilters }
      })
      const result = res && res.result ? res.result : {}

      if ((this.data.activeCityKey || DEFAULT_CITY_KEY) !== requestCityKey || !this.data.isRideServiceAvailable) {
        return
      }

      if (!result.success) {
        if (showLoading) {
          showDataError("加载失败", result.errorMsg || "load failed", "拼车列表加载失败，请稍后重试。")
        }
        this.setData({
          loading: false,
          hasLoadedOnce: true,
          originalCarpoolList: [],
          originalRequestList: [],
          dayGroups: []
        })
        return
      }

      const data = result.data || {}
      const carpoolList = Array.isArray(data.carpool) ? data.carpool : []
      const requestList = Array.isArray(data.request) ? data.request : []

      carpoolList.sort((a, b) => this.sortByDateTime(a, b))
      requestList.sort((a, b) => this.sortByDateTime(a, b))

      const decoratedCarpool = carpoolList
        .map(x => this.decorateTripCommon(x, "carpool"))
        .filter(x => this.shouldShowTrip(x))

      const decoratedRequest = requestList
        .map(x => this.decorateTripCommon(x, "request"))
        .filter(x => this.shouldShowTrip(x))

      this.setData({
        originalCarpoolList: decoratedCarpool,
        originalRequestList: decoratedRequest,
        loading: false,
        hasLoadedOnce: true
      })

      this._loadedOnceAt = Date.now()
      this.cacheLoadedLists(decoratedCarpool, decoratedRequest)
      this.applyAllFiltersAndGroup()
      this.hydrateMissingPriceTexts(decoratedCarpool, decoratedRequest).then((changed) => {
        if (!changed) return
        if ((this.data.activeCityKey || DEFAULT_CITY_KEY) !== requestCityKey || !this.data.isRideServiceAvailable) return
        this.setData({
          originalCarpoolList: decoratedCarpool,
          originalRequestList: decoratedRequest
        })
        this.cacheLoadedLists(decoratedCarpool, decoratedRequest)
        this.applyAllFiltersAndGroup()
      })
    } catch (err) {
      console.error("loadBothLists error:", err)
      if ((this.data.activeCityKey || DEFAULT_CITY_KEY) !== requestCityKey || !this.data.isRideServiceAvailable) {
        return
      }
      if (showLoading) showDataError("加载失败", err, "拼车列表加载失败，请稍后重试。")
      this.setData({
        loading: false,
        hasLoadedOnce: true
      })
    }
  },

  async fetchListFast(meta) {
    const data = await this.fetchListFromCloud(meta)
    return { source: "cloud", data }
  },

  async fetchListFromCloud(meta) {
    const res = await wx.cloud.callFunction({
      name: meta.name,
      data: meta.data
    })

    const result = res && res.result ? res.result : {}
    if (!result.success) {
      throw new Error(result.errorMsg || result.error || `${meta.name} success=false`)
    }

    return Array.isArray(result.data) ? result.data : []
  },

  // =========================
  // 地址匹配（Fort Lee / Columbia / 普通包含匹配）
  // =========================
  isFortLee(address) {
    if (!address) return false
    const s = String(address)
    return (
      s.indexOf("Fort Lee") >= 0 ||
      s.indexOf("Fort Lee 核心区") >= 0 ||
      s.indexOf("Fort Lee 全区域") >= 0
    )
  },

  isColumbia(address) {
    if (!address) return false
    const s = String(address)
    return (
      s.indexOf("哥大") >= 0 ||
      s.indexOf("Columbia") >= 0
    )
  },

  isPresetPlace(address) {
    return this.isFortLee(address) || this.isColumbia(address)
  },

  makePlaceMatcher(place) {
    const p = String(place || "").trim()
    if (!p) return () => false
    if (p.indexOf("Fort Lee") >= 0) return (addr) => this.isFortLee(addr)
    if (p.indexOf("哥大") >= 0 || p.indexOf("Columbia") >= 0) {
      return (addr) => this.isColumbia(addr)
    }
    return (addr) => !!addr && String(addr).indexOf(p) >= 0
  },

  tripMatchesCity(trip, city) {
    if (!trip || !city || !city.key) return true
    const storedKey = String(trip.cityKey || trip.routeCityKey || "").trim()
    if (storedKey) return storedKey === city.key

    const texts = [
      trip.cityLabel,
      trip.routeCityLabel,
      trip.region,
      trip.bigregion,
      trip.address
    ]

    ;(trip.departures || []).forEach(item => {
      texts.push(item && item.address)
      texts.push(item && item.name)
      texts.push(item && item.displayName)
    })
    ;(trip.destinations || []).forEach(item => {
      texts.push(item && item.address)
      texts.push(item && item.name)
      texts.push(item && item.displayName)
    })

    return texts.some(text => textMatchesCity(text, city))
  },

  buildAnyFromMatchers() {
    return (this.data.fromPlaceList || []).map((x) => this.makePlaceMatcher(x))
  },

  buildAnyToMatchers() {
    return (this.data.toPlaceList || []).map((x) => this.makePlaceMatcher(x))
  },

  rebuildToOptionsByFrom(selectedFrom) {
    const baseTo = this.data.toPlaceList || []
    const baseAll = ["全部", ...baseTo, "其他"]

    if (!this.data.enableToLinkage) return baseAll
    if (!selectedFrom || selectedFrom === "全部" || selectedFrom === "其他") {
      return baseAll
    }

    const matchFrom = this.makePlaceMatcher(selectedFrom)
    const toSet = new Set()

    const all = [
      ...(this.data.originalCarpoolList || []),
      ...(this.data.originalRequestList || [])
    ]

    all.forEach((trip) => {
      const deps = trip && trip.departures ? trip.departures : []
      const dests = trip && trip.destinations ? trip.destinations : []
      const hasFrom = deps.some((d) => matchFrom(d && d.address))
      if (!hasFrom) return
      dests.forEach((d) => {
        const addr = d && d.address ? String(d.address).trim() : ""
        if (addr) toSet.add(addr)
      })
    })

    const narrowed = Array.from(toSet)
    if (narrowed.length === 0) return baseAll
    return ["全部", ...narrowed, "其他"]
  },

  // =========================
  // 统一筛选 + 分组
  // 改成：同一天内 carpool / request 合并成一个 items，并严格按时间排序
  // =========================
  applyAllFiltersAndGroup() {
    const {
      originalCarpoolList,
      originalRequestList,
      timeFilterIndex,
      todayDateStr,
      tomorrowDateStr,
      fromFilterOptions,
      fromFilterIndex,
      toFilterOptions,
      toFilterIndex
    } = this.data
    const activeCity = {
      key: this.data.activeCityKey || DEFAULT_CITY_KEY,
      label: this.data.activeCityLabel || DEFAULT_CITY_LABEL,
      aliases: this.data.activeCityAliases || []
    }

    const filterOneList = (list) => {
      let filtered = (list || []).filter(trip => this.tripMatchesCity(trip, activeCity))

      // 时间筛选
      if (timeFilterIndex >= 0) {
        filtered = filtered.filter((trip) => {
          const dep = this.getFirstDeparture(trip)
          const d = dep && dep.date ? dep.date : ""
          if (!d) return false
          if (timeFilterIndex === 0) return d === todayDateStr
          if (timeFilterIndex === 1) return d === tomorrowDateStr
          return d !== todayDateStr && d !== tomorrowDateStr
        })
      }

      const addressFilteringActive = fromFilterIndex >= 0 || toFilterIndex >= 0
      const fromSelected = fromFilterIndex >= 0 ? fromFilterOptions[fromFilterIndex] : null
      const toSelected = toFilterIndex >= 0 ? toFilterOptions[toFilterIndex] : null
      const fromLastIndex = fromFilterOptions.length - 1
      const toLastIndex = toFilterOptions.length - 1
      const anyFromMatchers = this.buildAnyFromMatchers()
      const anyToMatchers = this.buildAnyToMatchers()

      filtered = filtered.filter((trip) => {
        const departures = trip.departures || []
        const destinations = trip.destinations || []

        if (addressFilteringActive) {
          const depOK = departures.some(
            d => d && d.date && d.time && String(d.address || "").trim()
          )
          const destOK = destinations.some(
            d => d && String(d.address || "").trim()
          )
          if (!depOK || !destOK) return false
        }

        let passFrom = true
        if (fromSelected !== null && fromSelected !== "全部") {
          if (fromFilterIndex === fromLastIndex) {
            passFrom = departures.some((d) => {
              const addr = d && d.address ? String(d.address).trim() : ""
              if (!addr) return false
              if (!anyFromMatchers || anyFromMatchers.length === 0) {
                return !this.isPresetPlace(addr)
              }
              const matchesAny = anyFromMatchers.some((fn) => fn(addr))
              return !matchesAny
            })
          } else {
            const matchFrom = this.makePlaceMatcher(fromSelected)
            passFrom = departures.some((d) => matchFrom(d && d.address))
          }
        }

        let passTo = true
        if (toSelected !== null && toSelected !== "全部") {
          if (toFilterIndex === toLastIndex) {
            passTo = destinations.some((d) => {
              const addr = d && d.address ? String(d.address).trim() : ""
              if (!addr) return false
              if (!anyToMatchers || anyToMatchers.length === 0) {
                return !this.isPresetPlace(addr)
              }
              const matchesAny = anyToMatchers.some((fn) => fn(addr))
              return !matchesAny
            })
          } else {
            const matchTo = this.makePlaceMatcher(toSelected)
            passTo = destinations.some((d) => matchTo(d && d.address))
          }
        }

        return passFrom && passTo
      })

      filtered.sort((a, b) => this.sortByDateTime(a, b))
      return filtered
    }

    const carpoolFiltered = filterOneList(originalCarpoolList)
    const requestFiltered = filterOneList(originalRequestList)

    // 合并两类数据，统一按时间排序
    const merged = [...carpoolFiltered, ...requestFiltered].sort((a, b) =>
      this.sortByDateTime(a, b)
    )

    const map = new Map()

    merged.forEach((trip) => {
      const date = trip._date || ""
      if (!date) return

      if (!map.has(date)) {
        map.set(date, {
          date,
          dateLabel: this.formatMonthDayWeek(date),
          items: []
        })
      }

      const group = map.get(date)
      group.items.push(trip)
    })

    const groups = Array.from(map.values())
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""))

    this.setData({ dayGroups: groups })
  },

  // =========================
  // 筛选事件
  // =========================
  onFromFilterChange(e) {
    const index = Number(e.detail.value)
    const fromSelected = this.data.fromFilterOptions[index] || "全部"
    const nextToOptions = this.rebuildToOptionsByFrom(fromSelected)

    let nextToIndex = this.data.toFilterIndex
    if (nextToIndex >= 0 && nextToIndex > nextToOptions.length - 1) {
      nextToIndex = 0
    }

    this.setData(
      {
        fromFilterIndex: index,
        toFilterOptions: nextToOptions,
        toFilterIndex: nextToIndex
      },
      () => this.applyAllFiltersAndGroup()
    )
  },

  onToFilterChange(e) {
    const index = Number(e.detail.value)
    this.setData({ toFilterIndex: index }, () => this.applyAllFiltersAndGroup())
  },

  onTimeFilterChange(e) {
    const index = Number(e.detail.value)
    this.setData({ timeFilterIndex: index }, () => this.applyAllFiltersAndGroup())
  },

  onResetFilter() {
    const fromOptions = ["全部", ...(this.data.fromPlaceList || []), "其他"]
    const toOptions = ["全部", ...(this.data.toPlaceList || []), "其他"]

    this.setData(
      {
        fromFilterOptions: fromOptions,
        fromFilterIndex: -1,
        toFilterOptions: toOptions,
        toFilterIndex: -1,
        timeFilterIndex: -1
      },
      () => this.applyAllFiltersAndGroup()
    )
  },

  async onPullDownRefresh() {
    this.setData({ refresherTriggered: true })
    try {
      if (this.data.isRideServiceAvailable) {
        await this.loadBothLists({ showLoading: false })
        this.refreshStatusInBackground(true)
      } else {
        this.setData({
          loading: false,
          hasLoadedOnce: true,
          dayGroups: [],
          originalCarpoolList: [],
          originalRequestList: []
        })
      }
    } finally {
      this.setData({ refresherTriggered: false })
      wx.stopPullDownRefresh()
    }
  },

  // =========================
  // 跳转详情
  // =========================
  findDetailItem(id, type) {
    const fromGroups = []
    ;(this.data.dayGroups || []).forEach(group => {
      if (Array.isArray(group.items)) fromGroups.push(...group.items)
    })

    const pools = [
      fromGroups,
      type === "request" ? this.data.originalRequestList : this.data.originalCarpoolList,
      this.data.originalCarpoolList,
      this.data.originalRequestList
    ]

    for (const list of pools) {
      const item = (list || []).find(x => x && x._id === id)
      if (item) return item
    }

    return null
  },

  openDetailPage(url, id, type) {
    const item = this.findDetailItem(id, type)
    const preview = item ? { id, type, item, savedAt: Date.now() } : null

    if (preview) {
      try {
        wx.setStorageSync(DETAIL_PREVIEW_KEY, preview)
      } catch (e) {
      }
    }

    wx.navigateTo({
      url,
      success: (res) => {
        if (preview && res.eventChannel) {
          res.eventChannel.emit("routePreview", preview)
        }
      }
    })
  },

  goTripDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    this.openDetailPage(`/pages/home/tripDetail/tripDetail?id=${id}`, id, "carpool")
  },

  goRequestDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    this.openDetailPage(`/pages/home/requestDetail/requestDetail?id=${id}`, id, "request")
  },

  // =========================
  // 如果你的 wxml 改成遍历 group.items，就用这个
  // =========================
  goItemDetail(e) {
    const id = e.currentTarget.dataset.id
    const type = e.currentTarget.dataset.type
    if (!id) return

    if (type === "request") {
      this.openDetailPage(`/pages/home/requestDetail/requestDetail?id=${id}`, id, "request")
    } else {
      this.openDetailPage(`/pages/home/tripDetail/tripDetail?id=${id}`, id, "carpool")
    }
  }
})
