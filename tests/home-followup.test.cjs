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
function harness() {
  const state = { account: 'account-a', guest: false, scope: true, used: false, eligible: true, history: [], calls: [], considered: [],
    listeners: new Set(), timers: new Map(), timerId: 0, revision: 0, hides: 0, dismisses: 0, answers: [],
    notice: null, communityPending: null, cardsPending: null, outcomeReads: [], outcomesPending: null, now: 1800000000000 }
  class Clock extends Date { static now() { return state.now } }
  const followup = {
    canConsider: () => !!(state.account && !state.guest && state.scope && !state.used),
    readUnpromptedTrips(list) {
      state.outcomeReads.push({ account: state.account, list })
      return state.outcomesPending || Promise.resolve(list)
    },
    considerTrips(page, list) {
      state.considered.push({ account: state.account, list })
      if (state.eligible && list.length && followup.canConsider()) { state.used = true; page.setData({ followupVisible: true }) }
    },
    hide(page) { state.hides++; page.setData({ followupVisible: false }) },
    dispose(page) { followup.hide(page) },
    dismiss(page) { state.dismisses++; page.setData({ followupVisible: false }) },
    answer(page, outcome) { state.answers.push(outcome); page.setData({ followupVisible: false }) }
  }
  const wx = {
    getStorageSync: key => key === 'openid' ? state.account : key === 'isGuest' ? state.guest :
      key === 'rideListShouldRefreshAt' ? state.revision : undefined,
    setStorageSync() {},
    cloud: { callFunction() { throw new Error('Unexpected cloud request') } }
  }
  const community = {
    loadCommunityConfig: () => state.communityPending || Promise.resolve({}),
    getAvailableAnnouncement: () => state.notice,
    shouldShowAnnouncement: () => !!state.notice,
    recordAnnouncementShown: () => true
  }
  let definition
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/home/home.js'), 'utf8'), {
    wx, Date: Clock, console, Page: value => { definition = value },
    setTimeout(fn, delay) { const id = ++state.timerId; state.timers.set(id, { fn, delay }); return id },
    clearTimeout: id => state.timers.delete(id),
    require(name) {
      if (name.endsWith('/tripFollowup')) return followup
      if (name.endsWith('/analyticsSession')) return { subscribe(fn) {
        state.listeners.add(fn); fn(); return () => state.listeners.delete(fn)
      } }
      if (name.endsWith('/compat/rideHistory')) return { loadRideHistory(account) {
        state.calls.push('history:' + account)
        const pending = deferred(); state.history.push({ account, pending }); return pending.promise
      } }
      if (name.endsWith('/compat/rides')) return { isBackendEnabled: () => true, getHomeTripList() {
        state.calls.push('cards')
        return state.cardsPending || Promise.resolve({ result: { ok: true, data: {} } })
      } }
      if (name.endsWith('/community')) return community
      if (name.endsWith('/cityTree')) return { getCitySnapshot: () => ({ key: 'ny_nj' }), getCountryTabs: () => [], getCountryGroups: () => [] }
      if (name.endsWith('/rideTime')) return require('../utils/rideTime')
      return {}
    }
  })
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) }
  page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) callback.call(this) }
  page.loadPublicStats = page.loadUnreadCount = () => Promise.resolve()
  page.refreshHomeData = () => Promise.resolve()
  function refreshTimer() {
    const entry = [...state.timers.entries()].find(([, timer]) => timer.delay === 300)
    assert.ok(entry, 'home should schedule its normal entry refresh')
    state.timers.delete(entry[0]); entry[1].fn()
  }
  const resolve = (index, rows = [{ _id: 'completed-trip' }]) => state.history[index].pending.resolve({ result: { ok: true, data: rows } })
  return { page, state, refreshTimer, resolve, definition }
}

test('optional follow-up waits for the initial authoritative card read', async () => {
  const h = harness(), cards = deferred()
  h.page.refreshHomeData = h.definition.refreshHomeData
  h.state.cardsPending = cards.promise
  h.page.onShow(); h.refreshTimer(); await tick()
  assert.deepEqual(h.state.calls, ['cards'])
  assert.equal(h.page.data.loading, true)
  cards.resolve({ result: { ok: true, data: {} } }); await tick()
  assert.equal(h.page.data.loading, false)
  assert.equal(h.state.history.length, 1)
  assert.deepEqual(h.state.calls, ['cards', 'history:account-a'])
  h.resolve(0); await tick()
  assert.equal(h.page.data.followupVisible, true)
})

test('home waits for normal entry refresh before reading server history without a client status writer', async () => {
  const h = harness()
  h.page.onShow(); await tick()
  assert.equal(h.state.history.length, 0)
  h.refreshTimer(); await tick()
  assert.deepEqual(h.state.calls, ['history:account-a'])
  h.resolve(0); await tick()
  assert.equal(h.page.data.followupVisible, true)
  assert.equal(h.state.considered.length, 1)
  await h.page.loadHomeFollowup(true)
  assert.equal(h.state.history.length, 1, 'no further reads once the foreground prompt is used')
})

test('authorization readiness starts one read and concurrent notifications share it', async () => {
  const h = harness(); h.state.scope = false
  h.page.onShow(); h.refreshTimer(); await tick()
  assert.equal(h.state.history.length, 0)
  h.state.scope = true
  h.state.listeners.forEach(fn => fn()); h.state.listeners.forEach(fn => fn()); await tick()
  assert.equal(h.state.history.length, 1)
  h.resolve(0, []); await tick()
  h.state.listeners.forEach(fn => fn()); await h.page.loadHomeFollowup(); await tick()
  assert.equal(h.state.history.length, 1, 'successful empty history is cached for 30 seconds within the visit')
  h.state.now += 30000
  const next = h.page.loadHomeFollowup(); await tick()
  assert.equal(h.state.history.length, 2); h.resolve(1); await next
  assert.equal(h.page.data.followupVisible, true)
})

test('periodic analytics notifications never poll successful empty or ineligible history', async () => {
  for (const rows of [[], [{ _id: 'upcoming-trip' }]]) {
    const h = harness()
    // This test models controller rejection of a future/noneligible trip.
    h.state.eligible = false
    h.page.onShow(); h.refreshTimer(); await tick(); h.resolve(0, rows); await tick()
    assert.equal(h.page.data.followupVisible, false)
    for (let index = 0; index < 4; index++) {
      h.state.now += 31000
      h.state.listeners.forEach(fn => fn())
      await tick()
    }
    assert.equal(h.state.history.length, 1)
    h.state.revision++
    h.state.listeners.forEach(fn => fn()); await tick()
    assert.equal(h.state.history.length, 2, 'a real ride mutation still invalidates the history read')
    h.resolve(1, []); await tick()
  }
})

test('city selection and community announcements finish before the home follow-up', async () => {
  for (const modal of ['cityPickerVisible', 'communityNoticeVisible']) {
    const h = harness(); h.page.onShow(); await tick(); h.page.data[modal] = true
    h.refreshTimer(); await tick(); h.resolve(0); await tick()
    assert.equal(h.page.data.followupVisible, false)
    h.page[modal === 'cityPickerVisible' ? 'onCityPickerCancel' : 'onCommunityNoticeClose']()
    assert.equal(h.page.data.followupVisible, true)
  }
  const h = harness(), config = deferred(); h.state.communityPending = config.promise
  h.page.onShow(); h.refreshTimer(); await tick(); h.resolve(0); await tick()
  assert.equal(h.page.data.followupVisible, false, 'do not outrun an in-flight automatic announcement')
  h.state.notice = { id: 'notice' }; config.resolve({}); await tick()
  assert.equal(h.page.data.communityNoticeVisible, true)
  assert.equal(h.page.data.followupVisible, false)
  h.page.onCommunityNoticeClose(); assert.equal(h.page.data.followupVisible, true)
  h.page._announcementShownOnVisit = false
  await h.page.refreshCommunityConfig()
  assert.equal(h.page.data.communityNoticeVisible, false, 'a late announcement must not cover the prompt')
})

test('late history after hide or unload is discarded and returning reloads current membership', async () => {
  for (const method of ['onHide', 'onUnload']) {
    const h = harness(); h.page.onShow(); h.refreshTimer(); await tick()
    h.page[method](); h.resolve(0); await tick()
    assert.equal(h.page.data.followupVisible, false)
    assert.equal(h.state.considered.length, 0)
    assert.equal(h.state.listeners.size, 0)
    if (method === 'onHide') {
      h.page.onShow(); h.refreshTimer(); await tick()
      assert.equal(h.state.history.length, 2)
      h.resolve(1, []); await tick(); assert.equal(h.page.data.followupVisible, false)
    }
  }
})

test('closing a long-open city selector revalidates membership instead of prompting from old history', async () => {
  const h = harness(); h.page.onShow(); h.page.data.cityPickerVisible = true
  h.refreshTimer(); await tick(); h.resolve(0); await tick()
  h.state.now += 30000
  h.page.onCityPickerCancel(); await tick()
  assert.equal(h.page.data.followupVisible, false)
  assert.equal(h.state.history.length, 2)
  h.resolve(1, []); await tick()
  assert.equal(h.page.data.followupVisible, false)
})

test('account switches and guest transitions cannot reuse previous account history', async () => {
  const h = harness(); h.page.onShow(); h.refreshTimer(); await tick()
  h.state.account = 'account-b'; h.state.listeners.forEach(fn => fn()); await tick()
  assert.equal(h.state.history.length, 2)
  h.resolve(1, []); await tick(); h.resolve(0); await tick()
  assert.equal(h.page.data.followupVisible, false)
  assert.equal(h.state.considered.some(entry => entry.list.some(trip => trip._id === 'completed-trip')), false)
  h.state.guest = true; h.state.listeners.forEach(fn => fn()); await tick()
  assert.equal(h.state.history.length, 2)
  assert.equal(h.page._homeFollowup, null)
})

test('history errors are quiet and retriable, while a changed mutation revision rejects stale history', async () => {
  const h = harness(); h.page.onShow(); h.refreshTimer(); await tick()
  h.state.history[0].pending.reject(new Error('unavailable')); await tick()
  assert.equal(h.page.data.followupVisible, false)
  const retry = h.page.loadHomeFollowup(); await tick()
  assert.equal(h.state.history.length, 2)
  h.state.revision++; h.resolve(1); await retry
  assert.equal(h.page.data.followupVisible, false)
  const fresh = h.page.loadHomeFollowup(); await tick(); h.resolve(2); await fresh
  assert.equal(h.page.data.followupVisible, true)
})

test('explicit close uses dismiss while page hiding is only an interruption', async () => {
  const h = harness(); h.page.onShow(); h.refreshTimer(); await tick(); h.resolve(0); await tick()
  h.page.onFollowupClose()
  assert.equal(h.state.dismisses, 1)
  assert.equal(h.page.data.followupVisible, false)
  h.page.onFollowupAnswer({ currentTarget: { dataset: { outcome: 'no' } } })
  assert.deepEqual(h.state.answers, ['no'])
  const hides = h.state.hides
  h.page.onHide()
  assert.equal(h.state.hides, hides + 1)
  assert.equal(h.state.dismisses, 1)
  const markup = fs.readFileSync(path.join(__dirname, '../pages/home/home.wxml'), 'utf8')
  assert.match(markup, /仅询问一次，关闭后不再提醒/)
  assert.doesNotMatch(markup, /稍后回答/)
})

test('home waits for the remote prompt history and never displays an already answered or presented trip', async () => {
  const h = harness(), outcomes = deferred(); h.state.outcomesPending = outcomes.promise
  h.page.onShow(); h.refreshTimer(); await tick(); h.resolve(0); await tick()
  assert.equal(h.state.outcomeReads.length, 1)
  assert.equal(h.state.considered.length, 0)
  assert.equal(h.page.data.followupVisible, false)
  outcomes.resolve([]); await tick()
  assert.equal(h.page.data.followupVisible, false)
  assert.equal(h.page._homeFollowup.trips.length, 0)
  for (let i = 0; i < 3; i++) { h.state.now += 31000; h.state.listeners.forEach(fn => fn()); await tick() }
  assert.equal(h.state.outcomeReads.length, 1, 'a successful no-new-question result is not periodically polled')
})

test('unknown remote prompt state stays quiet and a later ordinary read retries', async () => {
  for (const failure of [null, new Error('unavailable')]) {
    const h = harness(), outcomes = deferred(); h.state.outcomesPending = outcomes.promise
    h.page.onShow(); h.refreshTimer(); await tick(); h.resolve(0); await tick()
    failure ? outcomes.reject(failure) : outcomes.resolve(null); await tick()
    assert.equal(h.page.data.followupVisible, false)
    assert.equal(h.state.considered.length, 0)
    assert.equal(h.page._homeFollowup, null)
    assert.equal(h.page._homeReads.followup.at, 0)
    h.state.outcomesPending = null
    const retry = h.page.loadHomeFollowup(); await tick(); h.resolve(1); await retry
    assert.equal(h.state.outcomeReads.length, 2)
    assert.equal(h.page.data.followupVisible, true)
  }
})

test('late remote prompt state cannot open after account changes, hiding, or a ride mutation', async () => {
  for (const change of [h => { h.state.account = 'account-b'; h.page.syncLoginState() },
    h => h.page.onHide(), h => { h.state.revision++ }]) {
    const h = harness(), outcomes = deferred(); h.state.outcomesPending = outcomes.promise
    h.page.onShow(); h.refreshTimer(); await tick(); h.resolve(0); await tick()
    change(h); outcomes.resolve([{ _id: 'old-account-trip' }]); await tick()
    assert.equal(h.page.data.followupVisible, false)
    assert.equal(h.state.considered.length, 0)
    assert.equal(h.page._homeFollowup, null)
  }
})
