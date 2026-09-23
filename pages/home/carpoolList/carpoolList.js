const { showDataError } = require("../../../utils/error")
const rideTime = require("../../../utils/rideTime")
const research = require("../../../utils/researchParticipation")
const rideTelemetry = require("../../../utils/rideTelemetry")
const { formatRidePriceTag, markRideListStale } = require("../../../utils/tripManage")
const rideCalendarPicker = require("../../../utils/rideCalendarPicker")
const { getCachedRideAddressConfig, loadRideAddressConfig, getStaticRideAddressConfig } = require("../../../utils/rideAddressConfig")
const { makeRidePlaceMatcher, shortRidePlaceLabel, placeIdentity, resolvePlaceId, FIXED_PLACES } = require("../../../utils/ridePlaceOptions")
const placeRecommendations = require("../../../utils/placeRecommendations")
const placePickerTelemetry = require("../../../utils/placePickerTelemetry")
const {
  DEFAULT_CITY_KEY,
  DEFAULT_CITY_LABEL,
  DEFAULT_CITY_TREE,
  RIDE_DEFAULT_CITY_KEY,
  RIDE_SERVICE_CITY_LABEL,
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
  normalizeRideServiceCityKey,
  rideCityKeysMatch,
  setStoredCitySnapshot,
  textMatchesCity
} = require("../../../utils/cityTree")

const LIST_REFRESH_INTERVAL = 30 * 1000
const HIDE_FULL_TRIPS_KEY = "carpoolListHideFullTripsV1"
const STATUS_REFRESH_KEY = "carpoolListStatusRefreshAtV1"
const STATUS_REFRESH_INTERVAL = 10 * 60 * 1000
const TRIP_EXPIRE_GRACE = 30 * 60 * 1000
const LIST_CACHE_KEY = "carpoolListDataV1"
const LIST_CACHE_TTL = LIST_REFRESH_INTERVAL
const LIST_REFRESH_KEY = "rideListShouldRefreshAt"
const DETAIL_PREVIEW_KEY = "carpoolDetailPreviewV1"
const RIDE_CITY_PICKER_HINT = "找不到你的城市？可以联系开发者请求开通该区域。当前优先服务纽约/新泽西。"
const RIDE_DEFAULT_CITY_SNAPSHOT = getCitySnapshot(DEFAULT_CITY_TREE, RIDE_DEFAULT_CITY_KEY)


Page({
  ...rideCalendarPicker.methods,
  onOpenCalendar() { rideTelemetry.stopList(this); return rideCalendarPicker.methods.onOpenCalendar.call(this) },
  onCloseCalendar() { const result = rideCalendarPicker.methods.onCloseCalendar.call(this); rideTelemetry.observeList(this); return result },

  data: {
    loading: true,
    hasLoadedOnce: false,
    loadingText: "正在加载附近路线...",
    refresherTriggered: false,

    statusBarHeight: 80,
    pageTitle: "线路列表",
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

    // 筛选
    fromFilterOptions: ["全部", "其他"],
    fromFilterIndex: -1,
    selectedFromPlace: "",
    fromFilterLabel: "不限出发地",
    toFilterOptions: ["全部", "其他"],
    toFilterIndex: -1,
    selectedToPlace: "",
    toFilterLabel: "不限目的地",
    enableToLinkage: false,
    routeTypeFilter: "all",
    selectedDate: "",
    dateFilterLabel: "选日期",
    hasActiveFilters: false,
    placePickerVisible: false,
    placePickerTitle: "选择出发地",
    placeSearchKeyword: "",
    placePickerOptions: [],
    refineFiltersVisible: false,
    moreFilterCount: 0,
    ...rideCalendarPicker.data,

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
    // 有空座/求车路线在前；是否显示末尾的满员车辆是长期本地偏好。
    dayGroups: [],
    fullTripCount: 0,
    hideFullTrips: true,
    hasMoreDays: false,
    nextPageDate: "",
    loadingMoreDays: false,
    loadMoreError: ""
  },

  _listLoadingPromise: null,
  _optionsLoadingPromise: null,
  _statusRefreshing: false,
  _loadedOnceAt: 0,
  _initFilterFromShare: null,

  onLoad(options) {
    this._listDisposed = false
    if (typeof research.subscribe === 'function') this._researchUnsubscribe = research.subscribe(state => {
      if (state.participating && (!this._rideResultSet || this._rideResultSet.scope !== research.getCollectionScope()) && this.data.hasLoadedOnce) {
        Promise.resolve().then(() => this.recordResearchResult(this._researchSearch, this.data.dayGroups || []))
      }
    })
    this.restoreFullTripPreference()
    const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const storedCity = getStoredCitySnapshot(RIDE_CITY_STORAGE_KEY, DEFAULT_CITY_TREE, RIDE_DEFAULT_CITY_KEY)
    this._applyCityUi((options && options.city) || storedCity.key || RIDE_DEFAULT_CITY_KEY, { persist: false })

    // 允许分享
    wx.showShareMenu({
      withShareTicket: true,
      menus: ['shareAppMessage', 'shareTimeline']
    })

    // 新分享使用地点文字；旧分享的索引在地点配置加载后继续兼容。
    this._initFilterFromShare = this.readShareFilters(options || {})

    const cachedOptions = this.getCachedFilterOptions()
    const defaultOptions = cachedOptions || this.buildFilterOptionData([], [])

    this.setData({
      statusBarHeight: info.statusBarHeight,
      ...this.getFilterDateData(),
      ...defaultOptions
    }, () => {
      this.applyShareFilters(!!cachedOptions, () => {
        if (!this.data.isRideServiceAvailable) {
          this.setData({
            loading: false,
            hasLoadedOnce: true,
            originalCarpoolList: [],
            originalRequestList: [],
            dayGroups: [],
            fullTripCount: 0,
          })
          setTimeout(() => this.loadCityTreeFromCloud(), 120)
          if (!cachedOptions) setTimeout(() => this.loadFilterPlaceConfig(), 200)
          return
        }
        this.loadBothLists({ showLoading: true }).then(() => {
          setTimeout(() => this.loadCityTreeFromCloud(), 120)
          if (!cachedOptions) setTimeout(() => this.loadFilterPlaceConfig(), 200)
          setTimeout(() => this.refreshStatusInBackground(false), 800)
        })
      })
    })
  },

  onShow() {
    if (this.data.placePickerVisible && this._placeContext && this._placeContext.viewerKey !== this.getListViewerKey()) this.onClosePlacePicker()
    this._researchVisible = true
    rideTelemetry.observeList(this)
    this.setData(this.getFilterDateData())
    if (this.data.calendarVisible) this.loadCalendarCounts()
    // 首屏由 onLoad 负责；返回时复用短缓存，身份/路线变更会立即失效。
    if (!this.data.hasLoadedOnce) return
    this.loadBothLists({ showLoading: false })
  },

  onHide() {
    placePickerTelemetry.closePlacePicker(this._placeSession, "page_hide")
    if (this.data.placePickerVisible) this.setData({ placePickerVisible: false })
    this._researchVisible = false
    rideTelemetry.stopList(this)
  },

  onUnload() {
    placePickerTelemetry.closePlacePicker(this._placeSession, "page_hide")
    this._listDisposed = true
    this._researchSearch = null
    rideTelemetry.stopList(this)
    if (this._researchUnsubscribe) this._researchUnsubscribe()
  },

  getListViewerKey() {
    try {
      return wx.getStorageSync("isGuest") ? "guest" : String(wx.getStorageSync("openid") || "guest")
    } catch (e) {
      return "guest"
    }
  },

  getListRequestKey() {
    return JSON.stringify([
      this.data.activeCityKey || RIDE_DEFAULT_CITY_KEY,
      this.getListViewerKey(),
      this.getRideListRefreshAt(),
      this.getDateRangeKey()
    ])
  },

  shiftDate(date, days) {
    return rideTime.shiftRideDate(date, days)
  },

  getInitialDatePage() {
    const today = this.data.todayDateStr || this.getFilterDateData().todayDateStr
    const exactDate = !!this.data.selectedDate || this.data.timeFilterIndex === 0 || this.data.timeFilterIndex === 1
    const startDate = this.data.selectedDate || (this.data.timeFilterIndex === 1
      ? this.shiftDate(today, 1) : this.data.timeFilterIndex === 2 ? this.shiftDate(today, 2) : today)
    return { startDate, endDateExclusive: this.shiftDate(startDate, exactDate ? 1 : 2), exactDate }
  },

  getDateRangeKey() {
    return JSON.stringify(this.getInitialDatePage())
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

  _applyCityUi(cityKey = RIDE_DEFAULT_CITY_KEY, options = {}) {
    const cityTree = normalizeCityTree(options.cityTree || this.data.cityTree || DEFAULT_CITY_TREE)
    const snapshot = getCitySnapshot(cityTree, normalizeRideDisplayCityKey(cityKey || RIDE_DEFAULT_CITY_KEY))
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
      isRideServiceAvailable: isRideServiceCityKey(snapshot.key),
      rideDemandRequested: false
    }

    if (options.persist !== false) setStoredCitySnapshot(RIDE_CITY_STORAGE_KEY, snapshot)
    this.setData(update)
    return snapshot
  },

  async loadCityTreeFromCloud() {
    try {
      const tree = await loadCityTreeConfig()
  
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
    rideTelemetry.stopList(this)
    const cityTree = this.data.cityTree || DEFAULT_CITY_TREE
    const cityPickerGroups = getCountryGroups(
      cityTree,
      this.data.activeCityCountryCode || "US",
      this.data.activeCityKey || RIDE_DEFAULT_CITY_KEY
    )
    this.setData({
      cityPickerVisible: true,
      placePickerVisible: false,
      refineFiltersVisible: false,
      calendarVisible: false,
      citySearchKeyword: "",
      cityPickerGroups,
      cityPickerHasResults: cityGroupsHaveResults(cityPickerGroups)
    })
  },

  onCityPickerCancel() {
    this.setData({ cityPickerVisible: false, citySearchKeyword: "" }, () => this.resumeResearchList())
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
    const serviceAvailable = isRideServiceCityKey(snapshot.key)
    this.clearListCache()
    this.setData({
      cityPickerVisible: false,
      citySearchKeyword: "",
      hasMoreDays: false,
      nextPageDate: "",
      loadMoreError: "",
      dayGroups: [],
      fullTripCount: 0,
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
    const cached = getCachedRideAddressConfig()
    return cached ? this.buildFilterOptionData(cached.fromPlaces, cached.toPlaces) : null
  },

  restoreCachedLists() {
    try {
      const cached = wx.getStorageSync(LIST_CACHE_KEY)
      if (!cached || cached.version !== 2 || !cached.savedAt || cached.rangeKey !== this.getDateRangeKey()) return false
      if (cached.hasMoreDays && !this.isValidFilterDate(cached.nextPageDate)) return false
      if (cached.viewerKey !== this.getListViewerKey()) return false
      if (Number(cached.revision || 0) !== this.getRideListRefreshAt()) return false
      if (!rideCityKeysMatch(cached.cityKey || DEFAULT_CITY_KEY, this.data.activeCityKey || RIDE_DEFAULT_CITY_KEY)) return false
      const age = Date.now() - Number(cached.savedAt)
      if (!Number.isFinite(age) || age < 0 || age >= LIST_CACHE_TTL) return false

      const carpoolList = (Array.isArray(cached.carpoolList) ? cached.carpoolList : [])
        .map(item => this.decorateTripCommon(item, "carpool"))
        .filter(item => this.shouldShowTrip(item))
      const requestList = (Array.isArray(cached.requestList) ? cached.requestList : [])
        .map(item => this.decorateTripCommon(item, "request"))
        .filter(item => this.shouldShowTrip(item))

      this._researchResultSource = 'cache'

      this.setData({
        originalCarpoolList: carpoolList,
        originalRequestList: requestList,
        loading: false,
        hasLoadedOnce: true,
        hasMoreDays: cached.hasMoreDays === true,
        nextPageDate: cached.nextPageDate || "",
        loadingMoreDays: false,
        loadMoreError: ""
      }, () => this.applyAllFiltersAndGroup())

      this._loadedOnceAt = Number(cached.savedAt) || Date.now()
      this._loadedListKey = this.getListRequestKey()
      this._loadedViewerKey = this.getListViewerKey()
      return true
    } catch (e) {
      return false
    }
  },

  cacheLoadedLists(carpoolList, requestList, request) {
    try {
      wx.setStorageSync(LIST_CACHE_KEY, {
        version: 2,
        rangeKey: request.rangeKey,
        savedAt: request.startedAt,
        viewerKey: request.viewerKey,
        revision: request.revision,
        cityKey: normalizeRideServiceCityKey(this.data.activeCityKey || RIDE_DEFAULT_CITY_KEY),
        hasMoreDays: this.data.hasMoreDays,
        nextPageDate: this.data.nextPageDate,
        carpoolList: Array.isArray(carpoolList) ? carpoolList : [],
        requestList: Array.isArray(requestList) ? requestList : []
      })
    } catch (e) {
    }
  },

  getSelectedOption(options, index) {
    if (!Array.isArray(options) || index < 0 || index >= options.length) return null
    return options[index]
  },

  getFilterDateData(now = new Date()) {
    return rideTime.getRideDateData(now)
  },

  normalizeFilterPlace(value) {
    const place = String(value == null ? "" : value).trim().slice(0, 200)
    return place === "全部" ? "" : shortRidePlaceLabel(place)
  },

  getSelectedFilterPlace(field) {
    const prefix = field === "to" ? "to" : "from"
    const selected = field === "to" ? this.data.selectedToPlace : this.data.selectedFromPlace
    return this.normalizeFilterPlace(selected || this.getSelectedOption(this.data[`${prefix}FilterOptions`], this.data[`${prefix}FilterIndex`]))
  },

  getAvailablePlaceOptions(field, optionData = this.data, selectedPlace) {
    const isTo = field === "to"
    const configured = optionData[isTo ? "toPlaceList" : "fromPlaceList"] || []
    const counterpartPlaceId = resolvePlaceId(this.getSelectedFilterPlace(isTo ? "from" : "to"))
    const suggestions = placeRecommendations.getCachedPlaceRecommendations({ cityKey: this.data.activeCityKey || RIDE_DEFAULT_CITY_KEY,
      viewerKey: this.getListViewerKey(), field: isTo ? 'destination' : 'departure', mode: 'filter', counterpartPlaceId })
    const selected = selectedPlace == null ? this.getSelectedFilterPlace(field) : selectedPlace
    const places = this.uniqNonEmpty([...configured, ...suggestions.places.map(place => place.value), selected])
      .filter(place => place !== "全部" && place !== "其他")
    return ["全部", ...places, "其他"]
  },

  syncFilterUi() {
    const selectedFromPlace = this.getSelectedFilterPlace("from")
    const selectedToPlace = this.getSelectedFilterPlace("to")
    const fromFilterOptions = this.getAvailablePlaceOptions("from", this.data, selectedFromPlace)
    const toFilterOptions = this.getAvailablePlaceOptions("to", this.data, selectedToPlace)
    const selectedDate = this.data.selectedDate
    const dateFilterLabel = selectedDate
      ? `${Number(selectedDate.slice(5, 7))}月${Number(selectedDate.slice(8, 10))}日`
      : (this.data.timeFilterIndex === 2 ? "其他日期" : "选日期")
    this.setData({
      selectedFromPlace,
      selectedToPlace,
      fromFilterOptions,
      toFilterOptions,
      fromFilterIndex: selectedFromPlace ? fromFilterOptions.indexOf(selectedFromPlace) : -1,
      toFilterIndex: selectedToPlace ? toFilterOptions.indexOf(selectedToPlace) : -1,
      fromFilterLabel: shortRidePlaceLabel(selectedFromPlace) || "不限出发地",
      toFilterLabel: shortRidePlaceLabel(selectedToPlace) || "不限目的地",
      dateFilterLabel,
      moreFilterCount: Number(!!(selectedDate || this.data.timeFilterIndex >= 0)) + Number(this.data.routeTypeFilter !== "all"),
      hasActiveFilters: !!(selectedFromPlace || selectedToPlace || selectedDate || this.data.timeFilterIndex >= 0 || this.data.routeTypeFilter !== "all")
    })
    if (this.data.placePickerVisible) this.updatePlacePickerOptions()
  },

  applyFilterOptionData(optionData) {
    const currentFrom = this.getSelectedFilterPlace("from")
    const currentTo = this.getSelectedFilterPlace("to")
    const fromFilterOptions = this.getAvailablePlaceOptions("from", optionData, currentFrom)
    const toFilterOptions = this.getAvailablePlaceOptions("to", optionData, currentTo)

    this.setData({
      ...optionData,
      fromFilterOptions,
      toFilterOptions,
      selectedFromPlace: currentFrom,
      selectedToPlace: currentTo,
      fromFilterIndex: currentFrom ? fromFilterOptions.indexOf(currentFrom) : -1,
      toFilterIndex: currentTo ? toFilterOptions.indexOf(currentTo) : -1
    }, () => {
      this.applyShareFilters(true, () => {
        if (this.data.hasLoadedOnce) this.applyAllFiltersAndGroup()
        if (this.data.calendarVisible) this.loadCalendarCounts()
      })
    })
  },

  applyShareFilters(consume, callback) {
    if (!this._initFilterFromShare) {
      this.syncFilterUi()
      if (callback) callback()
      return
    }

    const { from, to, time, fromPlace, toPlace, date, type } = this._initFilterFromShare
    const next = {}
    const legacyOptions = ["", "Fort Lee", "哥大"]
    const ambiguousLegacy = (fromPlace == null && from >= legacyOptions.length) || (toPlace == null && to >= legacyOptions.length)
    if (ambiguousLegacy && consume && !this._legacyPlaceNoticeShown) {
      this._legacyPlaceNoticeShown = true
      if (typeof wx.showToast === 'function') wx.showToast({ title: "旧分享地点已更新，请重新选择", icon: "none" })
    }

    if (fromPlace != null) {
      next.selectedFromPlace = fromPlace
      next.fromFilterIndex = -1
    } else if (from >= 0) {
      next.selectedFromPlace = legacyOptions[from] || ""
      next.fromFilterIndex = -1
    }
    if (toPlace != null) {
      next.selectedToPlace = toPlace
      next.toFilterIndex = -1
    } else if (to >= 0) {
      next.selectedToPlace = legacyOptions[to] || ""
      next.toFilterIndex = -1
    }
    if (time >= 0 && time < this.data.timeFilterOptions.length) {
      next.timeFilterIndex = time
    }
    next.selectedDate = date
    next.routeTypeFilter = type

    const done = () => {
      if (consume) this._initFilterFromShare = null
      this.syncFilterUi()
      if (callback) callback()
    }

    if (Object.keys(next).length) {
      this.setData(next, done)
    } else {
      done()
    }
  },

  isValidFilterDate(value) {
    return rideTime.isValidRideDate(value)
  },

  readShareFilters(options) {
    const decode = value => {
      try { return decodeURIComponent(String(value)) } catch (e) { return String(value) }
    }
    const date = options.date == null ? "" : decode(options.date)
    return {
      from: options.from != null ? Number(options.from) : -1,
      to: options.to != null ? Number(options.to) : -1,
      time: options.time != null ? Number(options.time) : -1,
      fromPlace: FIXED_PLACES.some(item => item.placeId === options.fromPlaceId) ? shortRidePlaceLabel(options.fromPlaceId) : (options.fromPlace == null ? null : this.normalizeFilterPlace(decode(options.fromPlace))),
      toPlace: FIXED_PLACES.some(item => item.placeId === options.toPlaceId) ? shortRidePlaceLabel(options.toPlaceId) : (options.toPlace == null ? null : this.normalizeFilterPlace(decode(options.toPlace))),
      date: this.isValidFilterDate(date) ? date : "",
      type: ["carpool", "request"].includes(options.type) ? options.type : "all"
    }
  },

  getFilterShareQuery() {
    const values = {
      city: this.data.activeCityKey || RIDE_DEFAULT_CITY_KEY,
      fromPlace: this.getSelectedFilterPlace("from"),
      toPlace: this.getSelectedFilterPlace("to"),
      fromPlaceId: resolvePlaceId(this.getSelectedFilterPlace("from")),
      toPlaceId: resolvePlaceId(this.getSelectedFilterPlace("to")),
      date: this.data.selectedDate || "",
      time: this.data.timeFilterIndex,
      type: this.data.routeTypeFilter
    }
    return Object.keys(values).map(key => `${key}=${encodeURIComponent(values[key])}`).join("&")
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
    return getApp().withReferralShare({
      title: '线路列表',
      path: `/pages/home/carpoolList/carpoolList?${this.getFilterShareQuery()}`
    })
  },

  onShareTimeline() {
    return getApp().withReferralShare({
      title: '线路列表',
      query: this.getFilterShareQuery()
    })
  },

  // =========================
  // 固定地点与发布页共享 5 分钟配置缓存。
  // =========================
  uniqNonEmpty(arr) {
    const seen = new Set()
    const out = []
    ;(arr || []).forEach((x) => {
      const s = shortRidePlaceLabel(String(x || "").trim())
      if (!s) return
      const identity = placeIdentity(s)
      if (seen.has(identity)) return
      seen.add(identity)
      out.push(s)
    })
    return out
  },

  loadFilterPlaceConfig() {
    if (this._listDisposed) return Promise.resolve()
    if (this._optionsLoadingPromise) return this._optionsLoadingPromise
    this._optionsLoadingPromise = loadRideAddressConfig().then(config => {
      if (!this._listDisposed) this.applyFilterOptionData(this.buildFilterOptionData(config.fromPlaces, config.toPlaces))
    }).catch(error => {
      // Keep the visible options and selection if a hot update is temporarily unavailable.
      console.error("loadFilterPlaceConfig", error)
    }).finally(() => { this._optionsLoadingPromise = null })
    return this._optionsLoadingPromise
  },

  // =========================
  // 状态刷新 + 列表加载
  // =========================
  async refreshStatusAndReload() {
    await this.loadBothLists({ showLoading: !this.data.hasLoadedOnce, force: true })
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
        markRideListStale()
        return Promise.all([
          this.loadBothLists({ showLoading: false, force: true }),
          this.data.calendarVisible ? this.loadCalendarCounts() : Promise.resolve()
        ])
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

    const ts = rideTime.parseRideDateTime(dep.date, dep.time)
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
    if (!rideTime.isValidRideDate(dateStr)) return dateStr
    const [, m, d] = dateStr.split("-").map(Number)
    const w = weekMap[rideTime.getRideWeekday(dateStr)]
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
      trip._rightLabel = "乘客线路"
    } else {
      trip._rightLabel = "司机线路"
      const availableSeats = this.getAvailableSeatCount(trip)
      const isFull = this.isFullCarpool(trip)
      trip._seatAvailability = isFull ? "full"
        : availableSeats == null ? "unknown"
        : availableSeats === 1 ? "last"
        : availableSeats === 2 ? "limited" : "available"
      trip._seatLabel = isFull ? "已满" : `余位 ${availableSeats == null ? "—" : availableSeats}`
    }

    return trip
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
    if (this._listDisposed) return
    if (!this.data.isRideServiceAvailable) {
      this.setData({
        loading: false,
        hasLoadedOnce: true,
        originalCarpoolList: [],
        originalRequestList: [],
        dayGroups: [],
        fullTripCount: 0,
        hasMoreDays: false,
        nextPageDate: "",
        loadingMoreDays: false,
        loadMoreError: ""
      })
      return Promise.resolve()
    }

    const key = this.getListRequestKey()
    if (this._listLoadingPromise && this._listLoadingKey === key) return this._listLoadingPromise
    if (!options.force && this._listMoreRequest && this._listMoreRequest.key === key) return this._moreLoadingPromise
    if (this._loadedViewerKey && this._loadedViewerKey !== this.getListViewerKey()) {
      this._loadedListKey = null
      this._loadedViewerKey = null
      this.setData({
        hasLoadedOnce: false,
        originalCarpoolList: [],
        originalRequestList: [],
        dayGroups: [],
        fullTripCount: 0,
        hasMoreDays: false,
        nextPageDate: ""
      })
    }
    if (!options.force) {
      const age = Date.now() - this._loadedOnceAt
      if (this.data.hasLoadedOnce && this._loadedListKey === key && age >= 0 && age < LIST_REFRESH_INTERVAL) {
        this._researchResultSource = 'cache'
        this.applyAllFiltersAndGroup()
        return
      }
      if (this.restoreCachedLists()) return
    }

    const request = {
      key,
      ...this.getInitialDatePage(),
      rangeKey: this.getDateRangeKey(),
      cityKey: this.data.activeCityKey || RIDE_DEFAULT_CITY_KEY,
      viewerKey: this.getListViewerKey(),
      revision: this.getRideListRefreshAt(),
      startedAt: Date.now()
    }
    this._listMoreRequest = null
    this._moreLoadingPromise = null
    this.setData({ loadingMoreDays: false, loadMoreError: "" })
    const showLoading = options.showLoading !== false && !this.data.hasLoadedOnce
    if (showLoading) {
      this.setData({
        loading: true,
        loadingText: "正在加载附近路线..."
      })
    } else {
      wx.showNavigationBarLoading()
    }

    this._listLoadingKey = key
    this._listActiveRequest = request
    this._listLoadingPromise = this._loadBothListsImpl(showLoading, request)
      .finally(() => {
        if (this._listActiveRequest !== request) return
        this._listLoadingPromise = null
        wx.hideNavigationBarLoading()
        // 请求期间发生加入/退出或切换身份时，不能把旧结果当作最新结果。
        if (!this._listDisposed && this.data.isRideServiceAvailable && key !== this.getListRequestKey()) {
          return this.loadBothLists({ showLoading: false, force: true })
        }
      })

    return this._listLoadingPromise
  },

  async readDatePage(request) {
    const res = await wx.cloud.callFunction({
      name: "getTripList",
      data: {
        type: "all", quick: true, fastOnly: true,
        startDate: request.startDate,
        endDateExclusive: request.endDateExclusive,
        cityKey: normalizeRideServiceCityKey(request.cityKey),
        cityLabel: RIDE_SERVICE_CITY_LABEL,
        cityAliases: this.data.activeCityAliases || []
      }
    })
    const result = res && res.result ? res.result : {}
    if (result.success) {
      const page = result.page
      if (!page || page.startDate !== request.startDate || page.endDateExclusive !== request.endDateExclusive ||
        typeof page.hasMore !== "boolean" ||
        (page.hasMore && (!this.isValidFilterDate(page.nextDate) || page.nextDate < page.endDateExclusive))) {
        throw new Error("路线分页信息无效，请稍后重试")
      }
    }
    return result
  },

  async _loadBothListsImpl(showLoading, request) {
    try {
      const result = await this.readDatePage(request)

      if (this._listDisposed || request.key !== this.getListRequestKey() || this._listActiveRequest !== request || !this.data.isRideServiceAvailable) {
        return
      }

      if (!result.success) {
        this._loadedListKey = null
        this.clearListCache()
        if (showLoading) {
          showDataError("加载失败", result.errorMsg || "load failed", "列表加载失败，请稍后重试。")
        }
        this.setData({
          loading: false,
          hasLoadedOnce: true,
          originalCarpoolList: [],
          originalRequestList: [],
          dayGroups: [],
          fullTripCount: 0,
          hasMoreDays: false,
          nextPageDate: ""
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
        hasLoadedOnce: true,
        hasMoreDays: !request.exactDate && result.page.hasMore,
        nextPageDate: !request.exactDate && result.page.hasMore ? result.page.nextDate : "",
        loadMoreError: ""
      })

      this._loadedOnceAt = request.startedAt
      this._loadedListKey = request.key
      this._loadedViewerKey = request.viewerKey
      this.cacheLoadedLists(decoratedCarpool, decoratedRequest, request)
      this._researchResultSource = 'network'
      this.applyAllFiltersAndGroup()
    } catch (err) {
      console.error("loadBothLists error:", err)
      if (this._listDisposed || request.key !== this.getListRequestKey() || this._listActiveRequest !== request || !this.data.isRideServiceAvailable) {
        return
      }
      this._loadedListKey = null
      this.clearListCache()
      if (showLoading) showDataError("加载失败", err, "列表加载失败，请稍后重试。")
      this.setData({
        loading: false,
        hasLoadedOnce: true
      })
    }
  },

  onListTouchStart(event) {
    const touch = event && event.touches && event.touches[0]
    this._listTouchStartY = touch && Number.isFinite(touch.clientY) ? touch.clientY : null
    this._listLoadMoreArmed = false
    this._listGestureConsumed = false
  },

  onListTouchMove(event) {
    const touch = event && event.touches && event.touches[0]
    if (this._listGestureConsumed || this._listTouchStartY == null || !touch || !Number.isFinite(touch.clientY)) return
    const movedUp = this._listTouchStartY - touch.clientY
    if (movedUp >= 12) this._listLoadMoreArmed = true
    else if (movedUp <= -12) this._listLoadMoreArmed = false
  },

  onListTouchEnd() {
    // Keep the intent until scroll momentum reaches the bottom.
    this._listTouchStartY = null
  },

  onListTouchCancel() {
    this._listTouchStartY = null
    this._listLoadMoreArmed = false
  },

  onListScrollToLower() {
    // Taps and expand/collapse layout changes must not advance the date page.
    if (!this._listLoadMoreArmed) return
    this._listLoadMoreArmed = false
    this._listGestureConsumed = true
    return this.onLoadMoreDays()
  },

  async onLoadMoreDays() {
    this._listLoadMoreArmed = false
    this._listGestureConsumed = true
    if (this._listDisposed || !this.data.isRideServiceAvailable || this.data.refresherTriggered ||
      this.data.loading || this.data.placePickerVisible || this.data.refineFiltersVisible || this.data.cityPickerVisible || this.data.calendarVisible) return
    if (this._listLoadingPromise) return this._listLoadingPromise
    if (this._moreLoadingPromise) return this._moreLoadingPromise
    if (!this.data.hasMoreDays || !this.isValidFilterDate(this.data.nextPageDate)) return
    const key = this.getListRequestKey()
    if (this._loadedListKey !== key) return this.loadBothLists({ force: true, showLoading: false })
    const request = {
      key, cityKey: this.data.activeCityKey || RIDE_DEFAULT_CITY_KEY,
      viewerKey: this.getListViewerKey(), revision: this.getRideListRefreshAt(),
      rangeKey: this.getDateRangeKey(), startedAt: this._loadedOnceAt,
      startDate: this.data.nextPageDate,
      endDateExclusive: this.shiftDate(this.data.nextPageDate, 2)
    }
    this._listMoreRequest = request
    this.setData({ loadingMoreDays: true, loadMoreError: "" })
    const isCurrent = () => !this._listDisposed && this._listMoreRequest === request &&
      request.key === this.getListRequestKey() && this.data.isRideServiceAvailable
    this._moreLoadingPromise = this.readDatePage(request).then(result => {
      if (!isCurrent()) return
      if (!result.success) throw new Error(result.errorMsg || "加载更多路线失败")
      const merge = (existing, incoming, type) => {
        const byId = new Map()
        ;[...existing, ...(incoming || [])].forEach(item => { if (item && item._id) byId.set(item._id, item) })
        return Array.from(byId.values()).map(item => this.decorateTripCommon(item, type))
          .filter(item => this.shouldShowTrip(item)).sort((a, b) => this.sortByDateTime(a, b))
      }
      const data = result.data || {}
      const carpool = merge(this.data.originalCarpoolList, data.carpool, "carpool")
      const requests = merge(this.data.originalRequestList, data.request, "request")
      this.setData({
        originalCarpoolList: carpool, originalRequestList: requests,
        hasMoreDays: result.page.hasMore,
        nextPageDate: result.page.hasMore ? result.page.nextDate : ""
      }, () => this.applyAllFiltersAndGroup())
      this.cacheLoadedLists(carpool, requests, request)
    }).catch(error => {
      if (isCurrent()) this.setData({ loadMoreError: "加载失败，点击重试" })
      console.error("load more route days failed", error)
    }).finally(() => {
      if (this._listMoreRequest !== request) return
      this._listMoreRequest = null
      this._moreLoadingPromise = null
      if (!this._listDisposed) this.setData({ loadingMoreDays: false })
    })
    return this._moreLoadingPromise
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
  // 固定地点使用共享别名匹配，自选具体地址保留原文。
  // =========================
  isFortLee(address) {
    return /fort\s*lee/i.test(String(address || ""))
  },

  isColumbia(address) {
    if (!address) return false
    const s = String(address).toLowerCase()
    return (
      s.indexOf("哥大") >= 0 ||
      s.indexOf("columbia") >= 0
    )
  },

  isPresetPlace(address) {
    return FIXED_PLACES.some(place => makeRidePlaceMatcher(place.value)(address))
  },

  makePlaceMatcher(place) {
    return makeRidePlaceMatcher(place)
  },

  tripMatchesCity(trip, city) {
    if (!trip || !city || !city.key) return true
    const storedKey = String(trip.cityKey || trip.routeCityKey || "").trim()
    if (storedKey) return rideCityKeysMatch(storedKey, city.key)

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
  // 同一区块按时间分组；满员车辆统一折叠到列表末尾。
  // =========================
  applyAllFiltersAndGroup() {
    this.syncFilterUi()
    const {
      originalCarpoolList,
      originalRequestList,
      timeFilterIndex,
      todayDateStr,
      tomorrowDateStr,
      selectedDate,
      routeTypeFilter,
      selectedFromPlace,
      selectedToPlace
    } = this.data
    const activeCity = {
      key: this.data.activeCityKey || RIDE_DEFAULT_CITY_KEY,
      label: this.data.activeCityLabel || DEFAULT_CITY_LABEL,
      aliases: this.data.activeCityAliases || []
    }

    const filterOneList = (list) => {
      let filtered = (list || []).filter(trip => this.shouldShowTrip(trip) && this.tripMatchesCity(trip, activeCity))

      // 时间筛选
      if (selectedDate || timeFilterIndex >= 0) {
        filtered = filtered.filter((trip) => {
          const dep = this.getFirstDeparture(trip)
          const d = dep && dep.date ? dep.date : ""
          if (!d) return false
          if (selectedDate) return d === selectedDate
          if (timeFilterIndex === 0) return d === todayDateStr
          if (timeFilterIndex === 1) return d === tomorrowDateStr
          return d !== todayDateStr && d !== tomorrowDateStr
        })
      }

      const addressFilteringActive = !!(selectedFromPlace || selectedToPlace)
      const fromSelected = selectedFromPlace || null
      const toSelected = selectedToPlace || null
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
          if (fromSelected === "其他") {
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
          if (toSelected === "其他") {
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

    const carpoolFiltered = routeTypeFilter === "request" ? [] : filterOneList(originalCarpoolList)
    const requestFiltered = routeTypeFilter === "carpool" ? [] : filterOneList(originalRequestList)
    const dateCounts = new Map()
    ;[...carpoolFiltered, ...requestFiltered].forEach(trip => {
      if (!trip._date) return
      if (!dateCounts.has(trip._date)) dateCounts.set(trip._date, { carpoolCount: 0, requestCount: 0 })
      const counts = dateCounts.get(trip._date)
      if (trip._type === "request") counts.requestCount += 1
      else counts.carpoolCount += 1
    })

    const fullTrips = carpoolFiltered.filter(trip => this.isFullCarpool(trip))
    const availableTrips = [
      ...carpoolFiltered.filter(trip => !this.isFullCarpool(trip)),
      ...requestFiltered
    ]
    const groups = this.groupTripsByDate(availableTrips, "available", dateCounts)
    if (!this.data.hideFullTrips) groups.push(...this.groupTripsByDate(fullTrips, "full", dateCounts))
    const search = this._researchSearch
    const renderGeneration = this._researchRenderGeneration = (this._researchRenderGeneration || 0) + 1
    this.setData({ dayGroups: groups, fullTripCount: fullTrips.length }, () => {
      // Read the state after synchronous cache restoration has completed too.
      Promise.resolve().then(() => {
        if (renderGeneration === this._researchRenderGeneration) this.recordResearchResult(search, groups)
      })
    })
  },

  recordResearchResult(search, groups) {
    if (this._listDisposed || this._researchVisible === false || !this.data.hasLoadedOnce || this.data.loading ||
      this._loadedListKey !== this.getListRequestKey()) return
    const activeSearch = search && search === this._researchSearch && !search.emitted &&
      search.key === this.getListRequestKey() && this.getInitialDatePage().exactDate
    const id = rideTelemetry.renderList(this, groups, { searchId: activeSearch ? search.id : '', source: this._researchResultSource })
    if (id && activeSearch) search.emitted = true
  },

  resumeResearchList() {
    this.recordResearchResult(this._researchSearch, this.data.dayGroups || [])
  },

  getAvailableSeatCount(trip) {
    const value = trip && trip.availSeatNum
    if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return null
    const count = Number(value)
    return Number.isInteger(count) ? count : null
  },

  isFullCarpool(trip) {
    if (!trip || trip._type !== "carpool") return false
    if (this.normalizeTripStatus(trip.status) === "full") return true
    const count = this.getAvailableSeatCount(trip)
    return count != null && count <= 0
  },

  groupTripsByDate(trips, section, dateCounts) {
    const map = new Map()
    ;[...trips].sort((a, b) => this.sortByDateTime(a, b)).forEach(trip => {
      const date = trip._date || ""
      if (!date) return
      if (!map.has(date)) {
        map.set(date, {
          key: `${section}:${date}`,
          date,
          dateLabel: this.formatMonthDayWeek(date),
          ...(dateCounts && dateCounts.get(date)),
          items: []
        })
      }
      map.get(date).items.push(trip)
    })
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date))
  },

  restoreFullTripPreference() {
    let hideFullTrips = true
    try {
      const saved = wx.getStorageSync(HIDE_FULL_TRIPS_KEY)
      if (typeof saved === "boolean") hideFullTrips = saved
    } catch (e) {
    }
    this.setData({ hideFullTrips })
  },

  onToggleHideFullTrips() {
    this._listTouchStartY = null
    this._listLoadMoreArmed = false
    this._listGestureConsumed = true
    const hideFullTrips = !this.data.hideFullTrips
    // No TTL: this display preference survives list refreshes and future visits.
    try {
      wx.setStorageSync(HIDE_FULL_TRIPS_KEY, hideFullTrips)
    } catch (e) {
    }
    this.setData({ hideFullTrips }, () => this.applyAllFiltersAndGroup())
  },

  // =========================
  // 筛选事件
  // =========================
  changeFilters(patch) {
    // 配置异步返回时，不能再用分享初始值覆盖用户已经做出的选择。
    this._initFilterFromShare = null
    const previousRange = this.getDateRangeKey()
    this.setData(patch, () => {
      // This method is called by explicit filter controls only, never by initial
      // load/share normalization. Broad date ranges are intentionally not sampled.
      const range = this.getInitialDatePage()
      const searchId = range.exactDate ? research.recordSearch({
        tripType: this.data.routeTypeFilter || 'all', serviceDate: range.startDate,
        originArea: rideTelemetry.coarseArea(this.data.selectedFromPlace), destinationArea: rideTelemetry.coarseArea(this.data.selectedToPlace),
        hideFullTrips: this.data.hideFullTrips === true
      }) : ''
      this._researchSearch = searchId ? { id: searchId, key: this.getListRequestKey(), emitted: false } : null
      this._researchResultSource = 'cache'
      if ((this.data.hasLoadedOnce || this._listLoadingPromise) && previousRange !== this.getDateRangeKey()) {
        this.setData({
          hasLoadedOnce: false, loading: true,
          originalCarpoolList: [], originalRequestList: [], dayGroups: [],
          fullTripCount: 0, hasMoreDays: false, nextPageDate: "", loadMoreError: ""
        })
        this.syncFilterUi()
        this.loadBothLists({ showLoading: true })
        return
      }
      this.applyAllFiltersAndGroup()
    })
  },

  onOpenPlacePicker(e) {
    rideTelemetry.stopList(this)
    placePickerTelemetry.closePlacePicker(this._placeSession, "replaced")
    const field = e && e.currentTarget && e.currentTarget.dataset.field
    this._placePickerField = field === "to" ? "to" : "from"
    this.syncFilterUi()
    this._placeContext = { cityKey: this.data.activeCityKey || RIDE_DEFAULT_CITY_KEY, viewerKey: this.getListViewerKey(),
      field: this._placePickerField === 'to' ? 'destination' : 'departure', mode: 'filter',
      counterpartPlaceId: resolvePlaceId(this.getSelectedFilterPlace(this._placePickerField === 'to' ? 'from' : 'to')) }
    const snapshot = placeRecommendations.getCachedPlaceRecommendations(this._placeContext)
    this._placeSession = placePickerTelemetry.createPlacePickerSession(this._placeContext, snapshot)
    const configured = this.data[this._placePickerField === 'to' ? 'toPlaceList' : 'fromPlaceList']
    const fixed = configured.length ? configured : getStaticRideAddressConfig().fromPlaces
    const seen = new Set()
    this._frozenPlaceOptions = [{ value: '', label: this._placePickerField === 'to' ? '不限目的地' : '不限出发地', placeId: 'unknown', source: 'fixed', filterToken: true },
      ...fixed.map(value => ({ value: this.normalizeFilterPlace(value), label: shortRidePlaceLabel(value), placeId: resolvePlaceId(value), source: 'fixed' })),
      ...snapshot.places.map(row => ({ ...row, value: this.normalizeFilterPlace(row.value) })),
      { value: '其他', label: '其他', placeId: 'unknown', source: 'fixed', filterToken: true }].filter(row => {
        const id = placeIdentity(row.value)
        if (seen.has(id)) return false
        seen.add(id); return true
      })
    const selected = this.getSelectedFilterPlace(this._placePickerField)
    if (selected && !this._frozenPlaceOptions.some(row => row.value === selected)) this._frozenPlaceOptions.splice(-1, 0, { value: selected, label: selected, placeId: resolvePlaceId(selected), source: 'personal' })
    let placeCount = 0
    this._frozenPlaceOptions = this._frozenPlaceOptions.filter(row => row.filterToken || ++placeCount <= 20)
    this.setData({ placePickerVisible: true, calendarVisible: false, cityPickerVisible: false, refineFiltersVisible: false,
      placePickerTitle: this._placePickerField === "to" ? "选择目的地" : "选择出发地", placeSearchKeyword: ""
    }, () => {
      this.updatePlacePickerOptions()
      placePickerTelemetry.renderPlaces(this._placeSession, this.data.placePickerOptions)
      placePickerTelemetry.observePlaces(this, this._placeSession, '.list-place-option')
    })
    // Keep the current panel stable while new data warms the next opening.
    return Promise.all([placeRecommendations.loadPlaceRecommendations(this._placeContext), this.loadFilterPlaceConfig()])
  },

  updatePlacePickerOptions() {
    const field = this._placePickerField === "to" ? "to" : "from"
    const selected = this.getSelectedFilterPlace(field)
    const keyword = String(this.data.placeSearchKeyword || "").trim().toLowerCase()
    const options = (this._frozenPlaceOptions || []).filter(option => {
      if (!keyword || option.value === "") return true
      return option.label.toLowerCase().includes(keyword) || placeIdentity(option.value) === placeIdentity(keyword) || makeRidePlaceMatcher(keyword)(option.value)
    }).map((option, position) => ({ ...option, position, selected: option.value === selected,
      groupLabel: { personal: '我的最近', circle: '同圈常用', city: '本区常用', new: '新公共地点' }[option.source] || '' }))
    this.setData({ placePickerOptions: options })
  },

  onPlaceSearchInput(e) {
    this.setData({ placeSearchKeyword: String((e.detail && e.detail.value) || "") }, () => this.updatePlacePickerOptions())
  },

  onSelectFilterPlace(e) {
    if (!this.data.placePickerVisible || !this._placeContext || this._placeContext.viewerKey !== this.getListViewerKey()) return
    const value = this.normalizeFilterPlace(e.currentTarget.dataset.value)
    const field = this._placePickerField === "to" ? "to" : "from"
    const row = this.data.placePickerOptions.find(place => place.value === value)
    if (!row) return
    placePickerTelemetry.renderPlaces(this._placeSession, this.data.placePickerOptions)
    placePickerTelemetry.selectPlace(this._placeSession, row, row.position)
    if (value && value !== '其他') placeRecommendations.rememberPlace(value, this._placeContext, row.placeId)
    this.changeFilters({ [field === "to" ? "selectedToPlace" : "selectedFromPlace"]: value,
      [`${field}FilterIndex`]: -1, placePickerVisible: false, placeSearchKeyword: "" })
  },

  onClosePlacePicker() {
    placePickerTelemetry.closePlacePicker(this._placeSession, "close")
    this.setData({ placePickerVisible: false, placeSearchKeyword: "" }, () => this.resumeResearchList())
  },

  onOpenRefineFilters() {
    rideTelemetry.stopList(this)
    this.setData({ refineFiltersVisible: true, placePickerVisible: false, cityPickerVisible: false, calendarVisible: false })
  },

  onCloseRefineFilters() {
    this.setData({ refineFiltersVisible: false }, () => this.resumeResearchList())
  },

  onSwapFilterPlaces() {
    this.changeFilters({
      selectedFromPlace: this.getSelectedFilterPlace("to"),
      selectedToPlace: this.getSelectedFilterPlace("from"),
      fromFilterIndex: -1,
      toFilterIndex: -1
    })
  },

  onQuickDateChange(e) {
    const value = e.currentTarget.dataset.value
    const index = { all: -1, today: 0, tomorrow: 1 }[value]
    if (index == null) return
    this.changeFilters({ ...this.getFilterDateData(), timeFilterIndex: index, selectedDate: "" })
  },

  onSpecificDateChange(e) {
    const value = e.detail && e.detail.value
    if (!this.isValidFilterDate(value)) return
    this.changeFilters({ selectedDate: value, timeFilterIndex: -1 })
  },

  getCalendarRequest() {
    const request = {
      action: "calendar", month: this.data.calendarMonth,
      type: this.data.routeTypeFilter || "all",
      cityKey: normalizeRideServiceCityKey(this.data.activeCityKey || RIDE_DEFAULT_CITY_KEY),
      fromPlace: this.getSelectedFilterPlace("from"),
      toPlace: this.getSelectedFilterPlace("to")
    }
    if (request.fromPlace === "其他") request.fromPresets = this.data.fromPlaceList || []
    if (request.toPlace === "其他") request.toPresets = this.data.toPlaceList || []
    return request
  },

  applyCalendarSelection(date) {
    this.changeFilters({ selectedDate: date, timeFilterIndex: -1, calendarVisible: false, refineFiltersVisible: false })
  },

  onCalendarDismiss() {
    this.setData({ refineFiltersVisible: true })
  },

  onRouteTypeChange(e) {
    const type = e.currentTarget.dataset.type
    if (!["all", "carpool", "request"].includes(type)) return
    this.changeFilters({ routeTypeFilter: type })
  },

  onFromFilterChange(e) {
    const index = Number(e.detail.value)
    this.changeFilters({ selectedFromPlace: this.normalizeFilterPlace(this.data.fromFilterOptions[index]), fromFilterIndex: -1 })
  },

  onToFilterChange(e) {
    const index = Number(e.detail.value)
    this.changeFilters({ selectedToPlace: this.normalizeFilterPlace(this.data.toFilterOptions[index]), toFilterIndex: -1 })
  },

  onTimeFilterChange(e) {
    const index = Number(e.detail.value)
    this.changeFilters({ timeFilterIndex: index >= 0 && index <= 2 ? index : -1, selectedDate: "" })
  },

  onResetFilter() {
    this.changeFilters({
      selectedFromPlace: "",
      selectedToPlace: "",
      fromFilterIndex: -1,
      toFilterIndex: -1,
      timeFilterIndex: -1,
      selectedDate: "",
      routeTypeFilter: "all",
      placePickerVisible: false,
      placeSearchKeyword: ""
    })
  },

  async onPullDownRefresh() {
    this.setData({ refresherTriggered: true })
    try {
      if (this.data.isRideServiceAvailable) {
        await this.loadBothLists({ showLoading: false, force: true })
        this.refreshStatusInBackground(true)
      } else {
        this.setData({
          loading: false,
          hasLoadedOnce: true,
          dayGroups: [],
          fullTripCount: 0,
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
    rideTelemetry.clickTrip(this, id, type, item)
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
