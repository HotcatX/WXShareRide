const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../utils/tripDetailCache.js'), 'utf8')
const success = label => ({ ok: true, data: { _id: 'trip', label }, driverInfo: { phone: label } })
const flush = () => new Promise(resolve => setImmediate(resolve))

function harness() {
  const storage = { openid: 'alice', isGuest: false }
  const calls = []
  const wx = {
    getStorageSync: key => structuredClone(storage[key]),
    setStorageSync(key, value) { storage[key] = structuredClone(value) },
    cloud: { callFunction(input) {
      return new Promise((resolve, reject) => calls.push({ input, resolve: result => resolve({ result }), reject }))
    } }
  }
  const context = { module: { exports: {} }, wx }
  vm.runInNewContext(source, context)
  return { api: context.module.exports, storage, calls }
}

test('concurrent ordinary reads of the same normalized viewer/type/id share one request and cache', async () => {
  const h = harness()
  const first = h.api.fetchTripDetail('carpool', ' trip ')
  const second = h.api.fetchTripDetail('CARPOOL', 'trip')
  await flush()
  assert.equal(h.calls.length, 1)
  h.calls[0].resolve(success('current'))
  assert.equal((await first).data.label, 'current')
  assert.equal((await second).data.label, 'current')
  assert.equal((await h.api.fetchTripDetail('carpool', 'trip')).data.label, 'current')
  assert.equal(h.calls.length, 1)
})

test('route type and id have separate in-flight requests', async () => {
  const h = harness()
  const results = [h.api.fetchTripDetail('carpool', 'one'), h.api.fetchTripDetail('request', 'one'), h.api.fetchTripDetail('carpool', 'two')]
  await flush()
  assert.equal(h.calls.length, 3)
  h.calls.forEach((call, i) => call.resolve(success(String(i))))
  assert.deepEqual((await Promise.all(results)).map(result => result.data.label), ['0', '1', '2'])
})

test('switching accounts never shares a request or stores/returns the old account contact data', async () => {
  const h = harness()
  const alice = h.api.fetchTripDetail('carpool', 'trip')
  await flush()
  h.storage.openid = 'bob'
  const bob = h.api.fetchTripDetail('carpool', 'trip')
  await flush()
  assert.equal(h.calls.length, 2)
  h.calls[0].resolve(success('alice-private'))
  const discarded = await alice
  assert.equal(discarded.identityChanged, true)
  assert.equal(discarded.data, undefined)
  assert.equal(h.api.readTripDetailCache('carpool', 'trip'), null)
  h.calls[1].resolve(success('bob-private'))
  assert.equal((await bob).data.label, 'bob-private')
  h.storage.openid = 'alice'
  assert.equal(h.api.readTripDetailCache('carpool', 'trip'), null)
  h.storage.openid = 'bob'
  h.storage.isGuest = true
  assert.equal(h.api.readTripDetailCache('carpool', 'trip'), null)
})

test('forced reads bypass cached/in-flight data, with latest request winning cache regardless of completion order', async () => {
  const h = harness()
  h.api.writeTripDetailCache('carpool', 'trip', success('cached'))
  const beforeMutation = h.api.fetchTripDetail('carpool', 'trip', { force: true })
  const afterMutation = h.api.fetchTripDetail('carpool', 'trip', { force: true })
  await flush()
  assert.equal(h.calls.length, 2)
  h.calls[1].resolve(success('after-join'))
  assert.equal((await afterMutation).data.label, 'after-join')
  h.calls[0].resolve(success('before-join'))
  await beforeMutation
  assert.equal(h.api.readTripDetailCache('carpool', 'trip').data.label, 'after-join')
})

test('forced refresh supersedes an older ordinary request, and ordinary reads can join the new request', async () => {
  const h = harness()
  const old = h.api.fetchTripDetail('request', 'trip')
  const fresh = h.api.fetchTripDetail('request', 'trip', { force: true })
  const joined = h.api.fetchTripDetail('request', 'trip')
  await flush()
  assert.equal(h.calls.length, 2)
  h.calls[0].resolve(success('old'))
  await old
  assert.equal(h.api.readTripDetailCache('request', 'trip'), null)
  h.calls[1].resolve(success('fresh'))
  assert.equal((await fresh).data.label, 'fresh')
  assert.equal((await joined).data.label, 'fresh')
})

test('failed requests release deduplication and fresh access denials remove stale cached details', async () => {
  const h = harness()
  const failed = h.api.fetchTripDetail('carpool', 'trip')
  const sameFailure = h.api.fetchTripDetail('carpool', 'trip')
  const observed = Promise.allSettled([failed, sameFailure])
  await flush()
  h.calls[0].reject(new Error('offline'))
  assert.ok((await observed).every(result => result.status === 'rejected'))
  const retry = h.api.fetchTripDetail('carpool', 'trip')
  await flush()
  assert.equal(h.calls.length, 2)
  h.calls[1].resolve(success('private'))
  await retry
  for (const denial of [{ ok: false, blocked: true }, { ok: false, notFound: true }]) {
    h.api.writeTripDetailCache('carpool', 'trip', success('private'))
    const refresh = h.api.fetchTripDetail('carpool', 'trip', { force: true })
    await flush()
    h.calls.at(-1).resolve(denial)
    await refresh
    assert.equal(h.api.readTripDetailCache('carpool', 'trip'), null)
  }
})

test('invalidating a request after accepting it prevents an older unassigned read from repopulating its cache', async () => {
  const h = harness()
  const beforeAccept = h.api.fetchTripDetail('request', 'trip')
  await flush()
  h.api.removeTripDetailCache('request', 'trip')
  h.calls[0].resolve({ ok: true, data: { _id: 'trip', driverOpenid: '' } })
  await beforeAccept
  assert.equal(h.api.readTripDetailCache('request', 'trip', { allowStale: true }), null)
  const afterAccept = h.api.fetchTripDetail('request', 'trip')
  await flush()
  assert.equal(h.calls.length, 2)
  h.calls[1].resolve({ ok: true, data: { _id: 'trip', driverOpenid: 'alice' } })
  assert.equal((await afterAccept).data.driverOpenid, 'alice')
  assert.equal(h.api.readTripDetailCache('request', 'trip').data.driverOpenid, 'alice')
})
