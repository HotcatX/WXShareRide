const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const file = path.resolve(__dirname, '../pages/home/tripDetail/tripDetail.js')
const flush = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const ride = (id = 'full', extra = {}) => ({
  _id: id, kind: 'offer', cityKey: 'ny_nj', status: 'open', canonicalStatus: 'open', serverMode: true,
  businessVersion: 1, availSeatNum: 0, availableSeats: 0, seatCapacity: 3, hasDriver: true,
  viewer: { role: null, isCreator: false },
  departures: [{ address: 'Fort Lee', date: '2030-01-01', time: '08:00' }],
  destinations: [{ address: '哥大' }], referencePrice: '12', ...extra
})
const alternative = id => ride(id, { availSeatNum: 2, availableSeats: 2 })

function harness() {
  const state = { account: 'alice', calls: [], candidates: [alternative('other')], renders: [], clicks: [], navigation: [], detailReads: [], intents: [] }
  let definition
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page(value) { definition = value }, console,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, getCurrentPages: () => [{}],
    wx: {
      getStorageSync(key) { return key === 'openid' ? state.account : undefined },
      redirectTo(options) { state.navigation.push(options.url) },
      navigateTo(options) { state.navigation.push(options.url) }, stopPullDownRefresh() {}
    },
    require(name) {
      if (name.endsWith('/compat/rides')) return { isBackendEnabled: () => true }
      if (name.endsWith('/compat/profile')) return { getUserInfo: async () => ({}), legacyDocument: () => ({}) }
      if (name.endsWith('/rideAlternatives')) return { loadRideAlternatives: async source => {
        state.calls.push(source._id)
        if (state.failure) throw Error('offline')
        return state.pending || state.candidates
      } }
      if (name.endsWith('/rideTelemetry')) return {
        stopList() {}, detailViewed() {},
        requestIntent(stage, context, trip) { state.intents.push({ stage, context, trip }); return 'preview_intent_123456' },
        renderList(_page, groups, options) { state.renders.push({ groups, options }) },
        clickTrip(_page, id, type) { state.clicks.push({ id, type }) }
      }
      if (name.endsWith('/tripDetailCache')) return { fetchTripDetail: async (type, id, options) => {
        state.detailReads.push({ type, id, options }); return state.detailPending || { ok: true, data: alternative(id) }
      } }
      return require(path.resolve(path.dirname(file), name))
    }
  })
  const page = { ...definition, data: structuredClone(definition.data), _detailAccount: 'user:alice' }
  page.setData = function (patch, callback) { Object.assign(this.data, patch); callback?.() }
  page.data.tripId = 'full'
  return { page, state }
}

test('full nonmember detail shows actual nearby alternatives and reuses the exposure/click flow', async () => {
  const { page, state } = harness()
  page.applyTripData(ride(), 'full')
  assert.equal(page.data.alternativesState, 'loading')
  await flush()
  assert.equal(page.data.alternativesState, 'ready')
  assert.equal(page.data.alternatives[0].routeText, 'Fort Lee → 哥大')
  assert.equal(page.data.alternatives[0].timeText, '08:00')
  assert.equal(state.renders[0].groups[0].items[0]._id, 'other')
  assert.equal(state.renders[0].options.source, 'network')
  page.openAlternative({ currentTarget: { dataset: { id: 'other' } } })
  assert.equal(state.clicks[0].id, 'other')
  assert.deepEqual(state.navigation, ['/pages/home/tripDetail/tripDetail?id=other'])
  // The existing detail entry always performs a fresh status/capacity read.
  await page.loadTripDetail('other')
  assert.equal(state.detailReads[0].options.force, true)
  assert.equal(page.data.trip.availSeatNum, 2)
  assert.equal(page.data.alternativesState, 'idle')
})
test('request button opens the existing passenger publisher with empty or unavailable recommendations', async () => {
  for (const failed of [false, true]) {
    const { page, state } = harness()
    state.candidates = []; state.failure = failed
    page.applyTripData(ride(), 'full'); await flush()
    page.goRequestTrip()
    assertRequestPrefill(state, 'full_ride')
  }
  const guest = harness()
  guest.state.account = ''; guest.page._detailAccount = 'user:'
  guest.page.applyTripData(ride(), 'full'); await flush()
  guest.page.goRequestTrip()
  assertRequestPrefill(guest.state, 'full_ride')
})
function assertRequestPrefill(state, entry) {
  const url = new URL(state.navigation[0], 'https://preview.invalid')
  assert.equal(url.pathname, '/pages/home/newTrip/newTrip')
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    mode: 'passenger', from: 'Fort Lee', to: '哥大', date: '2030-01-01', time: '08:00',
    cityKey: 'ny_nj', sourceTripKey: 'full', entry, intentId: 'preview_intent_123456'
  })
  assert.equal(state.intents.length, 1)
  assert.equal(state.intents[0].stage, 'started')
  assert.equal(state.intents[0].trip._id, 'full')
  assert.equal(state.intents[0].context.entry, entry)
}

test('available ride uses the same request flow and records its distinct entry', async () => {
  const { page, state } = harness()
  page.applyTripData(alternative('full'), 'full'); await flush()
  page.goRequestTrip()
  assertRequestPrefill(state, 'ride_detail')
})

test('request button rejects stale accounts, unavailable details, membership and inactive page states', async () => {
  for (const change of [
    ({ state }) => { state.account = 'bob' },
    ({ page }) => { page._rideTelemetryHidden = true },
    ({ page }) => { page._disposed = true },
    ({ page }) => { page.data.loading = true },
    ({ page }) => { page.data.submitting = true },
    ({ page }) => { page.data.loadError = 'offline' },
    ({ page }) => { page.data.hasJoined = true },
    ({ page }) => { page.data.isOwner = true },
    ({ page }) => { page.data.trip.availSeatNum = null },
    ({ page }) => { page.data.tripId = 'different' },
    ({ page }) => { page.data.trip = null },
    ({ page }) => { page.data.routeExpired = true },
    ({ page }) => { page.data.trip.departures[0].date = '2020-01-01' }
  ]) {
    const context = harness()
    context.page.applyTripData(ride(), 'full'); await flush()
    change(context)
    context.page.goRequestTrip()
    assert.equal(context.state.navigation.length, 0)
  }
})

test('available, unknown-seat, joined, owner, and expired details do not request alternatives', async () => {
  for (const extra of [
    { availSeatNum: 1 }, { availSeatNum: undefined }, { availSeatNum: null },
    { viewer: { role: 'passenger', isCreator: false } }, { viewer: { role: 'driver', isCreator: true } },
    { departures: [{ address: 'Fort Lee', date: '2020-01-01', time: '08:00' }] }
  ]) {
    const { page, state } = harness()
    page.applyTripData(ride('full', extra), 'full')
    await flush()
    assert.equal(state.calls.length, 0)
    assert.equal(page.data.alternativesState, 'idle')
  }
})

test('empty complete results and a failed read have different UI states', async () => {
  const empty = harness(); empty.state.candidates = []
  empty.page.applyTripData(ride(), 'full'); await flush()
  assert.equal(empty.page.data.alternativesState, 'ready')
  assert.equal(empty.page.data.alternatives.length, 0)
  const failed = harness(); failed.state.failure = true
  failed.page.applyTripData(ride(), 'full'); await flush()
  assert.equal(failed.page.data.alternativesState, 'error')
  assert.equal(failed.state.renders.length, 0)
})

test('a late recommendation cannot overwrite a newer detail with available seats or another route', async () => {
  for (const updated of [alternative('full'), alternative('another')]) {
    const { page, state } = harness(), pending = deferred()
    state.pending = pending.promise
    page.applyTripData(ride(), 'full')
    page.applyTripData(updated, updated._id)
    pending.resolve([alternative('stale')]); await flush()
    assert.equal(page.data.alternativesState, 'idle')
    assert.equal(page.data.alternatives.length, 0)
    assert.equal(state.renders.length, 0)
  }
})

test('account change, page hide, unload, and removed source discard pending recommendations', async () => {
  for (const cancel of [
    ({ state }) => { state.account = 'bob' },
    ({ page }) => { page._rideTelemetryHidden = true; page.onHide() },
    ({ page }) => page.onUnload(),
    ({ page }) => page.setLoadError('removed', { notFound: true })
  ]) {
    const context = harness(), pending = deferred()
    context.state.pending = pending.promise
    context.page.applyTripData(ride(), 'full'); cancel(context)
    pending.resolve([alternative('stale')]); await flush()
    assert.equal(context.page.data.alternatives.length, 0)
    assert.equal(context.state.renders.length, 0)
  }
})

test('returning within 30 seconds restarts a hidden pending recommendation without extra detail reads', async () => {
  const { page, state } = harness(), pending = deferred()
  state.pending = pending.promise
  page.applyTripData(ride(), 'full')
  page._rideTelemetryHidden = true; page.onHide()
  pending.resolve([alternative('stale')]); await flush()
  state.pending = null
  page._rideTelemetryHidden = false // app.js patchedPage restores visibility before onShow.
  await page.onShow(); await flush()
  assert.equal(state.calls.length, 2)
  assert.equal(state.detailReads.length, 0)
  assert.equal(page.data.alternatives[0]._id, 'other')
})

test('newer refresh wins when two full-route recommendation reads complete out of order', async () => {
  const { page, state } = harness(), first = deferred(), second = deferred()
  state.pending = first.promise; page.applyTripData(ride(), 'full')
  state.pending = second.promise; page.applyTripData(ride('full', { businessVersion: 2 }), 'full')
  second.resolve([alternative('new')]); await flush()
  first.resolve([alternative('old')]); await flush()
  assert.equal(page.data.alternatives[0]._id, 'new')
  assert.equal(state.renders.length, 1)
})

test('a late main detail read is discarded when the account changes before onShow', async () => {
  const { page, state } = harness(), pending = deferred()
  state.detailPending = pending.promise
  const read = page.loadTripDetail('full')
  state.account = 'bob'
  pending.resolve({ ok: true, data: ride() }); await read
  assert.equal(page.data.trip, null)
  assert.equal(state.calls.length, 0)
})

test('template keeps the request entry outside the recommendation results condition', () => {
  const wxml = fs.readFileSync(file.replace('.js', '.wxml'), 'utf8')
  assert.match(wxml, /class="ride-scroll detail-scroll list-scroll"/)
  assert.match(wxml, /class="detail-alternative list-trip-card"/)
  assert.match(wxml, /alternativesState === 'ready' && alternatives.length/)
  assert.match(wxml, /wx:if="{{!hasJoined && !isOwner && \(trip.status === 'full' \|\| trip.availSeatNum === 0\)}}"/)
  assert.match(wxml, /<\/block>\s*<view class="detail-request-row">\s*<text>没有找到需要的？<\/text>/)
  assert.match(wxml, /id="request-alternative-trip"[^>]+bindtap="goRequestTrip"[^>]*>点击求车<\/button>/)
  assert.doesNotMatch(wxml, /同时间还有空位|同一天、同方向、同一出发时间|detail-alternatives-hint/)
  assert.match(wxml, /!hasJoined && !isOwner && trip.status !== 'full' && trip.availSeatNum > 0/)
  assert.match(wxml, /不是我想要的路线？/)
  assert.match(wxml, /id="request-another-trip"[^>]+bindtap="goRequestTrip"/)
})
