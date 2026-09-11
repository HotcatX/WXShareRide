const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function harness() {
  const storage = {}
  const navigation = []
  let now = 1800000000000
  let failNavigation = false
  let storageUnavailable = false
  const wx = {
    getStorageSync(key) {
      if (storageUnavailable) throw new Error('storage unavailable')
      return storage[key]
    },
    setStorageSync(key, value) {
      if (storageUnavailable) throw new Error('storage unavailable')
      storage[key] = value
    },
    switchTab(options) {
      navigation.push({ url: options.url, marketType: storage.market_active_listing_type_v1 })
      if (!failNavigation && options.success) options.success()
    },
    cloud: { init() {} }
  }
  const module = { exports: {} }
  class Clock extends Date { static now() { return now } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/tabMemory.js'), 'utf8'), {
    wx, module, Date: Clock
  })
  return {
    memory: module.exports, wx, storage, navigation,
    advance(ms) { now += ms },
    failNavigation() { failNavigation = true },
    failStorage() { storageUnavailable = true }
  }
}

const HOME = 'pages/home/home'
const launch = { scene: 1001, path: HOME, query: {} }

test('bottom-tab choice survives more than a week, expires at 30 days, and rejects invalid snapshots', () => {
  const h = harness()
  const { memory, storage } = h
  memory.rememberTab('sublet')
  h.advance(8 * 24 * 60 * 60 * 1000)
  assert.equal(memory.readRememberedTab(), 'sublet')
  h.advance(22 * 24 * 60 * 60 * 1000 - 1)
  assert.equal(memory.readRememberedTab(), 'sublet')
  h.advance(1)
  assert.equal(memory.readRememberedTab(), '')
  assert.equal(memory.rememberTab('tripDetail'), false)
  assert.equal(memory.rememberTab('__proto__'), false)
  memory.rememberTab('profile')
  storage[memory.TAB_MEMORY_KEY].savedAt += 1
  assert.equal(memory.readRememberedTab(), '')
  storage[memory.TAB_MEMORY_KEY] = { version: 1, tab: 'goods', savedAt: '1800000000000' }
  assert.equal(memory.readRememberedTab(), '')
  h.failStorage()
  assert.equal(memory.readRememberedTab(), '')
  assert.equal(memory.rememberTab('home'), false)
})

test('normal launch restores all four choices once and supplies the market type before navigation', () => {
  for (const [tab, url] of [
    ['home', null], ['goods', '/pages/market/market'],
    ['sublet', '/pages/market/market'], ['profile', '/pages/profile/profile']
  ]) {
    const h = harness()
    h.memory.rememberTab(tab)
    h.advance(8 * 24 * 60 * 60 * 1000)
    h.memory.prepareLaunch(launch)
    assert.equal(h.memory.restoreOnReady(HOME), !!url)
    assert.equal(h.navigation.length, url ? 1 : 0)
    if (url) assert.equal(h.navigation[0].url, url)
    if (tab === 'goods' || tab === 'sublet') assert.equal(h.navigation[0].marketType, tab)
    assert.equal(h.memory.restoreOnReady(HOME), false)
    h.advance(25 * 24 * 60 * 60 * 1000)
    assert.equal(h.memory.readRememberedTab(), tab, 'successful use extends retention')
  }
})

test('share, QR, query, deep-link and preview entry points always keep their own destination', () => {
  const h = harness()
  h.memory.rememberTab('profile')
  for (const options of [
    ...[1007, 1008, 1011, 1044, 1047, 1154, 1037, 9999].map(scene => ({ ...launch, scene })),
    { ...launch, query: { ref: 'invitation' } },
    { ...launch, query: { timelineShare: '1' } },
    { ...launch, path: 'pages/home/tripDetail/tripDetail' },
    { ...launch, path: 'pages/market/market' },
    { ...launch, shareTicket: 'share_ticket' },
    { ...launch, referrerInfo: { appId: 'source_app' } }
  ]) {
    h.memory.prepareLaunch(options)
    assert.equal(h.memory.restoreOnReady(HOME), false)
  }
  assert.deepEqual(h.navigation, [])
})

test('an unexpected first page or failed navigation cannot cause a later redirect loop', () => {
  const h = harness()
  h.memory.rememberTab('profile')
  h.memory.prepareLaunch(launch)
  h.memory.restoreOnReady('pages/home/tripDetail/tripDetail')
  assert.equal(h.memory.restoreOnReady(HOME), false)
  h.memory.prepareLaunch(launch)
  const savedAt = h.storage[h.memory.TAB_MEMORY_KEY].savedAt
  h.advance(1000)
  h.failNavigation()
  h.memory.restoreOnReady(HOME)
  assert.equal(h.memory.restoreOnReady(HOME), false)
  assert.equal(h.navigation.length, 1)
  assert.equal(h.storage[h.memory.TAB_MEMORY_KEY].savedAt, savedAt)
})

test('App restores after the first page is ready, preserving page callbacks and later foreground navigation', () => {
  const h = harness()
  const pages = []
  let app
  let readyCount = 0
  const context = {
    wx: h.wx, console,
    App(config) { app = config },
    Page(config) { pages.push(config) },
    getCurrentPages: () => [],
    require(name) {
      if (name === './utils/tabMemory') return h.memory
      if (name === './utils/timeline') return {
        updateLaunchContext() {}, isTimelinePreview: () => false, wrapPage() {}
      }
      return {
        captureReferral() {}, ensureReferralCode: () => Promise.resolve(), bindPendingReferral() {}
      }
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), context)
  h.memory.rememberTab('sublet')
  app.onLaunch(launch)
  app.onShow(launch)
  context.Page({ onReady() { readyCount += 1; return 'page ready' } })
  const page = { ...pages[0], route: HOME }
  assert.equal(h.navigation.length, 0)
  assert.equal(page.onReady(), 'page ready')
  assert.equal(readyCount, 1)
  assert.equal(h.navigation[0].url, '/pages/market/market')
  app.onShow(launch)
  page.onReady()
  assert.equal(h.navigation.length, 1)
})
