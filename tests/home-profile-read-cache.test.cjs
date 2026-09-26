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

function harness(kind, existingStorage) {
  const storage = existingStorage || { openid: 'user-a', isGuest: false }
  const state = { now: 1800000000000, calls: [], pending: {}, count: 3, toasts: [], notices: [], navigations: [], http: [], env: 'release', rollout: { enabled: true, rolloutPercent: { develop: 0, trial: 0, release: 0 } } }
  class Clock extends Date { static now() { return state.now } }
  const wx = {
    getStorageSync: key => storage[key],
    setStorageSync: (key, value) => { storage[key] = value },
    removeStorageSync: key => { delete storage[key] },
    getAccountInfoSync: () => ({ miniProgram: { envVersion: state.env } }),
    request(options) {
      state.http.push(options)
      if (!state.deferHttp) options.success({ statusCode: 200, data: state.snapshot })
      return { abort() {} }
    },
    navigateTo: value => state.navigations.push(value.url), showToast: value => state.toasts.push(value),
    cloud: {
      callFunction({ name }) {
        state.calls.push(name)
        if (state.pending[name]) return state.pending[name]
        const result = name === 'getUserInfo'
          ? { data: [{ _openid: storage.openid, name: storage.openid, rideStats: {} }] }
          : name === 'statistics' ? { success: true, data: { servedTrips: 42 } }
            : { ok: true, data: {} }
        return Promise.resolve({ result })
      },
      database: () => ({ collection: () => ({ where: () => ({ count: () => {
        state.calls.push('unread')
        return state.pending.unread || Promise.resolve({ total: state.count })
      } }) }) })
    }
  }
  const pilotModule = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/publicStatsClient.js'), 'utf8'), {
    module: pilotModule, wx, Date: Clock, setTimeout, clearTimeout,
    require: name => name === '../config/publicStats' ? state.rollout : require(path.join(__dirname, '../utils', name))
  })
  let definition
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../pages/${kind}/${kind}.js`), 'utf8'), {
    Page: value => { definition = value }, wx, Date: Clock, console: { error() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    require(name) {
      if (name.includes('publicStatsClient')) return pilotModule.exports
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
    page.refreshHomeStatusInBackground = () => Promise.resolve()
  }
  return { page, state, storage }
}

test('home reuses ordinary personal reads for 30 seconds, preserves forced refresh and stops speculative details', async () => {
  const { page, state } = harness('home')
  const read = () => Promise.all([page.refreshHomeData(), page.loadPublicStats(), page.loadUnreadCount()])
  await Promise.all([read(), read()])
  assert.deepEqual(state.calls, ['getHomeTripList', 'statistics', 'unread'])
  state.now += 29999
  await read()
  assert.equal(state.calls.length, 3)
  state.now += 1
  await read()
  assert.equal(state.calls.length, 5)
  await page.refreshHomeByUser()
  assert.equal(state.calls.length, 8)
  assert.equal(state.notices.at(-1).force, true)
  assert.equal(state.calls.includes('getTripDetail'), false)
})

test('home retries failed reads immediately and ignores pre-mutation list responses', async () => {
  const { page, state, storage } = harness('home')
  const old = deferred()
  state.pending.getHomeTripList = old.promise
  const request = page.refreshHomeData()
  await tick()
  storage.rideListShouldRefreshAt = 1
  old.resolve({ result: { ok: true, data: { driver: { createList: [{ _id: 'stale-trip' }] } } } })
  await request
  assert.equal(page.data.createTrips.length, 0)
  state.pending.getHomeTripList = Promise.resolve({ result: { ok: false } })
  await page.refreshHomeData()
  delete state.pending.getHomeTripList
  await page.refreshHomeData()
  assert.equal(state.calls.filter(name => name === 'getHomeTripList').length, 3)
})

test('home identity changes discard old private results and guests do not fetch personal lists', async () => {
  const { page, state, storage } = harness('home')
  const old = deferred()
  state.pending.getHomeTripList = old.promise
  const request = page.refreshHomeData()
  await tick()
  storage.openid = 'user-b'
  page.syncLoginState()
  delete state.pending.getHomeTripList
  await page.refreshHomeData()
  old.resolve({ result: { ok: true, data: { driver: { createList: [{ _id: 'a-private-trip' }] } } } })
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
  state.pending.getHomeTripList = oldList.promise
  state.pending.unread = oldCount.promise
  const request = Promise.all([page.refreshHomeData(), page.loadUnreadCount()])
  await tick()
  const obsolete = page._homeReads.trips
  delete state.pending.getHomeTripList
  delete state.pending.unread
  for (const openid of ['user-b', 'user-a']) {
    storage.openid = openid
    page.syncLoginState()
    await Promise.all([page.refreshHomeData(), page.loadUnreadCount()])
  }
  const currentTimestamp = page._homeReads.trips.at
  state.now += 1000
  oldList.resolve({ result: { ok: true, data: { driver: { createList: [{ _id: 'obsolete-trip' }] } } } })
  oldCount.resolve({ total: 99 })
  await request
  assert.equal(page.data.createTrips.length, 0)
  assert.equal(page.data.customTabProfileBadge, 3)
  assert.equal(storage.customTabProfileBadge, 3)
  assert.equal(obsolete.at, 0)
  assert.equal(page._homeReads.trips.at, currentTimestamp)
})

test('public statistics persist for 24 hours and keep their original sync time across login and ride changes', async () => {
  const { page, state, storage } = harness('home')
  await page.loadPublicStats()
  const syncedAt = storage.homePublicStatsCacheV1.syncedAt
  state.now += 60000
  storage.openid = 'user-b'
  storage.rideListShouldRefreshAt = 123
  page.syncLoginState()
  await page.loadPublicStats()
  assert.equal(state.calls.filter(name => name === 'statistics').length, 1)
  assert.equal(storage.homePublicStatsCacheV1.syncedAt, syncedAt)
  assert.equal(page.data.publicStats.servedTripsText, '42')

  const reopened = harness('home', storage)
  reopened.state.now = syncedAt + 24 * 3600000 - 1
  await reopened.page.loadPublicStats()
  assert.equal(reopened.state.calls.length, 0)
  assert.equal(storage.homePublicStatsCacheV1.syncedAt, syncedAt)
  reopened.state.now++
  await reopened.page.loadPublicStats()
  assert.deepEqual(reopened.state.calls, ['statistics'])
  await reopened.page.loadPublicStats({ force: true })
  assert.equal(reopened.state.calls.length, 2)
})

function trialSnapshot(now, servedTrips) {
  const data = { _id: 'home', servedTrips, coverageText: 'NY / NJ' }
  return { ok: true, schemaVersion: 1, source: 'cloudbase-snapshot', snapshotAt: now - 1000, expiresAt: now + 60000,
    revision: require('node:crypto').createHash('sha256').update(JSON.stringify(data)).digest('hex'), data }
}

test('home rollout retains the shared 24-hour stats cache and force refresh persists server data', async () => {
  const { page, state, storage } = harness('home')
  await page.loadPublicStats()
  const original = storage.homePublicStatsCacheV1
  state.rollout.rolloutPercent.develop = 100; state.env = 'develop'
  state.snapshot = trialSnapshot(state.now, 84)
  await page.loadPublicStats()
  assert.equal(state.http.length, 0)
  assert.equal(storage.homePublicStatsCacheV1, original)
  await page.loadPublicStats({ force: true })
  assert.equal(state.http.length, 1)
  assert.equal(page.data.publicStats.servedTripsText, '84')
  assert.equal(page._publicStatsReadDiagnostic.source, 'lighthouse')
  assert.equal(storage.homePublicStatsCacheV1.data.servedTrips, 84)
  const serverCachedAt = storage.homePublicStatsCacheV1.syncedAt
  state.rollout.enabled = false
  state.now += 1000
  await page.loadPublicStats()
  assert.equal(page.data.publicStats.servedTripsText, '84')
  assert.equal(page._publicStatsReadDiagnostic.source, 'local-cache')
  assert.equal(state.calls.filter(name => name === 'statistics').length, 1)
  assert.equal(storage.homePublicStatsCacheV1.syncedAt, serverCachedAt)
  state.rollout.enabled = true
  state.now = serverCachedAt + 24 * 3600000
  state.snapshot = trialSnapshot(state.now, 85)
  await page.loadPublicStats()
  assert.equal(state.http.length, 2)
  assert.equal(storage.homePublicStatsCacheV1.data.servedTrips, 85)
})

test('home ignores a late rollout response after rollback even when CloudBase mode returns from cache', async () => {
  const { page, state, storage } = harness('home')
  await page.loadPublicStats()
  const original = storage.homePublicStatsCacheV1
  state.rollout.rolloutPercent.develop = 100; state.env = 'develop'; state.deferHttp = true
  const pending = page.loadPublicStats({ force: true })
  await tick()
  state.rollout.enabled = false
  await page.loadPublicStats()
  state.http[0].success({ statusCode: 200, data: trialSnapshot(state.now, 999) })
  await pending
  assert.equal(page.data.publicStats.servedTripsText, '42')
  assert.equal(page._publicStatsReadDiagnostic.source, 'local-cache')
  assert.equal(storage.homePublicStatsCacheV1, original)
})

test('home rollout fallback refreshes the shared cache and avoids another ordinary network read', async () => {
  const { page, state, storage } = harness('home')
  await page.loadPublicStats()
  state.now += 1000
  state.rollout.rolloutPercent.develop = 100; state.env = 'develop'; state.snapshot = null
  await page.loadPublicStats({ force: true })
  assert.equal(state.http.length, 1)
  assert.equal(state.calls.filter(name => name === 'statistics').length, 2)
  assert.equal(page._publicStatsReadDiagnostic.source, 'cloudbase')
  assert.equal(storage.homePublicStatsCacheV1.syncedAt, state.now)
  await page.loadPublicStats()
  assert.equal(state.http.length, 1)
  assert.equal(state.calls.filter(name => name === 'statistics').length, 2)
})

test('release 100 percent merges forced home reads without creating a bucket and keeps its 24-hour cache and cloud fallback', async () => {
  const { page, state, storage } = harness('home')
  state.rollout.rolloutPercent.release = 100
  state.snapshot = trialSnapshot(state.now, 84)
  await Promise.all(Array.from({ length: 5 }, () => page.loadPublicStats({ force: true })))
  assert.equal(state.http.length, 1)
  assert.equal(state.calls.length, 0)
  assert.equal(storage.linkxPublicStatsRolloutV1, undefined)
  assert.equal(page._publicStatsReadDiagnostic.source, 'lighthouse')
  const syncedAt = storage.homePublicStatsCacheV1.syncedAt
  await page.loadPublicStats()
  assert.equal(page._publicStatsReadDiagnostic.source, 'local-cache')
  assert.equal(state.http.length, 1)
  assert.equal(storage.homePublicStatsCacheV1.syncedAt, syncedAt)
  state.snapshot = null
  await page.loadPublicStats({ force: true })
  assert.equal(state.http.length, 2)
  assert.deepEqual(state.calls, ['statistics'])
  assert.equal(page._publicStatsReadDiagnostic.source, 'cloudbase')
  assert.equal(storage.homePublicStatsCacheV1.data.servedTrips, 42)
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

test('public statistics reject malformed, expired and future-dated cache entries and retry failures', async () => {
  for (const entry of [
    { version: 1, syncedAt: 1800000000001, data: { servedTrips: 1, coverageText: 'NY / NJ' } },
    { version: 1, syncedAt: 1799900000000, data: { servedTrips: 1, coverageText: 'NY / NJ' } },
    { version: 1, syncedAt: 1800000000000, data: { servedTrips: 'unknown', coverageText: 'NY / NJ' } }
  ]) {
    const { page, state, storage } = harness('home')
    storage.homePublicStatsCacheV1 = entry
    state.pending.statistics = Promise.resolve({ result: { success: false, data: { servedTrips: 0 } } })
    await page.loadPublicStats()
    assert.equal(storage.homePublicStatsCacheV1, entry)
    delete state.pending.statistics
    await page.loadPublicStats()
    assert.equal(state.calls.length, 2)
    assert.equal(storage.homePublicStatsCacheV1.data.servedTrips, 42)
  }
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
    require: () => ({ isTimelinePreview: () => false }),
    wx: { cloud: { callFunction: () => {
      state.calls++
      if (state.failure) return Promise.reject(new Error('temporary failure'))
      return Promise.resolve({ result: { ok: true, serverTime: state.now,
        announcement: { available: state.available, id: 'notice-1', body: 'hello' } } })
    } } }
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
