const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../pages/home/carpoolList/carpoolList.js'), 'utf8')
const city = require('../utils/cityTree')
const pricing = require('../utils/tripManage')
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
const event = (key, value) => ({ currentTarget: { dataset: { [key]: value } } })

function route(id, date = '2030-01-01', extra = {}) {
  return {
    _id: id, status: 'open', availSeatNum: 2, cityKey: 'ny_nj',
    departures: [{ date, time: '12:00', address: 'Fort Lee' }],
    destinations: [{ address: 'Columbia' }], ...extra
  }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function pageResponse(args, carpool = [], request = [], page = {}) {
  const { startDate, endDateExclusive } = args.data
  return { result: { success: true, data: { carpool, request }, page: {
    startDate, endDateExclusive, nextDate: endDateExclusive, hasMore: false, ...page
  } } }
}
function harness({ carpool = [], request = [], store } = {}) {
  let definition
  const state = {
    now: Date.parse('2030-01-01T10:00:00'), calls: [], queued: [], analytics: [], telemetry: [], collect: false,
    store: store || { openid: 'viewer-a' }, carpool, request
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
    cloud: { callFunction(args) {
      assert.equal(args.name, 'getTripList', 'list pagination must not call details or status functions')
      state.calls.push(args)
      if (state.queued.length) return state.queued.shift().promise
      const { startDate, endDateExclusive } = args.data
      const inRange = item => item.departures[0].date >= startDate && item.departures[0].date < endDateExclusive
      const hasMore = [...state.carpool, ...state.request].some(item => item.departures[0].date >= endDateExclusive)
      return Promise.resolve(pageResponse(args, state.carpool.filter(inRange).map(plain), state.request.filter(inRange).map(plain), { hasMore }))
    } }
  }
  const context = {
    Page: value => { definition = value }, wx, Date: Clock, setTimeout, clearTimeout,
    console: { error() {}, warn() {} },
    require(name) {
      if (name.includes('placeRecommendations') || name.includes('placePickerTelemetry')) {
        if (!context._placeModules) context._placeModules = require('./helpers/load-place-modules.cjs')(context, context.require('analyticsSession'))
        return context._placeModules(name)
      }
      if (name.includes('rideTelemetry')) return require('./helpers/load-ride-telemetry.cjs')(context.require('analyticsSession'), { wx: context.wx, Date: typeof Clock === 'undefined' ? Date : Clock })
      if (name.includes('analyticsSession')) return {
        getCollectionScope: () => state.collect ? 'test:account_version_1' : '',
        makeEventId: () => 'selection_synthetic_' + (state.analytics.length + state.telemetry.length),
        recordEvent(eventName, data) { state.telemetry.push({eventName, data: plain(data)}); return {ok: true} },
        recordSearch(data) {
          if (!state.collect) return ''
          const searchId = 'search_synthetic_' + state.analytics.length
          state.analytics.push({ eventName: 'search_submitted', data: plain(data), searchId })
          return searchId
        },
        recordResults(data) { state.analytics.push({ eventName: 'result_set_rendered', data: plain(data) }); return { ok: true } }
      }
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
  Object.assign(page.data, page.getFilterDateData(), page.buildFilterOptionData(['Fort Lee', 'JFK'], ['哥大/Columbia', 'EWR']))
  page.refreshStatusInBackground = async () => {}
  const ids = () => plain(page.data.dayGroups.flatMap(group => group.items.map(item => item._id)))
  const ranges = () => state.calls.map(call => [call.data.startDate, call.data.endDateExclusive])
  const holdNext = () => { const held = deferred(); state.queued.push(held); return held }
  return { page, state, ids, ranges, holdNext }
}

test('first route read requests only today and tomorrow, with later routes left on the server', async () => {
  const { page, state, ids, ranges } = harness({
    carpool: [route('today'), route('tomorrow', '2030-01-02'), route('later', '2030-01-03')],
    request: [route('tomorrow-request', '2030-01-02'), route('future-request', '2030-01-05')]
  })
  await page.loadBothLists()
  assert.deepEqual(ranges(), [['2030-01-01', '2030-01-03']])
  assert.deepEqual(ids(), ['today', 'tomorrow', 'tomorrow-request'])
  assert.equal(page.data.hasMoreDays, true)
  assert.equal(page.data.nextPageDate, '2030-01-03')
  assert.equal(page.data.loadingMoreDays, false)
  assert.equal(state.calls[0].data.type, 'all')
})

test('changing the hide-full-cars preference cannot turn a pending scroll or layout change into a later-date read', async () => {
  const { page, state, ids } = harness({ carpool: [
    route('available'), route('full', '2030-01-01', { availSeatNum: 0 }),
    route('later', '2030-01-03')
  ] })
  await page.loadBothLists()
  await page.onListScrollToLower()
  assert.equal(state.calls.length, 1, 'initial short-list layout is not a request to load more')

  page.onListTouchStart({ touches: [{ clientY: 500 }] })
  page.onListTouchEnd()
  page.onToggleHideFullTrips()
  assert.equal(page.data.hideFullTrips, false)
  assert.equal(state.store.carpoolListHideFullTripsV1, false)
  await page.onListScrollToLower()
  assert.deepEqual(ids(), ['available', 'full'])
  assert.equal(page.data.nextPageDate, '2030-01-03')
  assert.equal(state.calls.length, 1)

  // A previous scroll intent must also be cleared before the list shrinks.
  page.onListTouchStart({ touches: [{ clientY: 500 }] })
  page.onListTouchMove({ touches: [{ clientY: 450 }] })
  page.onToggleHideFullTrips()
  assert.equal(page.data.hideFullTrips, true)
  await page.onListScrollToLower()
  assert.deepEqual(ids(), ['available'])
  assert.equal(state.calls.length, 1)
})

test('a deliberate upward swipe can load one more date page, including momentum after release', async () => {
  const { page, state, ids } = harness({ carpool: [
    route('today'), route('later', '2030-01-03'), route('last', '2030-01-05')
  ] })
  await page.loadBothLists()
  page.onListTouchStart({ touches: [{ clientY: 600 }] })
  page.onListTouchMove({ touches: [{ clientY: 540 }] })
  page.onListTouchEnd()
  await page.onListScrollToLower()
  assert.deepEqual(ids(), ['today', 'later'])
  assert.equal(state.calls.length, 2)
  await page.onListScrollToLower()
  assert.equal(state.calls.length, 2, 'new content settling does not load a third date page')

  page.onListTouchStart({ touches: [{ clientY: 600 }] })
  page.onListTouchMove({ touches: [{ clientY: 540 }] })
  await page.onListScrollToLower()
  page.onListTouchMove({ touches: [{ clientY: 480 }] })
  await page.onListScrollToLower()
  assert.deepEqual(ids(), ['today', 'later', 'last'])
  assert.equal(state.calls.length, 3, 'the same continuing gesture is consumed only once')
})

test('tap jitter, downward refresh gestures and cancelled swipes do not load more; the explicit footer still works', async () => {
  const { page, state, ids } = harness({ carpool: [route('today'), route('later', '2030-01-03')] })
  await page.loadBothLists()
  for (const endY of [599, 595, 605, 650]) {
    page.onListTouchStart({ touches: [{ clientY: 600 }] })
    page.onListTouchMove({ touches: [{ clientY: endY }] })
    page.onListTouchEnd()
    await page.onListScrollToLower()
  }
  page.onListTouchStart({ touches: [{ clientY: 600 }] })
  page.onListTouchMove({ touches: [{ clientY: 540 }] })
  page.onListTouchCancel()
  await page.onListScrollToLower()
  assert.equal(state.calls.length, 1)
  await page.onLoadMoreDays()
  assert.deepEqual(ids(), ['today', 'later'])
  assert.equal(state.calls.length, 2)
})

test('first-page and load-more duplicates each share a single read', async () => {
  const { page, state, holdNext } = harness()
  const first = holdNext()
  const load = page.loadBothLists()
  const sameLoad = page.loadBothLists({ force: true })
  assert.equal(state.calls.length, 1)
  first.resolve(pageResponse(state.calls[0], [route('today')], [], { hasMore: true }))
  await Promise.all([load, sameLoad])
  const more = holdNext()
  const loadMore = page.onLoadMoreDays()
  const sameMore = page.onLoadMoreDays()
  assert.equal(state.calls.length, 2)
  assert.equal(page.data.loadingMoreDays, true)
  more.resolve(pageResponse(state.calls[1], [route('later', '2030-01-03')]))
  await Promise.all([loadMore, sameMore])
  assert.equal(page.data.loadingMoreDays, false)
  assert.equal(page.data.hasMoreDays, false)
  await page.onLoadMoreDays()
  assert.equal(state.calls.length, 2, 'exhausted lists do not read another page')
})

test('later two-day pages append unique routes, preserve hidden and shown full-car preferences, and keep complete date totals', async () => {
  const { page, state, ids, holdNext, ranges } = harness()
  let held = holdNext()
  let load = page.loadBothLists()
  held.resolve(pageResponse(state.calls[0], [route('today')], [], { hasMore: true }))
  await load
  held = holdNext()
  load = page.onLoadMoreDays()
  held.resolve(pageResponse(state.calls[1], [
    route('today'), route('later', '2030-01-03'), route('later', '2030-01-03'),
    route('full', '2030-01-03', { availSeatNum: 0 })
  ], [route('request', '2030-01-03'), route('request', '2030-01-03')], { hasMore: true }))
  await load
  assert.deepEqual(ranges(), [['2030-01-01', '2030-01-03'], ['2030-01-03', '2030-01-05']])
  assert.deepEqual(ids(), ['today', 'later', 'request'])
  assert.equal(page.data.hideFullTrips, true)
  assert.equal(page.data.fullTripCount, 1)
  const group = page.data.dayGroups.find(item => item.date === '2030-01-03')
  assert.equal(group.carpoolCount, 2)
  assert.equal(group.requestCount, 1)
  assert.equal(page.data.nextPageDate, '2030-01-05')
  page.onToggleHideFullTrips()
  assert.deepEqual(ids(), ['today', 'later', 'request', 'full'])
  assert.equal(page.data.hideFullTrips, false)
  assert.equal(state.calls.length, 2, 'changing display preference only regroups existing routes')
  held = holdNext()
  load = page.onLoadMoreDays()
  held.resolve(pageResponse(state.calls[2], [
    route('last-available', '2030-01-05'), route('last-full', '2030-01-05', { status: 'full' })
  ]))
  await load
  assert.equal(page.data.hideFullTrips, false)
  assert.equal(state.store.carpoolListHideFullTripsV1, false)
  assert.deepEqual(ids(), ['today', 'later', 'request', 'last-available', 'full', 'last-full'])
  assert.equal(page.data.fullTripCount, 2)
  const lastGroups = page.data.dayGroups.filter(item => item.date === '2030-01-05')
  assert.deepEqual(plain(lastGroups.map(item => [item.carpoolCount, item.requestCount])), [[2, 0], [2, 0]])
  assert.deepEqual(ranges().at(-1), ['2030-01-05', '2030-01-07'])
})

test('an empty two-day range still allows loading a later range when the server reports more', async () => {
  const { page, ids, ranges } = harness({ carpool: [route('day-five', '2030-01-05')] })
  await page.loadBothLists()
  assert.deepEqual(ids(), [])
  assert.equal(page.data.hasMoreDays, true)
  await page.onLoadMoreDays()
  assert.deepEqual(ids(), [])
  assert.equal(page.data.hasMoreDays, true)
  await page.onLoadMoreDays()
  assert.deepEqual(ids(), ['day-five'])
  assert.deepEqual(ranges(), [
    ['2030-01-01', '2030-01-03'], ['2030-01-03', '2030-01-05'], ['2030-01-05', '2030-01-07']
  ])
  assert.equal(page.data.hasMoreDays, false)
})

test('failed extra pages preserve current routes and cursor, then retry the same dates', async () => {
  const { page, state, ids, holdNext, ranges } = harness({ carpool: [route('today'), route('later', '2030-01-03')] })
  await page.loadBothLists()
  const held = holdNext()
  const failed = page.onLoadMoreDays()
  held.reject(new Error('offline'))
  await failed
  assert.deepEqual(ids(), ['today'])
  assert.equal(page.data.nextPageDate, '2030-01-03')
  assert.equal(page.data.hasMoreDays, true)
  assert.equal(page.data.loadingMoreDays, false)
  assert.ok(page.data.loadMoreError)
  await page.onLoadMoreDays()
  assert.deepEqual(ids(), ['today', 'later'])
  assert.equal(Boolean(page.data.loadMoreError), false)
  assert.deepEqual(ranges().slice(1), [['2030-01-03', '2030-01-05'], ['2030-01-03', '2030-01-05']])
  assert.equal(state.calls.length, 3)
})

test('an application-level load-more failure is retryable without losing the loaded days', async () => {
  const { page, ids, holdNext } = harness({ carpool: [route('today'), route('later', '2030-01-03')] })
  await page.loadBothLists()
  const held = holdNext()
  const failed = page.onLoadMoreDays()
  held.resolve({ result: { success: false, errorMsg: 'temporarily unavailable' } })
  await failed
  assert.deepEqual(ids(), ['today'])
  assert.equal(page.data.hasMoreDays, true)
  assert.ok(page.data.loadMoreError)
  await page.onLoadMoreDays()
  assert.deepEqual(ids(), ['today', 'later'])
})

test('today, tomorrow and a chosen calendar date read only that day and hide further-day paging', async () => {
  const { page, state, ids, ranges } = harness({ carpool: [
    route('today'), route('tomorrow', '2030-01-02'), route('later', '2030-01-05'), route('much-later', '2030-01-10')
  ] })
  await page.loadBothLists()
  page.onQuickDateChange(event('value', 'today'))
  await tick()
  assert.deepEqual(ids(), ['today'])
  assert.deepEqual(ranges().at(-1), ['2030-01-01', '2030-01-02'])
  assert.equal(page.data.hasMoreDays, false)
  const calls = state.calls.length
  await page.onLoadMoreDays()
  assert.equal(state.calls.length, calls)
  page.onQuickDateChange(event('value', 'tomorrow'))
  await tick()
  assert.deepEqual(ids(), ['tomorrow'])
  assert.deepEqual(ranges().at(-1), ['2030-01-02', '2030-01-03'])
  assert.equal(page.data.hasMoreDays, false)
  page.onSpecificDateChange({ detail: { value: '2030-01-05' } })
  await tick()
  assert.deepEqual(ids(), ['later'])
  assert.deepEqual(ranges().at(-1), ['2030-01-05', '2030-01-06'])
  assert.equal(page.data.hasMoreDays, false)
  page.onQuickDateChange(event('value', 'all'))
  await tick()
  assert.deepEqual(ids(), ['today', 'tomorrow'])
  assert.deepEqual(ranges().at(-1), ['2030-01-01', '2030-01-03'])
  assert.equal(page.data.hasMoreDays, true)
})

test('place and route-type changes filter all loaded pages locally without restarting reads', async () => {
  const { page, state, ids } = harness({
    carpool: [route('today'), route('later', '2030-01-03')], request: [route('later-request', '2030-01-03')]
  })
  await page.loadBothLists()
  await page.onLoadMoreDays()
  const reads = state.calls.length
  page.onOpenPlacePicker(event('field', 'from'))
  page.onSelectFilterPlace(event('value', 'Fort Lee'))
  page.onRouteTypeChange(event('type', 'request'))
  await tick()
  assert.deepEqual(ids(), ['later-request'])
  assert.equal(state.calls.length, reads)
  page.onRouteTypeChange(event('type', 'all'))
  assert.deepEqual(ids(), ['today', 'later', 'later-request'])
})

test('pull-to-refresh replaces appended days with the initial two-day range while preserving local filters', async () => {
  const { page, ids, ranges } = harness({ carpool: [route('today'), route('later', '2030-01-03')] })
  await page.loadBothLists()
  await page.onLoadMoreDays()
  page.onRouteTypeChange(event('type', 'carpool'))
  assert.deepEqual(ids(), ['today', 'later'])
  await page.onPullDownRefresh()
  assert.deepEqual(ids(), ['today'])
  assert.deepEqual(ranges().at(-1), ['2030-01-01', '2030-01-03'])
  assert.equal(page.data.nextPageDate, '2030-01-03')
  assert.equal(page.data.hasMoreDays, true)
  assert.equal(page.data.routeTypeFilter, 'carpool')
  assert.equal(page.data.refresherTriggered, false)
})

test('a late extra page cannot overwrite a newer full refresh', async () => {
  const { page, state, ids, holdNext } = harness({ carpool: [route('today'), route('later', '2030-01-03')] })
  await page.loadBothLists()
  const oldMore = holdNext()
  const pending = page.onLoadMoreDays()
  state.carpool = [route('fresh-today'), route('future', '2030-01-07')]
  await page.loadBothLists({ force: true })
  oldMore.resolve(pageResponse(state.calls[1], [route('stale-later', '2030-01-03')], [], { hasMore: false }))
  await pending
  assert.deepEqual(ids(), ['fresh-today'])
  assert.equal(page.data.nextPageDate, '2030-01-03')
  assert.equal(page.data.hasMoreDays, true)
  assert.equal(page.data.loadingMoreDays, false)
})

test('changing viewer invalidates an in-flight extra page and its cached contents', async () => {
  const { page, state, ids, holdNext } = harness({ carpool: [route('viewer-a'), route('later', '2030-01-03')] })
  await page.loadBothLists()
  const oldMore = holdNext()
  const pending = page.onLoadMoreDays()
  state.store.openid = 'viewer-b'
  state.carpool = [route('viewer-b')]
  await page.loadBothLists()
  oldMore.resolve(pageResponse(state.calls[1], [route('private-a', '2030-01-03')], [], { hasMore: true }))
  await pending
  assert.deepEqual(ids(), ['viewer-b'])
  assert.equal(state.store.carpoolListDataV1.viewerKey, 'viewer-b')
  assert.equal(page.data.hasMoreDays, false)
})

test('changing the calendar filter discards an old extra page even when it finishes after the date read', async () => {
  const { page, state, ids, holdNext } = harness({ carpool: [route('today'), route('chosen', '2030-01-08')] })
  await page.loadBothLists()
  const oldMore = holdNext()
  const pending = page.onLoadMoreDays()
  page.onSpecificDateChange({ detail: { value: '2030-01-08' } })
  await tick()
  oldMore.resolve(pageResponse(state.calls[1], [route('old-later', '2030-01-03')], [], { hasMore: true }))
  await pending
  assert.deepEqual(ids(), ['chosen'])
  assert.equal(page.data.selectedDate, '2030-01-08')
  assert.equal(page.data.hasMoreDays, false)
  assert.equal(page.data.loadingMoreDays, false)
})

test('unloading a page prevents a pending extra page from changing visible state or cache', async () => {
  const { page, state, ids, holdNext } = harness({ carpool: [route('today'), route('later', '2030-01-03')] })
  await page.loadBothLists()
  const oldMore = holdNext()
  const pending = page.onLoadMoreDays()
  const cacheBefore = plain(state.store.carpoolListDataV1)
  page.onUnload()
  oldMore.resolve(pageResponse(state.calls[1], [route('late', '2030-01-03')]))
  await pending
  assert.deepEqual(ids(), ['today'])
  assert.deepEqual(state.store.carpoolListDataV1, cacheBefore)
})

test('a recent persistent page cache restores appended days and resumes at the saved cursor', async () => {
  const first = harness({ carpool: [route('today'), route('later', '2030-01-03'), route('last', '2030-01-05')] })
  await first.page.loadBothLists()
  await first.page.onLoadMoreDays()
  const cached = first.state.store.carpoolListDataV1
  assert.equal(cached.version, 2)
  assert.ok(cached.rangeKey)
  const restored = harness({ store: plain(first.state.store), carpool: first.state.carpool })
  restored.state.now += 10000
  await restored.page.loadBothLists()
  assert.equal(restored.state.calls.length, 0)
  assert.deepEqual(restored.ids(), ['today', 'later'])
  assert.equal(restored.page.data.hasMoreDays, true)
  assert.equal(restored.page.data.nextPageDate, '2030-01-05')
  await restored.page.onLoadMoreDays()
  assert.deepEqual(restored.ranges(), [['2030-01-05', '2030-01-07']])
  assert.deepEqual(restored.ids(), ['today', 'later', 'last'])
})

test('old, expired, future-dated or differently scoped caches are not used as date pages', async () => {
  const initial = harness({ carpool: [route('cached'), route('later', '2030-01-03')] })
  await initial.page.loadBothLists()
  const mutations = [
    cache => { delete cache.version; delete cache.rangeKey },
    cache => { cache.savedAt -= 30000 },
    cache => { cache.savedAt += 1 },
    cache => { cache.rangeKey = 'different-date-scope' }
  ]
  for (const mutate of mutations) {
    const store = plain(initial.state.store)
    mutate(store.carpoolListDataV1)
    const other = harness({ store, carpool: [route('fresh')] })
    await other.page.loadBothLists()
    assert.equal(other.state.calls.length, 1)
    assert.deepEqual(other.ids(), ['fresh'])
  }
})

test('selecting a date cannot reuse a recent cache for the unfiltered two-day range', async () => {
  const first = harness({ carpool: [route('today'), route('tomorrow', '2030-01-02')] })
  await first.page.loadBothLists()
  const other = harness({ store: plain(first.state.store), carpool: first.state.carpool })
  other.page.setData({ selectedDate: '2030-01-02' })
  await other.page.loadBothLists()
  assert.deepEqual(other.ranges(), [['2030-01-02', '2030-01-03']])
  assert.deepEqual(other.ids(), ['tomorrow'])
  assert.equal(other.page.data.hasMoreDays, false)
})

test('crossing midnight changes the base range even while the previous cache is still under 30 seconds old', async () => {
  const { page, state, ids, ranges } = harness({ carpool: [route('next-day', '2030-01-02'), route('day-three', '2030-01-03')] })
  state.now = Date.parse('2030-01-01T23:59:55')
  Object.assign(page.data, page.getFilterDateData())
  await page.loadBothLists()
  assert.deepEqual(ids(), ['next-day'])
  state.now += 10000
  page.onShow()
  await tick()
  assert.deepEqual(ranges().at(-1), ['2030-01-02', '2030-01-04'])
  assert.deepEqual(ids(), ['next-day', 'day-three'])
})

test('analytics records only explicit exact-date searches and their actually rendered count; cached refinements stay local', async () => {
  const h = harness({ carpool: [route('available'), route('full', '2030-01-01', { availSeatNum: 0 })] })
  h.state.collect = true
  await h.page.loadBothLists(); await tick()
  assert.equal(h.state.analytics.length, 0, 'initial all-date load is not a submitted search')
  h.page.onQuickDateChange(event('value', 'today'))
  await tick()
  assert.deepEqual(h.state.analytics.map(e => e.eventName), ['search_submitted', 'result_set_rendered'])
  assert.equal(h.state.analytics[0].data.serviceDate, '2030-01-01')
  const { candidates, candidatesComplete, selectionSetId, ...summary } = h.state.analytics[1].data
  assert.deepEqual(summary, { searchId: h.state.analytics[0].searchId,
    source: 'network', renderedCount: 1, loadedDateCount: 1, hasMore: false })
  assert.equal(candidatesComplete, true)
  assert.ok(selectionSetId)
  assert.deepEqual(candidates.map(item => item.tripKey), ['available'], 'hidden full trips are not included in the rendered candidate snapshot')
  const calls = h.state.calls.length
  h.page.onRouteTypeChange(event('type', 'request')); await tick()
  assert.equal(h.state.calls.length, calls)
  assert.equal(h.state.analytics[3].data.source, 'cache')
  assert.equal(h.state.analytics[3].data.renderedCount, 0)
  h.page.onQuickDateChange(event('value', 'all')); await tick()
  assert.equal(h.state.analytics.length, 4, 'all dates never become a fabricated today search')
})

test('failed and superseded exact-date reads never report empty successful analytics results', async () => {
  const h = harness(); h.state.collect = true
  await h.page.loadBothLists()
  const failed = h.holdNext()
  h.page.onQuickDateChange(event('value', 'today'))
  failed.reject(new Error('offline')); await tick()
  assert.deepEqual(h.state.analytics.map(e => e.eventName), ['search_submitted'])
  const old = h.holdNext()
  h.page.onQuickDateChange(event('value', 'tomorrow')); await tick()
  const oldRequest = h.state.calls[h.state.calls.length - 1]
  h.page.onSpecificDateChange({ detail: { value: '2030-01-05' } }); await tick()
  old.resolve(pageResponse(oldRequest)); await tick()
  const results = h.state.analytics.filter(e => e.eventName === 'result_set_rendered')
  assert.equal(results.length, 1)
  assert.equal(results[0].data.searchId, h.state.analytics.filter(e => e.eventName === 'search_submitted').at(-1).searchId)
})
