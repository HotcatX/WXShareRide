const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function personalRides(id) {
  const departureAt = '2030-01-01T20:00:00.000Z'
  return { rides: id ? [{ id, kind: 'offer', cityKey: 'ny_nj', status: 'open', version: 1,
    seatCapacity: 3, availableSeats: 2, hasDriver: true, listedPriceCents: 800, listedPriceLabel: '$8',
    departureAt, role: 'driver', isCreator: true, seatCount: 0,
    stops: [{ position: 0, kind: 'departure', address: 'Fort Lee', departureAt },
      { position: 1, kind: 'destination', address: 'Columbia', departureAt: null }] }] : [], nextPage: null }
}

function harness(kind, existingStorage) {
  const storage = existingStorage || { openid: 'user-a', isGuest: false }
  const state = { now: 1800000000000, calls: [], pending: {}, count: 3, toasts: [], notices: [], navigations: [],
    pendingFollowup: false, followupListeners: new Set() }
  class Clock extends Date { static now() { return state.now } }
  const wx = {
    getWindowInfo: () => ({ windowWidth: 390, statusBarHeight: 44 }),
    getStorageSync: key => storage[key],
    setStorageSync: (key, value) => { storage[key] = value },
    removeStorageSync: key => { delete storage[key] },
    navigateTo: value => state.navigations.push(value.url), showToast: value => state.toasts.push(value),
    cloud: {
      callFunction({ name }) {
        state.calls.push(name)
        if (state.pending[name]) return state.pending[name]
        const result = name === 'getUserInfo'
          ? { data: [{ _openid: storage.openid, name: storage.openid, rideStats: {} }] }
          : { ok: true, data: {} }
        return Promise.resolve({ result })
      },
      database: () => ({ collection: () => ({ where: () => ({ count: () => {
        state.calls.push('unread')
        return state.pending.unread || Promise.resolve({ total: state.count })
      } }) }) })
    }
  }
  const rides = require('../utils/compat/rides').createRideClient({ wx, backend: {
    isBackendEnabled: () => true,
    get(route) {
      assert.equal(route, '/api/v1/me/rides?scope=current&page=1&limit=50')
      state.calls.push('/api/v1/me/rides')
      return state.pending.rides || Promise.resolve(personalRides())
    }
  } })
  let definition
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../pages/${kind}/${kind}.js`), 'utf8'), {
    Page: value => { definition = value }, wx, Date: Clock, console: { error() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    require(name) {
      if (name.endsWith('/tripFollowup')) return { hide() {}, canConsider: () => false,
        refreshPendingFollowup() { state.followupListeners.forEach(listener => listener(!!storage.openid && !storage.isGuest && state.pendingFollowup)) },
        subscribePendingFollowup(listener) { state.followupListeners.add(listener)
          listener(!!storage.openid && !storage.isGuest && state.pendingFollowup)
          return () => state.followupListeners.delete(listener) } }
      if (name.endsWith('/analyticsSession')) return { subscribe: () => () => {} }
      if (name.endsWith('/compat/rides')) return { isBackendEnabled: () => true, ...rides }
      if (name.endsWith('/compat/profile')) return require('./helpers/profile-api.cjs')(wx)
      if (name.endsWith('/profileDisplay')) return { resolveProfileAvatar: async (user, fallback) => user.avatarUrl || fallback }
      if (name.includes('rideTime')) return require('../utils/rideTime')
      if (name.includes('cityTree')) return {
        getCitySnapshot: () => ({ key: 'ny_nj' }), getCountryTabs: () => [], getCountryGroups: () => []
      }
      if (name.includes('community')) return {
        loadCommunityConfig: options => { state.notices.push(options); return Promise.resolve(null) },
        getAvailableAnnouncement: () => null, shouldShowAnnouncement: () => false
      }
      return { formatRidePriceTag: value => value, formatRideStats: () => ({ completeText: '0 次', ratingCount: 0 }) }
    }
  })
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) }
  page.setData = function(patch, callback) { Object.assign(this.data, patch); if (callback) callback.call(this) }
  if (kind === 'home') {
    page.data.isRideServiceAvailable = true
    page.syncLoginState()
  }
  return { page, state, storage }
}

test('home reuses ordinary personal reads for 30 seconds, preserves forced refresh and stops speculative details', async () => {
  const { page, state } = harness('home')
  const read = () => Promise.all([page.refreshHomeData(), page.loadUnreadCount()])
  await Promise.all([read(), read()])
  assert.deepEqual(state.calls, ['/api/v1/me/rides', 'unread'])
  state.now += 29999
  await read()
  assert.equal(state.calls.length, 2)
  state.now += 1
  await read()
  assert.equal(state.calls.length, 4)
  await page.refreshHomeByUser()
  assert.equal(state.calls.length, 6)
  assert.equal(state.notices.at(-1).force, true)
  assert.equal(state.calls.includes('getTripDetail'), false)
})

test('home retries failed reads immediately and ignores pre-mutation list responses', async () => {
  const { page, state, storage } = harness('home')
  const old = deferred()
  state.pending.rides = old.promise
  const request = page.refreshHomeData()
  await tick()
  storage.rideListShouldRefreshAt = 1
  old.resolve(personalRides('stale-trip'))
  await request
  assert.equal(page.data.createTrips.length, 0)
  state.pending.rides = Promise.resolve({ rides: null, nextPage: null })
  await page.refreshHomeData()
  delete state.pending.rides
  await page.refreshHomeData()
  assert.equal(state.calls.filter(name => name === '/api/v1/me/rides').length, 3)
  state.pending.rides = Promise.resolve(personalRides('current-trip'))
  await page.refreshHomeData(true)
  assert.equal(page.data.createTrips[0]._id, 'current-trip')
})

test('home identity changes discard old private results and guests do not fetch personal lists', async () => {
  const { page, state, storage } = harness('home')
  const old = deferred()
  state.pending.rides = old.promise
  const request = page.refreshHomeData()
  await tick()
  storage.openid = 'user-b'
  page.syncLoginState()
  delete state.pending.rides
  await page.refreshHomeData()
  old.resolve(personalRides('a-private-trip'))
  await request
  assert.equal(page.data.createTrips.length, 0)
  storage.isGuest = true
  page.syncLoginState()
  await page.refreshHomeData()
  assert.equal(state.calls.length, 2)
})

test('home A-to-B-to-A returns cannot reuse an obsolete request or refresh its cache timestamp', async () => {
  const { page, state, storage } = harness('home')
  const oldList = deferred()
  const oldCount = deferred()
  state.pending.rides = oldList.promise
  state.pending.unread = oldCount.promise
  const request = Promise.all([page.refreshHomeData(), page.loadUnreadCount()])
  await tick()
  const obsolete = page._homeReads.trips
  delete state.pending.rides
  delete state.pending.unread
  for (const openid of ['user-b', 'user-a']) {
    storage.openid = openid
    page.syncLoginState()
    await Promise.all([page.refreshHomeData(), page.loadUnreadCount()])
  }
  const currentTimestamp = page._homeReads.trips.at
  state.now += 1000
  oldList.resolve(personalRides('obsolete-trip'))
  oldCount.resolve({ total: 99 })
  await request
  assert.equal(page.data.createTrips.length, 0)
  assert.equal(page.data.customTabProfileBadge, 3)
  assert.equal(storage.customTabProfileBadge, 3)
  assert.equal(obsolete.at, 0)
  assert.equal(page._homeReads.trips.at, currentTimestamp)
})

test('home request entry opens passenger mode for members and guests without changing the default driver entry', () => {
  for (const storage of [{ openid: 'member', isGuest: false }, { openid: '', isGuest: true }]) {
    const { page, state } = harness('home', storage)
    page.goRequestTrip()
    page.goNewTrip()
    assert.deepEqual(state.navigations, [
      '/pages/home/newTrip/newTrip?mode=passenger',
      '/pages/home/newTrip/newTrip'
    ])
    assert.equal(state.calls.length, 0)
  }
})

test('both home create entries block navigation in an unsupported ride city', () => {
  const { page, state } = harness('home')
  page.data.isRideServiceAvailable = false
  page.goRequestTrip()
  page.goNewTrip()
  assert.equal(state.navigations.length, 0)
  assert.deepEqual(state.toasts.map(toast => toast.title), ['该地区暂未开通', '该地区暂未开通'])
})

test('profile ordinary returns deduplicate and cache reads, but editing and ride mutations invalidate', async () => {
  const { page, state, storage } = harness('profile')
  await Promise.all([page.refreshAuthAndData(), page.refreshAuthAndData()])
  assert.deepEqual(state.calls, ['getUserInfo', 'unread'])
  await page.refreshAuthAndData()
  assert.equal(state.calls.length, 2)
  page.goEditProfile()
  await page.refreshAuthAndData()
  assert.equal(state.calls.length, 4)
  storage.rideListShouldRefreshAt = 5
  await page.refreshAuthAndData()
  assert.equal(state.calls.length, 6)
  await page.refreshAuthAndData({ force: true })
  assert.equal(state.calls.length, 8)
  state.now += 30000
  await page.refreshAuthAndData()
  assert.equal(state.calls.length, 10)
})

test('first profile refresh preserves a cached pending badge after identity setup and guests clear it', async () => {
  const { page, state, storage } = harness('profile')
  state.pendingFollowup = true
  page.onLoad()
  assert.equal(page.data.hasPendingFollowup, true)
  await page.refreshAuthAndData()
  assert.equal(page.data.hasPendingFollowup, true)
  assert.equal(page.data.isLoggedIn, true)
  storage.isGuest = true
  await page.refreshAuthAndData()
  assert.equal(page.data.hasPendingFollowup, false)
  assert.equal(page.data.isLoggedIn, false)
  page.onUnload()
  assert.equal(state.followupListeners.size, 0)
})

test('notification callbacks still force unread refresh and failures do not fill the short cache', async () => {
  const { page, state } = harness('profile')
  await page.refreshAuthAndData()
  state.count = 0
  await page.loadUnreadCount()
  assert.equal(page.data.unreadCount, 0)
  state.pending.getUserInfo = Promise.reject(new Error('temporary failure'))
  await page.loadUserInfo()
  delete state.pending.getUserInfo
  await page.refreshAuthAndData()
  assert.equal(state.calls.filter(name => name === 'getUserInfo').length, 3)
  assert.equal(page.data.isLoggedIn, true)
})

test('profile late response cannot overwrite another account or a logged-out screen', async () => {
  for (const guest of [false, true]) {
    const { page, state, storage } = harness('profile')
    const old = deferred()
    state.pending.getUserInfo = old.promise
    const request = page.refreshAuthAndData()
    await tick()
    storage.openid = guest ? '' : 'user-b'
    storage.isGuest = guest
    delete state.pending.getUserInfo
    await page.refreshAuthAndData()
    old.resolve({ result: { data: [{ name: 'private user-a info', rideStats: {} }] } })
    await request
    assert.equal(page.data.name, guest ? '' : 'user-b')
    assert.equal(page.data.isLoggedIn, !guest)
  }
})

test('profile A-to-B-to-A returns reject obsolete profile and unread writes', async () => {
  const { page, state, storage } = harness('profile')
  const oldUser = deferred()
  const oldCount = deferred()
  state.pending.getUserInfo = oldUser.promise
  state.pending.unread = oldCount.promise
  const request = page.refreshAuthAndData()
  await tick()
  const obsolete = page._profileReads.user
  delete state.pending.getUserInfo
  delete state.pending.unread
  for (const openid of ['user-b', 'user-a']) {
    storage.openid = openid
    await page.refreshAuthAndData()
  }
  const currentTimestamp = page._profileReads.user.at
  state.now += 1000
  oldUser.resolve({ result: { data: [{ name: 'obsolete private profile', rideStats: {} }] } })
  oldCount.resolve({ total: 99 })
  await request
  assert.equal(page.data.name, 'user-a')
  assert.equal(storage.userInfo.name, 'user-a')
  assert.equal(page.data.unreadCount, 3)
  assert.equal(storage.customTabProfileBadge, 3)
  assert.equal(obsolete.at, 0)
  assert.equal(page._profileReads.user.at, currentTimestamp)
})

test('community short cache is opt-in, expires with server clock, and force reads replace it', async () => {
  const state = { now: 1800000000000, calls: 0, available: true, failure: false }
  class Clock extends Date { static now() { return state.now } }
  const context = { module: { exports: {} }, Date: Clock, setTimeout, clearTimeout,
    require: name => name === './backendClient' ? {
      get(route, options) {
        assert.equal(route, '/api/v1/community')
        assert.equal(options.anonymous, true)
        state.calls++
        if (state.failure) return Promise.reject(new Error('temporary failure'))
        return Promise.resolve({ serverTime: new Date(state.now).toISOString(),
          group: { expiresAt: null }, announcement: { available: state.available, id: 'notice-1',
            body: 'hello', startAt: null, endAt: null } })
      }, resolveImages: async () => []
    } : ({ isTimelinePreview: () => false }),
    wx: { getStorageSync: () => '' }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/community.js'), 'utf8'), context)
  const api = context.module.exports
  await api.loadCommunityConfig({ maxAgeMs: 30000 })
  state.available = false
  state.now += 29999
  assert.ok(api.getAvailableAnnouncement(await api.loadCommunityConfig({ maxAgeMs: 30000 })))
  assert.equal(state.calls, 1)
  state.now++
  assert.equal(api.getAvailableAnnouncement(await api.loadCommunityConfig({ maxAgeMs: 30000 })), null)
  assert.equal(state.calls, 2)
  state.available = true
  assert.ok(api.getAvailableAnnouncement(await api.loadCommunityConfig({ force: true, maxAgeMs: 30000 })))
  assert.equal(state.calls, 3)
  state.failure = true
  await assert.rejects(api.loadCommunityConfig({ force: true }))
  state.failure = false
  await api.loadCommunityConfig({ maxAgeMs: 30000 })
  assert.equal(state.calls, 5)
})
