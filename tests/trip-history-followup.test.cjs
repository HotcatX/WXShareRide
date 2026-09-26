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
    listeners: new Set(), timers: new Map(), nextTimer: 0, navigation: [], toasts: [] }
  const followup = {
    considerTrips(page, list) { state.considered.push({ account: state.account, list: plain(list) }) },
    answer() {}, hide() { state.hides++ }, dispose() { state.disposed++ }
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

test('onLoad/onShow share one history call and only consider rendered successful data', async () => {
  const h = harness(); const load = h.page.onLoad(); const show = h.page.onShow()
  await tick(); assert.equal(h.state.requests.length, 1); assert.equal(h.state.considered.length, 0)
  h.resolve(0, [row('fresh'), { missing: true, _id: 'deleted' }]); await Promise.all([load, show])
  assert.equal(h.state.considered.length, 1)
  assert.equal(h.state.considered[0].list[0]._id, 'fresh')
  assert.equal(h.page.data.loading, false)
  h.state.listeners.forEach(fn => fn())
  assert.equal(h.state.requests.length, 1, 'authorization readiness reuses visible history without extra cloud calls')
  assert.equal(h.state.considered.length, 2)
})

test('a hidden page and an unloaded page cannot show a late follow-up', async () => {
  for (const method of ['onHide', 'onUnload']) {
    const h = harness(); const load = h.page.onLoad(); const show = h.page.onShow(); await tick()
    h.page[method](); h.resolve(0, [row('late')]); await Promise.all([load, show])
    assert.equal(h.state.considered.length, 0)
    assert.equal(h.state.listeners.size, 0)
    assert.ok(h.state.hides >= 1)
  }
})

test('existing rating deep links take priority and scheduled navigation is cancelled on hide', async () => {
  const h = harness(); const load = h.page.onLoad({ rateTripId: 'rate_this' }); const show = h.page.onShow(); await tick()
  h.resolve(0, [row('rate_this')]); await Promise.all([load, show])
  assert.equal(h.state.considered.length, 0)
  assert.equal(h.state.timers.size, 1)
  h.page.onHide(); assert.equal(h.state.timers.size, 0)
  assert.equal(h.state.navigation.length, 0)
})

test('account switch discards late old history and does not join an old account flight', async () => {
  const h = harness(); const a = h.page.onLoad(); h.page.onShow(); await tick()
  h.state.account = 'fixture-b'; const b = h.page.loadHistoryTrips(); await tick()
  h.resolve(1, [row('b')]); await b
  h.resolve(0, [row('a')]); await a
  assert.equal(h.page.data.historyTrips[0]._id, 'b')
  assert.deepEqual(h.state.considered.map(item => item.account), ['fixture-b'])
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

test('onShow refreshes before asking again and cannot present stale previous-visit membership', async () => {
  const h = harness(); const load = h.page.onLoad(); const show = h.page.onShow(); await tick()
  h.resolve(0, [row('old')]); await Promise.all([load, show]); h.page.onHide()
  const before = h.state.considered.length
  const again = h.page.onShow(); await tick()
  assert.equal(h.state.considered.length, before, 'synchronous subscription must not ask using the previous list')
  h.resolve(1, []); await again
  assert.deepEqual(h.state.considered[h.state.considered.length - 1].list, [])
})

test('authorization notification after account change closes the current account question immediately', async () => {
  const h = harness(); const load = h.page.onLoad(); const show = h.page.onShow(); await tick()
  h.resolve(0, [row('a')]); await Promise.all([load, show])
  const before = h.state.hides
  h.state.account = 'fixture-b'; h.state.listeners.forEach(fn => fn())
  assert.equal(h.state.hides, before + 1)
  assert.equal(h.state.considered.length, 1)
})
