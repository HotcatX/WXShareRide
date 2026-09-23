const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { buildCalendarDays, shiftMonth, formatMonthTitle } = require('../utils/rideCalendar')
const city = require('../utils/cityTree')
const pricing = require('../utils/tripManage')
const source = fs.readFileSync(path.join(__dirname, '../pages/home/carpoolList/carpoolList.js'), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
const dateEvent = date => ({ currentTarget: { dataset: { date } } })

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function calendarResponse(month = '2030-01', days = [
  { date: `${month}-15`, carpoolCount: 12, requestCount: 3 },
  { date: `${month}-21`, carpoolCount: 7, requestCount: 1 }
]) {
  return { result: { success: true, month, data: { days } } }
}

function harness({ realStatusRefresh = false } = {}) {
  let definition
  const state = {
    now: Date.parse('2030-01-15T10:00:00'),
    calls: [], queued: [], store: { openid: 'viewer-a' }
  }
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [state.now])) }
    static now() { return state.now }
  }
  const wx = {
    getStorageSync: key => state.store[key],
    setStorageSync: (key, value) => { state.store[key] = plain(value) },
    removeStorageSync: key => { delete state.store[key] },
    showNavigationBarLoading() {}, hideNavigationBarLoading() {}, stopPullDownRefresh() {},
    showToast() {},
    cloud: { callFunction(args) {
      if (args.name === 'syncTripStatus') {
        state.calls.push(args)
        return Promise.resolve({ result: { totalUpdated: 1 } })
      }
      assert.equal(args.name, 'getTripList', 'calendar reads reuse the existing list function')
      state.calls.push(args)
      if (args.data.action === 'calendar') {
        if (state.queued.length) return state.queued.shift().promise
        return Promise.resolve(calendarResponse(args.data.month))
      }
      const { startDate, endDateExclusive } = args.data
      return Promise.resolve({ result: {
        success: true, data: { carpool: [], request: [] },
        page: { startDate, endDateExclusive, nextDate: endDateExclusive, hasMore: false }
      } })
    } }
  }
  const context = {
    Page: value => { definition = value }, wx, Date: Clock, setTimeout, clearTimeout,
    getApp: () => ({ globalData: {} }),
    console: { error() {}, warn() {}, log() {} },
    require(name) {
      if (name.includes('placeRecommendations') || name.includes('placePickerTelemetry')) {
        if (!context._placeModules) context._placeModules = require('./helpers/load-place-modules.cjs')(context, context.require('researchParticipation'))
        return context._placeModules(name)
      }
      if (name.includes('rideTelemetry')) return require('./helpers/load-ride-telemetry.cjs')(context.require('researchParticipation'), { wx, Date: Clock })
      if (name.includes('researchParticipation')) return { recordSearch: () => '', recordResults: () => ({ ok: false }) }
      if (name.includes('rideTime')) return require('../utils/rideTime')
      if (name.includes('cityTree')) return city
      if (name.includes('ridePlaceOptions')) return require('../utils/ridePlaceOptions')
      if (name.includes('rideAddressConfig')) {
        const module = { exports: {} }
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/rideAddressConfig.js'), 'utf8'), {
          ...context, module, require: name => require('../utils/' + (name.includes('placeCatalog') ? 'placeCatalog' : 'ridePlaceOptions'))
        })
        return module.exports
      }
      if (name.includes('tripManage')) return {
        ...pricing,
        markRideListStale() {
          state.store.rideListShouldRefreshAt = Math.max(state.now, Number(state.store.rideListShouldRefreshAt || 0) + 1)
          return state.store.rideListShouldRefreshAt
        }
      }
      if (name.includes('rideCalendarPicker')) {
        const module = { exports: {} }
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/rideCalendarPicker.js'), 'utf8'), {
          ...context, module, require: () => require('../utils/rideCalendar')
        })
        return module.exports
      }
      if (name.includes('error')) return { showDataError() {} }
      throw new Error(`Unexpected dependency: ${name}`)
    }
  }
  vm.runInNewContext(source, context)
  const page = { ...definition, data: plain(definition.data) }
  page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) callback.call(this) }
  Object.assign(page.data, page.getFilterDateData(), page.buildFilterOptionData(['Fort Lee', 'JFK'], ['哥大/Columbia', 'EWR']))
  if (!realStatusRefresh) page.refreshStatusInBackground = async () => {}
  const holdNext = () => { const held = deferred(); state.queued.push(held); return held }
  const open = async () => { page.onOpenCalendar(); await tick() }
  const calendarCalls = () => state.calls.filter(call => call.data.action === 'calendar')
  const listCalls = () => state.calls.filter(call => call.name === 'getTripList' && call.data.action !== 'calendar')
  const day = date => page.data.calendarDays.find(item => item.date === date)
  return { page, state, holdNext, open, calendarCalls, listCalls, day }
}

test('Chinese calendar uses Monday-first complete weeks, unique cell keys and real month days', () => {
  const days = buildCalendarDays({ month: '2026-09', today: '2026-09-11', selectedDate: '', counts: {}, countsReady: true })
  assert.equal(days.length, 35)
  assert.equal(days[0].isPlaceholder, true, 'September 2026 starts Tuesday, leaving Monday empty')
  assert.equal(days[1].date, '2026-09-01')
  assert.equal(days[1].day, 1)
  assert.equal(days.at(-1).isPlaceholder, true)
  assert.equal(days.filter(item => !item.isPlaceholder).length, 30)
  assert.equal(new Set(days.map(item => item.key)).size, days.length)
  assert.equal(formatMonthTitle('2026-09').replace(/\s/g, ''), '2026年9月')
})

test('calendar handles leap February and both year boundaries without date overflow', () => {
  const leap = buildCalendarDays({ month: '2028-02', today: '2028-02-01', counts: {}, countsReady: true })
  assert.equal(leap.filter(item => !item.isPlaceholder).length, 29)
  assert.ok(leap.some(item => item.date === '2028-02-29'))
  const regular = buildCalendarDays({ month: '2029-02', today: '2029-02-01', counts: {}, countsReady: true })
  assert.equal(regular.filter(item => !item.isPlaceholder).length, 28)
  assert.equal(regular.length % 7, 0)
  assert.equal(shiftMonth('2030-12', 1), '2031-01')
  assert.equal(shiftMonth('2030-01', -1), '2029-12')
})

test('date cells distinguish past, today, selection and independently display departure/request totals', () => {
  const days = buildCalendarDays({
    month: '2030-01', today: '2030-01-15', selectedDate: '2030-01-21', countsReady: true,
    counts: { '2030-01-15': { carpoolCount: 12, requestCount: 3 } }
  })
  const find = date => days.find(item => item.date === date)
  assert.equal(find('2030-01-14').isPast, true)
  assert.equal(find('2030-01-15').isPast, false)
  assert.equal(find('2030-01-15').isToday, true)
  assert.equal(find('2030-01-21').isSelected, true)
  assert.equal(find('2030-01-21').isToday, false)
  assert.equal(find('2030-01-15').carpoolCount, 12)
  assert.equal(find('2030-01-15').requestCount, 3)
  assert.equal(find('2030-01-15').carpoolText, '12发')
  assert.equal(find('2030-01-15').requestText, '3求')
  assert.equal(find('2030-01-20').carpoolText, '0发', 'a successful month read establishes zero for omitted days')
  assert.equal(find('2030-01-20').requestText, '0求')
})

test('unknown monthly statistics remain unknown rather than falsely displaying zero', () => {
  const days = buildCalendarDays({ month: '2030-01', today: '2030-01-15', counts: {}, countsReady: false })
  const current = days.find(item => item.date === '2030-01-15')
  assert.equal(current.countsReady, false)
  assert.equal(current.carpoolText, '—发')
  assert.equal(current.requestText, '—求')
})

test('opening calendar starts at today, closes competing sheets, and reads monthly counts without loading routes', async () => {
  const { page, open, calendarCalls, listCalls, day } = harness()
  Object.assign(page.data, { refineFiltersVisible: true, placePickerVisible: true, cityPickerVisible: true })
  await open()
  assert.equal(page.data.calendarVisible, true)
  assert.equal(page.data.refineFiltersVisible, false)
  assert.equal(page.data.placePickerVisible, false)
  assert.equal(page.data.cityPickerVisible, false)
  assert.equal(page.data.calendarMonth, '2030-01')
  assert.equal(page.data.calendarSelectedDate, '2030-01-15')
  assert.equal(page.data.calendarCanPrev, false)
  assert.equal(page.data.calendarCanConfirm, true)
  assert.equal(day('2030-01-15').carpoolText, '12发')
  assert.equal(day('2030-01-15').requestText, '3求')
  assert.equal(calendarCalls().length, 1)
  assert.equal(calendarCalls()[0].data.month, '2030-01')
  assert.equal(listCalls().length, 0)
})

test('opening from a chosen future date preserves its month and selected day', async () => {
  const { page, open } = harness()
  page.data.selectedDate = '2030-03-21'
  await open()
  assert.equal(page.data.calendarMonth, '2030-03')
  assert.equal(page.data.calendarSelectedDate, '2030-03-21')
  assert.equal(page.data.calendarCanPrev, true)
  assert.equal(page.data.calendarCanConfirm, true)
})

test('a day tap is a draft only; cancelling returns to filters and keeps the applied date', async () => {
  const { page, open, listCalls } = harness()
  page.data.selectedDate = '2030-01-20'
  await open()
  page.onCalendarSelectDate(dateEvent('2030-01-21'))
  assert.equal(page.data.calendarSelectedDate, '2030-01-21')
  assert.equal(page.data.selectedDate, '2030-01-20')
  assert.equal(listCalls().length, 0)
  page.onCloseCalendar()
  assert.equal(page.data.calendarVisible, false)
  assert.equal(page.data.refineFiltersVisible, true)
  assert.equal(page.data.selectedDate, '2030-01-20')
  await open()
  assert.equal(page.data.calendarSelectedDate, '2030-01-20', 'discarded draft is not reapplied next time')
})

test('confirm applies only the selected day, closes sheets and leaves list paging to its normal single-day request', async () => {
  const { page, open, listCalls } = harness()
  page.data.hasLoadedOnce = true
  await open()
  page.onCalendarSelectDate(dateEvent('2030-01-21'))
  page.onCalendarConfirm()
  await tick()
  assert.equal(page.data.selectedDate, '2030-01-21')
  assert.equal(page.data.timeFilterIndex, -1)
  assert.equal(page.data.calendarVisible, false)
  assert.equal(page.data.refineFiltersVisible, false)
  assert.equal(page.data.placePickerVisible, false)
  assert.equal(page.data.cityPickerVisible, false)
  assert.equal(listCalls().length, 1)
  assert.equal(listCalls()[0].data.startDate, '2030-01-21')
  assert.equal(listCalls()[0].data.endDateExclusive, '2030-01-22')
  assert.equal(page.data.hasMoreDays, false)
})

test('past, invalid and off-month dates cannot become a calendar selection', async () => {
  const { page, open } = harness()
  await open()
  for (const date of ['2030-01-14', '2030-02-30', '2030-02-21', '', 'not-a-date']) {
    page.onCalendarSelectDate(dateEvent(date))
    assert.equal(page.data.calendarSelectedDate, '2030-01-15', `reject ${date}`)
  }
})

test('month navigation cannot go before today and clears draft until a visible date is chosen', async () => {
  const { page, open, calendarCalls, listCalls } = harness()
  await open()
  page.onCalendarPrevMonth()
  await tick()
  assert.equal(page.data.calendarMonth, '2030-01')
  assert.equal(calendarCalls().length, 1)
  page.onCalendarNextMonth()
  await tick()
  assert.equal(page.data.calendarMonth, '2030-02')
  assert.equal(page.data.calendarSelectedDate, '')
  assert.equal(page.data.calendarCanConfirm, false)
  page.onCalendarConfirm()
  assert.equal(page.data.calendarVisible, true)
  assert.equal(listCalls().length, 0)
  page.onCalendarSelectDate(dateEvent('2030-02-04'))
  assert.equal(page.data.calendarCanConfirm, true)
  page.onCalendarPrevMonth()
  await tick()
  assert.equal(page.data.calendarMonth, '2030-01')
  assert.equal(page.data.calendarSelectedDate, '')
  assert.equal(page.data.calendarCanPrev, false)
})

test('month counts send the active city, route type and stable place filters to the server', async () => {
  const { page, open, calendarCalls } = harness()
  Object.assign(page.data, {
    selectedFromPlace: 'Fort Lee', selectedToPlace: '哥大/Columbia', routeTypeFilter: 'request'
  })
  await open()
  const sent = calendarCalls()[0].data
  assert.equal(sent.cityKey, page.data.activeCityKey)
  assert.equal(sent.type, 'request')
  assert.equal(sent.fromPlace, 'Fort Lee')
  assert.equal(sent.toPlace, '哥大')
  assert.equal(sent.action, 'calendar')
  assert.equal(sent.month, '2030-01')
  assert.equal('startDate' in sent, false, 'month counts do not inherit the two-day list window')
})

test('concurrent month requests coalesce and successful data is reused for five minutes', async () => {
  const { page, state, holdNext, open, calendarCalls, day } = harness()
  const held = holdNext()
  await open()
  const duplicate = page.loadCalendarCounts()
  assert.equal(calendarCalls().length, 1)
  assert.equal(page.data.calendarLoading, true)
  held.resolve(calendarResponse())
  await duplicate
  await tick()
  assert.equal(page.data.calendarLoading, false)
  assert.equal(day('2030-01-15').carpoolText, '12发')
  page.onCloseCalendar()
  state.now += 299_999
  await open()
  assert.equal(calendarCalls().length, 1)
  assert.equal(day('2030-01-15').carpoolText, '12发')
  page.onCloseCalendar()
  state.now += 1
  await open()
  assert.equal(calendarCalls().length, 2)
})

test('month cache is separated by place, route type and viewer identity', async () => {
  const { page, state, open, calendarCalls } = harness()
  await open()
  page.onCloseCalendar()
  page.data.selectedFromPlace = 'JFK'
  await open()
  assert.equal(calendarCalls().length, 2)
  page.onCloseCalendar()
  page.data.routeTypeFilter = 'carpool'
  await open()
  assert.equal(calendarCalls().length, 3)
  page.onCloseCalendar()
  state.store.openid = 'viewer-b'
  await open()
  assert.equal(calendarCalls().length, 4)
})

test('network failure retains unknown counts and retry recovers without fetching any route details', async () => {
  const { page, holdNext, open, calendarCalls, listCalls, day } = harness()
  const held = holdNext()
  await open()
  held.reject(new Error('offline'))
  await tick()
  assert.ok(page.data.calendarError)
  assert.equal(page.data.calendarLoading, false)
  assert.equal(day('2030-01-15').countsReady, false)
  assert.equal(day('2030-01-15').carpoolText, '—发')
  assert.equal(day('2030-01-15').requestText, '—求')
  page.onCalendarRetry()
  await tick()
  assert.equal(calendarCalls().length, 2)
  assert.equal(Boolean(page.data.calendarError), false)
  assert.equal(day('2030-01-15').countsReady, true)
  assert.equal(listCalls().length, 0)
})

test('application-level month failure is not cached as a successful empty month', async () => {
  const { page, holdNext, open, calendarCalls, day } = harness()
  const held = holdNext()
  await open()
  held.resolve({ result: { success: false, errorMsg: 'temporarily unavailable' } })
  await tick()
  assert.ok(page.data.calendarError)
  assert.equal(day('2030-01-15').carpoolText, '—发')
  page.onCloseCalendar()
  await open()
  assert.equal(calendarCalls().length, 2)
  assert.equal(day('2030-01-15').carpoolText, '12发')
})

test('a slower previous month cannot replace the current month statistics', async () => {
  const { page, holdNext, open, day } = harness()
  const january = holdNext()
  await open()
  page.onCalendarNextMonth()
  await tick()
  assert.equal(page.data.calendarMonth, '2030-02')
  assert.equal(day('2030-02-15').carpoolText, '12发')
  january.resolve(calendarResponse('2030-01', [{ date: '2030-01-15', carpoolCount: 999, requestCount: 999 }]))
  await tick()
  assert.equal(page.data.calendarMonth, '2030-02')
  assert.equal(day('2030-02-15').carpoolText, '12发')
  assert.equal(page.data.calendarLoading, false)
})

test('a response arriving after closing the calendar cannot modify its current UI or reopen it', async () => {
  const { page, holdNext, open } = harness()
  const held = holdNext()
  await open()
  page.onCloseCalendar()
  const closed = plain({
    days: page.data.calendarDays, error: page.data.calendarError,
    loading: page.data.calendarLoading, month: page.data.calendarMonth
  })
  held.resolve(calendarResponse())
  await tick()
  assert.equal(page.data.calendarVisible, false)
  assert.equal(page.data.refineFiltersVisible, true)
  assert.deepEqual(plain({
    days: page.data.calendarDays, error: page.data.calendarError,
    loading: page.data.calendarLoading, month: page.data.calendarMonth
  }), closed)
})

test('a previous viewer response cannot populate a new viewer calendar', async () => {
  const { page, state, holdNext, open, day } = harness()
  const oldViewer = holdNext()
  await open()
  state.store.openid = 'viewer-b'
  await page.loadCalendarCounts()
  assert.equal(day('2030-01-15').carpoolText, '12发')
  oldViewer.resolve(calendarResponse('2030-01', [{ date: '2030-01-15', carpoolCount: 999, requestCount: 999 }]))
  await tick()
  assert.equal(day('2030-01-15').carpoolText, '12发')
  assert.equal(page.data.calendarLoading, false)
})

test('calendar-only reads and drafts preserve loaded two-day routes, date totals and pagination cursor', async () => {
  const { page, open, listCalls } = harness()
  Object.assign(page.data, {
    originalCarpoolList: [{ _id: 'loaded-car' }], originalRequestList: [{ _id: 'loaded-request' }],
    dayGroups: [{ date: '2030-01-15', carpoolCount: 1, requestCount: 1, items: [{ _id: 'loaded-car' }] }],
    hasMoreDays: true, nextPageDate: '2030-01-17', fullTripCount: 2, hideFullTrips: false
  })
  const readListState = () => plain({
    carpool: page.data.originalCarpoolList, request: page.data.originalRequestList,
    groups: page.data.dayGroups, hasMoreDays: page.data.hasMoreDays,
    nextPageDate: page.data.nextPageDate, fullTripCount: page.data.fullTripCount,
    hideFullTrips: page.data.hideFullTrips
  })
  const before = readListState()
  await open()
  page.onCalendarSelectDate(dateEvent('2030-01-21'))
  page.onCalendarNextMonth()
  await tick()
  page.onCloseCalendar()
  assert.deepEqual(readListState(), before)
  assert.equal(listCalls().length, 0)
})

test('background status changes refresh an open calendar under the new revision and ignore its older pending counts', async () => {
  const { page, state, holdNext, open, calendarCalls, listCalls, day } = harness({ realStatusRefresh: true })
  page.data.originalCarpoolList = [{ _id: 'route-that-just-completed' }]
  const outdated = holdNext()
  await open()
  assert.equal(page.data.calendarLoading, true)
  assert.equal(calendarCalls().length, 1)
  await page.refreshStatusInBackground(true)
  assert.ok(state.store.rideListShouldRefreshAt > 0)
  assert.equal(state.calls.filter(call => call.name === 'syncTripStatus').length, 1)
  assert.equal(calendarCalls().length, 2, 'status changes refresh monthly totals as well as the two-day list')
  assert.equal(listCalls().length, 1)
  assert.equal(page.data.calendarLoading, false)
  assert.equal(day('2030-01-15').carpoolText, '12发')
  outdated.resolve(calendarResponse('2030-01', [{ date: '2030-01-15', carpoolCount: 999, requestCount: 999 }]))
  await tick()
  assert.equal(page.data.calendarLoading, false)
  assert.equal(day('2030-01-15').carpoolText, '12发')
  assert.equal(page._statusRefreshing, false)
})
