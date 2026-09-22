const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const expiry = require('../utils/routeExpiry')
const tripManage = require('../utils/tripManage')
const NOW = Date.parse('2026-09-14T20:00:00Z')
const LIST_URL = '/pages/home/carpoolList/carpoolList'

function route(overrides = {}) {
  return {
    _id: 'shared-route', _openid: 'creator', status: 'open',
    latestDepartureAtMs: NOW + 60000, departureAtMs: NOW + 60000,
    departures: [{ address: 'Fort Lee', date: '2026-09-14', time: '16:01' }],
    destinations: [{ address: '哥大' }],
    passengers: [], passengerID: ['creator'], passengerCount: 1, availSeatNum: 3,
    ...overrides
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(kind, { stackDepth = 2, cached = null, fetchResult, fetchResults } = {}) {
  const file = kind === 'carpool' ? 'tripDetail' : 'requestDetail'
  let definition
  const clock = { now: NOW }
  class ClockDate extends Date { static now() { return clock.now } }
  const calls = { cloud: [], redirects: [], navigations: [], cacheReads: [], fetches: [], storageWrites: [] }
  const store = { openid: 'viewer', userInfo: { wechatID: 'fixture-contact' } }
  const cache = {
    readTripDetailCache(...args) { calls.cacheReads.push(args); return cached },
    fetchTripDetail(...args) {
      calls.fetches.push(args)
      if (fetchResults) return Promise.resolve(fetchResults[calls.fetches.length - 1])
      return Promise.resolve(fetchResult === undefined ? { ok: true, data: route() } : fetchResult)
    },
    removeTripDetailCache() {}
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, `pages/home/${file}/${file}.js`), 'utf8'), {
    Page(value) { definition = value },
    Date: ClockDate,
    console: { error() {}, warn() {}, log() {} },
    setTimeout, clearTimeout,
    getCurrentPages: () => Array.from({ length: stackDepth }, () => ({})),
    getApp: () => ({ withReferralShare: share => share }),
    wx: {
      getStorageSync: key => store[key],
      setStorageSync(key, value) { calls.storageWrites.push({ key, value }); store[key] = value },
      removeStorageSync(key) { delete store[key] },
      getWindowInfo: () => ({ statusBarHeight: 24 }),
      showShareMenu() {}, hideShareMenu() {}, stopPullDownRefresh() {}, showToast() {},
      redirectTo(options) { calls.redirects.push(options) },
      navigateTo(options) { calls.navigations.push(options) },
      reLaunch(options) { calls.navigations.push(options) },
      cloud: { callFunction(options) { calls.cloud.push(options); return Promise.resolve({ result: {} }) } }
    },
    require(name) {
      if (name.endsWith('/routeExpiry')) return {
        ...expiry,
        isRouteExpired: (trip, now = clock.now) => expiry.isRouteExpired(trip, now)
      }
      if (name.endsWith('/tripDetailCache')) return cache
      if (name.endsWith('/tripManage')) return tripManage
      throw new Error(`Unexpected dependency: ${name}`)
    }
  })
  const page = { ...definition, data: structuredClone(definition.data) }
  page.setData = function (patch) { Object.assign(this.data, patch) }
  page.loadUserSpots = async () => {}
  const apply = trip => kind === 'carpool'
    ? page.applyTripData(trip, trip._id, { fromPreview: true })
    : page.applyRequestData(trip)
  const applyResult = result => kind === 'carpool'
    ? page.applyTripDetailResult(result, 'shared-route')
    : page.applyRequestDetailResult(result, 'shared-route')
  return { page, calls, clock, store, apply, applyResult }
}

test('a route expires at its departure deadline, including full routes, but not before it', () => {
  assert.equal(expiry.isRouteExpired(route(), NOW), false)
  assert.equal(expiry.isRouteExpired(route({ status: 'full', availSeatNum: 0 }), NOW), false)
  assert.equal(expiry.isRouteExpired(route(), NOW + 60000), true)
  assert.equal(expiry.isRouteExpired(route(), NOW + 60001), true)
})

test('closed states and explicit lifecycle flags override future departure metadata', () => {
  for (const status of ['past', 'close', 'closed', 'finished', 'completed', 'expired', 'ended', 'cancelled', 'canceled', 'deleted']) {
    assert.equal(expiry.isRouteExpired(route({ status }), NOW), true, status)
  }
  for (const flag of ['isDeleted', 'deleted', 'isCancelled', 'isCanceled', 'cancelled', 'canceled', 'isEnded', 'ended', 'completed']) {
    assert.equal(expiry.isRouteExpired(route({ [flag]: true }), NOW), true, flag)
    assert.equal(expiry.isRouteExpired(route({ [flag]: false }), NOW), false, flag)
  }
  for (const flag of ['deletedAt', 'cancelledAt', 'canceledAt', 'endedAt', 'completedAt']) {
    assert.equal(expiry.isRouteExpired(route({ [flag]: NOW - 1000 }), NOW), true, flag)
    for (const empty of [null, false, 0, '']) {
      assert.equal(expiry.isRouteExpired(route({ [flag]: empty }), NOW), false, flag)
    }
  }
})

test('deadline uses saved latest departure, saved first departure, then latest valid New York departure', () => {
  assert.equal(expiry.getRouteExpiryAt(route({ latestDepartureAtMs: NOW + 30000 })), NOW + 30000)
  assert.equal(expiry.getRouteExpiryAt(route({ latestDepartureAtMs: undefined })), NOW + 60000)
  const legacy = route({
    latestDepartureAtMs: undefined, departureAtMs: undefined,
    departures: [
      { date: '2026-09-14', time: '15:00' },
      { date: '2026-09-14', time: '18:00' },
      { date: '2026-02-30', time: '23:00' }
    ]
  })
  assert.equal(expiry.getRouteExpiryAt(legacy), Date.parse('2026-09-14T22:00:00Z'))
  assert.equal(expiry.isRouteExpired(legacy, NOW), false)
  assert.equal(expiry.getRouteExpiryAt({ firstDepartureDate: '2026-01-14', firstDepartureTime: '18:00' }), Date.parse('2026-01-14T23:00:00Z'))
})

test('missing or invalid time does not fabricate an expired route', () => {
  for (const trip of [null, {}, { status: 'open' }, { latestDepartureAtMs: 'invalid' },
    { departures: [{ date: '2026-02-30', time: '16:00' }] },
    { departures: [{ date: '2026-03-08', time: '02:30' }] },
    { departures: [{ date: '2026-09-14', time: '27:00' }] }]) {
    assert.equal(expiry.isRouteExpired(trip, NOW), false, JSON.stringify(trip))
  }
})

test('legacy New York dates yield identical expiry under New York, Shanghai and UTC device time zones', () => {
  const code = `const { getRouteExpiryAt, isRouteExpired } = require('./utils/routeExpiry');
    const trips = [
      { departures: [{ date: '2026-09-14', time: '18:00' }] },
      { departures: [{ date: '2026-01-14', time: '18:00' }] },
      { departures: [{ date: '2026-11-01', time: '01:30' }] }
    ];
    process.stdout.write(JSON.stringify(trips.map(trip => ({ at: getRouteExpiryAt(trip), expired: isRouteExpired(trip, ${NOW}) }))));`
  const results = ['America/New_York', 'Asia/Shanghai', 'UTC'].map(TZ => {
    const child = spawnSync(process.execPath, ['-e', code], { cwd: root, env: { ...process.env, TZ }, encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    return JSON.parse(child.stdout)
  })
  assert.deepEqual(results[0], results[1])
  assert.deepEqual(results[0], results[2])
  assert.equal(results[0][0].at, Date.parse('2026-09-14T22:00:00Z'))
  assert.equal(results[0][0].expired, false)
  assert.equal(results[0][1].at, Date.parse('2026-01-14T23:00:00Z'))
  assert.equal(results[0][2].at, Date.parse('2026-11-01T05:30:00Z'))
})

for (const kind of ['carpool', 'request']) {
  test(`${kind}: an expired preview cannot display route or membership information`, () => {
    const f = fixture(kind)
    f.page.data.tripId = 'shared-route'
    f.apply(route())
    if (kind === 'carpool') f.page.data.driverInfo = { _openid: 'creator', phone: 'private-contact' }
    f.apply(route({ status: 'past' }))
    assert.equal(f.page.data.routeExpired, true)
    assert.equal(f.page.data.trip, null)
    assert.equal(f.page.data.loading, false)
    assert.equal(f.page.data.departAddress, '')
    assert.equal(f.page.data.destAddress, '')
    assert.equal(f.page.data.driverOpenid, '')
    if (kind === 'carpool') assert.equal(f.page.data.driverInfo, null)
  })

  test(`${kind}: an expired server response clears an earlier preview and is considered handled`, () => {
    const f = fixture(kind)
    f.page.data.tripId = 'shared-route'
    f.apply(route())
    if (kind === 'carpool') {
      f.page.applyDriverInfo = () => assert.fail('expired detail must not expose driver contacts')
      f.page.loadDriverInfo = () => assert.fail('expired detail must not fetch driver contacts')
      f.page.applyDriverStats = () => assert.fail('expired detail must not expose driver statistics')
    }
    assert.equal(f.applyResult({ ok: true, data: route({ status: 'past' }),
      driverInfo: { _openid: 'creator', phone: 'private-contact' }, driverStats: { completedDriverTrips: 9 }
    }), true)
    assert.equal(f.page.data.routeExpired, true)
    assert.equal(f.page.data.trip, null)
    assert.equal(f.calls.cloud.length, 0)
  })

  test(`${kind}: old cache is checked against the current deadline before it is displayed`, async () => {
    const refresh = deferred()
    const f = fixture(kind, { cached: { ok: true, data: route({ latestDepartureAtMs: NOW - 1 }) }, fetchResult: refresh.promise })
    f.page.data.tripId = 'shared-route'
    await f.page.loadTripDetail('shared-route')
    assert.equal(f.page.data.routeExpired, true)
    assert.equal(f.page.data.trip, null)
    refresh.resolve({ ok: true, data: route({ status: 'past' }) })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.page.data.routeExpired, true)
  })

  for (const useCache of [false, true]) {
    test(`${kind}: older ${useCache ? 'cache background refresh' : 'detail fetch'} cannot restore a route after a newer refresh reports expiry`, async () => {
      const older = deferred()
      const newer = deferred()
      const f = fixture(kind, {
        cached: useCache ? { ok: true, data: route() } : null,
        fetchResults: [older.promise, newer.promise]
      })
      f.page.data.tripId = 'shared-route'
      const firstLoad = f.page.loadTripDetail('shared-route')
      const secondLoad = f.page.loadTripDetail('shared-route', { force: true })
      assert.equal(f.calls.fetches.length, 2)
      newer.resolve({ ok: true, data: route({ status: kind === 'carpool' ? 'past' : 'closed' }) })
      await secondLoad
      assert.equal(f.page.data.routeExpired, true)
      assert.equal(f.page.data.trip, null)

      older.resolve({ ok: true, data: route({ passengers: [{ _openid: 'viewer' }], driverOpenid: 'assigned-driver' }),
        driverInfo: { _openid: 'creator', phone: 'stale-private-contact' }, driverStats: { completedDriverTrips: 10 }
      })
      await firstLoad
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(f.page.data.routeExpired, true, 'a stale open response must not reverse the terminal screen')
      assert.equal(f.page.data.trip, null)
      assert.equal(f.page.data.driverOpenid, '')
      assert.equal(f.page.data.departAddress, '')
      assert.equal(f.page.data.destAddress, '')
      if (kind === 'carpool') assert.equal(f.page.data.driverInfo, null)
    })
  }

  test(`${kind}: a detail response received after the page unloads does not update its data`, async () => {
    const pending = deferred()
    const f = fixture(kind, { fetchResult: pending.promise })
    f.page.data.tripId = 'shared-route'
    const load = f.page.loadTripDetail('shared-route')
    f.page.onUnload()
    const snapshot = structuredClone(f.page.data)
    pending.resolve({ ok: true, data: route({ passengers: [{ _openid: 'viewer' }] }),
      driverInfo: { _openid: 'creator', phone: 'late-private-contact' }
    })
    await load
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(f.page.data, snapshot)
  })

  for (const [label, stackDepth, options] of [
    ['direct launch', 1, { id: 'shared-route' }],
    ['marked share while app is already open', 2, { id: 'shared-route', fromShare: '1' }]
  ]) {
    test(`${kind}: ${label} skips stale previews and fetches current route state`, async () => {
      const response = deferred()
      const f = fixture(kind, { stackDepth, cached: { ok: true, data: route() }, fetchResult: response.promise })
      f.store.carpoolDetailPreviewV1 = { id: 'shared-route', type: kind, item: route(), savedAt: NOW }
      const load = f.page.onLoad(options)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(f.page.data.trip, null, 'cached route must not flash before shared route is verified')
      assert.equal(f.calls.cacheReads.length, 0)
      assert.equal(f.calls.fetches.length, 1)
      assert.equal(f.calls.fetches[0][2].force, true)
      response.resolve({ ok: true, data: route({ status: 'past' }) })
      await load
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(f.page.data.routeExpired, true)
      assert.equal(f.page.data.trip, null)
    })
  }

  test(`${kind}: returning to a page detects expiry even inside the usual refresh interval`, async () => {
    const f = fixture(kind)
    f.page.data.tripId = 'shared-route'
    f.apply(route({ latestDepartureAtMs: NOW + 100 }))
    f.clock.now += 101
    await f.page.onShow()
    assert.equal(f.page.data.routeExpired, true)
    assert.equal(f.page.data.trip, null)
  })

  test(`${kind}: find available carpools replaces the obsolete detail with the regular list`, () => {
    const f = fixture(kind)
    f.page.setRouteExpired()
    f.page.goToAvailableCarpools()
    assert.equal(f.calls.redirects.length, 1)
    assert.equal(f.calls.redirects[0].url, LIST_URL)
    assert.equal(f.calls.navigations.length, 0)
  })

  test(`${kind}: friend shares carry a freshness marker`, () => {
    const f = fixture(kind)
    f.page.data.tripId = 'shared-route'
    f.apply(route())
    const shared = f.page.onShareAppMessage()
    assert.match(shared.path, /[?&]fromShare=1(?:&|$)/)
    assert.match(shared.path, /[?&]id=shared-route(?:&|$)/)
  })

  const actions = kind === 'carpool' ? ['joinCarpool'] : ['joinAsPassenger', 'acceptRequest']
  for (const action of actions) {
    test(`${kind}: ${action} stops before login, profile or mutation work when expired or missing`, async () => {
      for (const trip of [route({ latestDepartureAtMs: NOW }), null]) {
        const f = fixture(kind)
        Object.assign(f.page.data, { tripId: 'shared-route', trip, pickupAddress: 'Pickup', dropoffAddress: 'Dropoff' })
        f.page.ensureLoginBeforeJoin = () => assert.fail('unavailable route must not prompt for login')
        f.page.ensureLoginBeforeAction = () => assert.fail('unavailable route must not prompt for login')
        f.page.ensureWechatBeforeAction = () => assert.fail('unavailable route must not request profile')
        await f.page[action]()
        assert.equal(f.calls.cloud.length, 0)
        assert.equal(f.calls.storageWrites.length, 0)
        if (trip) assert.equal(f.page.data.routeExpired, true)
      }
    })
  }
}
