const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const SOURCE = path.resolve(__dirname, '../pages/profile/tripHistory/tripHistory.js')
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function harness() {
  const state = { account: 'fixture-a', guest: false, requests: [], considered: [], hides: 0, disposed: 0,
    listeners: new Set(), timers: new Map(), nextTimer: 0, navigation: [], toasts: [], feedbackReads: 0, reports: [], ratings: [], readFailure: false, source: 'unanswered', outcome: null }
  const followup = {
    considerTrips(page, list) { state.considered.push({ account: state.account, list: plain(list) }) },
    answer() {}, hide() { state.hides++ }, dispose() { state.disposed++ }, thank() {},
    eligibleTrip: trip => trip._eligible ? {} : null,
    async readHistoryOutcomes(trips) { state.feedbackReads++; return state.readFailure ? null : trips.filter(trip => trip._eligible).map(trip => ({ tripKey: trip._id, source: state.source, outcome: state.outcome })) },
    reportHistory(trip, outcome) { state.reports.push({ id: trip._id, outcome }); return state.rejectReport ? { ok: false } : { ok: true, outcome, source: 'self_report' } }
  }
  const analytics = { subscribe(fn) { state.listeners.add(fn); fn(); return () => state.listeners.delete(fn) } }
  const wx = {
    getStorageSync: key => key === 'openid' ? state.account : key === 'isGuest' ? state.guest : undefined,
    getWindowInfo: () => ({ statusBarHeight: 20 }),
    showToast: value => state.toasts.push(value),
    navigateTo: value => state.navigation.push(value),
    cloud: { callFunction(args) {
      assert.equal(args.name, 'getMyTripHistory')
      const pending = deferred(); state.requests.push({ pending, account: state.account }); return pending.promise
    } }
  }
  let config
  vm.runInNewContext(fs.readFileSync(SOURCE, 'utf8'), { wx, console,
    require(name) { if (name.endsWith('/tripFollowup')) return followup
      if (name.endsWith('/analyticsSession')) return analytics
      if (name.endsWith('/compat/rideHistory')) return { loadRideHistory: account => {
        const pending = deferred(); state.requests.push({ pending, account }); return pending.promise } }
      if (name.endsWith('/compat/rides')) return { callTripManage: async input => {
        state.ratings.push(plain(input)); if (state.ratingFlight) return state.ratingFlight.promise
        return { ok: true, data: { rideId: input.tripId, targetId: input.targetUserId, score: state.recoveredScore || input.score } } } }
      throw new Error('Unexpected import: ' + name) },
    Page(value) { config = value },
    setTimeout(fn) { const id = ++state.nextTimer; state.timers.set(id, fn); return id },
    clearTimeout(id) { state.timers.delete(id) }
  }, { filename: SOURCE })
  const page = Object.assign({}, config, { data: plain(config.data) })
  page.setData = function (patch, done) { Object.assign(this.data, plain(patch)); if (done) done.call(this) }
  const resolve = (index, data) => state.requests[index].pending.resolve({ result: { ok: true, data } })
  return { page, state, resolve }
}
const row = id => ({ _id: id, historySource: 'carpool', historyRole: 'driver_create', departures: [{ date: '2026-09-22', time: '18:00' }] })

test('history shares one read and no longer owns the follow-up prompt', async () => {
  const h = harness(); const load = h.page.onLoad(); const show = h.page.onShow()
  await tick(); assert.equal(h.state.requests.length, 1); assert.equal(h.state.considered.length, 0)
  h.resolve(0, [row('fresh'), { missing: true, _id: 'deleted' }]); await Promise.all([load, show])
  assert.equal(h.state.considered.length, 0)
  assert.equal(h.page.data.historyTrips[0]._id, 'fresh')
  assert.equal(h.page.data.loading, false)
  h.state.listeners.forEach(fn => fn())
  assert.equal(h.state.requests.length, 1, 'authorization readiness reuses visible history without extra cloud calls')
  assert.equal(h.state.considered.length, 0)
})

test('a hidden page and an unloaded page cannot show a late follow-up', async () => {
  for (const method of ['onHide', 'onUnload']) {
    const h = harness(); const load = h.page.onLoad(); const show = h.page.onShow(); await tick()
    h.page[method](); h.resolve(0, [row('late')]); await Promise.all([load, show])
    assert.equal(h.state.considered.length, 0)
    assert.equal(h.state.listeners.size, 0)
    assert.equal(h.state.hides, 0)
  }
})

test('rating deep links scroll to the inline card without opening another page', async () => {
  const h = harness(); const load = h.page.onLoad({ rateTripId: 'rate_this' }); const show = h.page.onShow(); await tick()
  h.resolve(0, [row('rate_this')]); await Promise.all([load, show])
  assert.equal(h.state.considered.length, 0)
  assert.equal(h.page.data.scrollIntoTrip, 'history-trip-0')
  assert.equal(h.state.timers.size, 0)
  h.page.onHide(); assert.equal(h.state.timers.size, 0)
  assert.equal(h.state.navigation.length, 0)
})

test('account switch discards late old history and does not join an old account flight', async () => {
  const h = harness(); const a = h.page.onLoad(); h.page.onShow(); await tick()
  h.state.account = 'fixture-b'; const b = h.page.loadHistoryTrips(); await tick()
  h.resolve(1, [row('b')]); await b
  h.resolve(0, [row('a')]); await a
  assert.equal(h.page.data.historyTrips[0]._id, 'b')
  assert.equal(h.state.considered.length, 0)
  h.state.account = 'fixture-a'; const back = h.page.loadHistoryTrips(); await tick()
  assert.equal(h.state.requests.length, 3); h.resolve(2, [row('new-a')]); await back
  assert.equal(h.page.data.historyTrips[0]._id, 'new-a')
})

test('guest transition invalidates the flight, then re-login fetches again rather than being stuck', async () => {
  const h = harness(); const old = h.page.onLoad(); h.page.onShow(); await tick()
  h.state.guest = true; await h.page.loadHistoryTrips(); h.resolve(0, [row('stale')]); await old
  assert.equal(h.page.data.historyTrips.length, 0); assert.equal(h.state.considered.length, 0)
  h.state.guest = false; const fresh = h.page.loadHistoryTrips(); await tick()
  assert.equal(h.state.requests.length, 2); h.resolve(1, [row('fresh')]); await fresh
  assert.equal(h.page.data.historyTrips[0]._id, 'fresh')
})

test('onShow refreshes history without presenting a second feedback entry', async () => {
  const h = harness(); const load = h.page.onLoad(); const show = h.page.onShow(); await tick()
  h.resolve(0, [row('old')]); await Promise.all([load, show]); h.page.onHide()
  const before = h.state.considered.length
  const again = h.page.onShow(); await tick()
  assert.equal(h.state.considered.length, before, 'synchronous subscription must not ask using the previous list')
  h.resolve(1, []); await again
  assert.equal(h.page.data.historyTrips.length, 0)
  assert.equal(h.state.considered.length, 0)
})

test('history has no analytics subscription or follow-up overlay', () => {
  const h = harness()
  assert.equal(h.state.listeners.size, 0)
  assert.equal(h.page.onFollowupAnswer, undefined)
  assert.equal(h.page._considerFollowup, undefined)
  assert.doesNotMatch(fs.readFileSync(path.resolve(__dirname, '../pages/profile/tripHistory/tripHistory.wxml'), 'utf8'), /followupVisible/)
})

const feedbackRow = (id = 'ride-1', role = 'passenger') => ({ ...row(id), _eligible: true,
  historyRole: role, driverUserId: role === 'passenger' ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : '', myRating: 0 })
async function loaded(options = {}) {
  const h = harness(); Object.assign(h.state, options)
  const load = h.page.onLoad(); const show = h.page.onShow(); await tick()
  h.resolve(0, [feedbackRow('ride-1', options.role || 'passenger')]); await Promise.all([load, show]); await tick()
  return h
}
const answer = (h, outcome) => h.page.onHistoryAnswer({ currentTarget: { dataset: { id: 'ride-1', outcome } } })
const rate = (h, score) => h.page.onHistoryRate({ currentTarget: { dataset: { id: 'ride-1', score } } })
test('history default can be corrected once; confirmed answers replace the question and reject late taps', async () => {
  const h = await loaded({ source: 'dismissed_default', outcome: 'yes' })
  assert.equal(h.page.data.historyTrips[0]._feedbackStatus, '待确认')
  assert.equal(h.page.data.historyTrips[0]._showRating, false)
  answer(h, 'no')
  let card = h.page.data.historyTrips[0]
  assert.equal(card._feedbackOutcome, 'no'); assert.equal(card._feedbackAssumed, false)
  assert.equal(card._feedbackStatus, '待评分'); assert.equal(card._showRating, true)
  answer(h, 'yes'); answer(h, 'yes')
  assert.deepEqual(h.state.reports, [{ id: 'ride-1', outcome: 'no' }])
  assert.equal(h.page.data.historyTrips[0]._feedbackOutcome, 'no')
  assert.equal(h.state.navigation.length, 0)
})
test('failed query never creates an unanswered fact or enables answer buttons; retry can recover', async () => {
  const h = await loaded({ readFailure: true })
  assert.equal(h.page.data.historyTrips[0]._feedbackReady, false)
  answer(h, 'yes'); assert.equal(h.state.reports.length, 0)
  h.state.readFailure = false; h.page.retryFeedback(); await tick()
  assert.equal(h.page.data.historyTrips[0]._feedbackStatus, '待确认')
  h.state.rejectReport = true; answer(h, 'yes')
  assert.equal(h.page.data.historyTrips[0]._feedbackOutcome, null)
  assert.equal(h.page.data.historyTrips[0]._showRating, false)
})
test('driver confirms only, never rates themselves; passenger rating uses actual receipt score', async () => {
  const driver = await loaded({ role: 'driver_create' }); answer(driver, 'yes'); await rate(driver, 5)
  assert.equal(driver.page.data.historyTrips[0]._feedbackStatus, '已完成')
  assert.equal(driver.page.data.historyTrips[0]._showRating, false); assert.equal(driver.state.ratings.length, 0)
  const h = await loaded({ source: 'self_report', outcome: 'yes', recoveredScore: 3 })
  await rate(h, 5)
  assert.equal(h.page.data.historyTrips[0]._myRating, 3)
  assert.equal(h.page.data.historyTrips[0]._feedbackStatus, '已完成')
  await rate(h, 2); assert.equal(h.state.ratings.length, 1)
})
test('account switch rejects stale card actions and late ratings cannot update another account', async () => {
  const h = await loaded({ source: 'self_report', outcome: 'no' })
  h.state.account = 'fixture-b'; answer(h, 'yes'); await rate(h, 5)
  assert.equal(h.state.reports.length, 0); assert.equal(h.state.ratings.length, 0)
  h.state.account = 'fixture-a'; h.state.ratingFlight = deferred()
  const pending = rate(h, 4); h.state.account = 'fixture-b'
  h.state.ratingFlight.resolve({ ok: true, data: { rideId: 'ride-1', targetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', score: 4 } })
  await pending; assert.equal(h.page.data.historyTrips[0]._myRating, 0)
})
