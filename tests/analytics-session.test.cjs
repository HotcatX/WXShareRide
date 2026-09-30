const test = require('node:test')
const assert = require('node:assert/strict')
const { createAnalyticsSession, PENDING_KEY } = require('../utils/analyticsSession')
const { createBackendClient, SESSION_KEY } = require('../utils/backendClient')
const { STORAGE_KEY } = require('../utils/analyticsClient')
const { COHORT_KEY } = require('../utils/rolloutCohort')
const { sha256 } = require('../utils/hash')
const defaults = require('../config/analytics')
const tick = () => new Promise(resolve => setImmediate(resolve))
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const T = 1800700000000
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function reply(status, key = 'participant_00000001', version = status === 'none' ? 0 : 1, clock = T) {
  const out = { ok: true, status, statusVersion: version, purposeVersion: defaults.purposeVersion, noticeVersion: defaults.noticeVersion }
  if (status !== 'none') out.participantKey = key
  if (status === 'active') out.session = { participantKey: key, grantId: 'authorization_000001', statusVersion: version,
    status: 'active', confirmed: true, purposeVersion: defaults.purposeVersion, acceptedPurposeVersion: defaults.purposeVersion,
    token: 'opaque-test-token', tokenExpiresAtMs: clock + 60000 }
  return out
}
function harness(options = {}) {
  const store = options.store || { openid: 'account-a', [COHORT_KEY]: { version: 1, bucket: 100 } }
  const state = { now: T, calls: [], cloud: [], batches: [], env: 'release', timers: new Map(), next: 0,
    remote: options.remote || reply('none'), fail: false, httpStatus: 200 }
  const wx = {
    getStorageSync: key => copy(store[key]),
    setStorageSync: (key, value) => { store[key] = copy(value) },
    removeStorageSync: key => { delete store[key] },
    getAccountInfoSync: () => ({ miniProgram: { envVersion: state.env } }),
    cloud: { callFunction: async args => { state.cloud.push(copy(args)); throw new Error('No fresh statistics cloud transport') } }
  }
  const backend = { collectionSession: async data => {
    state.calls.push(copy(data))
    if (options.call) return options.call(data, state)
    if (state.fail) throw Object.assign(new Error('offline'), { code: 'NETWORK_ERROR', status: 0 })
    if (data.action === 'activate') state.remote = reply('active', undefined, 1, state.now)
    if (data.action === 'withdraw') state.remote = reply('revoked', state.remote.participantKey, state.remote.statusVersion + 1)
    if (data.action === 'status' && state.remote.session) state.remote.session.tokenExpiresAtMs = state.now + 60000
    return copy(state.remote)
  } }
  const manager = createAnalyticsSession({ wx, backend, now: () => state.now, random: () => 0.123,
    config: { rolloutPercent: { develop: 0, trial: 0, release: 5 }, ...options.config },
    setTimeout(fn, delay) { const id = ++state.next; state.timers.set(id, { fn, at: state.now + delay }); return id },
    clearTimeout: id => state.timers.delete(id),
    transport: async request => {
      state.batches.push(request)
      if (options.transport) return options.transport(request, state)
      const body = JSON.parse(request.body)
      return { statusCode: state.httpStatus, data: { ok: true, batchId: body.batchId, payloadHash: sha256(request.body), eventCount: body.events.length } }
    }
  })
  const advance = async ms => {
    state.now += ms
    let runs = 0
    while (true) {
      const due = [...state.timers.entries()].find(([, value]) => value.at <= state.now)
      if (!due) break
      assert.ok(++runs <= 12, 'timer must never spin at zero delay')
      state.timers.delete(due[0]); due[1].fn(); await tick()
    }
  }
  const start = async () => { const ready = manager.beginForeground(); manager.pageShown('pages/home/home'); await ready; await tick() }
  return { manager, backend, state, store, wx, advance, start }
}

test('first in-cohort visit activates once then immediately uploads the current page; no popups or extra identity calls', async () => {
  const h = harness(); await h.start()
  assert.deepEqual(h.state.calls.map(x => x.action), ['status', 'activate'])
  assert.equal(h.manager.getState().participating, true)
  assert.equal(h.manager.getState().queuedCount, 1)
  await h.advance(0)
  assert.equal(h.state.batches.length, 1)
  assert.equal(h.manager.getState().queuedCount, 0)
  assert.deepEqual(JSON.parse(h.state.batches[0].body).events.map(e => [e.eventName, e.data.page]), [['page_view', 'home']])
  await h.manager.refreshStatus(); h.manager.pageShown('pages/home/tripDetail/tripDetail')
  assert.equal(h.state.calls.length, 2)
  assert.equal(JSON.stringify(h.state.calls).includes('account-a'), false)
  assert.equal(JSON.stringify(h.store[STORAGE_KEY]).includes('opaque-test-token'), false)
  assert.deepEqual(h.state.cloud, [])
})

test('unready authority rejects a collection session before either transport starts', async () => {
  const h = harness()
  h.wx.request = () => assert.fail('unready authority cannot send HTTP')
  const backend = createBackendClient({ wx: h.wx, authority: {
    getMode() { throw Object.assign(new Error('not ready'), { code: 'BACKEND_NOT_READY' }) },
    isReady: () => false, subscribe() {}
  } })
  Object.assign(h.backend, backend)
  await assert.rejects(backend.collectionSession({ action: 'status' }), { code: 'BACKEND_NOT_READY' })
  await h.start()
  assert.equal(h.manager.getState().error, 'status_unavailable')
  assert.equal(h.manager.getState().participating, false)
  assert.deepEqual(h.state.cloud, []); assert.deepEqual(h.state.batches, [])
})

test('non-server authority cannot use the retired statistics call for a fresh session', async () => {
  for (const mode of ['cloudbase', 'invalid']) {
    const h = harness()
    h.wx.request = () => assert.fail('non-server authority cannot send HTTP')
    const backend = createBackendClient({ wx: h.wx, authority: {
      getMode: () => mode, isReady: () => true, subscribe() {}
    } })
    Object.assign(h.backend, backend)
    await assert.rejects(backend.collectionSession({ action: 'status' }), { code: 'BACKEND_DISABLED' })
    await h.start()
    assert.equal(h.manager.getState().error, 'status_unavailable')
    assert.equal(h.manager.getState().participating, false)
    assert.deepEqual(h.state.cloud, []); assert.deepEqual(h.state.batches, [])
  }
})

test('canonical session network failure never falls back to statistics or issues another grant', async () => {
  const h = harness(), requests = []
  h.store.openid = 'synthetic-analytics-account-a'
  h.store[SESSION_KEY] = { token: 'a'.repeat(43), expiresAt: new Date(T + 3600000).toISOString(),
    user: { id: '00000000-0000-4000-8000-000000000001', openid: h.store.openid, referralCode: 'ref_0123456789ab' } }
  h.wx.request = input => { requests.push(copy({ url: input.url, data: input.data })); input.fail() }
  Object.assign(h.backend, createBackendClient({ wx: h.wx, now: () => h.state.now,
    authority: { getMode: () => 'server', isReady: () => true, subscribe() {} } }))
  await h.start()
  assert.equal(h.manager.getState().error, 'status_unavailable')
  assert.equal(h.manager.getState().participating, false)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://collect.linkx.ink/api/v1/analytics/session')
  assert.equal(requests[0].data.action, 'status')
  assert.deepEqual(h.state.cloud, []); assert.deepEqual(h.state.batches, [])
  assert.equal(h.store[PENDING_KEY], undefined)
})

test('revoked, outside cohort, preview and unknown environment never activate or collect', async () => {
  const revoked = harness({ remote: reply('revoked') }); await revoked.start(); await revoked.advance(60000)
  assert.deepEqual(revoked.state.calls.map(x => x.action), ['status'])
  assert.equal(revoked.state.batches.length, 0)
  for (const env of ['develop', 'trial', 'unknown']) {
    const h = harness(); h.state.env = env; await h.start(); await h.advance(60000)
    assert.equal(h.state.calls.length, 0); assert.equal(h.state.batches.length, 0)
  }
  for (const bucket of [500, 9999, null, -1, '100']) {
    const h = harness(); h.store[COHORT_KEY].bucket = bucket; await h.start()
    assert.equal(h.state.calls.length, 0)
  }
})

test('none activation failure refreshes status once without an activation loop', async () => {
  const h = harness({ call: async data => data.action === 'activate'
    ? Promise.reject(Object.assign(new Error('conflict'), { status: 409 })) : reply('none') })
  await h.start(); await tick(); await h.advance(60000)
  assert.deepEqual(h.state.calls.map(x => x.action), ['status', 'activate', 'status'])
  assert.equal(h.state.timers.size, 0); assert.equal(h.state.batches.length, 0)
  await h.manager.refreshStatus({ force: true }); await tick()
  assert.equal(h.state.calls.filter(x => x.action === 'activate').length, 1)
})

test('active status without a usable session stops collection while keeping withdrawal available', async () => {
  const active = reply('active'); delete active.session
  const h = harness({ remote: active }); await h.start()
  assert.equal(h.manager.getState().status, 'active'); assert.equal(h.manager.getState().participating, false)
  assert.equal(h.manager.getState().canWithdraw, true)
  assert.equal((await h.manager.withdraw()).ok, true)
  assert.equal(h.manager.getState().status, 'revoked')
})

test('foreground status is singleflight and market/profile pages produce no study events', async () => {
  const held = deferred()
  const h = harness({ call: () => held.promise })
  const a = h.manager.beginForeground(), b = h.manager.refreshStatus()
  h.manager.pageShown('pages/market/market'); await tick()
  assert.equal(a, b); assert.equal(h.state.calls.length, 1)
  held.resolve(reply('active')); await a; await tick()
  assert.equal(h.manager.getState().queuedCount, 0)
  h.manager.pageShown('pages/profile/profile'); await h.advance(60000)
  assert.equal(h.state.batches.length, 0)
})

test('401 respects token-refresh cooldown rather than spinning; idle expiry does not refresh authorization', async () => {
  const h = harness({ remote: reply('active') }); await h.start()
  h.state.httpStatus = 401; await h.advance(0)
  assert.equal(h.state.batches.length, 1)
  const before = h.state.calls.length
  await h.advance(15000)
  assert.equal(h.state.calls.length, before)
  assert.equal([...h.state.timers.values()][0].at, T + 30000)
  h.state.httpStatus = 200; await h.advance(15000)
  assert.equal(h.state.calls.length, before + 1); assert.equal(h.state.batches.length, 2)
  await h.advance(120000)
  assert.equal(h.state.calls.length, before + 1, 'idle expiration has no timer/network')
  h.manager.pageShown('pages/home/requestDetail/requestDetail'); await h.advance(2000)
  assert.equal(h.state.calls.length, before + 2)
})

test('later events batch at idle with a 15-second upload floor; failures retain byte-identical payload and back off', async () => {
  const h = harness({ remote: reply('active') }); await h.start(); await h.advance(0)
  h.manager.pageShown('pages/home/carpoolList/carpoolList')
  const searchId = h.manager.recordSearch({ tripType: 'all', serviceDate: '2026-09-24' })
  h.manager.recordResults({ searchId, source: 'network', renderedCount: 0, loadedDateCount: 1, hasMore: false })
  await h.advance(2000); assert.equal(h.state.batches.length, 1)
  h.state.httpStatus = 503; await h.advance(13000)
  assert.equal(h.state.batches.length, 2)
  const pending = h.state.batches[1].body
  const events = JSON.parse(pending).events
  assert.deepEqual(events.map(e => e.eventName), ['page_view', 'search_submitted', 'result_set_rendered'])
  assert.equal(events[2].data.candidatesComplete, false); assert.equal('candidates' in events[2].data, false)
  await h.advance(15000); assert.equal(h.state.batches.length, 2)
  h.state.httpStatus = 200; await h.advance(20000)
  assert.equal(h.state.batches[2].body, pending); assert.equal(h.manager.getState().queuedCount, 0)
})

test('withdrawal immediately purges queue, retries the same persisted operation, and waits for server confirmation', async () => {
  const h = harness({ remote: reply('active') }); await h.start()
  h.state.fail = true
  const response = await h.manager.withdraw()
  assert.equal(response.ok, false); assert.equal(h.manager.getState().participating, false)
  assert.equal(h.manager.getState().pendingWithdrawal, true); assert.equal(h.store[STORAGE_KEY], undefined)
  assert.equal(h.state.timers.size, 0)
  const first = h.state.calls.find(x => x.action === 'withdraw')
  assert.equal(JSON.stringify(h.store[PENDING_KEY]).includes('account-a'), false)
  const restarted = harness({ store: h.store, remote: reply('active') }); await restarted.start(); await tick()
  const second = restarted.state.calls.find(x => x.action === 'withdraw')
  assert.deepEqual(second, first); assert.equal(restarted.manager.getState().status, 'revoked')
  assert.equal(restarted.store[PENDING_KEY], undefined); assert.equal(restarted.state.batches.length, 0)
})

test('renamed session honors a pre-upgrade pending withdrawal and its original request ID', async () => {
  const pending = { participantKey: 'participant_00000001', requestId: 'legacy_withdraw_00001',
    expectedStatusVersion: 1, purposeVersion: 'ride-research-v1',
    noticeVersion: 'ride-research-notice-2026-09-23', conflict: false }
  const h = harness({ remote: reply('active'), store: { openid: 'account-a',
    [COHORT_KEY]: { version: 1, bucket: 100 }, rideResearchPendingWithdrawV1: [pending] } })
  await h.start(); await tick()
  const request = h.state.calls.find(value => value.action === 'withdraw')
  assert.ok(request)
  const { participantKey, conflict, ...expected } = pending
  assert.deepEqual(request, { action: 'withdraw', ...expected })
  assert.equal(h.manager.getState().status, 'revoked')
  assert.equal(h.state.batches.length, 0)
  assert.equal(h.store.rideResearchPendingWithdrawV1, undefined)
})

test('pending withdrawal follows participant ownership, including outside cohort; never revokes a different signed-in account', async () => {
  const first = harness({ remote: reply('active') }); await first.start(); first.state.fail = true; await first.manager.withdraw()
  const other = harness({ store: first.store, remote: reply('active', 'participant_00000002') })
  other.store.openid = 'account-b'; await other.start()
  assert.equal(other.state.calls.some(x => x.action === 'withdraw'), false)
  other.store[COHORT_KEY].bucket = 9999
  const owner = harness({ store: other.store, remote: reply('active') }); owner.store.openid = 'account-a'
  await owner.start(); await tick()
  assert.equal(owner.state.calls.filter(x => x.action === 'withdraw').length, 1)
  assert.equal(owner.state.batches.length, 0)
})

test('account switch discards a late grant and clears old queued data', async () => {
  const held = deferred()
  const h = harness({ call: data => data.action === 'status' ? held.promise : Promise.resolve(reply('active')) })
  const starting = h.manager.beginForeground(); h.manager.pageShown('pages/home/home'); await tick()
  h.store.isGuest = true; h.store.openid = ''; h.manager.identityChanged()
  held.resolve(reply('active')); await starting; await tick()
  assert.equal(h.manager.getState().loggedIn, false); assert.equal(h.state.batches.length, 0)
  assert.equal(h.state.calls.some(x => x.action === 'activate'), false)
})

test('withdraw conflict stays locally stopped and requires a new explicit operation after status refresh', async () => {
  const h = harness({ call: async data => data.action === 'withdraw'
    ? Promise.reject(Object.assign(new Error('conflict'), { status: 409 })) : reply('active') })
  await h.start(); await h.manager.withdraw(); await tick()
  assert.equal(h.manager.getState().withdrawalConflict, true)
  assert.equal(h.manager.getState().participating, false)
  const count = h.state.calls.length
  await h.advance(120000); assert.equal(h.state.calls.length, count)
  assert.equal(h.state.batches.length, 0)
})

test('background clears timers and the next foreground restores queue with one status request', async () => {
  const h = harness({ remote: reply('active') }); await h.start(); await h.advance(0)
  h.manager.pageShown('pages/home/tripDetail/tripDetail')
  h.manager.endForeground(); await tick()
  assert.equal(h.state.timers.size, 0)
  await h.advance(20000)
  assert.equal(h.state.batches.length, 1)
  await h.manager.beginForeground(); h.manager.pageShown('pages/home/home'); await h.advance(0)
  assert.equal(h.state.calls.length, 2)
  assert.equal(h.state.batches.length, 2)
  assert.equal(h.manager.getState().queuedCount, 0)
})

test('environment becomes unavailable before a scheduled upload: no transport and queue is cleared', async () => {
  const h = harness({ remote: reply('active') }); await h.start()
  h.wx.getAccountInfoSync = () => { throw new Error('unavailable') }
  await h.advance(0)
  assert.equal(h.state.batches.length, 0)
  assert.equal(h.state.timers.size, 0)
  assert.equal(h.manager.getState().participating, false)
  assert.equal(h.store[STORAGE_KEY], undefined)
})

test('a late activation rechecks the current login identity even without a page/login hook', async () => {
  const held = deferred()
  const h = harness({ call: async data => data.action === 'activate' ? held.promise : reply('none') })
  await h.start(); h.store.openid = 'account-b'
  held.resolve(reply('active')); await tick(); await h.advance(0)
  assert.equal(h.manager.getState().participating, false)
  assert.equal(h.state.batches.length, 0)
})

test('100 percent includes every installation without requiring a cohort bucket', async () => {
  for (const bucket of [9999, null, 'invalid']) {
    const h = harness({ config: { rolloutPercent: defaults.rolloutPercent } })
    h.store[COHORT_KEY] = bucket
    await h.start(); await h.advance(0)
    assert.equal(h.manager.getState().participating, true)
    assert.equal(h.state.batches.length, 1)
    assert.equal(h.state.calls.some(data => Object.hasOwn(data, 'collectionMode')), false)
  }
})

test('development and trial use test-only grants and upload the current page through the same client', async () => {
  for (const env of ['develop', 'trial']) {
    const h = harness({ config: { rolloutPercent: defaults.rolloutPercent }, call: async data => ({
      ...reply(data.action === 'status' ? 'none' : 'active'), synthetic: true
    }) })
    h.state.env = env
    await h.start(); await h.advance(0)
    assert.deepEqual(h.state.calls.map(data => [data.action, data.collectionMode]), [['status', 'test'], ['activate', 'test']])
    assert.equal(h.manager.getState().participating, true)
    assert.equal(h.state.batches.length, 1)
    assert.equal(h.manager.getState().queuedCount, 0)
  }
})

test('test and release reject a grant from the other dataset', async () => {
  for (const env of ['develop', 'trial', 'release']) {
    const h = harness({ config: { rolloutPercent: defaults.rolloutPercent }, call: async () => ({
      ...reply('active'), synthetic: env === 'release'
    }) })
    h.state.env = env
    await h.start(); await h.advance(0)
    assert.equal(h.manager.getState().participating, false)
    assert.equal(h.state.batches.length, 0)
    assert.equal(h.manager.getState().error, 'status_unavailable')
  }
})

test('changing build mode while authorization is in flight discards the old grant and queued events', async () => {
  const held = deferred()
  const h = harness({ config: { rolloutPercent: defaults.rolloutPercent }, call: data => data.collectionMode === 'test'
    ? held.promise : Promise.resolve(reply('revoked')) })
  h.state.env = 'trial'
  const starting = h.manager.beginForeground(); h.manager.pageShown('pages/home/home'); await tick()
  h.state.env = 'release'; await h.manager.identityChanged()
  held.resolve({ ...reply('active'), synthetic: true }); await starting; await tick(); await h.advance(0)
  assert.equal(h.manager.getState().status, 'revoked')
  assert.equal(h.manager.getState().participating, false)
  assert.equal(h.state.batches.length, 0)
  assert.equal(h.store[STORAGE_KEY], undefined)
})

test('place request 401 invalidates manager token age and refreshes after bounded cooldown', async () => {
  const h = harness({ remote: reply('active'), transport: async request => ({ statusCode: 401, data: { ok: false, error: 'INVALID_TOKEN' } }) })
  await h.start()
  const payload = { schemaVersion: 1, cityKey: 'ny_nj', field: 'departure', mode: 'driver' }
  assert.equal(await h.manager.requestPlaceSuggestions(payload), null)
  const initial = h.state.calls.length
  assert.equal(await h.manager.requestPlaceSuggestions(payload), null)
  assert.equal(h.state.calls.length, initial)
  h.state.now += 30001
  assert.equal(await h.manager.requestPlaceSuggestions(payload), null)
  assert.equal(h.state.calls.length, initial + 1)
  assert.equal(h.state.calls.at(-1).action, 'status')
})


test('event metadata observes the current real foreground without creating a background session',async()=>{
  const h=harness()
  assert.equal(h.manager.getEventMetadata(),null);assert.equal(h.state.calls.length,0)
  await h.start();const metadata=h.manager.getEventMetadata()
  assert.ok(metadata.sessionId);assert.equal(metadata.context.buildMode,'release')
  assert.equal(h.store[STORAGE_KEY].events[0].sessionId,metadata.sessionId)
  h.manager.endForeground();assert.equal(h.manager.getEventMetadata(),null)
  await tick();h.state.now+=1000;await h.start()
  assert.notEqual(h.manager.getEventMetadata().sessionId,metadata.sessionId)
})

test('followup query refreshes the existing session and rejects a late response after switching accounts', async () => {
  const h = harness({ transport: async request => ({ statusCode: 200, data: request.url.endsWith('/v1/followups/query') ? { ok: true, outcomes: [] } : {} }) })
  await h.start()
  const payload = { schemaVersion: 1, trips: [{ tripKey: 'trip-1', tripType: 'carpool', role: 'passenger' }] }
  assert.deepEqual(await h.manager.requestFollowupOutcomes(payload), { ok: true, outcomes: [] })
  h.state.now += 61000
  const before = h.state.calls.length
  assert.deepEqual(await h.manager.requestFollowupOutcomes(payload), { ok: true, outcomes: [] })
  assert.equal(h.state.calls.length, before + 1)
  const response = deferred()
  const late = harness({ transport: async () => response.promise }); await late.start()
  const pending = late.manager.requestFollowupOutcomes(payload)
  late.store.openid = 'account-b'; late.manager.identityChanged()
  response.resolve({ statusCode: 200, data: { ok: true, outcomes: [] } })
  assert.equal(await pending, null)
})

test('followup queue snapshot hook runs after session readiness and before the read transport', async () => {
  let captured = false, count = 0
  const h = harness({ transport: async request => {
    if (request.url.endsWith('/v1/followups/query')) {
      assert.equal(captured, true); count++
      return { statusCode: 200, data: { ok: true, outcomes: [] } }
    }
    return { statusCode: 200, data: {} }
  } })
  await h.start()
  await h.manager.requestFollowupOutcomes({ schemaVersion: 1, trips: [{ tripKey: 'trip-1', tripType: 'carpool', role: 'passenger' }] }, () => {
    assert.ok(h.manager.getCollectionScope()); captured = true
  })
  assert.equal(count, 1)
})
