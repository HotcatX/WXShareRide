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
  result: { success: true, month, data: { days } }
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
    templateReads: 0, userReads: 0, driverPrices: 0, passengerPrices: 0, addressReads: [], priceReads: [], priceRows: [],
    addressConfig: {
      Departure: { _id: 'dep', JFK: 'JFK', FortLee: 'Fort Lee核心区', Flushing: 'Flushing', Columbia: '哥大', LGA: 'LGA 机场', EWR: 'EWR 机场' },
      Arrival: { _id: 'arr', JFK: 'JFK', FortLee: 'Fort Lee核心区', Flushing: 'Flushing', Columbia: '哥大', LGA: 'LGA 机场', EWR: 'EWR 机场' }
    }
  }
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [state.now])) }
    static now() { return state.now }
  }
  const requestKey = args => args.name === 'getTripList' ? `getTripList:${args.data.action}` : `${args.name}:${args.data?.type || ''}`
  const wx = {
    getWindowInfo: () => ({ statusBarHeight: 24 }),
    getStorageSync: key => state.store[key],
    setStorageSync: (key, value) => { state.store[key] = plain(value) },
    removeStorageSync: key => { delete state.store[key] },
    hideKeyboard() {}, showToast() {}, navigateBack() {},
    navigateTo: args => { state.navigation.push(plain(args)) },
    cloud: {
      callFunction(args) {
        state.calls.push(plain(args))
        const queue = state.queue.get(requestKey(args))
        if (queue?.length) return queue.shift().promise
        if (args.name === 'getTripList' && args.data.action === 'calendar') return Promise.resolve(calendarResponse(args.data.month))
        if (args.name === 'getTripList' && args.data.action === 'places') return Promise.resolve(placeResponse())
        throw new Error(`Unexpected cloud call: ${args.name}`)
      },
      database() {
        return { RegExp: ({ regexp, options }) => new RegExp(regexp, options), collection(name) {
          if (name === 'Request_Price') return { where(condition) {
            let limit = 20
            return {
              limit(value) { limit = value; return this },
              get() {
                state.priceReads.push({ condition, limit })
                const matches = row => Object.entries(condition).every(([key, value]) => typeof value?.test === 'function' ? value.test(row[key]) : row[key] === value)
                return Promise.resolve({ data: state.priceRows.filter(matches).slice(0, limit).map(plain) })
              }
            }
          } }
          assert.ok(['Departure', 'Arrival'].includes(name), 'both modes read the same existing address configuration')
          return { get() {
            state.addressReads.push(name)
            const queue = state.queue.get(`address:${name}`)
            if (queue?.length) return queue.shift().promise
            return Promise.resolve({ data: [plain(state.addressConfig[name])] })
          } }
        } }
      }
    }
  }
  const context = vm.createContext({
    wx, Date: Clock, Page: value => { definition = value },
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout
  })
  const modules = new Map()
  function loadModule(filename) {
    const absolute = path.resolve(filename)
    if (absolute === path.join(ROOT, 'utils/researchParticipation.js')) return {
      getCollectionScope: () => 'test:' + state.store.openid,
      recordEvent: (name, data) => { state.telemetry.push({ name, data: plain(data) }); return { ok: true } },
      requestPlaceSuggestions: async data => {
        state.placeRequests.push(plain(data))
        const queue = state.queue.get('places:independent')
        return queue?.length ? queue.shift().promise : placeResponse([data.field === 'departure' ? '公共出发站' : '公共到达站'])
      }
    }
    if (absolute === path.join(ROOT, 'utils/cloudConfig.js')) return { loadPublicConfigDoc: async () => null }
    if (absolute === path.join(ROOT, 'utils/error.js')) return { showDataError: (...args) => state.errors.push(args) }
    if (modules.has(absolute)) return modules.get(absolute).exports
    const module = { exports: {} }
    modules.set(absolute, module)
    const execute = vm.runInContext(`(function(require, module, exports) {\n${fs.readFileSync(absolute, 'utf8')}\n})`, context, { filename: absolute })
    execute(name => {
      assert.ok(name.startsWith('.'), `Unexpected dependency: ${name}`)
      return loadModule(path.resolve(path.dirname(absolute), `${name}.js`))
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
    calendarCalls: () => state.calls.filter(call => call.data?.action === 'calendar'),
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
  assert.deepEqual(state.addressReads, ['Departure', 'Arrival'])
  assert.deepEqual(page.data.departureAddresses, ['Fort Lee核心区', '哥大', 'Flushing', 'JFK', 'EWR 机场', 'LGA 机场', 'LIC', 'JSQ', '其他'])
  assert.deepEqual(page.data.arrivalAddresses, page.data.departureAddresses)
})

test('missing or invalid deep-link mode remains driver and loads its address types and templates', async () => {
  for (const mode of [undefined, 'unknown', 'Passenger']) {
    const { page, state, start } = harness()
    await start(mode)
    assert.equal(page.data.mode, 'driver')
    assert.equal(state.templateReads, 1)
    assert.deepEqual(state.addressReads, ['Departure', 'Arrival'])
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
      action: 'calendar', month: '2030-01', type: 'all', cityKey: 'ny_nj',
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
  const failed = hold('getTripList:calendar')
  const next = page.onCalendarNextMonth()
  assert.equal(page.data.calendarMonth, '2030-02')
  assert.equal(day('2030-02-20').carpoolText, '—发')
  failed.reject(new Error('network failed'))
  await next
  assert.ok(page.data.calendarError)
  assert.equal(page.data.calendarLoading, false)
  assert.equal(day('2030-02-20').carpoolText, '—发')
  assert.equal(day('2030-02-20').requestText, '—求')
  const retry = hold('getTripList:calendar')
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
  const january = hold('getTripList:calendar')
  const opened = page.onOpenDatePicker()
  await page.onCalendarNextMonth()
  assert.equal(day('2030-02-20').carpoolText, '17发')
  january.resolve(calendarResponse('2030-01', [{ date: '2030-01-20', carpoolCount: 999, requestCount: 999 }]))
  await opened
  assert.equal(page.data.calendarMonth, '2030-02')
  assert.equal(day('2030-02-20').carpoolText, '17发')
  const march = hold('getTripList:calendar')
  const next = page.onCalendarNextMonth()
  page.onCloseCalendar()
  const closed = plain(page.data)
  march.resolve(calendarResponse('2030-03'))
  await next
  assert.deepEqual(page.data, closed)
})

test('switching from driver to passenger shares in-flight configuration without a second pair of reads', async () => {
  const { page, state, hold } = harness()
  const oldDeparture = hold('address:Departure')
  const oldArrival = hold('address:Arrival')
  page.onLoad({ mode: 'driver' })
  page.setMode({ currentTarget: { dataset: { mode: 'passenger' } } })
  await tick()
  assert.equal(page.data.mode, 'passenger')
  assert.deepEqual(state.addressReads, ['Departure', 'Arrival'])
  oldDeparture.resolve({ data: [{ _id: 'dep', place: '共有出发' }] })
  oldArrival.resolve({ data: [{ _id: 'arr', place: '共有到达' }] })
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
    const departure = hold('address:Departure')
    const arrival = hold('address:Arrival')
    page.onLoad({ mode: 'passenger' })
    page.onUnload()
    const closed = plain(page.data)
    if (failed) departure.reject(new Error('stale configuration request failed'))
    else departure.resolve({ data: [{ place: '迟到出发' }] })
    arrival.resolve({ data: [{ place: '迟到到达' }] })
    await tick()
    assert.deepEqual(page.data, closed)
    assert.equal(state.errors.length, 0)
  }
})

test('both forms show the eight fixed places and keep a completed background response for next opening', async () => {
  for (const mode of ['driver', 'passenger']) {
    const { page, start, state, hold } = harness()
    await start(mode)
    const suggestions = hold('places:independent')
    const opened = page.onOpenPlacePicker(placeEvent('departure'))
    const labels = page.data.placePickerFixedOptions.map(item => item.label)
    suggestions.resolve(placeResponse(['公共车站']))
    await opened
    assert.deepEqual(labels, ['Fort Lee', '哥大', '法拉盛', 'JFK', 'EWR 纽瓦克机场', 'LGA 拉瓜迪亚', 'LIC', 'JSQ'])
    assert.deepEqual(page.data.placePickerOptions, [])
    page.onClosePlacePicker()
    await page.onOpenPlacePicker(placeEvent('departure'))
    assert.deepEqual(page.data.placePickerOptions.map(row => row.value), ['公共车站'])
    await page.onConfirmPlace(valueEvent('EWR 机场'))
    assert.equal(page.data.departureAddress, 'EWR 机场')
    assert.equal(state.driverPrices, mode === 'driver' ? 1 : 0)
    assert.equal(state.passengerPrices, mode === 'passenger' ? 1 : 0)
    assert.equal(state.addressReads.length, 2)
  }
})

test('expired fixed configuration refreshes underlying data while the open panel stays stable', async () => {
  const { page, start, state } = harness()
  await start('driver')
  await page.onOpenPlacePicker(placeEvent('departure'))
  const frozen = plain(page.data.placePickerFixedOptions)
  page.onClosePlacePicker()
  state.addressConfig.Departure = { _id: 'dep', museum: '博物馆', campus: '哥大', jfk: 'JFK' }
  state.addressConfig.Arrival = { _id: 'arr', destination: '新目的地', newark: 'Newark Airport' }
  state.now += 300000
  await page.onOpenPlacePicker(placeEvent('departure'))
  assert.equal(state.addressReads.length, 4)
  assert.deepEqual(page.data.placePickerFixedOptions, frozen)
  page.onClosePlacePicker()
  await page.onOpenPlacePicker(placeEvent('departure'))
  assert.equal(page.data.placePickerFixedOptions.at(-1).label, '博物馆')
  assert.equal(page.data.placePickerFixedOptions.length, 9)
  assert.equal(state.addressReads.length, 4)
})

test('short airport labels resolve existing passenger price rows with one query and prefer an exact configured pair', async () => {
  for (const [selected, saved] of [['EWR 机场', '纽瓦克'], ['JFK', 'JFK 机场'], ['拉瓜迪亚', 'La Guardia Airport'], ['法拉盛', 'Flushing']]) {
    const { page, start, state, readPassengerPrice } = harness()
    await start('passenger')
    Object.assign(page.data, { departureAddress: selected, destinationAddress: '哥大' })
    state.priceRows = [
      { Departure: saved + ' Terminal C', Destination: '哥大', Price: 999 },
      { Departure: saved, Destination: '哥大', Price: 32 }
    ]
    await readPassengerPrice()
    assert.equal(String(page.data.referencePrice), '32', selected)
    assert.equal(state.priceReads.length, 1)
    state.priceRows.push({ Departure: selected, Destination: '哥大', Price: 28 })
    await readPassengerPrice()
    assert.equal(String(page.data.referencePrice), '28', 'exact selected pair takes precedence over legacy spelling')
    assert.equal(state.priceReads.length, 2, 'each price update makes only one query')
  }
})

test('airport price alias matching works in either direction and does not broaden specific custom destinations', async () => {
  const { page, start, state, readPassengerPrice } = harness()
  await start('passenger')
  Object.assign(page.data, { departureAddress: '哥大', destinationAddress: 'EWR 机场' })
  state.priceRows = [{ Departure: '哥大', Destination: 'Newark Liberty International Airport', Price: 45 }]
  await readPassengerPrice()
  assert.equal(String(page.data.referencePrice), '45')
  page.data.destinationAddress = 'EWR Terminal C'
  await readPassengerPrice()
  assert.equal(page.data.referencePrice, '参考打车价格')
  assert.equal(state.priceReads.at(-1).condition.Destination, 'EWR Terminal C')
  assert.equal(state.priceReads.at(-1).limit, 1)
  state.priceRows.push({ Departure: '哥大', Destination: 'EWR Terminal C', Price: 51 })
  await readPassengerPrice()
  assert.equal(String(page.data.referencePrice), '51')
  assert.equal(state.priceReads.length, 3)
})

test('Fort Lee core and whole-area passenger prices retain their original exact configuration keys', async () => {
  const { page, start, state, readPassengerPrice } = harness()
  await start('passenger')
  Object.assign(page.data, { departureAddress: 'Fort Lee 核心区', destinationAddress: '哥大' })
  state.priceRows = [
    { Departure: 'Fort Lee 全区域', Destination: '哥大', Price: 15 },
    { Departure: 'Fort Lee 核心区', Destination: '哥大', Price: 10 }
  ]
  await readPassengerPrice()
  assert.equal(String(page.data.referencePrice), '10')
  assert.deepEqual(plain(state.priceReads[0].condition), { Departure: 'Fort Lee 核心区', Destination: '哥大' })
  assert.equal(state.priceReads[0].limit, 1)
})
