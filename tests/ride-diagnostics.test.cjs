const test = require('node:test')
const assert = require('node:assert/strict')
const { createRideDiagnostics } = require('../utils/rideDiagnostics')

const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function setup(callFunction = () => Promise.resolve({ result: { success: true } })) {
  const state = { clock: 1000, scope: 'real:account-a:grant-1', events: [] }
  const analytics = { getCollectionScope: () => state.scope,
    recordEvent: (name, data) => { state.events.push({ name, data }); return { ok: true } } }
  const wx = { cloud: { callFunction } }
  const diagnostics = createRideDiagnostics({ now: () => state.clock })
  assert.equal(diagnostics.install(wx, analytics), true)
  diagnostics.beginForeground()
  return { state, analytics, wx, diagnostics }
}

test('preserves the original Promise, receiver, options and fulfilled response', async () => {
  const held = deferred(); let receiver, received
  const h = setup(function (options) { receiver = this; received = options; return held.promise })
  const input = { name: 'getTripDetail', data: { type: 'carpool', id: 'trip_123' } }
  const customThis = { sentinel: true }
  const returned = h.wx.cloud.callFunction.call(customThis, input)
  assert.equal(returned, held.promise); assert.equal(receiver, customThis); assert.equal(received, input)
  h.state.clock = 1137
  const response = { requestID: 'cloud_request_000001', result: { success: true, privateData: 'not collected' } }
  held.resolve(response); assert.equal(await returned, response); await tick()
  assert.deepEqual(h.state.events, [{ name: 'service_request', data: {
    operation: 'getTripDetail', tripKey: 'trip_123', tripType: 'carpool', outcome: 'success', code: 'OK',
    cloudRequestId: 'cloud_request_000001', durationMs: 137 } }])
})

test('callback receiver, arguments, return value and one observation survive callback plus Promise', async () => {
  const held = deferred(); let received
  const response = { result: { ok: true } }; const callbackThis = { receiver: true }
  const h = setup(function (options) { received = options; return held.promise })
  const data = { type: 'request', requestId: 'request_business_01' }
  let successArgs, completeCount = 0
  const options = Object.freeze({ name: 'joinTrip', data,
    success: function () { assert.equal(this, callbackThis); successArgs = [...arguments]; return 37 },
    complete() { completeCount += 1 } })
  assert.equal(h.wx.cloud.callFunction(options), held.promise)
  assert.equal(received.data, data); assert.notEqual(received, options)
  assert.equal(received.success.call(callbackThis, response, 'extra'), 37)
  received.complete(response); held.resolve(response); await tick()
  assert.deepEqual(successArgs, [response, 'extra']); assert.equal(completeCount, 1)
  assert.equal(h.state.events.length, 1)
  assert.equal(h.state.events[0].data.tripKey, 'request_business_01')
})

test('never adds callbacks or changes a callback-only return; complete-only results are observable', () => {
  let seen; const task = { cancel() {} }
  const h = setup(options => { seen = options; return task })
  const complete = function () { return 'unchanged' }
  const returned = h.wx.cloud.callFunction({ name: 'getTripList', complete })
  assert.equal(returned, task); assert.equal('success' in seen, false); assert.equal('fail' in seen, false)
  assert.equal(seen.complete({ errMsg: 'cloud.callFunction:ok' }), 'unchanged')
  assert.equal(h.state.events.length, 1)
})

test('preserves the exact rejection and synchronous exception without reporting free text', async () => {
  const rejection = Object.assign(new Error('private phone +1 2015550100'), { code: 'TIMEOUT', requestID: 'cloud_request_000002' })
  const rejected = Promise.reject(rejection)
  const h = setup(() => rejected)
  const returned = h.wx.cloud.callFunction({ name: 'getTripList' })
  assert.equal(returned, rejected); await assert.rejects(returned, error => error === rejection); await tick()
  assert.equal(h.state.events[0].data.code, 'TIMEOUT')
  assert.equal(h.state.events[0].data.outcome, 'network_error')
  const thrown = new TypeError('private token'); const sync = setup(() => { throw thrown })
  assert.throws(() => sync.wx.cloud.callFunction({ name: 'createTrip' }), error => error === thrown)
  assert.equal(sync.state.events[0].data.code, 'SYNC_THROW')
  assert.equal(JSON.stringify([h.state.events, sync.state.events]).includes('private'), false)
})

test('user callback exceptions still propagate and do not emit a second failure', () => {
  const thrown = new Error('caller exception')
  const h = setup(options => options.success({ result: { success: true } }))
  assert.throws(() => h.wx.cloud.callFunction({ name: 'getTripList', success() { throw thrown } }), error => error === thrown)
  assert.equal(h.state.events.length, 1); assert.equal(h.state.events[0].data.outcome, 'success')
})

test('records business failures with safe codes and never serializes arbitrary data', async () => {
  const privateData = { type: 'request', requestId: 'business_request_id', action: 'quitTrip' }
  Object.defineProperty(privateData, 'phone', { get() { throw new Error('must never read phone') }, enumerable: true })
  const result = { ok: false, error: 'private error with phone', errorMsg: 'private message' }
  Object.defineProperty(result, 'userInfo', { get() { throw new Error('must never read response body') } })
  const h = setup(() => Promise.resolve({ result, requestID: 'unsafe@account.example' }))
  await h.wx.cloud.callFunction({ name: 'tripManage', data: privateData }); await tick()
  assert.deepEqual(h.state.events[0].data, { operation: 'tripManage.quitTrip', tripKey: 'business_request_id',
    tripType: 'request', outcome: 'business_error', code: 'BUSINESS_REJECTED', durationMs: 0 })
})

test('operation and routing fields have closed allowlists; statistics and unrelated calls are untouched', async () => {
  const received = []
  const h = setup(options => { received.push(options); return Promise.resolve({ result: { success: true } }) })
  for (const name of ['statistics', 'unrelatedFunction', 'login', 'getUserInfo', 'getUserInfoByOpenids']) {
    const input = { name, get data() { throw new Error('excluded payload must not be read') } }
    await h.wx.cloud.callFunction(input)
    assert.equal(received.at(-1), input)
  }
  await h.wx.cloud.callFunction({ name: 'tripManage', data: { type: 'private role', tripId: 'private@email', action: 'deleteEverything' } })
  await h.wx.cloud.callFunction({ name: 'getTripDetail', data: { type: 'carpool', id: 'bad/id?secret=yes' } })
  await tick()
  assert.deepEqual(h.state.events.map(event => event.data.operation), ['tripManage', 'getTripDetail'])
  assert.ok(h.state.events.every(event => !('tripKey' in event.data) && !('tripType' in event.data)))
})

test('drops old results after identity/mode/grant scope changes, background or a new foreground', async () => {
  for (const change of ['scope', 'hide', 'newForeground']) {
    const held = deferred(); const h = setup(() => held.promise)
    h.wx.cloud.callFunction({ name: 'getTripList' })
    if (change === 'scope') h.state.scope = 'test:account-b:grant-2'
    else { h.diagnostics.endForeground(); if (change === 'newForeground') h.diagnostics.beginForeground() }
    held.resolve({ result: { success: true } }); await tick()
    assert.equal(h.state.events.length, 0)
  }
  const h = setup(); h.state.scope = ''
  await h.wx.cloud.callFunction({ name: 'getTripList' }); await tick()
  assert.equal(h.state.events.length, 0)
})

test('recording errors, context errors and unusual response getters cannot fail business calls', async () => {
  const response = { get result() { throw new Error('getter') } }
  const promise = Promise.resolve(response); const h = setup(() => promise)
  assert.equal(h.wx.cloud.callFunction({ name: 'getTripList' }), promise); assert.equal(await promise, response)
  h.analytics.recordEvent = () => { throw new Error('queue failed') }
  const good = setup(); good.analytics.recordEvent = h.analytics.recordEvent
  await good.wx.cloud.callFunction({ name: 'getTripList' }); await tick()
  good.analytics.getCollectionScope = () => { throw new Error('scope failed') }
  await good.wx.cloud.callFunction({ name: 'getTripList' }); await tick()
  assert.equal(good.state.events.length, 0)
})

test('100-success and separate 20-error budgets reset only on a new foreground; duplicate errors are suppressed', async () => {
  let failed = false
  const h = setup(() => Promise.resolve({ result: failed ? { success: false } : { success: true } }))
  for (let i = 0; i < 110; i += 1) await h.wx.cloud.callFunction({ name: 'getTripList' })
  h.diagnostics.beginForeground()
  await h.wx.cloud.callFunction({ name: 'getTripList' })
  assert.equal(h.state.events.length, 100)
  failed = true
  for (let i = 0; i < 25; i += 1) {
    const data = { type: 'carpool', id: 'trip_' + i }
    await h.wx.cloud.callFunction({ name: 'getTripDetail', data })
    await h.wx.cloud.callFunction({ name: 'getTripDetail', data })
  }
  await tick()
  assert.equal(h.state.events.length, 120)
  assert.deepEqual(h.diagnostics.getStatus(), { foreground: true, successes: 100, errors: 20, maxSuccesses: 100, maxErrors: 20 })
  h.diagnostics.endForeground(); h.diagnostics.beginForeground()
  await h.wx.cloud.callFunction({ name: 'getTripDetail', data: { type: 'carpool', id: 'trip_0' } }); await tick()
  assert.equal(h.state.events.length, 121)
})

test('runtime fingerprints contain only error type and code positions, and ignore changing private messages', () => {
  const h = setup()
  const first = { name: 'TypeError', message: 'phone +1 2015550100', stack: 'TypeError: private phone\n    at handler (https://private.example/user/alice/pages/home/home.js:123:8)\n    at app.js:20:3' }
  const second = { name: 'TypeError', message: 'another user', stack: 'TypeError: another secret\n    at handler (https://different.example/user/bob/pages/home/home.js:123:8)\n    at app.js:20:3' }
  assert.equal(h.diagnostics.captureError('runtime', first), true)
  assert.equal(h.diagnostics.captureError('runtime', second), false)
  assert.equal(h.state.events.length, 1)
  const data = h.state.events[0].data
  assert.deepEqual(Object.keys(data).sort(), ['code', 'errorKind', 'fingerprint'])
  assert.equal(data.code, 'TYPE_ERROR'); assert.match(data.fingerprint, /^[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(data).includes('phone'), false)
  assert.equal(JSON.stringify(data).includes('alice'), false)
  assert.equal(h.diagnostics.captureError('unhandled_rejection', { reason: new RangeError('secret'), promise: {} }), true)
  assert.equal(h.state.events[1].data.code, 'RANGE_ERROR')
  assert.equal(h.diagnostics.captureError('unknown', first), false)
  h.diagnostics.endForeground(); assert.equal(h.diagnostics.captureError('runtime', 'Error: secret'), false)
})

test('App onError strings are normalized, hostile errors ignored, and repeated installs do not double-wrap', async () => {
  const h = setup(); const wrapper = h.wx.cloud.callFunction
  assert.equal(h.diagnostics.install(h.wx, h.analytics), true); assert.equal(h.wx.cloud.callFunction, wrapper)
  assert.equal(h.diagnostics.captureError('runtime', 'ReferenceError: private\n    at app.js:30:4'), true)
  assert.equal(h.state.events[0].data.code, 'REFERENCE_ERROR')
  assert.equal(h.diagnostics.captureError('runtime', { get name() { throw new Error('hostile') } }), false)
  await h.wx.cloud.callFunction({ name: 'getPublicStats' }); await tick()
  assert.equal(h.state.events.length, 2)
  const locked = { cloud: Object.freeze({ callFunction() {} }) }
  assert.equal(createRideDiagnostics().install(locked, h.analytics), false)
})

test('duration is finite, nonnegative and bounded even if the device clock changes', async () => {
  for (const changed of [0, Infinity, 999999999]) {
    const held = deferred(); const h = setup(() => held.promise)
    h.wx.cloud.callFunction({ name: 'getTripList' }); h.state.clock = changed
    held.resolve({ result: { success: true } }); await tick()
    assert.equal(h.state.events[0].data.durationMs, changed === 999999999 ? 300000 : 0)
  }
})
