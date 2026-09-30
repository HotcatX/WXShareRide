const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
const dateEvent = date => ({ currentTarget: { dataset: { date } } })
const placeEvent = type => ({ currentTarget: { dataset: { type } } })
const valueEvent = value => ({ detail: { value } })
const calendarResponse = (month, days = [{ date: `${month}-20`, carpoolCount: 17, requestCount: 6 }]) => ({
  month, days: days.map(({ date, carpoolCount, requestCount }) => ({ date, offerCount: carpoolCount, requestCount }))
})
const defaults = require('../utils/placeCatalog').fixedPlaceValues()
const placeResponse = (labels = ['公共车站']) => ({ ok: true, catalogVersion: 'places-v1', rankingVersion: 'circle-selection-v1', generatedAt: 1894703400000,
  circles: [], places: labels.map((label, index) => ({ placeId: 'poi_test_' + index, label, source: 'circle' })) })


function harness() {
  let definition
  const state = {
    now: new Date(2030, 0, 15, 12, 30).getTime(),
    calls: [], placeRequests: [], telemetry: [], queue: new Map(), navigation: [], errors: [],
    store: { openid: 'viewer-a', ride_active_city_v1: { key: 'ny_nj' } },
    templateReads: 0, userReads: 0, driverPrices: 0, passengerPrices: 0, configReads: [], priceRows: [],
    addressConfig: { fromPlaces: [...defaults], toPlaces: [...defaults] }
  }
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [state.now])) }
    static now() { return state.now }
  }
  const wx = {
    getWindowInfo: () => ({ statusBarHeight: 24 }),
    getStorageSync: key => state.store[key],
    setStorageSync: (key, value) => { state.store[key] = plain(value) },
    removeStorageSync: key => { delete state.store[key] },
    hideKeyboard() {}, showToast() {}, navigateBack() {},
    navigateTo: args => { state.navigation.push(plain(args)) },
    cloud: {
      callFunction() { throw new Error('No fresh CloudBase function calls') },
      database() { throw new Error('No direct location collection reads') }
    }
  }
  const backend = { isBackendEnabled: () => true, async get(url, options) {
    assert.equal(options.public, true)
    if (url === '/api/v1/locations') {
      state.configReads.push(url)
      const queue = state.queue.get('locations')
      if (queue?.length) return queue.shift().promise
      return { ...plain(require('../utils/locationCatalog.generated')),
        rideAddresses: { ...plain(require('../utils/locationCatalog.generated').rideAddresses), offer: plain(state.addressConfig) },
        requestPrices: plain(state.priceRows) }
    }
    const query = Object.fromEntries(new URL(url, 'https://synthetic.invalid').searchParams)
    assert.ok(url.startsWith('/api/v1/rides/calendar?'))
    state.calls.push({ url, data: query })
    const queue = state.queue.get('calendar')
    return queue?.length ? queue.shift().promise : calendarResponse(query.month)
  } }
  const locations = require('../utils/locationConfig').createLocationClient(backend, () => state.now)

  const context = vm.createContext({
    wx, Date: Clock, Page: value => { definition = value },
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout
  })
  const modules = new Map()
  function loadModule(filename) {
    const absolute = path.resolve(filename)
    if (absolute === path.join(ROOT, 'utils/backendClient.js')) return backend
    if (absolute === path.join(ROOT, 'utils/analyticsSession.js')) return {
      getCollectionScope: () => 'test:' + state.store.openid,
      recordEvent: (name, data) => { state.telemetry.push({ name, data: plain(data) }); return { ok: true } },
      requestPlaceSuggestions: async data => {
        state.placeRequests.push(plain(data))
        const queue = state.queue.get('places:independent')
        return queue?.length ? queue.shift().promise : placeResponse([data.field === 'departure' ? '公共出发站' : '公共到达站'])
      }
    }
    if (absolute === path.join(ROOT, 'utils/locationConfig.js')) return { loadLocationConfig: options => locations.load(options) }
    if (absolute === path.join(ROOT, 'utils/error.js')) return { showDataError: (...args) => state.errors.push(args) }
    if (modules.has(absolute)) return modules.get(absolute).exports
    const module = { exports: {} }
    modules.set(absolute, module)
    const execute = vm.runInContext(`(function(require, module, exports) {\n${fs.readFileSync(absolute, 'utf8')}\n})`, context, { filename: absolute })
    execute(name => {
      assert.ok(name.startsWith('.'), `Unexpected dependency: ${name}`)
      return loadModule(path.resolve(path.dirname(absolute), name.endsWith('.js') ? name : `${name}.js`))
    }, module, module.exports)
    return module.exports
  }
  loadModule(path.join(ROOT, 'pages/home/newTrip/newTrip.js'))
  const page = { ...definition, data: plain(definition.data) }
  page.setData = function (patch, callback) {
    Object.assign(this.data, plain(patch))
    if (callback) callback.call(this)
  }
  page.loadUserInfo = async () => { state.userReads += 1 }
  page.loadTemplates = async () => { state.templateReads += 1 }
  page.updateReferencePrice_driver = () => { state.driverPrices += 1 }
  page.updateReferencePriceFromRequestPrice = async () => { state.passengerPrices += 1 }
  function hold(key) {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    const queue = state.queue.get(key) || []
    queue.push({ promise })
    state.queue.set(key, queue)
    return { resolve, reject }
  }
  return {
    page, state, hold,
    readPassengerPrice: () => definition.updateReferencePriceFromRequestPrice.call(page),
    async start(mode) { page.onLoad(mode == null ? {} : { mode }); await tick() },
    calendarCalls: () => state.calls,
    placeCalls: () => state.placeRequests,
    day: date => page.data.calendarDays.find(day => day.date === date)
  }
}

test('passenger deep link shares driver address configuration without loading driver templates', async () => {
  const { page, state, start } = harness()
  await start('passenger')
  assert.equal(page.data.mode, 'passenger')
  assert.equal(page.data.referencePrice, '')
  assert.equal(state.templateReads, 0)
  assert.deepEqual(state.configReads, ['/api/v1/locations'])
  assert.deepEqual(page.data.departureAddresses, [...defaults, '其他'])
  assert.deepEqual(page.data.arrivalAddresses, page.data.departureAddresses)
})

test('missing or invalid deep-link mode remains driver and loads its address types and templates', async () => {
  for (const mode of [undefined, 'unknown', 'Passenger']) {
    const { page, state, start } = harness()
    await start(mode)
    assert.equal(page.data.mode, 'driver')
    assert.equal(state.templateReads, 1)
    assert.deepEqual(state.configReads, ['/api/v1/locations'])
  }
})

test('passenger login and profile completion both preserve the passenger return URL', async () => {
  const { page, state, start } = harness()
  await start('passenger')
  delete state.store.openid
  assert.equal(page.ensureLoginBeforeCreate_passenger(), false)
  assert.equal(state.store.pendingPage.url, '/pages/home/newTrip/newTrip?mode=passenger')
  assert.equal(state.store.postLoginAction.returnUrl, '/pages/home/newTrip/newTrip?mode=passenger')
  assert.equal(state.navigation.at(-1).url, '/pages/other/login/login')
  state.store.openid = 'viewer-a'
  page.data.userInfo = null
  page.passenger_confirmTrip()
  assert.equal(state.store.pendingPage.url, '/pages/home/newTrip/newTrip?mode=passenger')
  assert.equal(state.navigation.at(-1).url, '/pages/profile/addInfo/addInfo?from=login')
})

test('both forms request monthly departure and request counts for the selected places and service city', async () => {
  for (const mode of ['driver', 'passenger']) {
    const { page, state, start, calendarCalls, day } = harness()
    await start(mode)
    state.store.ride_active_city_v1 = { key: 'nj' }
    Object.assign(page.data, { departureAddress: 'Fort Lee核心区', destinationAddress: 'JFK', departureDate: '2030-01-20' })
    await page.onOpenDatePicker()
    assert.deepEqual(calendarCalls().at(-1).data, {
      month: '2030-01', cityKey: 'ny_nj',
      fromPlace: 'Fort Lee核心区', toPlace: 'JFK'
    })
    assert.equal(day('2030-01-20').carpoolText, '17发')
    assert.equal(day('2030-01-20').requestText, '6求')
    assert.equal(day('2030-01-21').carpoolText, '0发')
    assert.equal(page.data.calendarLoading, false)
  }
})

test('choosing a date preserves the form mode and fields, while cancellation discards the draft', async () => {
  for (const mode of ['driver', 'passenger']) {
    const { page, start } = harness()
    await start(mode)
    const saved = {
      mode, departureAddress: 'Fort Lee', destinationAddress: '哥大', departureDate: '2030-01-20',
      departureTime: '09:07', referencePrice: '12', carNumber: 'TEST', comment: '备注', passengerCount: 3
    }
    Object.assign(page.data, saved)
    await page.onOpenDatePicker()
    page.onCalendarSelectDate(dateEvent('2030-01-21'))
    assert.equal(page.data.departureDate, saved.departureDate)
    page.onCloseCalendar()
    for (const [key, value] of Object.entries(saved)) assert.equal(page.data[key], value, key)
    await page.onOpenDatePicker()
    assert.equal(page.data.calendarSelectedDate, saved.departureDate)
    page.onCalendarSelectDate(dateEvent('2030-01-22'))
    page.onCalendarConfirm()
    assert.equal(page.data.departureDate, '2030-01-22')
    assert.equal(page.data.calendarVisible, false)
    for (const [key, value] of Object.entries(saved)) if (key !== 'departureDate') assert.equal(page.data[key], value, key)
  }
})

test('switching months reads that month and a failed read keeps counts unknown until retry succeeds', async () => {
  const { page, start, hold, calendarCalls, day } = harness()
  await start('passenger')
  await page.onOpenDatePicker()
  const failed = hold('calendar')
  const next = page.onCalendarNextMonth()
  assert.equal(page.data.calendarMonth, '2030-02')
  assert.equal(day('2030-02-20').carpoolText, '—发')
  failed.reject(new Error('network failed'))
  await next
  assert.ok(page.data.calendarError)
  assert.equal(page.data.calendarLoading, false)
  assert.equal(day('2030-02-20').carpoolText, '—发')
  assert.equal(day('2030-02-20').requestText, '—求')
  const retry = hold('calendar')
  const retried = page.onCalendarRetry()
  retry.resolve(calendarResponse('2030-02', [{ date: '2030-02-20', carpoolCount: 41, requestCount: 9 }]))
  await retried
  assert.equal(day('2030-02-20').carpoolText, '41发')
  assert.equal(day('2030-02-20').requestText, '9求')
  assert.equal(page.data.calendarError, '')
  assert.deepEqual(calendarCalls().map(call => call.data.month), ['2030-01', '2030-02', '2030-02'])
})

test('the two fields use distinct snapshots and refreshed options only appear on the next opening', async () => {
  const { page, start, placeCalls } = harness()
  await start('driver')
  Object.assign(page.data, { departureAddress: '出发自选', destinationAddress: '到达自选' })
  await page.onOpenPlacePicker(placeEvent('departure'))
  assert.equal(page.data.placePickerValue, '出发自选')
  assert.deepEqual(page.data.placePickerOptions, [], 'first order is frozen while the public response arrives')
  page.onClosePlacePicker()
  await page.onOpenPlacePicker(placeEvent('departure'))
  assert.deepEqual(page.data.placePickerOptions.map(row => row.label), ['公共出发站'])
  page.onClosePlacePicker()
  await page.onOpenPlacePicker(placeEvent('destination'))
  assert.equal(page.data.placePickerTitle, '选择目的地')
  assert.equal(page.data.placePickerValue, '到达自选')
  assert.deepEqual(page.data.placePickerOptions, [])
  page.onClosePlacePicker()
  await page.onOpenPlacePicker(placeEvent('destination'))
  assert.deepEqual(page.data.placePickerOptions.map(row => row.label), ['公共到达站'])
  assert.deepEqual(placeCalls().map(row => row.field), ['departure', 'destination'])
})

test('custom place confirmation updates only its field and invokes the correct mode price hook', async () => {
  for (const mode of ['driver', 'passenger']) {
    const { page, state, start } = harness()
    await start(mode)
    Object.assign(page.data, { departureAddress: '原出发', destinationAddress: '原到达' })
    await page.onOpenPlacePicker(placeEvent('departure'))
    await page.onConfirmPlace(valueEvent('  自选出发  '))
    assert.equal(page.data.departureAddress, '自选出发')
    assert.equal(page.data.destinationAddress, '原到达')
    assert.equal(page.data.placePickerVisible, false)
    await page.onOpenPlacePicker(placeEvent('destination'))
    await page.onConfirmPlace(valueEvent('自选到达'))
    assert.equal(page.data.departureAddress, '自选出发')
    assert.equal(page.data.destinationAddress, '自选到达')
    assert.equal(state.driverPrices, mode === 'driver' ? 2 : 0)
    assert.equal(state.passengerPrices, mode === 'passenger' ? 2 : 0)
  }
})

test('invalid custom places cannot close the picker, change the form, or trigger pricing', async () => {
  const { page, state, start } = harness()
  await start('driver')
  page.data.departureAddress = '原出发'
  await page.onOpenPlacePicker(placeEvent('departure'))
  for (const value of ['', '  ', 'a'.repeat(201)]) {
    await page.onConfirmPlace(valueEvent(value))
    assert.equal(page.data.departureAddress, '原出发')
    assert.equal(page.data.placePickerVisible, true)
  }
  assert.equal(state.driverPrices, 0)
})

test('time confirmation retains minute 07 and cancellation leaves the previous time unchanged', async () => {
  for (const mode of ['driver', 'passenger']) {
    const { page, start } = harness()
    await start(mode)
    page.data.departureTime = '08:16'
    page.onOpenTimePicker()
    page.onCloseTimePicker()
    assert.equal(page.data.departureTime, '08:16')
    page.onOpenTimePicker()
    page.onTimeChange(valueEvent('19:07'))
    assert.equal(page.data.departureTime, '19:07')
    assert.equal(page.data.timePickerVisible, false)
    page.onTimeChange(valueEvent('24:00'))
    assert.equal(page.data.departureTime, '19:07')
    assert.equal(page.data.mode, mode)
  }
})

test('late place suggestions cannot change a closed or unloaded page', async () => {
  for (const finish of ['close', 'unload']) {
    const { page, start, hold } = harness()
    await start('driver')
    const held = hold('places:independent')
    const opened = page.onOpenPlacePicker(placeEvent('departure'))
    if (finish === 'close') page.onClosePlacePicker()
    else page.onUnload()
    const before = plain(page.data)
    held.resolve(placeResponse(['迟到的出发'], ['迟到的到达']))
    await opened
    assert.deepEqual(page.data, before)
    assert.deepEqual(plain(page._placeSuggestions.places), [])
  }
})

test('account change closes the private panel and late responses cannot repopulate it', async () => {
  const { page, state, start, hold, placeCalls } = harness()
  await start('driver')
  const old = hold('places:independent')
  const opened = page.onOpenPlacePicker(placeEvent('departure'))
  state.store.openid = 'viewer-b'
  await page.loadPlaceSuggestions()
  assert.equal(page.data.placePickerVisible, false)
  old.resolve(placeResponse(['旧账号公共地点']))
  await opened
  await page.onOpenPlacePicker(placeEvent('departure'))
  assert.deepEqual(page.data.placePickerOptions, [])
  page.onClosePlacePicker()
  await page.onOpenPlacePicker(placeEvent('departure'))
  assert.deepEqual(page.data.placePickerOptions.map(row => row.label), ['公共出发站'])
  assert.equal(placeCalls().length, 2)
})

test('late calendar responses cannot replace a new month or modify a closed calendar', async () => {
  const { page, start, hold, day } = harness()
  await start('driver')
  const january = hold('calendar')
  const opened = page.onOpenDatePicker()
  await page.onCalendarNextMonth()
  assert.equal(day('2030-02-20').carpoolText, '17发')
  january.resolve(calendarResponse('2030-01', [{ date: '2030-01-20', carpoolCount: 999, requestCount: 999 }]))
  await opened
  assert.equal(page.data.calendarMonth, '2030-02')
  assert.equal(day('2030-02-20').carpoolText, '17发')
  const march = hold('calendar')
  const next = page.onCalendarNextMonth()
  page.onCloseCalendar()
  const closed = plain(page.data)
  march.resolve(calendarResponse('2030-03'))
  await next
  assert.deepEqual(page.data, closed)
})

test('switching from driver to passenger shares in-flight configuration without a second catalog request', async () => {
  const { page, state, hold } = harness()
  const sharedCatalog = hold('locations')
  page.onLoad({ mode: 'driver' })
  page.setMode({ currentTarget: { dataset: { mode: 'passenger' } } })
  await tick()
  assert.equal(page.data.mode, 'passenger')
  assert.deepEqual(state.configReads, ['/api/v1/locations'])
  sharedCatalog.resolve({ ...plain(require('../utils/locationCatalog.generated')), rideAddresses: { ...plain(require('../utils/locationCatalog.generated').rideAddresses), offer: { fromPlaces: [...defaults, '共有出发'], toPlaces: [...defaults, '共有到达'] } } })
  await tick()
  assert.deepEqual(page.data.departureAddresses, [...defaults, '共有出发', '其他'])
  assert.deepEqual(page.data.arrivalAddresses, [...defaults, '共有到达', '其他'])
  assert.equal(page.data.loadingDepartureAddrs, false)
  assert.equal(page.data.loadingArrivalAddrs, false)
  assert.equal(state.errors.length, 0)
})

test('address responses after unload cannot modify the page or show an obsolete error', async () => {
  for (const failed of [false, true]) {
    const { page, state, hold } = harness()
    const catalog = hold('locations')
    page.onLoad({ mode: 'passenger' })
    page.onUnload()
    const closed = plain(page.data)
    if (failed) catalog.reject(new Error('stale configuration request failed'))
    else catalog.resolve(plain(require('../utils/locationCatalog.generated')))
    await tick()
    assert.deepEqual(page.data, closed)
    assert.equal(state.errors.length, 0)
  }
})

test('both forms show the twelve fixed places and keep a completed background response for next opening', async () => {
  for (const mode of ['driver', 'passenger']) {
    const { page, start, state, hold } = harness()
    await start(mode)
    const suggestions = hold('places:independent')
    const opened = page.onOpenPlacePicker(placeEvent('departure'))
    const labels = page.data.placePickerFixedOptions.map(item => item.label)
    suggestions.resolve(placeResponse(['公共车站']))
    await opened
    assert.deepEqual(labels, ['Fort Lee', '哥大', '法拉盛', 'JFK', 'EWR 纽瓦克机场', 'LGA 拉瓜迪亚', 'LIC', 'JSQ', 'Inwood', '中城', 'NYU', 'Queens'])
    assert.deepEqual(page.data.placePickerOptions, [])
    page.onClosePlacePicker()
    await page.onOpenPlacePicker(placeEvent('departure'))
    assert.deepEqual(page.data.placePickerOptions.map(row => row.value), ['公共车站'])
    await page.onConfirmPlace(valueEvent('EWR 机场'))
    assert.equal(page.data.departureAddress, 'EWR 机场')
    assert.equal(state.driverPrices, mode === 'driver' ? 1 : 0)
    assert.equal(state.passengerPrices, mode === 'passenger' ? 1 : 0)
    assert.equal(state.configReads.length, 1)
  }
})

test('expired fixed configuration refreshes underlying data while the open panel stays stable', async () => {
  const { page, start, state } = harness()
  await start('driver')
  await page.onOpenPlacePicker(placeEvent('departure'))
  const frozen = plain(page.data.placePickerFixedOptions)
  page.onClosePlacePicker()
  state.addressConfig = { fromPlaces: [...defaults, '博物馆'], toPlaces: [...defaults, '新目的地'] }
  state.now += 300000
  await page.onOpenPlacePicker(placeEvent('departure'))
  assert.equal(state.configReads.length, 2)
  assert.deepEqual(page.data.placePickerFixedOptions, frozen)
  page.onClosePlacePicker()
  await page.onOpenPlacePicker(placeEvent('departure'))
  assert.equal(page.data.placePickerFixedOptions.at(-1).label, '博物馆')
  assert.equal(page.data.placePickerFixedOptions.length, 13)
  assert.equal(state.configReads.length, 2)
})

test('short airport labels resolve the server passenger price catalog with one read and prefer an exact configured pair', async () => {
  for (const [selected, saved] of [['EWR 机场', '纽瓦克'], ['JFK', 'JFK 机场'], ['拉瓜迪亚', 'La Guardia Airport'], ['法拉盛', 'Flushing']]) {
    const { page, start, state, readPassengerPrice } = harness()
    Object.assign(page.data, { departureAddress: selected, destinationAddress: '哥大' })
    state.priceRows = [
      { fromAddress: saved + ' Terminal C', toAddress: '哥大', label: '999' },
      { fromAddress: saved, toAddress: '哥大', label: '32' }
    ]
    await start('passenger')
    await readPassengerPrice()
    assert.equal(String(page.data.referencePrice), '32', selected)
    assert.equal(state.configReads.length, 1)
    state.priceRows.push({ fromAddress: selected, toAddress: '哥大', label: '28' })
    state.now += 300000
    await readPassengerPrice()
    assert.equal(String(page.data.referencePrice), '28', 'exact selected pair takes precedence over legacy spelling')
    assert.equal(state.configReads.length, 2, 'an expired catalog refreshes once for both address and price consumers')
  }
})

test('airport price alias matching works in either direction and does not broaden specific custom destinations', async () => {
  const { page, start, state, readPassengerPrice } = harness()
  Object.assign(page.data, { departureAddress: '哥大', destinationAddress: 'EWR 机场' })
  state.priceRows = [{ fromAddress: '哥大', toAddress: 'Newark Liberty International Airport', label: '45' }]
  await start('passenger')
  await readPassengerPrice()
  assert.equal(String(page.data.referencePrice), '45')
  page.data.destinationAddress = 'EWR Terminal C'
  await readPassengerPrice()
  assert.equal(page.data.referencePrice, '参考打车价格')
  assert.equal(state.configReads.at(-1), '/api/v1/locations')
  state.priceRows.push({ fromAddress: '哥大', toAddress: 'EWR Terminal C', label: '51' })
  state.now += 300000
  await readPassengerPrice()
  assert.equal(String(page.data.referencePrice), '51')
  assert.equal(state.configReads.length, 2)
})

test('Fort Lee core and whole-area passenger prices retain their original exact configuration keys', async () => {
  const { page, start, state, readPassengerPrice } = harness()
  Object.assign(page.data, { departureAddress: 'Fort Lee 核心区', destinationAddress: '哥大' })
  state.priceRows = [
    { fromAddress: 'Fort Lee 全区域', toAddress: '哥大', label: '15' },
    { fromAddress: 'Fort Lee 核心区', toAddress: '哥大', label: '10' }
  ]
  await start('passenger')
  await readPassengerPrice()
  assert.equal(String(page.data.referencePrice), '10')
  assert.deepEqual(state.configReads, ['/api/v1/locations'])
})
