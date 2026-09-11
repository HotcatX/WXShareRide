const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../pages/home/home.js'), 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function harness({ enabled = false, maxShows = 2 } = {}) {
  const state = {
    config: { announcement: { available: true, enabled, id: 'notice-1', title: '拼车群', body: '欢迎', imageUrl: 'https://example.test/group.jpg', maxShows } },
    reads: 0, counts: 0, toasts: [], next: null, now: 1800000000000
  }
  const timers = new Map()
  let timerTime = 0, nextTimerId = 0
  const clock = {
    setTimeout(callback, delay) {
      const id = nextTimerId++
      timers.set(id, { callback, delay, dueAt: timerTime + delay })
      return id
    },
    clearTimeout(id) { timers.delete(id) },
    pending() { return [...timers.values()] },
    advance(milliseconds) {
      const target = timerTime + milliseconds
      let calls = 0
      while (true) {
        const next = [...timers.entries()].sort((a, b) => a[1].dueAt - b[1].dueAt)[0]
        if (!next || next[1].dueAt > target) break
        assert.ok(++calls < 100, 'timer must not spin')
        timers.delete(next[0])
        state.now += next[1].dueAt - timerTime
        timerTime = next[1].dueAt
        next[1].callback()
      }
      state.now += target - timerTime
      timerTime = target
    }
  }
  const community = {
    loadCommunityConfig() { state.reads++; return state.next || Promise.resolve(state.config) },
    getCommunityNow(config) { assert.ok(config); return state.now },
    getAvailableAnnouncement(config) {
      const notice = config && config.announcement
      return notice && notice.available && (!notice.endAt || notice.endAt > state.now) ? notice : null
    },
    shouldShowAnnouncement(config) { return !!(config && config.announcement.available && config.announcement.enabled && state.counts < config.announcement.maxShows) },
    recordAnnouncementShown() { state.counts++; return true }
  }
  let definition
  const city = { getCitySnapshot: () => ({ key: 'ny_nj' }), getCountryTabs: () => [], getCountryGroups: () => [] }
  vm.runInNewContext(source, {
    Page: value => { definition = value }, console, Date,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval, clearInterval,
    wx: { showToast: value => state.toasts.push(value.title), previewImage: () => { throw new Error('Home must open the shared notice, not another preview') } },
    require(name) { return name.includes('/community') ? community : name.includes('/cityTree') ? city : {} }
  })
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) }
  page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) callback.call(this) }
  for (const name of ['syncLoginState', 'scheduleHomeShowRefresh', 'clearHomeShowRefresh']) page[name] = () => {}
  return { page, state, community, clock }
}

test('disabled automatic notice stays hidden on entry but manual button opens the same content without consuming a view', async () => {
  const { page, state } = harness()
  page.onShow()
  await tick()
  assert.equal(page.data.communityNoticeVisible, false)
  await page.onJoinCommunityGroup()
  assert.equal(page.data.communityNoticeVisible, true)
  assert.equal(page.data.communityNotice.id, 'notice-1')
  assert.equal(state.counts, 0)
  page.onCommunityNoticeClose()
  await page.onJoinCommunityGroup()
  assert.equal(page.data.communityNoticeVisible, true)
  assert.equal(state.counts, 0)
})

test('automatic notice appears once per visit and respects total configured count', async () => {
  const { page, state } = harness({ enabled: true })
  page.onShow(); await tick()
  assert.equal(state.counts, 1)
  page.onCommunityNoticeClose()
  await page.refreshCommunityConfig()
  assert.equal(state.counts, 1)
  assert.equal(page.data.communityNoticeVisible, false)
  page.onHide(); page.onShow(); await tick()
  assert.equal(state.counts, 2)
  page.onHide(); page.onShow(); await tick()
  assert.equal(page.data.communityNoticeVisible, false)
  assert.equal(state.counts, 2)
  await page.onJoinCommunityGroup()
  assert.equal(page.data.communityNoticeVisible, true)
  assert.equal(state.counts, 2)
})

test('manual button blocks concurrent taps and invalidates an older automatic response', async () => {
  const { page, state } = harness({ enabled: true })
  const wait = deferred(); state.next = wait.promise
  page.onShow()
  const first = page.onJoinCommunityGroup()
  const second = page.onJoinCommunityGroup()
  assert.equal(state.reads, 2)
  wait.resolve(state.config)
  await Promise.all([first, second]); await tick()
  assert.equal(page.data.communityNoticeVisible, true)
  assert.equal(state.counts, 0)
})

test('leaving the page prevents a late manual or automatic response from opening a notice', async () => {
  for (const manual of [false, true]) {
    const { page, state } = harness({ enabled: true })
    const wait = deferred(); state.next = wait.promise
    page.onShow()
    const pending = manual ? page.onJoinCommunityGroup() : null
    page.onHide()
    wait.resolve(state.config)
    await pending; await tick()
    assert.equal(page.data.communityNoticeVisible, false)
    assert.equal(state.counts, 0)
  }
})

test('returning from a notice image preview does not auto-display another notice', async () => {
  const { page, state } = harness({ enabled: true, maxShows: 10 })
  page.onShow(); await tick()
  page.onAnnouncementPreview()
  page.onHide(); page.onShow(); await tick()
  assert.equal(page.data.communityNoticeVisible, false)
  assert.equal(state.counts, 1)
})

test('manual view remains available when auto is disabled; expiry or removal dismisses the visible content', async () => {
  const { page, state } = harness()
  page.onShow(); await tick()
  await page.onJoinCommunityGroup()
  state.config.announcement.body = '云端更新的说明'
  await page.refreshCommunityConfig()
  assert.equal(page.data.communityNoticeVisible, true)
  assert.equal(page.data.communityNotice.body, '云端更新的说明')
  state.config.announcement.available = false
  await page.refreshCommunityConfig()
  assert.equal(page.data.communityNoticeVisible, false)
  await page.onJoinCommunityGroup()
  assert.equal(state.toasts.length, 1)
  assert.equal(state.counts, 0)
})

test('hot disabling auto closes an automatically opened modal and configuration failures remain quiet', async () => {
  const { page, state } = harness({ enabled: true })
  page.onShow(); await tick()
  state.config.announcement.enabled = false
  await page.refreshCommunityConfig()
  assert.equal(page.data.communityNoticeVisible, false)
  state.next = Promise.reject(new Error('private cloud trace'))
  await page.refreshCommunityConfig()
  assert.equal(state.toasts.length, 0)
  await page.onJoinCommunityGroup()
  assert.deepEqual(state.toasts, ['暂时无法加载，请稍后重试'])
  assert.equal(page.data.communityGroupLoading, false)
})

test('storage failure or an open city picker cannot trigger or consume an automatic impression', async () => {
  const { page, state, community } = harness({ enabled: true })
  page.data.cityPickerVisible = true
  page.onShow(); await tick()
  assert.equal(state.counts, 0)
  page.data.cityPickerVisible = false
  community.recordAnnouncementShown = () => false
  await page.refreshCommunityConfig()
  assert.equal(page.data.communityNoticeVisible, false)
  assert.equal(state.counts, 0)
})

test('manual and automatic notices close at the server-clock deadline without consuming another impression', async () => {
  for (const automatic of [false, true]) {
    const { page, state, clock } = harness({ enabled: automatic })
    state.config.announcement.endAt = state.now + 1000
    page.onShow(); await tick()
    if (!automatic) await page.onJoinCommunityGroup()
    assert.equal(page.data.communityNoticeVisible, true)
    assert.equal(clock.pending()[0].delay, 1000)
    clock.advance(999)
    assert.equal(page.data.communityNoticeVisible, true)
    clock.advance(1)
    assert.equal(page.data.communityNoticeVisible, false)
    assert.equal(page.data.communityNotice, null)
    assert.equal(clock.pending().length, 0)
    assert.equal(state.counts, automatic ? 1 : 0)
    await page.onJoinCommunityGroup()
    assert.equal(page.data.communityNoticeVisible, false)
  }
})

test('long notice validity schedules bounded timer segments and rechecks the server clock', async () => {
  const { page, state, clock } = harness()
  const maximumDelay = 2147483647
  state.config.announcement.endAt = state.now + maximumDelay + 2500
  page.onShow(); await tick()
  await page.onJoinCommunityGroup()
  assert.equal(clock.pending()[0].delay, maximumDelay)
  clock.advance(maximumDelay)
  assert.equal(page.data.communityNoticeVisible, true)
  assert.equal(clock.pending()[0].delay, 2500)
  clock.advance(2499)
  assert.equal(page.data.communityNoticeVisible, true)
  clock.advance(1)
  assert.equal(page.data.communityNoticeVisible, false)
  assert.equal(clock.pending().length, 0)
})

test('updated expiry replaces the timer and queued callbacks cannot dismiss refreshed content', async () => {
  const { page, state, clock } = harness()
  state.config.announcement.endAt = state.now + 1000
  page.onShow(); await tick()
  await page.onJoinCommunityGroup()
  const oldCallback = clock.pending()[0].callback
  clock.advance(500)
  state.config.announcement.endAt = state.now + 3000
  await page.refreshCommunityConfig()
  assert.equal(clock.pending().length, 1)
  assert.equal(clock.pending()[0].delay, 3000)
  clock.advance(500)
  oldCallback()
  assert.equal(page.data.communityNoticeVisible, true)
  assert.equal(clock.pending().length, 1)
  clock.advance(2500)
  assert.equal(page.data.communityNoticeVisible, false)
})

test('close, hide, unload and image preview clear expiry timers and invalidate queued callbacks', async () => {
  for (const action of ['onCommunityNoticeClose', 'onHide', 'onUnload', 'onAnnouncementPreview']) {
    const { page, state, clock } = harness()
    state.config.announcement.endAt = state.now + 1000
    page.onShow(); await tick()
    await page.onJoinCommunityGroup()
    const callback = clock.pending()[0].callback
    page[action]()
    assert.equal(clock.pending().length, 0, action)
    let updates = 0
    page.setData = () => { updates++ }
    clock.advance(1000)
    callback()
    assert.equal(updates, 0, action)
  }
})

test('removing the deadline or receiving unavailable content clears a visible notice timer', async () => {
  const { page, state, clock } = harness()
  state.config.announcement.endAt = state.now + 1000
  page.onShow(); await tick()
  await page.onJoinCommunityGroup()
  state.config.announcement.endAt = 0
  await page.refreshCommunityConfig()
  assert.equal(clock.pending().length, 0)
  clock.advance(2000)
  assert.equal(page.data.communityNoticeVisible, true)
  state.config.announcement.endAt = state.now + 1000
  await page.refreshCommunityConfig()
  assert.equal(clock.pending().length, 1)
  state.config.announcement.available = false
  await page.refreshCommunityConfig()
  assert.equal(page.data.communityNoticeVisible, false)
  assert.equal(clock.pending().length, 0)
})
