const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { requestPlan, selectRequests, createRequestRecommendations } = require('../utils/requestRecommendations')
const { parseRideDateTime } = require('../utils/rideTime')
const now = parseRideDateTime('2030-01-15', '12:00')
const form = { cityKey: 'ny_nj', departureAddress: 'Fort Lee', destinationAddress: '哥大', departureDate: '2030-01-15', departureTime: '15:00' }
const ride = (id, time, extra = {}) => ({ _id: id, kind: 'request', status: 'open', cityKey: 'ny_nj', hasDriver: false,
  departures: [{ address: 'Fort Lee', date: '2030-01-15', time }], destinations: [{ address: '哥大' }],
  departureAtMs: parseRideDateTime('2030-01-15', time), passengerCount: 1, ...extra })

test('explicit route uses inclusive asymmetric window and nearest time before seats/history popularity', () => {
  const rows = [ride('early', '14:30'), ride('late', '15:15'), ride('near', '14:55'), ride('closest', '15:00'),
    ride('too-early', '14:29'), ride('too-late', '15:16')]
  const plan = requestPlan(form, [], now)
  assert.deepEqual(selectRequests(rows, plan, now).map(row => row._id), ['closest', 'near', 'late'])
  assert.deepEqual(selectRequests([rows[0], rows[1]], plan, now).map(row => row._id), ['late', 'early'])
})

test('only future open unassigned requests in the same city and directional route are suggested', () => {
  const valid = ride('alias', '15:00', { destinations: [{ address: '哥伦比亚大学' }] })
  const rows = [valid, ride('closed', '15:00', { status: 'past' }), ride('assigned', '15:00', { hasDriver: true }),
    ride('offer', '15:00', { kind: 'offer' }), ride('city', '15:00', { cityKey: 'other' }),
    ride('reverse', '15:00', { departures: [{ address: '哥大', date: '2030-01-15', time: '15:00' }], destinations: [{ address: 'Fort Lee' }] }),
    ride('other-date', '15:00', { departures: [{ address: 'Fort Lee', date: '2030-01-16', time: '15:00' }] }),
    ride('multi', '15:00', { destinations: [{ address: '哥大' }, { address: 'NYU' }] })]
  assert.deepEqual(selectRequests(rows, requestPlan(form, [], now), now).map(row => row._id), ['alias'])
  assert.deepEqual(selectRequests(rows, requestPlan(form, [], now), parseRideDateTime('2030-01-15', '15:01')), [])
})

test('history learns directed route frequency and never substitutes an explicitly selected endpoint', () => {
  const history = [ride('a', '15:00'), ride('b', '15:00'), ride('c', '15:00', { destinations: [{ address: 'NYU' }] })]
  const empty = { cityKey: 'ny_nj' }
  const plan = requestPlan(empty, history, now)
  assert.equal(plan.basis, 'history')
  assert.deepEqual(plan.routes.map(route => [route.from, route.to, route.weight]), [['Fort Lee', '哥大', 2], ['Fort Lee', 'NYU', 1]])
  assert.equal(plan.startDate, '2030-01-15'); assert.equal(plan.endDateExclusive, '2030-01-17')
  assert.equal(requestPlan({ ...empty, departureAddress: 'JFK' }, history, now).routes.length, 0)
  const explicit = requestPlan({ ...form, destinationAddress: 'JFK' }, history, now)
  assert.equal(explicit.routes[0].to, 'JFK')
  assert.deepEqual(selectRequests(history, explicit, now), [])
})

test('custom addresses use exact normalized text; broad labels do not merge buildings', () => {
  const plan = requestPlan({ ...form, departureAddress: '  Modern   800 ' }, [], now)
  const rows = ['modern 800', 'Modern 900'].map((address, i) => ride(String(i), '15:00', {
    departures: [{ address, date: '2030-01-15', time: '15:00' }] }))
  assert.deepEqual(selectRequests(rows, plan, now).map(row => row._id), ['0'])
})

function controllerFixture() {
  let owner = 'driver', clock = now
  const calls = [], events = []
  const page = { data: { ...form, mode: 'driver', requestSuggestions: [] },
    setData(patch, callback) { Object.assign(this.data, patch); callback?.() } }
  const options = { wx: { getStorageSync: key => key === 'openid' ? owner : false }, now: () => clock,
    backend: { get: async url => { calls.push(url); return { rides: [] } } },
    rides: { callTripList: async input => { calls.push(input); return { result: { data: { request: [ride('valid', '15:00')] } } } } },
    telemetry: { stopList() {}, pageHidden(p) { p._rideTelemetryHidden = true }, pageVisible(p) { p._rideTelemetryHidden = false },
      renderList: (p, groups, opts) => events.push(opts) } }
  const controller = createRequestRecommendations(page, () => 'ny_nj', options)
  return { page, options, controller, calls, events, owner: value => { owner = value }, clock: value => { clock = value } }
}

test('route/time changes reuse the complete selected-day read and label cached observations', async () => {
  const { page, controller, calls, events } = controllerFixture()
  await controller.load()
  page.data.departureTime = '15:10'; await controller.load()
  page.data.destinationAddress = 'NYU'; await controller.load()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { type: 'request', cityKey: 'ny_nj', startDate: '2030-01-15', endDateExclusive: '2030-01-16' })
  assert.deepEqual(events.map(event => event.source), ['network', 'cache', 'cache'])
  assert.deepEqual(page.data.requestSuggestions, [])
})

test('account switches, mode switches and hidden pages discard stale reads without blocking publishing', async () => {
  for (const change of [fixture => fixture.owner('other'), fixture => { fixture.page.data.mode = 'passenger' }, fixture => fixture.controller.pause()]) {
    const fixture = controllerFixture()
    let resolve
    fixture.options.rides.callTripList = () => new Promise(done => { resolve = done })
    const pending = fixture.controller.load(); change(fixture)
    resolve({ result: { data: { request: [ride('stale', '15:00')] } } })
    await pending
    assert.deepEqual(fixture.page.data.requestSuggestions, [])
    assert.equal(fixture.events.length, 0)
  }
})

test('history reads only once per account; empty history never loads a generic unbounded suggestion feed', async () => {
  const fixture = controllerFixture()
  fixture.page.data.departureAddress = ''; fixture.page.data.destinationAddress = ''
  await fixture.controller.load(); await fixture.controller.load()
  assert.deepEqual(fixture.calls, ['/api/v1/me/rides?scope=history&role=driver&page=1&limit=50'])
  fixture.owner('other'); await fixture.controller.load()
  assert.equal(fixture.calls.length, 2)
})

test('multi-stop templates and failed request reads leave the optional recommendation area empty', async () => {
  const fixture = controllerFixture()
  fixture.page._selectedTemplate = { definition: { stops: [{}, {}, {}] } }
  await fixture.controller.load(); assert.equal(fixture.calls.length, 0)
  fixture.page._selectedTemplate = null
  fixture.options.rides.callTripList = async () => { throw Error('offline') }
  await fixture.controller.load(); assert.deepEqual(fixture.page.data.requestSuggestions, [])
})

function publisherFixture() {
  let definition
  const prices = [], navigation = [], storage = new Map()
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/home/newTrip/newTrip.js'), 'utf8'), {
    Page: value => { definition = value }, console, setTimeout, clearTimeout,
    wx: { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), navigateTo: value => navigation.push(value), getWindowInfo: () => ({ statusBarHeight: 20 }) },
    require(name) {
      if (name.endsWith('/rideTime')) return require('../utils/rideTime')
      if (name.endsWith('/compat/profile')) return { identity: () => storage.get('openid') || '' }
      if (name.endsWith('/requestRecommendations')) return { createRequestRecommendations: () => ({ show() {} }) }
      if (name.endsWith('/compat/ridePublish')) return { loadRequestPrice: async (...args) => { prices.push(args); return '8' } }
      return {}
    }
  })
  const page = { ...definition, data: { ...definition.data, mode: 'passenger' },
    setData(patch, callback) { Object.assign(this.data, patch); callback?.() } }
  return { page, prices, storage, navigation }
}

test('passenger entry restores source route date/time and keeps edited fields through login return', async () => {
  const { page, prices, storage } = publisherFixture()
  page._requestIntent = { entry: 'full_ride', sourceTripKey: 'original', intentId: 'intent' }
  page.applyRequestPrefill({ from: 'Fort%20Lee', to: encodeURIComponent('哥大'), date: '2030-01-15', time: '15%3A00' })
  await Promise.resolve()
  assert.equal(page.data.departureAddress, 'Fort Lee'); assert.equal(page.data.destinationAddress, '哥大')
  assert.equal(page.data.departureDate, '2030-01-15'); assert.equal(page.data.departureTime, '15:00')
  assert.deepEqual(prices, [['Fort Lee', '哥大']])
  page.data.departureTime = '15:15'
  page.ensureLoginBeforeCreate_passenger()
  const returned = new URL(storage.get('pendingPage').url, 'https://mini.local')
  assert.equal(returned.searchParams.get('time'), '15:15')
  assert.equal(returned.searchParams.get('intentId'), 'intent')
  assert.equal(returned.searchParams.get('sourceTripKey'), 'original')
})

test('malformed query dates/times are not prefilled', () => {
  const { page } = publisherFixture()
  page.applyRequestPrefill({ from: '%broken', date: '2030-02-31', time: '25:00' })
  assert.equal(page.data.departureAddress, '')
  assert.equal(page.data.departureDate, '')
  assert.equal(page.data.departureTime, '')
})

test('the existing login redirect opens a fresh publisher retaining prefill on its first onShow', async () => {
  const before = publisherFixture()
  before.page._requestIntent = { entry: 'full_ride', sourceTripKey: 'original', intentId: 'intent' }
  Object.assign(before.page.data, form)
  before.page.ensureLoginBeforeCreate_passenger()
  const pending = new URL(before.storage.get('pendingPage').url, 'https://mini.local')
  const after = publisherFixture()
  after.storage.set('openid', 'signed-in-user')
  Object.assign(after.page, { loadUserInfo() {}, loadAllAddresses() {}, loadTemplatesIfNeeded() {} })
  after.page.onLoad(Object.fromEntries(pending.searchParams))
  after.page.onShow()
  await Promise.resolve()
  assert.equal(after.page.data.departureAddress, form.departureAddress)
  assert.equal(after.page.data.departureTime, form.departureTime)
  assert.equal(after.page.data.departureDate, form.departureDate)
  assert.equal(after.page._requestIntent.intentId, 'intent')
})

test('login navigateBack preserves the guest passenger draft, while a later account switch clears it', async () => {
  const { page, storage } = publisherFixture()
  Object.assign(page, { loadUserInfo() {}, loadAllAddresses() {}, loadTemplatesIfNeeded() {} })
  page.onLoad({ mode: 'passenger', from: 'Fort Lee', to: '哥大', date: '2030-01-15', time: '15:00', entry: 'full_ride', sourceTripKey: 'original' })
  page.ensureLoginBeforeCreate_passenger()
  storage.set('openid', 'signed-in-user')
  page.onShow()
  await Promise.resolve()
  assert.equal(page.data.departureAddress, 'Fort Lee'); assert.equal(page.data.departureTime, '15:00')
  assert.equal(page._requestIntent.sourceTripKey, 'original')
  storage.set('openid', 'different-user')
  page.onShow()
  assert.equal(page.data.departureAddress, ''); assert.equal(page.data.departureTime, '')
  assert.equal(page._requestIntent.sourceTripKey, undefined)
})
