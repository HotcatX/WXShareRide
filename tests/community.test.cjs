const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../utils/community.js'), 'utf8')
const KEY = 'community_announcement_history_v1'
const NOW = 1800000000000
const clone = value => JSON.parse(JSON.stringify(value))
function fixture(overrides = {}) {
  return {
    ok: true, serverTime: NOW,
    group: { enabled: true, title: '加入拼车群', imageUrl: 'https://images.example.test/group.png?token=one', expiresAt: NOW + 3600000 },
    announcement: { available: true, enabled: true, id: 'notice-1', title: '公告', body: '欢迎加入', imageUrl: '', maxShows: 2, intervalHours: 24, startAt: 0, endAt: 0, ...overrides }
  }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function harness(options = {}) {
  const state = { wall: options.wall || NOW, monotonic: 1000, preview: false, response: fixture(), calls: [], writes: [], stored: '', failRead: false, failWrite: false, pending: null, timers: new Map(), nextTimer: 0 }
  class Clock extends Date { static now() { return state.wall } }
  const wx = {
    cloud: { callFunction(args) { state.calls.push(clone(args)); return state.pending || Promise.resolve({ result: clone(state.response) }) } },
    getPerformance: () => ({ now: () => state.monotonic }),
    getStorageSync(key) { assert.equal(key, KEY); if (state.failRead) throw new Error('private read failure'); return state.stored },
    setStorageSync(key, value) { assert.equal(key, KEY); if (state.failWrite) throw new Error('private write failure'); state.stored = clone(value); state.writes.push(clone(value)) }
  }
  const context = {
    module: { exports: {} }, Date: Clock,
    require(name) { assert.equal(name, './timeline'); return { isTimelinePreview: () => state.preview } },
    setTimeout(fn, delay) { const id = ++state.nextTimer; state.timers.set(id, { fn, delay }); return id },
    clearTimeout(id) { state.timers.delete(id) }
  }
  if (!options.noWx) context.wx = wx
  if (options.noCloud) delete wx.cloud
  if (options.noCallFunction) delete wx.cloud.callFunction
  if (options.noPerformance) delete wx.getPerformance
  vm.runInNewContext(source, context)
  const api = context.module.exports
  function advance(ms) { state.wall += ms; state.monotonic += ms }
  return { state, api, wx, advance }
}

test('missing runtime or cloud and timeline preview perform zero requests', async () => {
  for (const options of [{ noWx: true }, { noCloud: true }, { noCallFunction: true }, {}]) {
    const { api, state } = harness(options)
    if (!Object.keys(options).length) state.preview = true
    assert.equal(await api.loadCommunityConfig({ force: true }), null)
    assert.equal(state.calls.length, 0)
  }
})

test('concurrent force calls deduplicate but every later load fetches fresh configuration', async () => {
  const { api, state } = harness()
  const pending = deferred(); state.pending = pending.promise
  const first = api.loadCommunityConfig()
  const second = api.loadCommunityConfig({ force: true })
  assert.equal(first, second)
  assert.deepEqual(state.calls, [{ name: 'marketApi', data: { action: 'communityConfig' } }])
  pending.resolve({ result: fixture() })
  const config = await first
  assert.ok(api.getAvailableAnnouncement(config))
  state.pending = null
  state.response.announcement.available = false
  const fresh = await api.loadCommunityConfig()
  assert.equal(state.calls.length, 2)
  assert.equal(api.getAvailableAnnouncement(fresh), null)
  assert.equal(state.writes.length, 0)
})

test('an in-flight response is discarded if the app enters timeline preview', async () => {
  const { api, state } = harness()
  const pending = deferred(); state.pending = pending.promise
  const request = api.loadCommunityConfig()
  state.preview = true
  pending.resolve({ result: fixture() })
  assert.equal(await request, null)
  assert.equal(api.getAvailableAnnouncement(fixture()), null)
  assert.equal(api.recordAnnouncementShown(fixture()), false)
})

test('cloud failure and malformed response expose friendly errors and allow retry', async () => {
  const { api, state } = harness()
  for (const result of [{ ok: false, message: 'secret token' }, { ok: true, serverTime: 'bad' }, null]) {
    state.pending = Promise.resolve({ result })
    await assert.rejects(api.loadCommunityConfig(), error => error.code === 'COMMUNITY_UNAVAILABLE' && !error.message.includes('secret'))
  }
  state.pending = Promise.reject(new Error('credential secret'))
  await assert.rejects(api.loadCommunityConfig(), /暂时无法加载社群信息/)
  state.pending = null
  assert.ok(await api.loadCommunityConfig())
  assert.equal(state.timers.size, 0)
})

test('timeout clears pending state; a late old response cannot replace a fresh result', async () => {
  const { api, state } = harness()
  const old = deferred(); state.pending = old.promise
  const first = api.loadCommunityConfig()
  const timer = [...state.timers.values()][0]
  assert.equal(timer.delay, 15000)
  timer.fn()
  await assert.rejects(first, error => error.code === 'TIMEOUT')
  state.pending = null
  state.response.announcement.available = false
  const fresh = await api.loadCommunityConfig()
  old.resolve({ result: fixture() })
  await Promise.resolve()
  assert.equal(api.getAvailableAnnouncement(fresh), null)
  assert.equal(state.calls.length, 2)
})

test('server clock corrects skew and monotonic time expires both group and notice', async () => {
  const { api, state, advance } = harness({ wall: NOW - 1000000000 })
  state.response.announcement.endAt = NOW + 1000
  state.response.group.expiresAt = NOW + 1000
  const config = await api.loadCommunityConfig()
  assert.equal(api.getCommunityNow(config), NOW)
  assert.equal(api.isGroupAvailable(config), true)
  assert.ok(api.getAvailableAnnouncement(config))
  state.wall -= 500000
  advance(1000)
  assert.equal(api.getCommunityNow(config), NOW + 1000)
  assert.equal(api.isGroupAvailable(config), false)
  assert.equal(api.getAvailableAnnouncement(config), null)
})

test('fallback wall clock advances expiry when performance API is unavailable', async () => {
  const { api, state, advance } = harness({ noPerformance: true, wall: NOW + 1234567 })
  state.response.announcement.endAt = NOW + 200
  const config = await api.loadCommunityConfig()
  assert.equal(api.getCommunityNow(config), NOW)
  advance(200)
  assert.equal(api.getAvailableAnnouncement(config), null)
})

test('manual viewing ignores automatic switch and frequency, returns a copy, and never records', async () => {
  const { api, state } = harness()
  state.response.announcement.enabled = false
  state.response.announcement.maxShows = 0
  const config = await api.loadCommunityConfig()
  for (let i = 0; i < 5; i++) assert.equal(api.getAvailableAnnouncement(config).body, '欢迎加入')
  const notice = api.getAvailableAnnouncement(config)
  notice.body = 'modified'
  assert.equal(config.announcement.body, '欢迎加入')
  assert.equal(api.shouldShowAnnouncement(config), false)
  assert.equal(api.recordAnnouncementShown(config), false)
  assert.equal(state.writes.length, 0)
})

test('manual availability requires valid ID, server availability, content, and a valid current window', async () => {
  const { api, state } = harness()
  for (const change of [{ available: false }, { id: '' }, { id: 'bad/id' }, { body: '', imageUrl: '' }, { startAt: NOW + 1 }, { endAt: NOW }, { startAt: NOW + 5, endAt: NOW + 4 }, { startAt: -1 }, { endAt: 'tomorrow' }]) {
    state.response = fixture(change)
    assert.equal(api.getAvailableAnnouncement(await api.loadCommunityConfig()), null, JSON.stringify(change))
  }
  state.response = fixture({ startAt: NOW, endAt: NOW + 1 })
  assert.ok(api.getAvailableAnnouncement(await api.loadCommunityConfig()))
})

test('only valid HTTPS image URLs pass; text-only and image-only notices are supported', async () => {
  const { api, state } = harness()
  for (const imageUrl of ['http://example.test/a.png', 'cloud://env/file.png', 'javascript:alert(1)', 'https://user:secret@example.test/a.png', 'https://example.test\\evil/a', 'https://example..test/a', 'https://example.test/a\n']) {
    state.response = fixture({ imageUrl })
    state.response.group.imageUrl = imageUrl
    const config = await api.loadCommunityConfig()
    assert.equal(api.getAvailableAnnouncement(config), null, imageUrl)
    assert.equal(api.isGroupAvailable(config), false)
  }
  state.response = fixture({ body: '', imageUrl: 'https://image.example.test:443/qrcode?sign=x' })
  assert.ok(api.getAvailableAnnouncement(await api.loadCommunityConfig()))
  state.response = fixture({ body: '纯文字', imageUrl: '' })
  assert.ok(api.getAvailableAnnouncement(await api.loadCommunityConfig()))
})

test('frequency persists by ID across refresh, editing, toggling, and module reload', async () => {
  const { api, state, advance } = harness()
  const config = await api.loadCommunityConfig()
  assert.equal(api.shouldShowAnnouncement(config), true)
  assert.equal(api.recordAnnouncementShown(config), true)
  assert.equal(api.shouldShowAnnouncement(config), false)
  advance(24 * 3600000 - 1)
  assert.equal(api.shouldShowAnnouncement(config), false)
  advance(1)
  assert.equal(api.shouldShowAnnouncement(config), true)
  assert.equal(api.recordAnnouncementShown(config), true)
  assert.equal(api.shouldShowAnnouncement(config), false)
  state.response.serverTime = api.getCommunityNow(config)
  state.response.announcement.title = 'new title'
  state.response.announcement.imageUrl = 'https://image.example.test/changed.png'
  state.response.announcement.enabled = false
  assert.ok(api.getAvailableAnnouncement(await api.loadCommunityConfig()))
  state.response.announcement.enabled = true
  assert.equal(api.shouldShowAnnouncement(await api.loadCommunityConfig()), false)
  const second = harness()
  second.state.stored = clone(state.stored)
  second.state.response = clone(state.response)
  assert.equal(second.api.shouldShowAnnouncement(await second.api.loadCommunityConfig()), false)
  assert.equal(state.stored.items[0].count, 2)
  assert.deepEqual(Object.keys(state.stored.items[0]).sort(), ['count', 'id', 'lastShownAt'])
})

test('zero interval supports subsequent entries up to maxShows; a new ID has its own counter', async () => {
  const { api, state } = harness()
  state.response = fixture({ intervalHours: 0, maxShows: 2 })
  const config = await api.loadCommunityConfig()
  assert.equal(api.recordAnnouncementShown(config), true)
  assert.equal(api.recordAnnouncementShown(config), true)
  assert.equal(api.recordAnnouncementShown(config), false)
  assert.ok(api.getAvailableAnnouncement(config))
  state.response.announcement.id = 'notice-2'
  assert.equal(api.shouldShowAnnouncement(await api.loadCommunityConfig()), true)
})

test('frequency defaults are one view and 24 hours and explicit invalid limits disable automatic viewing only', async () => {
  const { api, state } = harness()
  state.response = fixture({ maxShows: undefined, intervalHours: undefined })
  let config = await api.loadCommunityConfig()
  assert.equal(config.announcement.maxShows, 1)
  assert.equal(config.announcement.intervalHours, 24)
  for (const change of [{ maxShows: 0 }, { maxShows: 101 }, { maxShows: 1.5 }, { maxShows: '2' }, { intervalHours: -1 }, { intervalHours: 8761 }, { intervalHours: '0' }]) {
    state.response = fixture(change)
    config = await api.loadCommunityConfig()
    assert.equal(api.shouldShowAnnouncement(config), false)
    assert.ok(api.getAvailableAnnouncement(config))
  }
  for (const change of [{ maxShows: 100 }, { intervalHours: 8760 }, { intervalHours: 0.5 }]) {
    state.response = fixture(change)
    assert.equal(api.shouldShowAnnouncement(await api.loadCommunityConfig()), true)
  }
})

test('unavailable, unreadable or corrupt storage prevents automatic display without blocking manual view', async () => {
  const { api, state, wx } = harness()
  const config = await api.loadCommunityConfig()
  for (const stored of [{}, { version: 1, items: 'bad' }, { version: 1, items: [{ id: 'notice-1', count: 1001, lastShownAt: NOW }] }, { version: 1, items: [{ id: 'notice-1', count: 1, lastShownAt: NOW }, { id: 'notice-1', count: 1, lastShownAt: NOW }] }]) {
    state.stored = stored
    assert.equal(api.shouldShowAnnouncement(config), false)
    assert.equal(api.recordAnnouncementShown(config), false)
    assert.ok(api.getAvailableAnnouncement(config))
  }
  state.stored = ''; state.failRead = true
  assert.equal(api.shouldShowAnnouncement(config), false)
  state.failRead = false
  delete wx.setStorageSync
  assert.equal(api.shouldShowAnnouncement(config), false)
  assert.equal(api.recordAnnouncementShown(config), false)
})

test('failed storage write does not approve display or increment the persisted counter', async () => {
  const { api, state } = harness()
  const config = await api.loadCommunityConfig()
  state.failWrite = true
  assert.equal(api.shouldShowAnnouncement(config), true)
  assert.equal(api.recordAnnouncementShown(config), false)
  assert.equal(state.stored, '')
  assert.equal(state.writes.length, 0)
})

test('recording prunes to the most recent 100 IDs and keeps a new ID even on a timestamp tie', async () => {
  const { api, state } = harness()
  state.stored = { version: 1, items: Array.from({ length: 100 }, (_, i) => ({ id: 'old-' + i, count: 1, lastShownAt: NOW })) }
  const config = await api.loadCommunityConfig()
  assert.equal(api.recordAnnouncementShown(config), true)
  assert.equal(state.stored.items.length, 100)
  assert.equal(state.stored.items[0].id, 'notice-1')
  assert.equal(state.stored.items[0].count, 1)
  assert.equal(api.shouldShowAnnouncement(config), false)
})

test('future last display and exhausted bounded counters fail closed even with zero interval', async () => {
  const { api, state } = harness()
  state.response = fixture({ maxShows: 100, intervalHours: 0 })
  const config = await api.loadCommunityConfig()
  for (const item of [{ id: 'notice-1', count: 1, lastShownAt: NOW + 1 }, { id: 'notice-1', count: 1000, lastShownAt: NOW - 1 }]) {
    state.stored = { version: 1, items: [item] }
    assert.equal(api.shouldShowAnnouncement(config), false)
    assert.equal(api.recordAnnouncementShown(config), false)
  }
})

test('normalization keeps only public configuration fields and never persists content or URLs', async () => {
  const { api, state } = harness()
  state.response.secret = 'private'
  state.response.announcement.internalNotes = 'private'
  const config = await api.loadCommunityConfig()
  assert.equal(config.secret, undefined)
  assert.equal(config.announcement.internalNotes, undefined)
  assert.equal(api.recordAnnouncementShown(config), true)
  assert.equal(JSON.stringify(state.stored).includes('欢迎'), false)
  assert.equal(JSON.stringify(state.stored).includes('https:'), false)
})
