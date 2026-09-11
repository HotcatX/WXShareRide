const rideCalendar = require("./rideCalendar")

const CALENDAR_CACHE_TTL = 5 * 60 * 1000
const CALENDAR_CACHE_LIMIT = 20
const calendarReads = new Map()

function trimCalendarCache() {
  // Keep in-flight requests available to other pages until they finish.
  for (const [key, entry] of calendarReads) {
    if (calendarReads.size <= CALENDAR_CACHE_LIMIT) break
    if (!entry.promise) calendarReads.delete(key)
  }
}

function copyCounts(counts) {
  const result = {}
  Object.keys(counts).forEach(date => { result[date] = { ...counts[date] } })
  return result
}

// Page adapters supply the selected date, filters, viewer and confirmed selection.
// Monthly counts and pending reads are shared; selection and rendering stay page-local.
const data = {
  todayDateStr: "",
  tomorrowDateStr: "",
  calendarConfirmText: "查看这一天",
  calendarVisible: false,
  calendarMonth: "",
  calendarMonthTitle: "",
  calendarDays: [],
  calendarSelectedDate: "",
  calendarCanPrev: false,
  calendarCanConfirm: false,
  calendarSelectionLabel: "请选择日期",
  calendarLoading: false,
  calendarError: ""
}

const methods = {
  stopCalendarTouchMove() {},

  getCalendarRequestKey() {
    const request = this.getCalendarRequest()
    const filters = Object.keys(request).sort().map(name => {
      const value = request[name]
      const preset = name === "fromPresets" || name === "toPresets"
      return [name, preset && Array.isArray(value) ? value.slice().sort() : value]
    })
    return JSON.stringify([filters, this.getListViewerKey(), this.getRideListRefreshAt(), this.data.todayDateStr])
  },

  renderCalendar() {
    if (!this.data.calendarMonth) return
    const selected = this.data.calendarSelectedDate
    const today = this.data.todayDateStr || this.getFilterDateData().todayDateStr
    this.setData({
      calendarMonthTitle: rideCalendar.formatMonthTitle(this.data.calendarMonth),
      calendarCanPrev: this.data.calendarMonth > today.slice(0, 7),
      calendarCanConfirm: this.isValidFilterDate(selected) && selected >= today,
      calendarSelectionLabel: selected ? `${Number(selected.slice(5, 7))}月${Number(selected.slice(8, 10))}日` : "请选择日期",
      calendarDays: rideCalendar.buildCalendarDays({
        month: this.data.calendarMonth, today, selectedDate: selected,
        counts: this._calendarCounts || {}, countsReady: !!this._calendarCountsReady
      })
    })
  },

  onOpenCalendar() {
    const dates = this.getFilterDateData()
    const candidate = typeof this.getCalendarInitialDate === "function" ? this.getCalendarInitialDate() :
      this.data.selectedDate || (this.data.timeFilterIndex === 1 ? dates.tomorrowDateStr : dates.todayDateStr)
    const selected = this.isValidFilterDate(candidate) && candidate >= dates.todayDateStr ? candidate : dates.todayDateStr
    this._calendarCounts = {}
    this._calendarCountsReady = false
    this.setData({
      ...dates, calendarVisible: true, refineFiltersVisible: false, placePickerVisible: false, cityPickerVisible: false,
      calendarMonth: selected.slice(0, 7), calendarSelectedDate: selected,
      calendarLoading: false, calendarError: ""
    })
    this.renderCalendar()
    return this.loadCalendarCounts()
  },

  onCloseCalendar() {
    this.setData({ calendarVisible: false })
    if (typeof this.onCalendarDismiss === "function") this.onCalendarDismiss()
  },

  changeCalendarMonth(delta) {
    const month = rideCalendar.shiftMonth(this.data.calendarMonth, delta)
    if (month < this.data.todayDateStr.slice(0, 7)) return
    this._calendarCounts = {}
    this._calendarCountsReady = false
    this.setData({ calendarMonth: month, calendarSelectedDate: "", calendarLoading: false, calendarError: "" })
    this.renderCalendar()
    return this.loadCalendarCounts()
  },

  onCalendarPrevMonth() {
    if (this.data.calendarCanPrev) return this.changeCalendarMonth(-1)
  },

  onCalendarNextMonth() {
    return this.changeCalendarMonth(1)
  },

  onCalendarSelectDate(e) {
    const date = e.currentTarget.dataset.date
    if (!this.data.calendarVisible || !this.isValidFilterDate(date) || date < this.data.todayDateStr ||
      date.slice(0, 7) !== this.data.calendarMonth) return
    this.setData({ calendarSelectedDate: date })
    this.renderCalendar()
  },

  onCalendarConfirm() {
    const date = this.data.calendarSelectedDate
    if (!this.data.calendarVisible || !this.isValidFilterDate(date) || date < this.data.todayDateStr) return
    this.applyCalendarSelection(date)
  },

  onCalendarRetry() {
    return this.loadCalendarCounts({ force: true })
  },

  async loadCalendarCounts(options = {}) {
    if (!this.data.calendarVisible || (this._listDisposed || this._calendarDisposed)) return
    const key = this.getCalendarRequestKey()
    const request = this.getCalendarRequest()
    const reads = calendarReads
    let entry = reads.get(key)
    const now = Date.now()
    if (!entry || (!entry.promise && (options.force || !entry.days || now - entry.at < 0 || now - entry.at >= CALENDAR_CACHE_TTL))) {
      entry = { at: 0, days: null, promise: null }
      reads.set(key, entry)
      const pending = entry
      entry.promise = (async () => {
        const res = await wx.cloud.callFunction({ name: "getTripList", data: request })
        const result = res && res.result
        if (!result || !result.success || result.month !== request.month || !Array.isArray(result.data && result.data.days)) {
          throw new Error(result && result.errorMsg || "无法读取日历统计")
        }
        const counts = {}
        result.data.days.forEach(day => {
          if (!this.isValidFilterDate(day.date) || !day.date.startsWith(`${request.month}-`) ||
            !Number.isSafeInteger(day.carpoolCount) || day.carpoolCount < 0 ||
            !Number.isSafeInteger(day.requestCount) || day.requestCount < 0) throw new Error("日历统计格式错误")
          counts[day.date] = { carpoolCount: day.carpoolCount, requestCount: day.requestCount }
        })
        pending.days = counts
        pending.at = Date.now()
      })().finally(() => {
        pending.promise = null
        trimCalendarCache()
      })
    }
    // Refresh recency without extending the five-minute lifetime of the result.
    reads.delete(key)
    reads.set(key, entry)
    trimCalendarCache()
    this._calendarReadEntry = entry
    const isCurrent = () => !(this._listDisposed || this._calendarDisposed) && this.data.calendarVisible &&
      key === this.getCalendarRequestKey() && this._calendarReadEntry === entry
    if (entry.promise) {
      this._calendarCounts = {}
      this._calendarCountsReady = false
      this.setData({ calendarLoading: true, calendarError: "" })
      this.renderCalendar()
    }
    try {
      if (entry.promise) await entry.promise
      if (!isCurrent()) return
      this._calendarCounts = copyCounts(entry.days)
      this._calendarCountsReady = true
      this.setData({ calendarLoading: false, calendarError: "" })
      this.renderCalendar()
    } catch (error) {
      if (!isCurrent()) return
      this._calendarCounts = {}
      this._calendarCountsReady = false
      this.setData({ calendarLoading: false, calendarError: "统计加载失败，点击重试" })
      this.renderCalendar()
    }
  }
}

module.exports = { data, methods }
