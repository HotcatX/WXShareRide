const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../pages/home/carpoolList/carpoolList.js'), 'utf8')
const city = require('../utils/cityTree')
const pricing = require('../utils/tripManage')
const NOW = Date.parse('2030-01-01T10:00:00')
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function route(id, options = {}) {
  return { _id: id, status: 'open', availSeatNum: 2, cityKey: 'ny_nj',
    departures: [{ date: '2030-01-01', time: '12:00', address: 'Fort Lee' }],
    destinations: [{ address: 'Columbia' }], ...options }
}
const response = (carpool = [], request = []) => ({ result: {
  success: true, data: { carpool, request },
  page: { startDate: '2030-01-01', endDateExclusive: '2030-01-03', nextDate: '', hasMore: false }
} })
function harness({ store, now = NOW, holdTimers = false } = {}) {
  let definition
  const state = { now, calls: [], store: store || { openid: 'viewer-a' }, next: null, readError: false, writeError: false, timers: [] }
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [state.now])) }
    static now() { return state.now }
  }
  const wx = {
    getStorageSync: key => {
      if (state.readError && key === 'carpoolListHideFullTripsV1') throw new Error('Storage unavailable')
      return state.store[key]
    },
    setStorageSync: (key, value) => {
      if (state.writeError && key === 'carpoolListHideFullTripsV1') throw new Error('Storage full')
      state.store[key] = plain(value)
    },
    removeStorageSync: key => { delete state.store[key] },
    getWindowInfo: () => ({ statusBarHeight: 20 }), showShareMenu() {},
    showNavigationBarLoading() {}, hideNavigationBarLoading() {}, stopPullDownRefresh() {},
    cloud: { callFunction(args) { state.calls.push(args); return state.next ? state.next.promise : Promise.resolve(response()) } }
  }
  const context = {
    Page: page => { definition = page }, Date: Clock, wx,
    console: { error() {}, warn() {} },
    setTimeout: holdTimers ? (callback, delay) => state.timers.push({ callback, delay }) : setTimeout,
    clearTimeout,
    require(name) {
      if (name.includes('rideTime')) return require('../utils/rideTime')
      if (name.includes('cityTree')) return city
      if (name.includes('ridePlaceOptions')) return require('../utils/ridePlaceOptions')
      if (name.includes('rideAddressConfig')) {
        const module = { exports: {} }
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/rideAddressConfig.js'), 'utf8'), {
          ...context, module, require: () => require('../utils/ridePlaceOptions')
        })
        return module.exports
      }
      if (name.includes('tripManage')) return pricing
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
  page.data.todayDateStr = '2030-01-01'
  page.data.tomorrowDateStr = '2030-01-02'
  const fill = (cars, requests = []) => {
    page.data.originalCarpoolList = cars.map(item => page.decorateTripCommon(item, 'carpool'))
    page.data.originalRequestList = requests.map(item => page.decorateTripCommon(item, 'request'))
    page.applyAllFiltersAndGroup()
  }
  const ids = () => plain(page.data.dayGroups.flatMap(group => group.items.map(item => item._id)))
  return { page, state, fill, ids }
}

test('full cars are hidden by default; showing them keeps available cars and requests first without cloud calls', () => {
  const { page, fill, ids, state } = harness()
  fill([
    route('full-early', { status: 'full' }),
    route('available-tomorrow', { departures: [{ date: '2030-01-02', time: '09:00', address: 'Fort Lee' }] }),
    route('zero', { availSeatNum: '0' }), route('available-today')
  ], [route('request-full', { status: 'full', availSeatNum: 0 })])
  assert.equal(page.data.fullTripCount, 2)
  assert.equal(page.data.hideFullTrips, true)
  assert.deepEqual(ids(), ['available-today', 'request-full', 'available-tomorrow'])
  page.onToggleHideFullTrips()
  assert.equal(page.data.hideFullTrips, false)
  assert.equal(state.store.carpoolListHideFullTripsV1, false)
  assert.deepEqual(ids(), ['available-today', 'request-full', 'available-tomorrow', 'full-early', 'zero'])
  assert.equal(new Set(page.data.dayGroups.map(group => group.key)).size, page.data.dayGroups.length)
  page.onToggleHideFullTrips()
  assert.equal(state.store.carpoolListHideFullTripsV1, true)
  assert.equal(ids().length, 3)
  assert.equal(state.calls.length, 0)
})

test('full count follows date/address filters and showing all-full lists persists through filter changes', () => {
  const { page, fill, ids } = harness()
  fill([route('full-today', { availSeatNum: 0 }), route('full-tomorrow', {
    availSeatNum: 0, departures: [{ date: '2030-01-02', time: '12:00', address: 'JFK' }]
  }), route('expired', { status: 'past', availSeatNum: 0 })])
  assert.deepEqual(ids(), [])
  assert.equal(page.data.fullTripCount, 2)
  page.onToggleHideFullTrips()
  assert.equal(ids().length, 2)
  assert.deepEqual(plain(page.data.dayGroups.map(group => [group.carpoolCount, group.requestCount])), [[1, 0], [1, 0]], 'dates with only full cars retain their totals when expanded')
  page.onTimeFilterChange({ detail: { value: '0' } })
  assert.equal(page.data.hideFullTrips, false)
  assert.equal(page.data.fullTripCount, 1)
  assert.deepEqual(ids(), ['full-today'])
  page.onResetFilter()
  assert.equal(page.data.hideFullTrips, false)
  page.data.fromFilterOptions = ['全部', 'JFK', '其他']
  page.onFromFilterChange({ detail: { value: '1' } })
  assert.equal(page.data.fullTripCount, 1)
  assert.deepEqual(ids(), ['full-tomorrow'])
})

test('full-car visibility restores on page entry after a year and persists both boolean choices', async () => {
  const first = harness()
  first.page.onToggleHideFullTrips()
  assert.equal(first.state.store.carpoolListHideFullTripsV1, false)
  assert.equal(first.state.calls.length, 0)
  const second = harness({ store: first.state.store, now: NOW + 366 * 86400000, holdTimers: true })
  second.page.loadBothLists = async () => {}
  second.page.onLoad({})
  await tick()
  assert.equal(second.page.data.hideFullTrips, false, 'false must not be replaced by the default onLoad')
  second.fill([route('full', { status: 'full', departures: [{ date: second.page.data.todayDateStr, time: '12:00', address: 'Fort Lee' }] })])
  assert.deepEqual(second.ids(), ['full'])
  second.page.onToggleHideFullTrips()
  assert.equal(second.state.store.carpoolListHideFullTripsV1, true)
  const third = harness({ store: second.state.store, now: NOW + 732 * 86400000, holdTimers: true })
  third.page.loadBothLists = async () => {}
  third.page.onLoad({})
  await tick()
  assert.equal(third.page.data.hideFullTrips, true)
  third.fill([route('full', { status: 'full', departures: [{ date: third.page.data.todayDateStr, time: '12:00', address: 'Fort Lee' }] })])
  assert.deepEqual(third.ids(), [])
  assert.equal(second.state.calls.length + third.state.calls.length, 0)
})

test('missing or malformed visibility preferences and storage read failures safely default to hiding full cars', () => {
  for (const saved of [undefined, null, '', 'false', 'true', 0, 1, {}, [], { value: false, savedAt: NOW }]) {
    const { page, state } = harness({ store: { carpoolListHideFullTripsV1: saved } })
    page.data.hideFullTrips = false
    page.restoreFullTripPreference()
    assert.equal(page.data.hideFullTrips, true, JSON.stringify(saved))
    assert.equal(state.calls.length, 0)
  }
  const { page, state } = harness({ store: { carpoolListHideFullTripsV1: false } })
  page.data.hideFullTrips = false
  state.readError = true
  assert.doesNotThrow(() => page.restoreFullTripPreference())
  assert.equal(page.data.hideFullTrips, true)
})

test('a storage write failure still changes visible full cars immediately without advancing pagination', () => {
  const { page, state, fill, ids } = harness()
  fill([route('available'), route('full', { status: 'full' })])
  state.writeError = true
  page.data.hasMoreDays = true
  page.data.nextPageDate = '2030-01-03'
  page._listLoadMoreArmed = true
  assert.doesNotThrow(() => page.onToggleHideFullTrips())
  assert.equal(page.data.hideFullTrips, false)
  assert.deepEqual(ids(), ['available', 'full'])
  page.onListScrollToLower()
  assert.equal(page.data.nextPageDate, '2030-01-03')
  assert.equal(state.calls.length, 0)
  assert.doesNotThrow(() => page.onToggleHideFullTrips())
  assert.equal(page.data.hideFullTrips, true)
  assert.deepEqual(ids(), ['available'])
})

test('refresh, list-cache reuse, more dates and city changes preserve full-car visibility', async () => {
  const { page, state, ids } = harness()
  page.onToggleHideFullTrips()
  page.refreshStatusInBackground = async () => {}
  state.next = deferred()
  const first = page.loadBothLists()
  state.next.resolve(response([route('full-first', { status: 'full' })]))
  await first
  assert.deepEqual(ids(), ['full-first'])
  assert.equal(page.data.hideFullTrips, false)
  assert.equal(page.restoreCachedLists(), true)
  assert.equal(page.data.hideFullTrips, false)
  const countBeforeCachedRead = state.calls.length
  await page.loadBothLists()
  assert.equal(state.calls.length, countBeforeCachedRead)
  state.next = deferred()
  const refresh = page.onPullDownRefresh()
  state.next.resolve(response([route('full-refreshed', { status: 'full' })]))
  await refresh
  assert.deepEqual(ids(), ['full-refreshed'])
  assert.equal(page.data.hideFullTrips, false)
  page.data.hasMoreDays = true
  page.data.nextPageDate = '2030-01-03'
  state.next = deferred()
  const more = page.onLoadMoreDays()
  const later = response([route('full-later', { status: 'full', departures: [{ date: '2030-01-03', time: '12:00', address: 'Fort Lee' }] })])
  later.result.page = { startDate: '2030-01-03', endDateExclusive: '2030-01-05', nextDate: '', hasMore: false }
  state.next.resolve(later)
  await more
  assert.deepEqual(ids(), ['full-refreshed', 'full-later'])
  assert.equal(page.data.hideFullTrips, false)
  page.onSelectCity({ currentTarget: { dataset: { key: 'boston' } } })
  assert.equal(page.data.isRideServiceAvailable, false)
  assert.equal(page.data.hideFullTrips, false)
  await page.onPullDownRefresh()
  assert.equal(page.data.hideFullTrips, false)
  assert.equal(state.store.carpoolListHideFullTripsV1, false)
})

test('missing seat counts do not falsely fold legacy cars', () => {
  const { page, fill, ids } = harness()
  fill([route('unknown', { availSeatNum: null }), route('missing', { availSeatNum: undefined }), route('invalid', { availSeatNum: 'unknown' })])
  assert.equal(page.data.fullTripCount, 0)
  assert.equal(ids().length, 3)
})

test('seat availability colors follow remaining capacity, with full status taking priority', () => {
  const { page, fill } = harness()
  fill([
    route('plenty', { availSeatNum: 4 }),
    route('available-boundary', { availSeatNum: '3' }),
    route('limited', { availSeatNum: 2 }),
    route('last', { availSeatNum: '1' }),
    route('zero', { availSeatNum: 0 }),
    route('negative', { availSeatNum: -1 }),
    route('full-status', { status: 'full', availSeatNum: 3 })
  ])
  assert.deepEqual(plain(page.data.originalCarpoolList.map(item => [item._seatAvailability, item._seatLabel])), [
    ['available', '余位 4'], ['available', '余位 3'], ['limited', '余位 2'],
    ['last', '余位 1'], ['full', '已满'], ['full', '已满'], ['full', '已满']
  ])
  assert.equal(page.data.fullTripCount, 3)
})

test('invalid seat counts stay neutral and visible; request passenger counts never become seat availability', () => {
  const { page, fill, ids } = harness()
  const unknownCounts = [null, undefined, '', '  ', 'unknown', false, [], NaN, Infinity, 1.5]
  fill(unknownCounts.map((value, index) => route(`unknown-${index}`, { availSeatNum: value })), [
    route('request-one', { passengerCount: 1, availSeatNum: 1 }),
    route('request-zero', { passengerCount: 2, status: 'full', availSeatNum: 0 })
  ])
  assert.ok(page.data.originalCarpoolList.every(item => item._seatAvailability === 'unknown' && item._seatLabel === '余位 —'))
  assert.equal(page.data.fullTripCount, 0)
  assert.equal(ids().length, unknownCounts.length + 2)
  assert.ok(page.data.originalRequestList.every(item => item._seatAvailability === undefined))
  assert.deepEqual(plain(page.data.originalRequestList.map(item => item._requestPassengerCount)), [1, 2])
})

test('first-page requests coalesce, empty results cache, force/expiry/revision refresh', async () => {
  const { page, state } = harness()
  state.next = deferred()
  const first = page.loadBothLists()
  const second = page.loadBothLists({ force: true })
  assert.equal(state.calls.length, 1)
  state.next.resolve(response())
  await Promise.all([first, second])
  state.next = null
  await page.loadBothLists()
  assert.equal(state.calls.length, 1)
  await page.loadBothLists({ force: true })
  assert.equal(state.calls.length, 2)
  state.now += 30001
  await page.loadBothLists()
  assert.equal(state.calls.length, 3)
  state.store.rideListShouldRefreshAt = state.now + 1
  await page.loadBothLists()
  assert.equal(state.calls.length, 4)
  assert.equal(state.store.rideListShouldRefreshAt, state.now + 1, 'one page must not consume another page’s invalidation')
})

test('missing price no longer fetches the list twice or preloads details', async () => {
  const { page, state } = harness()
  state.next = deferred()
  const request = page.loadBothLists()
  state.next.resolve(response([route('no-price'), route('priced', { referencePrice: '$12/人' })]))
  await request
  assert.equal(state.calls.length, 1)
  assert.equal(state.calls[0].name, 'getTripList')
  assert.ok(page.data.originalCarpoolList.find(item => item._id === 'priced')._priceText)
})

test('mutation during a read discards stale results and starts a fresh read', async () => {
  const { page, state, ids } = harness()
  const old = deferred(); state.next = old
  const request = page.loadBothLists()
  state.store.rideListShouldRefreshAt = state.now + 1
  const fresh = deferred(); state.next = fresh
  old.resolve(response([route('old-seat-count')]))
  await tick()
  assert.equal(state.calls.length, 2)
  assert.deepEqual(ids(), [])
  fresh.resolve(response([route('new-seat-count')]))
  await request
  assert.deepEqual(ids(), ['new-seat-count'])
})

test('A to B to A responses cannot overwrite the latest A or clear its in-flight request', async () => {
  const { page, state, ids } = harness()
  const oldA = deferred(); state.next = oldA
  const first = page.loadBothLists()
  state.store.openid = 'viewer-b'
  const oldB = deferred(); state.next = oldB
  const second = page.loadBothLists()
  state.store.openid = 'viewer-a'
  const newA = deferred(); state.next = newA
  const third = page.loadBothLists()
  oldA.resolve(response([route('old-a')]))
  oldB.resolve(response([route('old-b')]))
  await Promise.all([first, second])
  assert.deepEqual(ids(), [])
  const fourth = page.loadBothLists()
  assert.equal(state.calls.length, 3)
  newA.resolve(response([route('new-a')]))
  await Promise.all([third, fourth])
  assert.deepEqual(ids(), ['new-a'])
})

test('identity change clears the old visible list even when the new request fails; retry succeeds', async () => {
  const { page, state, ids } = harness()
  state.next = deferred()
  const first = page.loadBothLists()
  state.next.resolve(response([route('viewer-a-visible')]))
  await first
  state.store.openid = 'viewer-b'
  state.next = deferred()
  const second = page.loadBothLists()
  assert.deepEqual(ids(), [])
  state.next.reject(new Error('offline'))
  await second
  assert.deepEqual(ids(), [])
  state.next = null
  await page.loadBothLists()
  assert.equal(state.calls.length, 3)
})

test('persistent empty cache is reusable but future timestamps and a different viewer are not', async () => {
  const { page, state } = harness()
  await page.loadBothLists()
  page._loadedListKey = null
  assert.equal(page.restoreCachedLists(), true)
  state.store.carpoolListDataV1.savedAt = state.now + 1000
  assert.equal(page.restoreCachedLists(), false)
  state.store.carpoolListDataV1.savedAt = state.now
  state.store.openid = 'viewer-b'
  assert.equal(page.restoreCachedLists(), false)
})
