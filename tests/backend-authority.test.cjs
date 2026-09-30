const test = require('node:test')
const assert = require('node:assert/strict')
const { createBackendAuthority, SERVER_KEY, APP_ID } = require('../utils/backendAuthority')
const { createBackendClient, PENDING_KEY } = require('../utils/backendClient')
const { createBackendPageGate } = require('../utils/backendPageGate')
const { createBackendHandler } = require('../cloudfunctions/backend/handler')
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const reply = authority => ({ result: { ok: true, data: { appId: APP_ID, authority } } })
const is = code => error => error.code === code
function harness(initial = {}) {
  const storage = structuredClone(initial), calls = [], requests = [], timers = []
  const state = { call: async () => reply('cloudbase'), write: () => {} }
  const wx = {
    getStorageSync: key => structuredClone(storage[key]),
    setStorageSync(key, value) { state.write(key, value); storage[key] = structuredClone(value) },
    removeStorageSync(key) { state.write(key); delete storage[key] },
    cloud: { callFunction(input) { calls.push(input); return state.call(input) } },
    request(input) { requests.push(input) }
  }
  const create = () => createBackendAuthority({ wx, setTimeout(fn) { timers.push(fn); return timers.length }, clearTimeout() {} })
  const authority = create()
  return { wx, storage, calls, requests, state, timers, authority, create }
}

test('authority is public finite deployment metadata and cannot invoke login, database or a supplied override', async () => {
  const handler = createBackendHandler({ authority: 'server', getKey() { throw Error('must not log in') } })
  assert.deepEqual(await handler({ action: 'authority' }, {}), reply('server').result)
  assert.deepEqual(await handler({ action: 'authority', userInfo: { openid: 'untrusted' }, tcbContext: { authority: 'cloudbase' } }, {}), reply('server').result)
  assert.equal((await handler({ action: 'authority', authority: 'server' }, {})).ok, false)
  for (const mode of ['cloudbase', 'auto', null, undefined]) {
    const invalid = createBackendHandler({ authority: mode, getKey() { throw Error('must not log in') } })
    assert.equal((await invalid({ action: 'authority' }, {})).error.code, 'AUTHORITY_NOT_READY')
  }
})

test('unknown source blocks both transports and user mutations are never queued behind readiness', async () => {
  const h = harness({ openid: 'synthetic-openid-user', isGuest: false })
  const client = createBackendClient({ wx: h.wx, authority: h.authority })
  assert.throws(client.isBackendEnabled, is('BACKEND_NOT_READY'))
  await assert.rejects(client.mutate('test', 'POST', '/api/v1/rides', {}), is('BACKEND_NOT_READY'))
  await assert.rejects(client.cloudMutate('test', 'templates.delete', { id: 'x' }), is('BACKEND_NOT_READY'))
  assert.deepEqual(h.calls, []); assert.deepEqual(h.requests, []); assert.equal(h.storage[PENDING_KEY], undefined)
  await h.authority.ready()
  assert.equal(client.isBackendEnabled(), false)
  assert.equal(h.calls.length, 1); assert.deepEqual(h.requests, [])
})

test('first launch and repeated foreground checks share a flight, fail closed and keep a fixed runtime mode', async () => {
  const h = harness(), first = deferred()
  h.state.call = () => first.promise
  const a = h.authority.ready(), b = h.authority.refresh()
  await tick(); assert.equal(h.calls.length, 1)
  first.resolve(reply('cloudbase')); assert.equal(await a, 'cloudbase'); assert.equal(await b, 'cloudbase')
  const second = deferred(); h.state.call = () => second.promise
  const c = h.authority.refresh()
  assert.equal(h.authority.isReady(), false); assert.equal(h.authority.getMode(), 'cloudbase')
  second.reject(Error('offline')); await assert.rejects(c, is('BACKEND_NOT_READY'))
  assert.equal(h.authority.isReady(), false); assert.equal(h.authority.getMode(), 'cloudbase')
  h.state.call = async () => reply('cloudbase')
  assert.equal(await h.authority.refresh(), 'cloudbase')
  assert.equal(h.storage[SERVER_KEY], undefined)
})

test('timed out or malformed handshakes never select CloudBase and late replies cannot overwrite a newer result', async () => {
  const h = harness(), late = deferred()
  h.state.call = () => late.promise
  const first = h.authority.ready(); await tick(); h.timers[0]()
  await assert.rejects(first, is('BACKEND_NOT_READY'))
  h.state.call = async () => ({ result: { ok: true, data: { appId: 'another-app', authority: 'cloudbase' } } })
  await assert.rejects(h.authority.ready(), is('BACKEND_NOT_READY'))
  h.state.call = async () => reply('server'); await h.authority.ready()
  late.resolve(reply('cloudbase')); await tick()
  assert.equal(h.authority.getMode(), 'server')
  const calls = h.calls.length; await h.authority.refresh(); assert.equal(h.calls.length, calls)
})

test('handoff persists only server, never changes a running CloudBase interpretation, and preserves pending across restart', async () => {
  const pending = [{ method: 'CLOUD', key: 'original-key', request: { body: { id: 'original-id' } } }]
  const h = harness({ [PENDING_KEY]: pending, pending_referral: { referralCode: 'ref_original' }, userInfo: { name: 'old' } })
  await h.authority.ready(); h.state.call = async () => reply('server')
  await assert.rejects(h.authority.refresh(), is('BACKEND_RESTART_REQUIRED'))
  assert.deepEqual(h.authority.state(), { mode: 'cloudbase', phase: 'restart_required', ready: false, epoch: 4 })
  assert.equal(h.storage[SERVER_KEY], 'server'); assert.deepEqual(h.storage[PENDING_KEY], pending)
  await assert.rejects(h.authority.ready(), is('BACKEND_RESTART_REQUIRED'))
  h.storage.userInfo = { name: 'late old response' }
  const restarted = h.create(), before = h.calls.length
  assert.equal(await restarted.ready(), 'server'); assert.equal(h.calls.length, before)
  assert.equal(h.storage.userInfo, undefined); assert.deepEqual(h.storage[PENDING_KEY], pending)
  assert.equal(h.storage.pending_referral.referralCode, 'ref_original')
})

test('a failed server marker write cannot resume CloudBase or lose confirmed handoff intent', async () => {
  const h = harness(); await h.authority.ready()
  h.state.call = async () => reply('server'); h.state.write = () => { throw Error('disk full') }
  await assert.rejects(h.authority.refresh(), is('LOCAL_STORAGE_UNAVAILABLE'))
  assert.throws(h.authority.getMode, is('BACKEND_RESTART_REQUIRED'))
  h.state.write = () => {}; h.state.call = async () => reply('cloudbase')
  const count = h.calls.length
  await assert.rejects(h.authority.ready(), is('BACKEND_RESTART_REQUIRED'))
  assert.equal(h.calls.length, count); assert.equal(h.storage[SERVER_KEY], 'server')
})

test('foreground revalidation preserves old same-source SDK ACKs but blocks new requests', async () => {
  const h = harness({ openid: 'synthetic-openid-user', isGuest: false }); await h.authority.ready()
  const client = createBackendClient({ wx: h.wx, authority: h.authority }), old = deferred()
  h.state.call = input => input.data.action === 'authority' ? Promise.resolve(reply('cloudbase')) : old.promise
  const read = client.cloudRead('identity')
  const checking = deferred(); h.state.call = () => checking.promise
  const refreshed = h.authority.refresh()
  await assert.rejects(client.cloudRead('identity'), is('BACKEND_NOT_READY'))
  old.resolve({ result: { ok: true, actor: { appId: APP_ID, openid: 'synthetic-openid-user', id: '00000000-0000-4000-8000-000000000001' }, data: {} } })
  assert.deepEqual(await read, {})
  checking.resolve(reply('cloudbase')); await refreshed
})

function pageHarness(authority) {
  const calls = [], errors = [], gate = createBackendPageGate({ authority, unavailable: error => errors.push(error) })
  const page = gate.wrapPage({ data: {}, setData(patch) { Object.assign(this.data, patch) },
    onLoad(options) { calls.push(['load', options]); this.setData({ loaded: true }) },
    onShow() { calls.push(['show']) }, onReady() { calls.push(['ready']) },
    onHide() { calls.push(['hide']); this.cleanup() }, onUnload() { calls.push(['unload']); this.cleanup() },
    cleanup() { calls.push(['cleanup']) }, submit() { calls.push(['write']) },
    onShareAppMessage() { return { title: 'original', path: '/pages/home/home?id=1' } } })
  return { page, calls, errors }
}

test('page lifecycle waits in order while clicks and synchronous sharing never become deferred writes', async () => {
  const h = harness(), response = deferred(); h.state.call = () => response.promise
  const { page, calls } = pageHarness(h.authority)
  page.onLoad({ id: 'x' }); page.onShow(); page.onReady(); page.submit()
  assert.deepEqual(calls, [])
  assert.deepEqual(page.onShareAppMessage(), { title: '志远共享', path: '/pages/home/home' })
  response.resolve(reply('cloudbase')); await tick()
  assert.deepEqual(calls, [['load', { id: 'x' }], ['show'], ['ready']])
  assert.equal(page.data.loaded, true)
  assert.deepEqual(page.onShareAppMessage(), { title: 'original', path: '/pages/home/home?id=1' })
  page.submit(); assert.deepEqual(calls.at(-1), ['write'])
  const checking = deferred(); h.state.call = () => checking.promise
  const refresh = h.authority.refresh(); page.onHide(); page.setData({ acknowledged: true }); page.submit({ type: 'tap', currentTarget: {} })
  assert.deepEqual(calls.slice(-2), [['hide'], ['cleanup']]); assert.equal(page.data.acknowledged, true)
  checking.resolve(reply('cloudbase')); await refresh
})

test('a hidden or unloaded page never starts from a late handshake and failed handoff cannot mutate the old page', async () => {
  const h = harness(), pending = deferred(); h.state.call = () => pending.promise
  const hidden = pageHarness(h.authority), unloaded = pageHarness(h.authority)
  for (const item of [hidden, unloaded]) { item.page.onLoad({}); item.page.onShow() }
  hidden.page.onHide(); unloaded.page.onUnload()
  pending.resolve(reply('cloudbase')); await tick()
  assert.deepEqual(hidden.calls, []); assert.deepEqual(unloaded.calls, [])
  hidden.page.onShow(); assert.equal(hidden.calls[0][0], 'load')
  h.state.call = async () => reply('server')
  await assert.rejects(h.authority.refresh(), is('BACKEND_RESTART_REQUIRED'))
  hidden.page.submit(); hidden.page.setData({ stale: true })
  assert.equal(hidden.calls.some(call => call[0] === 'write'), false)
  assert.equal(hidden.page.data.stale, undefined)
})
