const { showDataError } = require("../../../utils/error")
const profileApi = require("../../../utils/compat/profile")
const templatesApi = require("../../../utils/compat/rideTemplates")
const publishApi = require("../../../utils/compat/ridePublish")
const rideTime = require("../../../utils/rideTime")
const rideCalendarPicker = require("../../../utils/rideCalendarPicker")
const { getDriverRouteDefaultPrice, getDriverRoutePriceKey } = require("../../../utils/driverRideDefaults")
const { shortRidePlaceLabel, resolvePlaceId } = require("../../../utils/ridePlaceOptions")
const { loadRideAddressConfig, getStaticRideAddressConfig } = require("../../../utils/rideAddressConfig")
const placeRecommendations = require("../../../utils/placeRecommendations")
const placePickerTelemetry = require("../../../utils/placePickerTelemetry")
const { markRideListStale } = require("../../../utils/tripManage")
const {
  DEFAULT_CITY_KEY,
  RIDE_CITY_STORAGE_KEY,
  getStoredCitySnapshot,
  getRideServiceCitySnapshot,
  isRideServiceCityKey
} = require("../../../utils/cityTree")

function getRideCitySnapshot() {
  const stored = getStoredCitySnapshot(RIDE_CITY_STORAGE_KEY, null, DEFAULT_CITY_KEY)
  if (!isRideServiceCityKey(stored.key)) return getRideServiceCitySnapshot({ key: DEFAULT_CITY_KEY })
  return getRideServiceCitySnapshot(stored)
}

Page({
  ...rideCalendarPicker.methods,
  data: {
    ...rideCalendarPicker.data,
    calendarConfirmText: "确定日期",
    timePickerVisible: false,
    placePickerVisible: false,
    placePickerTitle: "选择出发地",
    placePickerValue: "",
    placePickerOptions: [],
    placePickerFixedOptions: [],
    placePickerLoading: false,
    placePickerError: "",
    // ====== 顶部/通用 ======
    statusBarHeight: 80,
    pageTitle: "新建路线",
    templateRouteSummary: "",
    mode: "driver", // 默认司机

    userInfo: null,
    loadingUserInfo: false,
    driverProfileReady: false,
    submitting: false,

    // 地址列表（两种模式都用）
    departureAddresses: [],
    arrivalAddresses: [],
    loadingDepartureAddrs: true,
    loadingArrivalAddrs: true,

    // 已选字段（两种模式都用）
    departureAddress: "",
    destinationAddress: "",
    departureDate: "",
    departureTime: "",

    // ====== 司机模式字段 ======
    passengerCount: 1,
    passengerCountInput: "4",

    carNumber: "",
    carBrand: "",
    carModel: "",

    referencePrice: "",
    referencePriceHasNumber: false,
    comment: "",
    commentExpanded: false,
    templatesExpanded: false,
    showZelle: false,

    templates: [],
    loadingTemplates: false,
    publishedRide: null,
    preparingReturn: false,

    // ====== 乘客模式字段 ======
    // 注意：乘客也用 referencePrice 展示，但不可编辑（WXML 用 readonly view）
    priceLocked: true,
    acceptCarpool: false
  },

  // -------------------------
  // 生命周期
  // -------------------------
  onLoad(options = {}) {
    this._calendarDisposed = false
    this._pageIdentity = profileApi.identity()
    const info = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const mode = options.mode === "passenger" ? "passenger" : "driver"
    this.setData({ statusBarHeight: info.statusBarHeight, mode,
      ...this.getFilterDateData(),
      ...(mode === "passenger" ? { referencePrice: "", referencePriceHasNumber: false } : {})
    })

    // 地址可对游客开放加载
    this.loadAllAddresses()

    // 仅登录态才加载 userInfo
    this.loadUserInfo()

    // 司机默认：加载模板
    this.loadTemplatesIfNeeded()
  },

  onShow() {
    const identity = profileApi.identity()
    if (this._pageIdentity !== undefined && identity !== this._pageIdentity) {
      this.invalidateUserInfoRead()
      this._selectedTemplate = null
      this._priceManuallyEdited = false
      this.setData({ userInfo: null, departureAddress: "", destinationAddress: "", departureDate: "", departureTime: "",
        referencePrice: "", comment: "", templateRouteSummary: "", publishedRide: null, preparingReturn: false, submitting: false })
    }
    this._pageIdentity = identity
    if (this._publishedOwner && this._publishedOwner !== (wx.getStorageSync("openid") || "")) {
      this._publishedOwner = ""
      this._returnDepartureTimestamp = null
      this.setData({ publishedRide: null, preparingReturn: false })
    }
    if (this.data.calendarVisible) {
      this.setData(this.getFilterDateData())
      this.renderCalendar()
      this.loadCalendarCounts()
    }
    if (this.data.placePickerVisible) this.loadPlaceSuggestions()
    const tip = wx.getStorageSync("needLoginToast")
    if (tip) {
      wx.removeStorageSync("needLoginToast")
      wx.showToast({ title: tip, icon: "none", duration: 2000 })
    }

    this.loadUserInfo()
    this.loadTemplatesIfNeeded()
  },

  onHide() {
    placePickerTelemetry.closePlacePicker(this._placeSession, "page_hide")
    if (this.data.placePickerVisible) this.setData({ placePickerVisible: false })
  },

  onUnload() {
    placePickerTelemetry.closePlacePicker(this._placeSession, "page_hide")
    this._calendarDisposed = true
    this._placeReadRevision = (this._placeReadRevision || 0) + 1
  },

  // -------------------------
  // 顶部切换
  // -------------------------
  setMode(e) {
    const mode = e.currentTarget.dataset.mode
    if (this.data.submitting || this._submitInFlight) return
    if (!["driver", "passenger"].includes(mode) || mode === this.data.mode) return
    placePickerTelemetry.closePlacePicker(this._placeSession, "replaced")
    this._priceManuallyEdited = false
    this._selectedTemplate = null
    this._returnDepartureTimestamp = null

    this.setData({
      mode,
      preparingReturn: false,
      templateRouteSummary: "",
      publishedRide: null,
      calendarVisible: false,
      timePickerVisible: false,
      placePickerVisible: false,
      departureAddress: "",
      destinationAddress: "",
      referencePrice: "",
      referencePriceHasNumber: false,
      // passengerCountInput 只给司机用；乘客人数你也可保留不动
    }, async () => {
      // 两种发布模式共用地点配置，切换时复用五分钟缓存。
      await this.loadAllAddresses()
      if (this._calendarDisposed || this.data.mode !== mode) return

      if (mode === "passenger") {
        await this.updateReferencePriceFromRequestPrice()
      }

      // 司机模式：加载模板
      this.loadTemplatesIfNeeded()
    })
  },

  goBack() { wx.navigateBack() },

  // -------------------------
  // 登录态判定（只看 openid）
  // -------------------------
  isLoggedIn() {
    const openid = wx.getStorageSync("openid") || ""
    return !!openid && !wx.getStorageSync("isGuest")
  },

  // 司机：创建前拦截
  ensureLoginBeforeCreate_driver() {
    if (this.isLoggedIn()) return true

    wx.setStorageSync("pendingPage", { url: "/pages/home/newTrip/newTrip" })
    wx.setStorageSync("postLoginAction", {
      type: "requireProfile",
      returnUrl: "/pages/home/newTrip/newTrip"
    })

    wx.navigateTo({ url: "/pages/other/login/login" })
    return false
  },

  // 乘客：创建前拦截
  ensureLoginBeforeCreate_passenger() {
    if (this.isLoggedIn()) return true

    const pendingUrl = "/pages/home/newTrip/newTrip?mode=passenger"
    wx.setStorageSync("pendingPage", { url: pendingUrl })
    wx.setStorageSync("postLoginAction", {
      type: "requireProfile",
      from: "newTrip-passenger",
      returnUrl: pendingUrl
    })

    wx.navigateTo({ url: "/pages/other/login/login" })
    return false
  },

  showError(msg) {
    wx.showToast({ title: msg, icon: "none", duration: 2000 })
  },

  parseDateTimeSafe(dateStr, timeStr) {
    const timestamp = rideTime.parseRideDateTime(dateStr, timeStr)
    return Number.isFinite(timestamp) ? new Date(timestamp) : null
  },

  // -------------------------
  // userInfo
  // -------------------------
  loadUserInfo() {
    if (!this.isLoggedIn()) {
      this.invalidateUserInfoRead()
      this.setData({ userInfo: null, loadingUserInfo: false, driverProfileReady: false, carNumber: "", carBrand: "", carModel: "", showZelle: false })
      return Promise.resolve()
    }
    const identity = profileApi.identity()
    if (this._userInfoPromise && this._userInfoReadIdentity === identity) return this._userInfoPromise
    this._userInfoReadIdentity = identity
    const revision = this._userInfoReadRevision = (this._userInfoReadRevision || 0) + 1
    this.setData({ loadingUserInfo: true })
    const pending = this.readUserInfo(revision, identity).finally(() => {
      if (this._userInfoPromise !== pending) return
      this._userInfoPromise = null
      if (!this._calendarDisposed) this.setData({ loadingUserInfo: false })
    })
    this._userInfoPromise = pending
    return pending
  },

  invalidateUserInfoRead() {
    this._userInfoReadRevision = (this._userInfoReadRevision || 0) + 1
    this._userInfoPromise = null
  },

  async readUserInfo(revision, identity = profileApi.identity()) {
    const isCurrent = () => !this._calendarDisposed && revision === this._userInfoReadRevision && identity === profileApi.identity()
    try {
      const res = await profileApi.getUserInfo()
      if (!isCurrent()) return
      const list = res?.result?.data || []
      const user = list[0] || null
      const carNumber = String(user?.carNumber || "").trim()
      const carBrand = String(user?.carBrand || "").trim()
      const carModel = String(user?.carModel || "").trim()
      this.setData({
        userInfo: user,
        carNumber, carBrand, carModel,
        driverProfileReady: !!(carNumber && carBrand && carModel),
        showZelle: user?.defaultShowZelle === true
      })
      if (this.data.mode === "driver" && !this._priceManuallyEdited) this.updateReferencePrice_driver()
    } catch (e) {
      if (!isCurrent()) return
      this.setData({ userInfo: null, driverProfileReady: false, showZelle: false })
      console.error("loadUserInfo error:", e)
      showDataError("资料加载失败", e, "个人资料从数据库加载失败，请稍后重试。")
    }
  },

  onEditDriverProfile() {
    if (!this.ensureLoginBeforeCreate_driver()) return
    // A response started before editing must not overwrite the saved profile on return.
    this.invalidateUserInfoRead()
    this.setData({ loadingUserInfo: false })
    wx.navigateTo({ url: "/pages/profile/editInfo/editInfo?from=newTrip" })
  },

  promptDriverProfile(message) {
    wx.showModal({
      title: "完善司机资料",
      content: message,
      confirmText: "去完善",
      success: res => { if (res.confirm) this.onEditDriverProfile() }
    })
  },

  onToggleComment() { this.setData({ commentExpanded: !this.data.commentExpanded }) },
  onToggleTemplates() { this.setData({ templatesExpanded: !this.data.templatesExpanded }) },

  // -------------------------
  // 两种发布模式共用云端 Departure / Arrival 地点配置。
  // -------------------------
  async loadAllAddresses() {
    const mode = this.data.mode
    const revision = this._addressReadRevision = (this._addressReadRevision || 0) + 1
    const isCurrent = () => !this._calendarDisposed && revision === this._addressReadRevision && mode === this.data.mode
    this.setData({ loadingDepartureAddrs: true, loadingArrivalAddrs: true })

    try {
      const { fromPlaces: dep, toPlaces: arr } = await loadRideAddressConfig()
      if (!isCurrent()) return

      this.setData({
        departureAddresses: [...(dep || []), "其他"],
        arrivalAddresses: [...(arr || []), "其他"],
        loadingDepartureAddrs: false,
        loadingArrivalAddrs: false
      })
    } catch (e) {
      if (!isCurrent()) return
      console.error("loadAllAddresses error:", e)
      const fallback = getStaticRideAddressConfig()
      this.setData({ departureAddresses: [...fallback.fromPlaces, "其他"], arrivalAddresses: [...fallback.toPlaces, "其他"], loadingDepartureAddrs: false, loadingArrivalAddrs: false })
    }
  },

  // 地址变化后的分流：司机更新默认参考价；乘客读取路线参考价
  async afterAddressChanged() {
    this.refreshTemplateRouteSummary()
    if (this.data.mode === "driver") {
      this.updateReferencePrice_driver()
    } else {
      await this.updateReferencePriceFromRequestPrice()
    }
  },

  // -------------------------
  // 通用：日期时间
  // -------------------------
  getFilterDateData(now = new Date()) {
    return rideTime.getRideDateData(now)
  },

  isValidFilterDate(value) {
    return rideTime.isValidRideDate(value)
  },

  getListViewerKey() {
    return wx.getStorageSync("isGuest") ? "guest" : String(wx.getStorageSync("openid") || "guest")
  },

  getRideListRefreshAt() {
    return Number(wx.getStorageSync("rideListShouldRefreshAt") || 0)
  },

  getCalendarInitialDate() {
    return this.data.departureDate || this.getFilterDateData().todayDateStr
  },

  getCalendarRequest() {
    return {
      action: "calendar", month: this.data.calendarMonth, type: "all",
      cityKey: getRideCitySnapshot().key || DEFAULT_CITY_KEY,
      fromPlace: this.data.departureAddress || "",
      toPlace: this.data.destinationAddress || ""
    }
  },

  onOpenDatePicker() {
    wx.hideKeyboard()
    this.setData({ timePickerVisible: false, placePickerVisible: false })
    return this.onOpenCalendar()
  },

  applyCalendarSelection(date) {
    this.setData({ departureDate: date, calendarVisible: false }, () => this.refreshTemplateRouteSummary())
  },

  onOpenTimePicker() {
    wx.hideKeyboard()
    this.setData({ timePickerVisible: true, calendarVisible: false, placePickerVisible: false })
  },

  onCloseTimePicker() {
    this.setData({ timePickerVisible: false })
  },

  onTimeChange(e) {
    const value = e.detail.value
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value || "")) return
    this.setData({ departureTime: value, timePickerVisible: false }, () => this.refreshTemplateRouteSummary())
  },

  getPlaceRecommendationContext() {
    return { cityKey: getRideCitySnapshot().key || DEFAULT_CITY_KEY, viewerKey: this.getListViewerKey(),
      revision: this.getRideListRefreshAt(), field: this._placePickerField === "destination" ? "destination" : "departure", mode: this.data.mode,
      counterpartPlaceId: resolvePlaceId(this._placePickerField === "destination" ? this.data.departureAddress : this.data.destinationAddress) }
  },

  onOpenPlacePicker(e) {
    placePickerTelemetry.closePlacePicker(this._placeSession, "replaced")
    this._placePickerField = e.currentTarget.dataset.type === "destination" ? "destination" : "departure"
    wx.hideKeyboard()
    this._placeContext = this.getPlaceRecommendationContext()
    this._placeSuggestions = placeRecommendations.getCachedPlaceRecommendations(this._placeContext)
    this._placeSession = placePickerTelemetry.createPlacePickerSession(this._placeContext, this._placeSuggestions)
    const isDeparture = this._placePickerField !== "destination"
    const configured = (isDeparture ? this.data.departureAddresses : this.data.arrivalAddresses) || []
    const fallback = getStaticRideAddressConfig()
    const fixed = (configured.length ? configured : (isDeparture ? fallback.fromPlaces : fallback.toPlaces)).filter(value => !["全部", "其他", "自选"].includes(value))
    this.setData({
      placePickerVisible: true, calendarVisible: false, timePickerVisible: false,
      placePickerTitle: isDeparture ? "选择出发地" : "选择目的地",
      placePickerError: "", placePickerLoading: false,
      placePickerFixedOptions: fixed.map(value => ({ value, label: shortRidePlaceLabel(value) })),
      placePickerValue: isDeparture ? this.data.departureAddress : this.data.destinationAddress,
      placePickerOptions: this._placeSuggestions.places
    })
    // Show cached choices immediately, then update this panel when the read completes.
    return this.loadPlaceSuggestions()
  },

  async loadPlaceSuggestions(options = {}) {
    if (!this.data.placePickerVisible || this._calendarDisposed) return
    const context = this.getPlaceRecommendationContext()
    if (this._placeContext && (context.viewerKey !== this._placeContext.viewerKey || context.cityKey !== this._placeContext.cityKey || context.mode !== this._placeContext.mode)) {
      this.onClosePlacePicker()
      return
    }
    const session = this._placeSession
    const [snapshot, config] = await Promise.all([placeRecommendations.loadPlaceRecommendations({ ...context, force: true }), loadRideAddressConfig({ force: !!options.force }).catch(() => null)])
    if (this._calendarDisposed || !this.data.placePickerVisible || session !== this._placeSession || session.closed || JSON.stringify(context) !== JSON.stringify(this.getPlaceRecommendationContext())) return
    const patch = {}
    if (config) {
      patch.departureAddresses = [...config.fromPlaces, "其他"]
      patch.arrivalAddresses = [...config.toPlaces, "其他"]
      const fixed = context.field === 'destination' ? config.toPlaces : config.fromPlaces
      patch.placePickerFixedOptions = fixed.filter(value => !["全部", "其他", "自选"].includes(value)).map(value => ({ value, label: shortRidePlaceLabel(value) }))
    }
    if (!snapshot.localFallback) {
      const picker = typeof this.selectComponent === 'function' && this.selectComponent('#departure-place-picker')
      if (picker && typeof picker.stopObserving === 'function') picker.stopObserving()
      if (placePickerTelemetry.refreshPlacePickerSession(session, snapshot)) {
        this._placeSuggestions = snapshot
        patch.placePickerOptions = snapshot.places
      }
    }
    this.setData(patch)
  },

  onRetryPlaceSuggestions() { return this.loadPlaceSuggestions({ force: true }) },
  onPlacePresentation(e) { placePickerTelemetry.renderPlaces(this._placeSession, e.detail.items, e.detail.stage) },
  onPlaceCustomCancelled() { placePickerTelemetry.customCancelled(this._placeSession) },

  onClosePlacePicker() {
    placePickerTelemetry.closePlacePicker(this._placeSession, "close")
    this._placeReadRevision = (this._placeReadRevision || 0) + 1
    this.setData({ placePickerVisible: false })
  },

  async onConfirmPlace(e) {
    if (!this.data.placePickerVisible || !this._placeContext || this._placeContext.viewerKey !== this.getListViewerKey()) return
    const value = typeof e.detail.value === "string" ? e.detail.value.trim() : ""
    if (!value || value.length > 200) return
    const field = this._placePickerField === "destination" ? "destinationAddress" : "departureAddress"
    const row = this.data.placePickerOptions.find(item => item.value === value) || this.data.placePickerFixedOptions.find(item => item.value === value)
    const id = resolvePlaceId(value)
    const selected = { value, placeId: e.detail.placeId || (row && row.placeId) || (id === 'unknown' ? 'custom' : id), source: e.detail.source || (row && row.source) || (id === 'unknown' ? 'custom' : 'fixed') }
    placeRecommendations.rememberPlace(value, this._placeContext, selected.placeId)
    placePickerTelemetry.selectPlace(this._placeSession, selected, Number.isInteger(e.detail.position) ? e.detail.position : 0, !!e.detail.custom || selected.source === 'custom')
    this.setData({ [field]: value, placePickerVisible: false })
    await this.afterAddressChanged()
  },

  // -------------------------
  // 司机：人数输入（提交时按当前后端容量上限校验）
  // -------------------------
  onPassengerInput(e) {
    const v = String(e.detail.value || "")
    this.setData({ passengerCountInput: v })
  },

  // -------------------------
  // 司机：当次价格和备注；车辆与收款偏好统一从个人资料读取。
  // -------------------------
  onReferencePriceInput(e) {
    this._priceManuallyEdited = true
    this.setData({
      referencePrice: String(e.detail.value || ""),
      referencePriceHasNumber: true
    })
  },
  onCommentInput(e) { this.setData({ comment: e.detail.value }) },

  // -------------------------
  // 乘客：人数输入（1-4）
  // -------------------------
  onPassengerInputPassenger(e) {
    const num = Number(e.detail.value)
    if (!Number.isInteger(num) || num < 1 || num > 4) return this.showError("乘客数需为 1-4 的整数")
    this.setData({ passengerCount: num })
  },

  onCarpoolChange(e) {
    const checked = (e.detail.value || []).includes("1")
    this.setData({ acceptCarpool: checked })
  },

  // -------------------------
  // 乘客：读取路线参考价
  // -------------------------
  async updateReferencePriceFromRequestPrice() {
    const dep = (this.data.departureAddress || "").trim()
    const dest = (this.data.destinationAddress || "").trim()
    if (!dep || !dest) return
    const isCurrent = () => !this._calendarDisposed && this.data.mode === "passenger" &&
      dep === String(this.data.departureAddress || "").trim() && dest === String(this.data.destinationAddress || "").trim()

    try {
      const label = await publishApi.loadRequestPrice(dep, dest)
      if (!isCurrent()) return
      this.setData({ referencePrice: label, referencePriceHasNumber: false, priceLocked: true })
    } catch (err) {
      if (!isCurrent()) return
      console.error("updateReferencePriceFromRequestPrice error:", err)
      showDataError("价格加载失败", err, "参考价格从数据库加载失败，请稍后重试。")
    }
  },

  // -------------------------
  // 司机：默认参考价
  // -------------------------
  updateReferencePrice_driver() {
    this._priceManuallyEdited = false
    const referencePrice = getDriverRouteDefaultPrice(
      this.data.departureAddress, this.data.destinationAddress, this.data.userInfo?.customPrice
    )
    this.setData({ referencePrice, referencePriceHasNumber: !!referencePrice })
  },

  // -------------------------
  // 司机：每周模板
  // -------------------------
  loadTemplatesIfNeeded() {
    if (this.data.mode !== "driver") return
    return this.loadTemplates()
  },

  loadTemplates() {
    const openid = wx.getStorageSync("openid") || ""
    if (!openid) {
      this._templateReadRevision = (this._templateReadRevision || 0) + 1
      this._templatesPromise = null
      this.setData({ templates: [], loadingTemplates: false })
      return Promise.resolve()
    }
    if (this._templatesPromise && this._templatesOpenid === openid) return this._templatesPromise
    if (this._templatesOpenid !== openid) this.setData({ templates: [] })
    this._templatesOpenid = openid
    const revision = this._templateReadRevision = (this._templateReadRevision || 0) + 1
    this.setData({ loadingTemplates: true })
    const pending = this.readTemplates(openid, revision).finally(() => {
      if (this._templatesPromise !== pending) return
      this._templatesPromise = null
      if (!this._calendarDisposed) this.setData({ loadingTemplates: false })
    })
    this._templatesPromise = pending
    return pending
  },

  async readTemplates(openid, revision) {
    const isCurrent = () => !this._calendarDisposed && revision === this._templateReadRevision &&
      openid === (wx.getStorageSync("openid") || "")
    try {
      const rows = await templatesApi.loadRideTemplates()
      if (!isCurrent()) return

      const templates = rows.map(t => this.decorateWeeklyShortcut({
        ...t,
        departureText: t.departureAddress || "未设置出发地",
        destinationText: t.destinationAddress || "未设置目的地",
        departureTimeText: `${t.weekdayText || ""} ${t.departureTime || ""}`.trim(),
        shortcutTitle: String(t.name || t.title || "").trim() ||
          (getDriverRoutePriceKey(t.departureAddress, t.destinationAddress)
            ? (String(t.destinationAddress).trim() === "哥大" ? "去学校" : "回程") : "常用路线")
      })).sort((a, b) =>
        (a.weekdayIndex === null ? 7 : a.weekdayIndex) - (b.weekdayIndex === null ? 7 : b.weekdayIndex) ||
        (a.departureTime || "99:99").localeCompare(b.departureTime || "99:99"))
      if (isCurrent()) this.setData({ templates })
    } catch (e) {
      if (!isCurrent()) return
      console.error("[loadTemplates] failed:", e)
      showDataError("模板加载失败", e, "出行模板从数据库加载失败，请稍后重试。")
    }
  },

  onManageTemplates() {
    if (this.data.submitting || this.data.publishedRide) return
    if (!this.ensureLoginBeforeCreate_driver()) return
    this._templateReadRevision = (this._templateReadRevision || 0) + 1
    this._templatesPromise = null
    wx.navigateTo({ url: "/pages/home/CarpoolTemplateList/CarpoolTemplateList" })
  },

  decorateWeeklyShortcut(route) {
    let weekdayIndex = Number.isInteger(route.weekdayIndex) && route.weekdayIndex >= 0 && route.weekdayIndex <= 6
      ? route.weekdayIndex : null
    if (weekdayIndex === null) {
      const match = /^(?:每周|周|星期)([一二三四五六日天])$/.exec(String(route.weekdayText || "").trim())
      if (match) weekdayIndex = "一二三四五六日".indexOf(match[1] === "天" ? "日" : match[1])
    }
    const time = this.normalizeTimeStr(route.departureTime || "")
    const options = { now: Date.now() }
    const occurrence = route.backendTemplate ? publishApi.templateOccurrence(route.backendTemplate, options.now) : null
    const nextDepartureDate = route.backendTemplate ? occurrence?.date || ""
      : rideTime.getNextWeeklyRideDate(weekdayIndex, time, options)
    const weekdayText = weekdayIndex === null ? "" : ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][weekdayIndex]
    const nextDepartureLabel = nextDepartureDate
      ? `${Number(nextDepartureDate.slice(5, 7))}月${Number(nextDepartureDate.slice(8, 10))}日` : "请确认日期时间"
    return { ...route, weekdayIndex, weekdayText, departureTime: time,
      weeklyLabel: weekdayText ? `每${weekdayText}` : "星期待设置",
      nextDepartureDate, nextDepartureLabel }
  },

  onTemplateTap(e) {
    if (this.data.submitting || this.data.publishedRide || this.data.mode !== "driver") return
    const id = e.currentTarget.dataset.id
    const tpl = (this.data.templates || []).find(x => x._id === id)
    if (!tpl) return

    // Recompute on tap: a card may have stayed open past its departure time.
    const weekly = this.decorateWeeklyShortcut(tpl)
    this.applyDriverShortcut(tpl, weekly.nextDepartureDate, weekly.departureTime)
    wx.showToast({ title: weekly.nextDepartureDate ? `已填入${weekly.nextDepartureLabel} ${weekly.weekdayText}` : "模板已填入，请选择日期时间", icon: "none", duration: 1800 })
  },

  applyDriverShortcut(route, date, time) {
    this._selectedTemplate = route.backendTemplate || null
    const seat = Number(route.passengerCount)
    const referencePrice = String(route.referencePrice ?? "")
    const comment = route.comment || ""
    this._priceManuallyEdited = !!referencePrice
    this._returnDepartureTimestamp = null
    this.setData({
      departureAddress: route.departureAddress || "",
      destinationAddress: route.destinationAddress || "",
      passengerCount: seat,
      passengerCountInput: String(seat),
      referencePrice,
      referencePriceHasNumber: !!referencePrice,
      comment,
      commentExpanded: !!comment,
      templatesExpanded: false,
      preparingReturn: false,
      publishedRide: null,
      departureDate: date,
      departureTime: time
    }, () => {
      if (!referencePrice && !this._selectedTemplate) this.updateReferencePrice_driver()
      this.refreshTemplateRouteSummary()
    })
  },

  normalizeTimeStr(t) {
    const s = String(t).trim()
    const m = s.match(/^([01]?\d|2[0-3]):([0-5]?\d)(?::[0-5]\d)?$/)
    if (!m) return ""
    const hh = m[1].padStart(2, "0")
    const mm = m[2].padStart(2, "0")
    return `${hh}:${mm}`
  },

  getNearestDateByWeekdayIndex_Mon0(idx) {
    if (!Number.isInteger(idx) || idx < 0 || idx > 6) return ""
    const targetJsDay = (idx + 1) % 7
    const today = this.getFilterDateData().todayDateStr
    const todayJsDay = rideTime.getRideWeekday(today)
    const add = (targetJsDay - todayJsDay + 7) % 7
    return rideTime.shiftRideDate(today, add)
  },

  // -------------------------
  // ✅ 统一入口：confirmTrip 分流到司机/乘客原逻辑
  // -------------------------
  async confirmTrip() {
    if (this.data.submitting || this._submitInFlight || this.data.publishedRide || this._calendarDisposed) return
    if (this.isLoggedIn()) {
      const identity = profileApi.identity()
      this._submitInFlight = true
      this.setData({ submitting: true })
      try {
        const recovered = await publishApi.recoverPublishedRide()
        if (this._calendarDisposed || identity !== profileApi.identity()) return
        if (recovered) {
          this._publishedOwner = wx.getStorageSync('openid') || ''
          this.setData({ publishedRide: { id: recovered.id, recovered: true }, preparingReturn: false })
          markRideListStale()
          return
        }
      } catch (error) {
        if (!this._calendarDisposed && identity === profileApi.identity()) this.showError('上次发布结果尚未确认，请重试')
        return
      } finally {
        this._submitInFlight = false
        if (!this._calendarDisposed && identity === profileApi.identity()) this.setData({ submitting: false })
      }
    }
    if (this.data.mode === "driver") return this.driver_confirmTrip()
    return this.passenger_confirmTrip()
  },

  // =========================
  // 司机：confirmTrip / submitTrip
  // =========================
  driver_confirmTrip() {
    if (this.data.submitting || this._submitInFlight || this.data.publishedRide) return
    const seat = Number(this.data.passengerCountInput)
    const maxSeats = 8
    if (!Number.isInteger(seat) || seat < 1 || seat > maxSeats) {
      this.showError(`载客数量必须为 1-${maxSeats} 的整数`)
      return
    }
    this.setData({ passengerCount: seat })

    if (!this.ensureLoginBeforeCreate_driver()) return
    if (this.data.submitting) return
    if (this.data.loadingUserInfo) return this.showError("正在读取司机资料，请稍候")

    const {
      userInfo,
      departureAddress,
      destinationAddress,
      departureDate,
      departureTime,
      passengerCount,
      carNumber,
      carBrand,
      carModel,
      referencePrice
    } = this.data

    if (!userInfo) {
      this.promptDriverProfile("请先填写个人信息和车辆资料，返回后可继续发布。")
      return
    }

    // 微信号校验
    if (!userInfo.wechatID || !String(userInfo.wechatID).trim()) {
      this.promptDriverProfile("请先填写微信号，方便加入的乘客联系你。")
      return
    }

    if (!carNumber || !carBrand || !carModel) {
      this.promptDriverProfile("请先填写车牌号、车辆品牌和型号，返回后会保留已填路线。")
      return
    }

    if (!departureAddress || !destinationAddress) return this.showError("请选择出发地和目的地")
    if (departureAddress === destinationAddress) return this.showError("出发地与目的地不能相同")
    if (!departureDate || !departureTime) return this.showError("请完善出发日期和时间")

    const selectedTime = this.parseDateTimeSafe(departureDate, departureTime)
    if (!selectedTime || isNaN(selectedTime.getTime())) return this.showError("时间解析失败，请重新选择日期和时间")

    const now = new Date()
    const diffMin = (selectedTime.getTime() - now.getTime()) / (1000 * 60)
    if (diffMin < 15) return this.showError("发车时间需晚于当前15分钟")
    if (diffMin > 43200) return this.showError("发车时间不能超过30天")
    if (this.data.preparingReturn && selectedTime.getTime() <= this._returnDepartureTimestamp) {
      return this.showError("返程时间需晚于去程时间")
    }

    const referencePriceText = String(referencePrice || "").trim()
    if (!referencePriceText) return this.showError("请填写参考价格")

    let fullRoute = ""
    try { fullRoute = publishApi.summarizeStops(publishApi.toRideInput(this.captureDriverDraft()).stops) }
    catch (error) { return this.showError(error.message) }
    const summary =
      `${fullRoute}\n` +
      `载客数：${passengerCount}\n` +
      `参考价格：${referencePriceText}\n` +
      `公开 Zelle 信息：${this.data.showZelle ? "是" : "否"}`

    const draft = this.captureDriverDraft()
    this.setData({ submitting: true })
    let answered = false
    wx.showModal({
      title: "确认新建路线",
      content: summary,
      success: (res) => {
        if (answered || this._calendarDisposed) return
        answered = true
        if (res.confirm) this.driver_submitTrip(draft)
        else this.setData({ submitting: false })
      },
      fail: () => { if (!this._calendarDisposed) this.setData({ submitting: false }) }
    })
  },

  captureDriverDraft() {
    const { departureAddress, destinationAddress, departureDate, departureTime, passengerCount, referencePrice, comment } = this.data
    const rideCity = getRideCitySnapshot()
    return { kind: "offer", departureAddress, destinationAddress, departureDate, departureTime, passengerCount,
      referencePrice: String(referencePrice ?? ""), comment,
      ...(this._selectedTemplate ? { template: JSON.parse(JSON.stringify(this._selectedTemplate)) } : {}),
      hasUserInfo: !!this.data.userInfo,
      openid: wx.getStorageSync("openid") || "", cityKey: rideCity.key || DEFAULT_CITY_KEY }
  },

  onPrepareReturnTrip() {
    const trip = this.data.publishedRide
    if (!trip || this.data.submitting || this._submitInFlight) return
    if (this._publishedOwner !== (wx.getStorageSync("openid") || "")) return
    if (trip.recovered || trip.kind === 'request' || (trip.stops && trip.stops.length > 2)) return
    this._selectedTemplate = null
    this._returnDepartureTimestamp = rideTime.parseRideDateTime(trip.departureDate, trip.departureTime)
    this._priceManuallyEdited = true
    this.setData({
      departureAddress: trip.destinationAddress,
      destinationAddress: trip.departureAddress,
      departureDate: trip.departureDate,
      departureTime: "",
      passengerCount: trip.passengerCount,
      passengerCountInput: String(trip.passengerCount),
      referencePrice: trip.referencePrice,
      referencePriceHasNumber: !!trip.referencePrice,
      comment: trip.comment || "",
      commentExpanded: !!trip.comment,
      templateRouteSummary: "",
      publishedRide: null,
      preparingReturn: true
    })
  },

  onReturnHome() {
    if (this.data.submitting || this._submitInFlight) return
    wx.reLaunch({ url: "/pages/home/home" })
  },

  async driver_submitTrip(draft = this.captureDriverDraft()) {
    if (this._submitInFlight || this.data.publishedRide || this._calendarDisposed) return
    this._submitInFlight = true
    if (!this.data.submitting) this.setData({ submitting: true })

    try {
      const {
        departureAddress,
        destinationAddress,
        departureDate,
        departureTime,
        passengerCount,
        comment,
        referencePrice
      } = draft

      if (!draft.hasUserInfo || !draft.openid || draft.openid !== (wx.getStorageSync("openid") || "")) {
        this.showError("用户信息缺失，请重新打开页面")
        return
      }

      const created = await publishApi.publishRide(draft)
      markRideListStale()
      if (!this._calendarDisposed && draft.openid === (wx.getStorageSync("openid") || "") && !wx.getStorageSync("isGuest")) {
        this._publishedOwner = draft.openid
        this.setData({ publishedRide: created.recovered ? { id: created.id, recovered: true } : {
          id: created.id, kind: 'offer', departureAddress, destinationAddress, departureDate, departureTime,
          passengerCount, referencePrice, comment, ...(created.payload ? { stops: created.payload.stops, routeSummary: publishApi.summarizeStops(created.payload.stops) } : {})
        }, preparingReturn: false })
      }
    } catch (e) {
      if (this._calendarDisposed || draft.openid !== (wx.getStorageSync("openid") || "") || wx.getStorageSync("isGuest")) return
      console.error("driver_submitTrip error:", e)
      this.showError("路线创建失败，请重试")
    } finally {
      this._submitInFlight = false
      if (!this._calendarDisposed) this.setData({ submitting: false })
    }
  },

  // =========================
  // 乘客：confirmTrip / submitRequest
  // =========================
  passenger_confirmTrip() {
    if (this.data.submitting || this._submitInFlight || this.data.publishedRide) return
    if (!this.ensureLoginBeforeCreate_passenger()) return

    const {
      userInfo, departureAddress, destinationAddress,
      departureDate, departureTime, passengerCount, referencePrice
    } = this.data

    if (!userInfo) {
      wx.showToast({ title: "请先完善个人信息", icon: "none" })
      wx.setStorageSync("pendingPage", { url: "/pages/home/newTrip/newTrip?mode=passenger" })
      wx.navigateTo({ url: "/pages/profile/addInfo/addInfo?from=login" })
      return
    }

    if (!departureAddress || !destinationAddress) return this.showError("请选择出发地和目的地")
    if (departureAddress === destinationAddress) return this.showError("出发地与目的地不能相同")
    if (!departureDate || !departureTime) return this.showError("请完善出发日期和时间")
    const referencePriceText = String(referencePrice || "").trim()
    if (!referencePriceText) return this.showError("价格信息缺失，请重新选择地址")

    const selectedTime = this.parseDateTimeSafe(departureDate, departureTime)
    if (!selectedTime || isNaN(selectedTime.getTime())) return this.showError("时间解析失败，请重新选择日期和时间")

    const now = new Date()
    const diffMin = (selectedTime - now) / (1000 * 60)
    if (diffMin < 15) return this.showError("出发时间需晚于当前15分钟")
    if (diffMin > 43200) return this.showError("出发时间不能超过30天")

    if (!Number.isInteger(Number(passengerCount)) || passengerCount < 1 || passengerCount > 4) return this.showError("乘客数需为 1-4 的整数")
    try { publishApi.toRideInput(this.capturePassengerDraft()) }
    catch (error) { return this.showError(error.message) }
    const summary =
      `出发：${departureAddress}  ${departureDate} ${departureTime}\n` +
      `到达：${destinationAddress}\n` +
      `人数：${passengerCount}\n` +
      `价格：${referencePriceText}`

    const draft = this.capturePassengerDraft()
    this.setData({ submitting: true })

    let answered = false
    wx.showModal({
      title: "确认发起求车",
      content: summary,
      success: async (res) => {
        if (answered || this._calendarDisposed) return
        answered = true
        if (!res.confirm) {
          this.setData({ submitting: false })
          return
        }
        await this.passenger_submitRequest(draft)
      },
      fail: () => { if (!this._calendarDisposed) this.setData({ submitting: false }) }
    })
  },

  capturePassengerDraft() {
    const { departureAddress, destinationAddress, departureDate, departureTime, passengerCount, referencePrice } = this.data
    const rideCity = getRideCitySnapshot()
    return { kind: 'request', departureAddress, destinationAddress, departureDate, departureTime, passengerCount,
      referencePrice: String(referencePrice || ''), comment: '', cityKey: rideCity.key || DEFAULT_CITY_KEY,
      openid: wx.getStorageSync('openid') || '', hasUserInfo: !!this.data.userInfo }
  },

  refreshTemplateRouteSummary() {
    let templateRouteSummary = ''
    if (this._selectedTemplate?.definition.stops.length > 2) {
      try { templateRouteSummary = publishApi.summarizeStops(publishApi.toRideInput(this.captureDriverDraft()).stops) }
      catch (_) { templateRouteSummary = '多站路线：' + this._selectedTemplate.definition.stops.map(stop => stop.address).join(' → ') + '（请确认完整出发时间）' }
    }
    this.setData({ templateRouteSummary })
  },

  async passenger_submitRequest(draft = this.capturePassengerDraft()) {
    if (this._submitInFlight || this.data.publishedRide || this._calendarDisposed) return
    this._submitInFlight = true
    this.setData({ submitting: true })
    try {
      const { departureAddress, destinationAddress, departureDate, departureTime, passengerCount, referencePrice } = draft
      if (!draft.hasUserInfo || !draft.openid || draft.openid !== (wx.getStorageSync('openid') || '') || wx.getStorageSync('isGuest')) {
        this.showError("请先完善个人信息")
        return
      }
      const created = await publishApi.publishRide(draft)
      markRideListStale()
      if (this._calendarDisposed || draft.openid !== (wx.getStorageSync('openid') || '') || wx.getStorageSync('isGuest')) return
      this._publishedOwner = draft.openid
      this.setData({ publishedRide: created.recovered ? { id: created.id, recovered: true } : {
        id: created.id, kind: 'request', departureAddress, destinationAddress, departureDate, departureTime,
        passengerCount, referencePrice, ...(created.payload ? { stops: created.payload.stops, routeSummary: publishApi.summarizeStops(created.payload.stops) } : {})
      } })
      wx.showToast({ title: created.recovered ? "已确认上次发布" : "已发布求车", icon: "success", duration: 1800 })
      if (!created.recovered) setTimeout(() => {
        if (!this._calendarDisposed && draft.openid === (wx.getStorageSync('openid') || '') && !wx.getStorageSync('isGuest')) wx.reLaunch({ url: "/pages/home/home" })
      }, 1200)
    } catch (e) {
      if (this._calendarDisposed || draft.openid !== (wx.getStorageSync('openid') || '') || wx.getStorageSync('isGuest')) return
      console.error("passenger_submitRequest error:", e)
      this.showError("求车创建失败，请重试")
    } finally {
      this._submitInFlight = false
      if (!this._calendarDisposed) this.setData({ submitting: false })
    }
  }
})
