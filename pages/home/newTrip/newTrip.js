const { showDataError } = require("../../../utils/error")
const rideCalendarPicker = require("../../../utils/rideCalendarPicker")
const { loadRidePlaceOptions } = require("../../../utils/ridePlaceOptions")
const {
  markRideListStale,
  normalizeRidePriceInput,
  extractRidePriceNumber,
  formatRidePricePerPerson
} = require("../../../utils/tripManage")
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
    mode: "driver", // 默认司机

    userInfo: null,
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

    referencePrice: "10",
    referencePriceHasNumber: true,
    comment: "",
    showZelle: false,

    templates: [],
    loadingTemplates: false,

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

  onUnload() {
    this._calendarDisposed = true
    this._placeReadRevision = (this._placeReadRevision || 0) + 1
  },

  // -------------------------
  // 顶部切换
  // -------------------------
  setMode(e) {
    const mode = e.currentTarget.dataset.mode
    if (!["driver", "passenger"].includes(mode) || mode === this.data.mode) return

    this.setData({
      mode,
      calendarVisible: false,
      timePickerVisible: false,
      placePickerVisible: false,
      departureAddress: "",
      destinationAddress: "",
      referencePrice: "",
      referencePriceHasNumber: false,
      // passengerCountInput 只给司机用；乘客人数你也可保留不动
    }, async () => {
      // ✅ 用“新 mode”去加载对应地址集合
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
    return !!openid
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
    if (!dateStr || !timeStr) return null
    const d = dateStr.split("-").map(n => parseInt(n, 10))
    const t = timeStr.split(":").map(n => parseInt(n, 10))
    if (d.length !== 3 || t.length !== 2) return null
    const [Y, M, D] = d
    const [hh, mm] = t
    if (!Y || !M || !D || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
    return new Date(Y, M - 1, D, hh, mm, 0, 0)
  },

  // -------------------------
  // userInfo
  // -------------------------
  async loadUserInfo() {
    if (!this.isLoggedIn()) {
      this.setData({ userInfo: null })
      return
    }

    try {
      const res = await wx.cloud.callFunction({ name: "getUserInfo" })
      const list = res?.result?.data || []
      if (!list.length) {
        this.setData({ userInfo: null })
        return
      }

      const user = list[0]
      // 司机模式：车信息要预填
      this.setData({
        userInfo: user,
        carNumber: user.carNumber || this.data.carNumber || "",
        carBrand: user.carBrand || this.data.carBrand || "",
        carModel: user.carModel || this.data.carModel || ""
      })
    } catch (e) {
      console.error("loadUserInfo error:", e)
      showDataError("资料加载失败", e, "个人资料从数据库加载失败，请稍后重试。")
    }
  },

  // -------------------------
  // 地址列表（根据 mode 调用不同 type）
  // -------------------------
  async loadAllAddresses() {
    const mode = this.data.mode
    const revision = this._addressReadRevision = (this._addressReadRevision || 0) + 1
    const isCurrent = () => !this._calendarDisposed && revision === this._addressReadRevision && mode === this.data.mode
    this.setData({ loadingDepartureAddrs: true, loadingArrivalAddrs: true })

    try {
      const depType = (this.data.mode === "passenger") ? "Departure_Request" : "Departure"
      const arrType = (this.data.mode === "passenger") ? "Arrival_Request" : "Arrival"

      const [dep, arr] = await Promise.all([
        this.loadAddressList(depType),
        this.loadAddressList(arrType)
      ])
      if (!isCurrent()) return

      this.setData({
        departureAddresses: [...(dep || []), "其他"],
        arrivalAddresses: [...(arr || []), "其他"],
        loadingDepartureAddrs: false,
        loadingArrivalAddrs: false
      }, () => { if (this.data.placePickerVisible) this.updatePlacePickerData() })
    } catch (e) {
      if (!isCurrent()) return
      console.error("loadAllAddresses error:", e)
      this.setData({ loadingDepartureAddrs: false, loadingArrivalAddrs: false })
      showDataError("地址加载失败", e, "地址配置从数据库加载失败，请稍后重试。")
    }
  },

  async loadAddressList(type) {
    try {
      const res = await wx.cloud.callFunction({
        name: "getAddressList",
        data: { type }
      })
      if (res?.result?.success) return res.result.addressList || []
      throw new Error(res?.result?.errorMsg || res?.result?.message || "getAddressList 返回失败")
    } catch (e) {
      console.error("loadAddressList error:", e)
      throw e
    }
  },

  // 地址变化后的分流：司机更新默认参考价；乘客查 Request_Price
  async afterAddressChanged() {
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
    const format = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
    return { todayDateStr: format(now), tomorrowDateStr: format(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)) }
  },

  isValidFilterDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false
    const [year, month, day] = value.split("-").map(Number)
    const date = new Date(year, month - 1, day)
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
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
    this.setData({ departureDate: date, calendarVisible: false })
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
    this.setData({ departureTime: value, timePickerVisible: false })
  },

  onOpenPlacePicker(e) {
    this._placePickerField = e.currentTarget.dataset.type === "destination" ? "destination" : "departure"
    wx.hideKeyboard()
    this.setData({
      placePickerVisible: true, calendarVisible: false, timePickerVisible: false,
      placePickerTitle: this._placePickerField === "departure" ? "选择出发地" : "选择目的地",
      placePickerError: "", placePickerOptions: [], placePickerLoading: false
    })
    this.updatePlacePickerData()
    return this.loadPlaceSuggestions()
  },

  updatePlacePickerData() {
    const isDeparture = this._placePickerField !== "destination"
    const configured = (isDeparture ? this.data.departureAddresses : this.data.arrivalAddresses) || []
    const fixed = configured.filter(value => /fort\s*lee|哥大|columbia/i.test(value))
    if (!fixed.some(value => /fort\s*lee/i.test(value))) fixed.unshift("Fort Lee")
    if (!fixed.some(value => /哥大|columbia/i.test(value))) fixed.push("哥大")
    const suggestions = this._placeSuggestions || {}
    this.setData({
      placePickerFixedOptions: fixed,
      placePickerValue: isDeparture ? this.data.departureAddress : this.data.destinationAddress,
      placePickerOptions: isDeparture ? (suggestions.fromPlaces || []) : (suggestions.toPlaces || [])
    })
  },

  async loadPlaceSuggestions(options = {}) {
    if (!this.data.placePickerVisible || this._calendarDisposed) return
    const revision = this._placeReadRevision = (this._placeReadRevision || 0) + 1
    const context = {
      cityKey: getRideCitySnapshot().key || DEFAULT_CITY_KEY,
      viewerKey: this.getListViewerKey(), revision: this.getRideListRefreshAt(), force: !!options.force
    }
    const contextKey = JSON.stringify([context.cityKey, context.viewerKey, context.revision])
    if (contextKey !== this._placeSuggestionsKey) {
      this._placeSuggestions = null
      this._placeSuggestionsKey = contextKey
      this.updatePlacePickerData()
    }
    this.setData({ placePickerLoading: true, placePickerError: "" })
    const isCurrent = () => !this._calendarDisposed && this.data.placePickerVisible && revision === this._placeReadRevision &&
      context.viewerKey === this.getListViewerKey() && context.revision === this.getRideListRefreshAt() &&
      context.cityKey === (getRideCitySnapshot().key || DEFAULT_CITY_KEY)
    try {
      const result = await loadRidePlaceOptions(context)
      if (!isCurrent()) return
      this._placeSuggestions = result
      this.updatePlacePickerData()
      this.setData({ placePickerLoading: false })
    } catch (error) {
      if (!isCurrent()) return
      this.setData({ placePickerLoading: false, placePickerError: "地点加载失败，点击重试" })
    }
  },

  onRetryPlaceSuggestions() { return this.loadPlaceSuggestions({ force: true }) },

  onClosePlacePicker() {
    this._placeReadRevision = (this._placeReadRevision || 0) + 1
    this.setData({ placePickerVisible: false })
  },

  async onConfirmPlace(e) {
    if (!this.data.placePickerVisible) return
    const value = typeof e.detail.value === "string" ? e.detail.value.trim() : ""
    if (!value || value.length > 200) return
    const field = this._placePickerField === "destination" ? "destinationAddress" : "departureAddress"
    this.onClosePlacePicker()
    this.setData({ [field]: value })
    await this.afterAddressChanged()
  },

  // -------------------------
  // 司机：人数输入（允许先输入，提交时校验 1-7）
  // -------------------------
  onPassengerInput(e) {
    const v = String(e.detail.value || "")
    this.setData({ passengerCountInput: v })
  },

  safeSeat(val) {
    const n = parseInt(val, 10)
    if (isNaN(n)) return this.data.passengerCount || 1
    return Math.min(7, Math.max(1, n))
  },

  // -------------------------
  // 司机：车/价/备注/zelle
  // -------------------------
  onCarNumberInput(e) { this.setData({ carNumber: e.detail.value }) },
  onCarBrandInput(e) { this.setData({ carBrand: e.detail.value }) },
  onCarModelInput(e) { this.setData({ carModel: e.detail.value }) },
  onReferencePriceInput(e) {
    this.setData({
      referencePrice: normalizeRidePriceInput(e.detail.value),
      referencePriceHasNumber: true
    })
  },
  onCommentInput(e) { this.setData({ comment: e.detail.value }) },

  onZelleCheckboxChange(e) {
    const values = e.detail.value || []
    this.setData({ showZelle: values.includes("showZelle") })
  },

  // -------------------------
  // 乘客：人数输入（1-4）
  // -------------------------
  onPassengerInputPassenger(e) {
    const num = parseInt(e.detail.value, 10)
    if (isNaN(num) || num < 1 || num > 4) return this.showError("乘客数需为 1-4 的整数")
    this.setData({ passengerCount: num })
  },

  onCarpoolChange(e) {
    const checked = (e.detail.value || []).includes("1")
    this.setData({ acceptCarpool: checked })
  },

  // -------------------------
  // 乘客：查 Request_Price
  // -------------------------
  async updateReferencePriceFromRequestPrice() {
    const dep = (this.data.departureAddress || "").trim()
    const dest = (this.data.destinationAddress || "").trim()
    if (!dep || !dest) return
    const isCurrent = () => !this._calendarDisposed && this.data.mode === "passenger" &&
      dep === String(this.data.departureAddress || "").trim() && dest === String(this.data.destinationAddress || "").trim()

    try {
      const db = wx.cloud.database()
      const res = await db.collection("Request_Price")
        .where({ Departure: dep, Destination: dest })
        .limit(1)
        .get()

      const row = (res?.data?.length) ? res.data[0] : null
      if (!isCurrent()) return
      if (row && row.Price !== undefined && row.Price !== null && String(row.Price).trim() !== "") {
        const priceNumber = extractRidePriceNumber(row.Price)
        this.setData({
          referencePrice: priceNumber || String(row.Price).trim(),
          referencePriceHasNumber: !!priceNumber,
          priceLocked: true
        })
      } else {
        this.setData({
          referencePrice: "参考打车价格",
          referencePriceHasNumber: false,
          priceLocked: true
        })
      }
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
    const dep = this.data.departureAddress
    const dest = this.data.destinationAddress
    if (!dep || !dest) return

    const userInfo = this.data.userInfo || {}
    const customPrice = userInfo.customPrice || {}

    const COL = "哥大"
    const FL_CORE = "Fort Lee 核心区"
    const FL_NONCORE = "Fort Lee 全区域"

    const hasColumbia = dep === COL || dest === COL
    const hasCore = dep === FL_CORE || dest === FL_CORE
    const hasNonCore = dep === FL_NONCORE || dest === FL_NONCORE

    if (hasColumbia && hasNonCore) {
      const val = extractRidePriceNumber(customPrice.fortLeeNonCore)
        ? extractRidePriceNumber(customPrice.fortLeeNonCore)
        : "13 USD"
      this.setData({ referencePrice: extractRidePriceNumber(val) || "13", referencePriceHasNumber: true })
      return
    }

    if (hasColumbia && hasCore) {
      const val = extractRidePriceNumber(customPrice.fortLeeCore)
        ? extractRidePriceNumber(customPrice.fortLeeCore)
        : "10 USD"
      this.setData({ referencePrice: extractRidePriceNumber(val) || "10", referencePriceHasNumber: true })
      return
    }
  },

  // -------------------------
  // 司机：模板（保持同表 CarpoolTemplate）
  // -------------------------
  loadTemplatesIfNeeded() {
    if (this.data.mode !== "driver") return
    this.loadTemplates()
  },

  async loadTemplates() {
    const openid = wx.getStorageSync("openid") || ""
    if (!openid) {
      this.setData({ templates: [], loadingTemplates: false })
      return
    }

    this.setData({ loadingTemplates: true })

    try {
      const db = wx.cloud.database()
      const res = await db.collection("CarpoolTemplate")
        .where({ _openid: openid })
        .orderBy("createdAt", "desc")
        .get()

      const templates = (res.data || []).map(t => ({
        ...t,
        departureText: t.departureAddress || "未设置出发地",
        destinationText: t.destinationAddress || "未设置目的地",
        departureTimeText: `${t.weekdayText || ""} ${t.departureTime || ""}`.trim()
      }))

      this.setData({ templates })
    } catch (e) {
      console.error("[loadTemplates] failed:", e)
      showDataError("模板加载失败", e, "出行模板从数据库加载失败，请稍后重试。")
    } finally {
      this.setData({ loadingTemplates: false })
    }
  },

  onTemplateTap(e) {
    const id = e.currentTarget.dataset.id
    const tpl = (this.data.templates || []).find(x => x._id === id)
    if (!tpl) return

    const dep = tpl.departureAddress || ""
    const dest = tpl.destinationAddress || ""

    const seat = this.safeSeat(tpl.passengerCount)
    const referencePrice = extractRidePriceNumber(tpl.referencePrice) || ""
    const comment = tpl.comment || ""
    const timeStr = tpl.departureTime ? this.normalizeTimeStr(tpl.departureTime) : ""
    const nextDateStr = this.getNearestDateByWeekdayIndex_Mon0(tpl.weekdayIndex)

    this.setData({
      departureAddress: dep,
      destinationAddress: dest,
      passengerCount: seat,
      passengerCountInput: String(seat),
      referencePrice,
      referencePriceHasNumber: !!referencePrice,
      comment,
      departureDate: nextDateStr || this.data.departureDate,
      departureTime: timeStr || this.data.departureTime,
      showZelle: tpl.zelle === "yes" || tpl.zelle === true
    }, () => {
      if (!referencePrice) this.updateReferencePrice_driver()
      wx.showToast({ title: "已应用模板", icon: "success", duration: 1000 })
    })
  },

  normalizeTimeStr(t) {
    const s = String(t).trim()
    const m = s.match(/^(\d{1,2}):(\d{1,2})$/)
    if (!m) return s
    const hh = String(Math.min(23, Math.max(0, parseInt(m[1], 10)))).padStart(2, "0")
    const mm = String(Math.min(59, Math.max(0, parseInt(m[2], 10)))).padStart(2, "0")
    return `${hh}:${mm}`
  },

  getNearestDateByWeekdayIndex_Mon0(idx) {
    if (idx === null || idx === undefined) return ""
    const targetJsDay = (idx + 1) % 7
    const now = new Date()
    const todayJsDay = now.getDay()
    const add = (targetJsDay - todayJsDay + 7) % 7
    const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + add)
    const Y = dt.getFullYear()
    const M = String(dt.getMonth() + 1).padStart(2, "0")
    const D = String(dt.getDate()).padStart(2, "0")
    return `${Y}-${M}-${D}`
  },

  // -------------------------
  // ✅ 统一入口：confirmTrip 分流到司机/乘客原逻辑
  // -------------------------
  confirmTrip() {
    if (this.data.mode === "driver") return this.driver_confirmTrip()
    return this.passenger_confirmTrip()
  },

  // =========================
  // 司机：confirmTrip / submitTrip
  // =========================
  driver_confirmTrip() {
    const seat = parseInt(this.data.passengerCountInput, 10)
    if (!seat || isNaN(seat) || seat < 1 || seat > 7) {
      this.showError("载客数量必须为 1-7 的整数")
      return
    }
    this.setData({ passengerCount: seat })

    if (!this.ensureLoginBeforeCreate_driver()) return
    if (this.data.submitting) return

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
      wx.showToast({ title: "请先完善个人信息", icon: "none" })
      wx.setStorageSync("pendingPage", { url: "/pages/home/newTrip/newTrip" })
      wx.navigateTo({ url: "/pages/profile/addInfo/addInfo?from=login" })
      return
    }

    // 微信号校验
    if (!userInfo.wechatID || !String(userInfo.wechatID).trim()) {
      wx.showToast({ title: "请先在个人中心填写微信号", icon: "none", duration: 2000 })
      return
    }

    if (!departureAddress || !destinationAddress) return this.showError("请选择出发地和目的地")
    if (departureAddress === destinationAddress) return this.showError("出发地与目的地不能相同")
    if (!departureDate || !departureTime) return this.showError("请完善出发日期和时间")

    const selectedTime = this.parseDateTimeSafe(departureDate, departureTime)
    if (!selectedTime || isNaN(selectedTime.getTime())) return this.showError("时间解析失败，请重新选择日期和时间")

    const now = new Date()
    const diffMin = (selectedTime.getTime() - now.getTime()) / (1000 * 60)
    if (diffMin < 12) return this.showError("发车时间需晚于当前15分钟")
    if (diffMin > 43200) return this.showError("发车时间不能超过30天")

    if (!carNumber || !carBrand || !carModel) return this.showError("请完整填写车牌号、车辆品牌和型号")
    const referencePriceText = formatRidePricePerPerson(referencePrice)
    if (!referencePriceText) return this.showError("请填写参考价格")

    const summary =
      `出发：${departureAddress}  ${departureDate} ${departureTime}\n` +
      `到达：${destinationAddress}\n` +
      `载客数：${passengerCount}\n` +
      `参考价格：${referencePriceText}\n` +
      `公开 Zelle 信息：${this.data.showZelle ? "是" : "否"}`

    this.setData({ submitting: true })

    wx.showModal({
      title: "确认新建路线",
      content: summary,
      success: (res) => {
        if (res.confirm) this.driver_submitTrip()
        else this.setData({ submitting: false })
      },
      fail: () => this.setData({ submitting: false })
    })
  },

  async driver_submitTrip() {
    if (!this.data.submitting) this.setData({ submitting: true })

    try {
      const {
        userInfo,
        departureAddress,
        destinationAddress,
        departureDate,
        departureTime,
        passengerCount,
        comment,
        referencePrice,
        carNumber,
        carBrand,
        carModel,
        showZelle
      } = this.data

      if (!userInfo) {
        this.showError("用户信息缺失，请重新打开页面")
        return
      }

      const departures = [{ address: departureAddress, date: departureDate, time: departureTime }]
      const destinations = [{ address: destinationAddress }]
      const rideCity = getRideCitySnapshot()

      const createPayload = {
        type: "carpool",
        cityKey: rideCity.key || DEFAULT_CITY_KEY,
        cityLabel: rideCity.label || "",
        departures,
        destinations,
        passengerCount,
        availSeatNum: passengerCount,
        status: "open",
        passengers: [],
        referencePrice: formatRidePricePerPerson(referencePrice),
        comment,
        zelle: showZelle ? "yes" : "no",
        carNumber,
        carBrand,
        carModel
      }

      const COL = "哥大"
      const FL_CORE = "Fort Lee 核心区"
      const FL_NONCORE = "Fort Lee 全区域"

      const hasColumbia = departureAddress === COL || destinationAddress === COL
      const hasCore = departureAddress === FL_CORE || destinationAddress === FL_CORE
      const hasNonCore = departureAddress === FL_NONCORE || destinationAddress === FL_NONCORE

      const referencePriceText = formatRidePricePerPerson(referencePrice)
      if (hasColumbia && hasNonCore && referencePriceText) {
        createPayload.customPrice = { fortLeeNonCore: referencePriceText }
      } else if (hasColumbia && hasCore && referencePriceText) {
        createPayload.customPrice = { fortLeeCore: referencePriceText }
      }

      const createRes = await wx.cloud.callFunction({
        name: "createTrip",
        data: createPayload
      })

      if (!createRes?.result?.success || !createRes?.result?.id) {
        this.showError("路线创建失败，请重试")
        return
      }

      markRideListStale()
      wx.showToast({ title: "路线创建成功", icon: "success", duration: 2000 })
      setTimeout(() => wx.reLaunch({ url: "/pages/home/home" }), 1500)

    } catch (e) {
      console.error("driver_submitTrip error:", e)
      this.showError("路线创建失败，请重试")
    } finally {
      this.setData({ submitting: false })
    }
  },

  // =========================
  // 乘客：confirmTrip / submitRequest
  // =========================
  passenger_confirmTrip() {
    if (this.data.submitting) return
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
    const referencePriceText = formatRidePricePerPerson(referencePrice)
    if (!referencePriceText) return this.showError("价格信息缺失，请重新选择地址")

    const selectedTime = this.parseDateTimeSafe(departureDate, departureTime)
    if (!selectedTime || isNaN(selectedTime.getTime())) return this.showError("时间解析失败，请重新选择日期和时间")

    const now = new Date()
    const diffMin = (selectedTime - now) / (1000 * 60)
    if (diffMin < 12) return this.showError("出发时间需晚于当前15分钟")
    if (diffMin > 43200) return this.showError("出发时间不能超过30天")

    const summary =
      `出发：${departureAddress}  ${departureDate} ${departureTime}\n` +
      `到达：${destinationAddress}\n` +
      `人数：${passengerCount}\n` +
      `价格：${referencePriceText}`

    this.setData({ submitting: true })

    wx.showModal({
      title: "确认发起求车",
      content: summary,
      success: async (res) => {
        if (!res.confirm) {
          this.setData({ submitting: false })
          return
        }
        await this.passenger_submitRequest()
      },
      fail: () => this.setData({ submitting: false })
    })
  },

  async passenger_submitRequest() {
    try {
      const {
        userInfo,
        departureAddress, destinationAddress,
        departureDate, departureTime,
        passengerCount, referencePrice
      } = this.data
      const referencePriceText = formatRidePricePerPerson(referencePrice, referencePrice)
      const rideCity = getRideCitySnapshot()

      if (!userInfo) {
        this.showError("请先完善个人信息")
        return
      }

      const createRes = await wx.cloud.callFunction({
        name: "createTrip",
        data: {
          type: "request",
          cityKey: rideCity.key || DEFAULT_CITY_KEY,
          cityLabel: rideCity.label || "",
          departures: [{ address: departureAddress, date: departureDate, time: departureTime }],
          destinations: [{ address: destinationAddress }],
          passengerCount,
          largeLuggageCount: 0,
          comment: "",
          referencePrice: referencePriceText
        }
      })

      const ok = createRes?.result?.success
      const requestId = createRes?.result?.id
      const errMsg = createRes?.result?.errorMsg || createRes?.result?.errMsg || ""

      if (!ok || !requestId) {
        this.showError(errMsg ? `求车创建失败：${errMsg}` : "求车创建失败，请重试")
        return
      }

      markRideListStale()
      wx.showToast({ title: "已发布求车", icon: "success", duration: 1800 })
      setTimeout(() => wx.reLaunch({ url: "/pages/home/home" }), 1200)

    } catch (e) {
      console.error("passenger_submitRequest error:", e)
      this.showError("求车创建失败，请重试")
    } finally {
      this.setData({ submitting: false })
    }
  }
})
