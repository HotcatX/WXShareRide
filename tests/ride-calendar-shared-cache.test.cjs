const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const plain = value => JSON.parse(JSON.stringify(value))
const dateEvent = date => ({ currentTarget: { dataset: { date } } })
const response = month => ({ result: { success: true, month, data: {
  days: [{ date: `${month}-20`, carpoolCount: 12, requestCount: 3 }]
} } })

// Load the real list/newTrip pages through one CommonJS module cache, as a mini-program does.
function harness() {
  const state = {
    now: new Date(2030, 0, 15, 12, 0).getTime(), calls: [], queue: [],
    store: { openid: 'viewer-a', ride_active_city_v1: { key: 'ny_nj' } }
  }
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [state.now])) }
    static now() { return state.now }
  }
  const wx = {
    getStorageSync: key => state.store[key],
    setStorageSync: (key, value) => { state.store[key] = plain(value) },
    hideKeyboard() {},
    cloud: { callFunction(args) {
      assert.equal(args.name, 'getTripList')
      assert.equal(args.data.action, 'calendar', 'opening a calendar must not read list details or publish trips')
      state.calls.push(plain(args))
      return state.queue.length ? state.queue.shift().promise : Promise.resolve(response(args.data.month))
    } }
  }
  const definitions = new Map()
  let currentPage
  const context = vm.createContext({
    wx, Date: Clock, Page: value => definitions.set(currentPage, value),
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout
  })
  const modules = new Map()
  function load(filename) {
    const absolute = path.resolve(filename)
    if (absolute === path.join(ROOT, 'utils/cloudConfig.js')) return { loadPublicConfigDoc: async () => null }
    if (absolute === path.join(ROOT, 'utils/error.js')) return { showDataError() {} }
    if (modules.has(absolute)) return modules.get(absolute).exports
    const module = { exports: {} }
    modules.set(absolute, module)
    const execute = vm.runInContext(`(function(require, module, exports) {\n${fs.readFileSync(absolute, 'utf8')}\n})`, context, { filename: absolute })
    execute(name => {
      assert.ok(name.startsWith('.'), `Unexpected dependency: ${name}`)
      return load(path.resolve(path.dirname(absolute), `${name}.js`))
    }, module, module.exports)
    return module.exports
  }
  for (const name of ['carpoolList', 'newTrip']) {
    currentPage = name
    load(path.join(ROOT, `pages/home/${name}/${name}.js`))
  }
  function createPage(mode = 'list') {
    const definition = definitions.get(mode === 'list' ? 'carpoolList' : 'newTrip')
    const page = { ...definition, data: plain(definition.data) }
    page.setData = function (patch, callback) {
      Object.assign(this.data, plain(patch))
      if (callback) callback.call(this)
    }
    Object.assign(page.data, page.getFilterDateData(), mode === 'list' ? {} : { mode })
    return page
  }
  function hold() {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    state.queue.push({ promise })
    return { resolve, reject }
  }
  return { state, createPage, hold }
}
const day = (page, date = '2030-01-20') => page.data.calendarDays.find(item => item.date === date)

test('the real list, driver and passenger pages share equivalent month counts while keeping date drafts private', async () => {
  const { state, createPage } = harness()
  const list = createPage('list')
  list.data.selectedFromPlace = 'Newport'
  list.data.selectedToPlace = 'Penn Station'
  await list.onOpenCalendar()
  list.onCalendarSelectDate(dateEvent('2030-01-21'))
  list.onCloseCalendar()
  list.onUnload()

  const driver = createPage('driver')
  Object.assign(driver.data, { departureAddress: 'Newport', destinationAddress: 'Penn Station', departureDate: '2030-01-20' })
  await driver.onOpenDatePicker()
  const passenger = createPage('passenger')
  Object.assign(passenger.data, { departureAddress: 'Newport', destinationAddress: 'Penn Station', departureDate: '2030-01-22' })
  const request = passenger.getCalendarRequest.bind(passenger)
  passenger.getCalendarRequest = () => Object.fromEntries(Object.entries(request()).reverse())
  await passenger.onOpenDatePicker()

  assert.equal(state.calls.length, 1, 'page/mode and object property order do not split equivalent cached queries')
  for (const page of [driver, passenger]) {
    assert.equal(day(page).carpoolText, '12发')
    assert.equal(day(page).requestText, '3求')
  }
  assert.equal(driver.data.calendarSelectedDate, '2030-01-20')
  assert.equal(passenger.data.calendarSelectedDate, '2030-01-22')
  driver.onCalendarSelectDate(dateEvent('2030-01-25'))
  driver.onCalendarConfirm()
  assert.equal(driver.data.departureDate, '2030-01-25')
  assert.equal(passenger.data.departureDate, '2030-01-22')
  assert.equal(passenger.data.calendarSelectedDate, '2030-01-22')
  assert.equal(passenger.data.calendarVisible, true)
  assert.equal(list.data.selectedDate, '', 'a discarded list draft is not transferred to publishing pages')
})

test('concurrent calendars coalesce across pages and an unloaded initiating page cannot discard another page result', async () => {
  const { state, createPage, hold } = harness()
  const pending = hold()
  const list = createPage('list')
  const first = list.onOpenCalendar()
  const driver = createPage('driver')
  const second = driver.onOpenDatePicker()
  const passenger = createPage('passenger')
  const third = passenger.onOpenDatePicker()
  assert.equal(state.calls.length, 1)
  assert.equal(driver.data.calendarLoading, true)
  assert.equal(passenger.data.calendarLoading, true)
  list.onCloseCalendar()
  list.onUnload()
  const closedListData = plain(list.data)
  pending.resolve(response('2030-01'))
  await Promise.all([first, second, third])
  assert.deepEqual(plain(list.data), closedListData, 'late shared data must not update the disposed page UI')
  for (const page of [driver, passenger]) {
    assert.equal(page.data.calendarLoading, false)
    assert.equal(day(page).carpoolText, '12发')
  }
  const returningList = createPage('list')
  await returningList.onOpenCalendar()
  assert.equal(state.calls.length, 1)
  assert.equal(day(returningList).requestText, '3求')
})

test('cross-page month data expires exactly five minutes after success and cache hits do not extend that deadline', async () => {
  const { state, createPage, hold } = harness()
  const pending = hold()
  const loading = createPage('list').onOpenCalendar()
  state.now += 20_000
  pending.resolve(response('2030-01'))
  await loading
  state.now += 299_999
  await createPage('driver').onOpenDatePicker()
  assert.equal(state.calls.length, 1)
  state.now += 1
  await createPage('passenger').onOpenDatePicker()
  assert.equal(state.calls.length, 2, 'the success timestamp, not the initial request or most recent hit, controls expiry')
})

test('shared month cache isolates viewer, city, month, route type, both places and ride revision', async () => {
  const changes = [
    ['viewer', (page, state) => { state.store.openid = 'viewer-b' }],
    ['city', page => { page.data.activeCityKey = 'boston' }],
    ['month', page => { page.data.selectedDate = '2030-02-20' }],
    ['type', page => { page.data.routeTypeFilter = 'request' }],
    ['departure', page => { page.data.selectedFromPlace = 'JFK' }],
    ['destination', page => { page.data.selectedToPlace = 'Penn Station' }],
    ['revision', (page, state) => { state.store.rideListShouldRefreshAt = state.now }]
  ]
  for (const [label, change] of changes) {
    const { state, createPage } = harness()
    await createPage('list').onOpenCalendar()
    const different = createPage('list')
    change(different, state)
    await different.onOpenCalendar()
    assert.equal(state.calls.length, 2, `${label} must not receive the old query result`)
    assert.equal(different.data.calendarLoading, false)
  }
})

test('a failed shared request leaves unknown counts and another page can retry once for all waiting pages', async () => {
  const { state, createPage, hold } = harness()
  const pending = hold()
  const list = createPage('list')
  const driver = createPage('driver')
  const first = list.onOpenCalendar()
  const second = driver.onOpenDatePicker()
  pending.reject(new Error('offline'))
  await Promise.all([first, second])
  assert.equal(state.calls.length, 1)
  for (const page of [list, driver]) {
    assert.ok(page.data.calendarError)
    assert.equal(day(page).countsReady, false)
    assert.equal(day(page).carpoolText, '—发')
  }
  const retry = hold()
  const passenger = createPage('passenger')
  const reopened = passenger.onOpenDatePicker()
  const duplicateRetry = driver.onCalendarRetry()
  assert.equal(state.calls.length, 2, 'even a force retry shares the already pending replacement')
  retry.resolve(response('2030-01'))
  await Promise.all([reopened, duplicateRetry])
  assert.equal(day(passenger).carpoolText, '12发')
  assert.equal(day(driver).requestText, '3求')
  assert.equal(driver.data.calendarError, '')
})

test('equivalent Other filter presets share data regardless of order but changed preset contents do not', async () => {
  const { state, createPage } = harness()
  const first = createPage('list')
  Object.assign(first.data, { selectedFromPlace: '其他', fromPlaceList: ['JFK', 'Newport'] })
  await first.onOpenCalendar()
  const reordered = createPage('list')
  Object.assign(reordered.data, { selectedFromPlace: '其他', fromPlaceList: ['Newport', 'JFK'] })
  await reordered.onOpenCalendar()
  assert.equal(state.calls.length, 1)
  const changed = createPage('list')
  Object.assign(changed.data, { selectedFromPlace: '其他', fromPlaceList: ['Newport', 'EWR'] })
  await changed.onOpenCalendar()
  assert.equal(state.calls.length, 2)
})

test('many pending calendars remain shareable and finishing a capacity-evicted entry still clears its pages loading state', async () => {
  const { state, createPage, hold } = harness()
  const open = []
  for (let index = 0; index < 21; index += 1) {
    const pending = hold()
    const page = createPage('list')
    page.data.selectedFromPlace = `Place ${index}`
    open.push({ pending, page, ready: page.onOpenCalendar() })
  }
  const driver = createPage('driver')
  driver.data.departureAddress = 'Place 0'
  const reused = driver.onOpenDatePicker()
  assert.equal(state.calls.length, 21, 'capacity pressure must not discard a request that another page is still awaiting')
  open[0].pending.resolve(response('2030-01'))
  await Promise.all([open[0].ready, reused])
  for (const page of [open[0].page, driver]) {
    assert.equal(page.data.calendarLoading, false)
    assert.equal(day(page).carpoolText, '12发')
  }
  for (const entry of open.slice(1)) entry.pending.resolve(response('2030-01'))
  await Promise.all(open.slice(1).map(entry => entry.ready))
  assert.ok(open.every(entry => !entry.page.data.calendarLoading))
})
