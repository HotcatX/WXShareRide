const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { createBackendClient, SESSION_KEY, PENDING_KEY } = require('../utils/backendClient')
const { sha256, sha256Bytes } = require('../utils/hash')
const userId = '00000000-0000-4000-8000-000000000001'
const imageId = '00000000-0000-4000-8000-000000000002'
const otherImageId = '00000000-0000-4000-8000-000000000003'
const openid = 'synthetic-openid-user'
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
function harness(options = {}) {
  let time = Date.parse('2026-09-26T12:00:00Z'), serial = 0
  const storage = { openid, isGuest: false }, calls = [], bridges = [], fileReads = []
  const proof = (patch = {}) => ({ token: 'a'.repeat(43), expiresAt: new Date(time + 3600000).toISOString(),
    user: { id: userId, openid, referralCode: 'ref_0123456789ab' }, ...patch })
  const state = { onRequest: req => reply(req, {}), onBridge: async () => ({ result: { ok: true, data: proof() } }),
    onSave: () => {}, files: new Map([['/tmp/a.png', new Uint8Array([0, 255, 128, 12]).buffer]]) }
  const wx = {
    getStorageSync: key => storage[key] === undefined ? undefined : structuredClone(storage[key]),
    setStorageSync: (key, value) => { state.onSave(key, value); storage[key] = structuredClone(value) },
    removeStorageSync: key => { state.onSave(key); delete storage[key] },
    cloud: { callFunction: data => { bridges.push(data); return state.onBridge(data) } },
    request: req => { calls.push(req); queueMicrotask(() => state.onRequest(req)); return { abort() { req.aborted = true } } },
    getFileSystemManager: () => ({ readFile(req) { fileReads.push(req.filePath); queueMicrotask(() => state.files.has(req.filePath)
      ? req.success({ data: state.files.get(req.filePath) }) : req.fail({ errMsg: 'missing' })) } })
  }
  const make = extra => createBackendClient({ wx, now: () => time, random: () => (++serial % 1000) / 1000,
    config: { mode: 'server' }, ...options, ...extra })
  const client = make()
  return { client, make, wx, storage, state, calls, bridges, fileReads, proof, advance: ms => { time += ms } }
}
function reply(req, data, status = 200) { req.success({ statusCode: status, data: { ok: true, data } }) }
function reject(req, code, status) { req.success({ statusCode: status, data: { ok: false, error: { code, message: code } } }) }
function is(code) { return error => error.code === code }

test('disabled transport cannot write receipts, invoke a login, read files or send requests', async () => {
  const h = harness({ config: { mode: 'cloudbase' } })
  await assert.rejects(h.client.login(), is('BACKEND_DISABLED'))
  await assert.rejects(h.client.get('/api/v1/me'), is('BACKEND_DISABLED'))
  await assert.rejects(h.client.mutate('test', 'PATCH', '/api/v1/me', {}), is('BACKEND_DISABLED'))
  await assert.rejects(h.client.uploadImage('/tmp/a.png', 'test'), is('BACKEND_DISABLED'))
  assert.deepEqual(h.calls, []); assert.deepEqual(h.bridges, []); assert.deepEqual(h.fileReads, [])
  assert.equal(h.storage[PENDING_KEY], undefined)
})

test('public search accepts valid URI punctuation left by encodeURIComponent', async () => {
  const h = harness()
  h.storage.isGuest = true; delete h.storage.openid
  await h.client.get(`/api/v1/market/listings?q=${encodeURIComponent("women's (new) bike!")}`, { public: true })
  assert.equal(h.calls.length, 1)
  assert.equal(h.bridges.length, 0)
})

test('only a validated bridge session becomes a bearer; simultaneous login shares the bridge', async () => {
  const h = harness(), pending = deferred()
  h.state.onBridge = () => pending.promise
  const first = h.client.login(), second = h.client.login()
  await tick(); assert.equal(h.bridges.length, 1)
  pending.resolve({ result: { ok: true, data: { ...h.proof(), platformSecret: 'must-not-persist' } } })
  assert.deepEqual(await first, await second)
  assert.deepEqual(h.bridges[0], { name: 'backend', data: { action: 'login' } })
  assert.equal(h.storage[SESSION_KEY].platformSecret, undefined)
  assert.equal(h.storage.openid, openid)
  await h.client.get('/api/v1/me')
  assert.equal(h.calls[0].header.Authorization, `Bearer ${'a'.repeat(43)}`)
  assert.equal(h.bridges.length, 1)
})

test('canceled login and logout reject late bridge results before persistence', async () => {
  for (const logout of [false, true]) {
    const h = harness(), pending = deferred()
    h.state.onBridge = () => pending.promise
    const login = h.client.login({ isCurrent: () => logout })
    if (logout) await h.client.logout()
    pending.resolve({ result: { ok: true, data: h.proof() } })
    await assert.rejects(login, is('REQUEST_CANCELLED'))
    assert.equal(h.storage[SESSION_KEY], undefined)
  }
})

test('bridge error, malformed and expired sessions are not treated as local OpenID authentication', async () => {
  for (const value of [{ result: { ok: false } }, { result: { ok: true, data: { openid } } },
    { result: { ok: true, data: { token: 'fake' } } }]) {
    const h = harness(); h.state.onBridge = async () => value
    await assert.rejects(h.client.get('/api/v1/me'), is('LOGIN_UNAVAILABLE'))
    assert.equal(h.calls.length, 0); assert.equal(h.storage[SESSION_KEY], undefined)
  }
  const h = harness()
  h.state.onBridge = async () => ({ result: { ok: true, data: h.proof({ user: { ...h.proof().user, openid: 'another-openid-user' } }) } })
  await assert.rejects(h.client.get('/api/v1/me'), is('IDENTITY_CHANGED'))
  assert.equal(h.calls.length, 0); assert.equal(h.storage[SESSION_KEY], undefined)
})

test('lost ACK and process restart retry the same permanent key and canonical payload exactly once', async () => {
  const h = harness(), ledger = new Map()
  let applications = 0, loseAck = true
  h.state.onRequest = req => {
    const key = req.header['Idempotency-Key']
    if (!ledger.has(key)) { applications++; ledger.set(key, { saved: applications }) }
    if (loseAck) { loseAck = false; req.fail({ errMsg: 'lost ACK after commit' }) }
    else reply(req, ledger.get(key))
  }
  await assert.rejects(h.client.mutate('profile.update', 'PATCH', '/api/v1/me', { name: 'A', profile: { bio: 'B' } }), is('NETWORK_ERROR'))
  const pending = h.storage[PENDING_KEY][0]
  const secondClient = h.make()
  assert.deepEqual(await secondClient.mutate('profile.update', 'PATCH', '/api/v1/me', { profile: { bio: 'B' }, name: 'A' }), { saved: 1 })
  assert.equal(applications, 1)
  assert.equal(h.calls[1].header['Idempotency-Key'], pending.key)
  assert.deepEqual(h.calls[0].data, h.calls[1].data)
  assert.equal(h.storage[PENDING_KEY], undefined)
  await secondClient.mutate('profile.update', 'PATCH', '/api/v1/me', { name: 'A', profile: { bio: 'B' } })
  assert.equal(applications, 2, 'a confirmed subsequent identical action is a new intent')
})

test('uncertain writes refuse a changed intent, while rejected transactions release the key', async () => {
  for (const [code, status, kept] of [['INTERNAL_ERROR', 500, true], ['RATE_LIMITED', 429, true],
    ['IDEMPOTENCY_CONFLICT', 409, true], ['INVALID_INPUT', 400, false], ['FORBIDDEN', 403, false]]) {
    const h = harness(); h.state.onRequest = req => reject(req, code, status)
    await assert.rejects(h.client.mutate('profile.update', 'PATCH', '/api/v1/me', { name: 'A' }), is(code))
    assert.equal(Boolean(h.storage[PENDING_KEY]), kept)
    if (kept) {
      await assert.rejects(h.client.mutate('profile.update', 'PATCH', '/api/v1/me', { name: 'B' }), is('PENDING_OPERATION'))
      assert.equal(h.calls.length, 1)
    }
  }
})

test('double taps share an operation; concurrent different input is rejected without a second write', async () => {
  const h = harness(); h.state.onRequest = () => {}
  const first = h.client.mutate('profile.update', 'PATCH', '/api/v1/me', { name: 'A' })
  const second = h.client.mutate('profile.update', 'PATCH', '/api/v1/me', { name: 'A' })
  await tick()
  assert.equal(h.calls.length, 1)
  await assert.rejects(h.client.mutate('profile.update', 'PATCH', '/api/v1/me', { name: 'B' }), is('OPERATION_IN_FLIGHT'))
  reply(h.calls[0], { name: 'A' })
  assert.deepEqual(await first, await second)
})

test('persisted original intent can be recovered explicitly before saving newly edited data', async () => {
  const h = harness(), ledger = new Map()
  h.state.onRequest = req => { ledger.set(req.header['Idempotency-Key'], { name: req.data.name }); req.fail({}) }
  await assert.rejects(h.client.mutate('profile.update', 'PATCH', '/api/v1/me', { name: 'Original' }), is('NETWORK_ERROR'))
  const originalKey = h.calls[0].header['Idempotency-Key'], restarted = h.make()
  await assert.rejects(restarted.mutate('profile.update', 'PATCH', '/api/v1/me', { name: 'New' }), is('PENDING_OPERATION'))
  h.state.onRequest = req => {
    const key = req.header['Idempotency-Key']
    if (!ledger.has(key)) ledger.set(key, { name: req.data.name })
    reply(req, ledger.get(key))
  }
  assert.deepEqual(await restarted.retryPending('profile.update'), { name: 'Original' })
  assert.equal(h.calls[1].header['Idempotency-Key'], originalKey)
  assert.deepEqual(await restarted.mutate('profile.update', 'PATCH', '/api/v1/me', { name: 'New' }), { name: 'New' })
  assert.equal(ledger.size, 2)
  assert.notEqual(h.calls[2].header['Idempotency-Key'], originalKey)
})

test('later 400/401/403/404 do not erase the permanent key of a previously uncertain commit', async () => {
  for (const status of [400, 401, 403, 404]) {
    const h = harness(); h.state.onRequest = req => req.fail({})
    await assert.rejects(h.client.mutate('profile.update', 'PATCH', '/api/v1/me', { name: 'A' }), is('NETWORK_ERROR'))
    const pending = structuredClone(h.storage[PENDING_KEY])
    h.state.onRequest = req => reject(req, 'DENIED', status)
    await assert.rejects(h.make().retryPending('profile.update'), is('DENIED'))
    assert.deepEqual(h.storage[PENDING_KEY], pending)
  }
})

test('storage failure and invalid destinations stop before any write request or poisoned pending receipt', async () => {
  const h = harness()
  h.state.onSave = key => { if (key === PENDING_KEY) throw new Error('quota exceeded') }
  await assert.rejects(h.client.mutate('profile.update', 'PATCH', '/api/v1/me', {}), is('LOCAL_STORAGE_UNAVAILABLE'))
  assert.equal(h.calls.length, 0)
  for (const path of ['https://evil.invalid/api/v1/me', '//evil.invalid/me', '/api/v1/me#x']) {
    await assert.rejects(h.client.mutate('profile.update', 'PATCH', path, {}), is('INVALID_REQUEST'))
  }
  assert.equal(h.storage[PENDING_KEY], undefined)
})

test('operation scopes reject missing values and support the longest valid legacy resource IDs', async () => {
  const h = harness()
  for (const scope of [undefined, null, 12, 'bad scope']) {
    await assert.rejects(h.client.mutate(scope, 'PATCH', '/api/v1/me', {}), is('INVALID_REQUEST'))
    await assert.rejects(h.client.uploadImage('/tmp/a.png', scope), is('INVALID_REQUEST'))
  }
  assert.equal(h.bridges.length, 0); assert.equal(h.fileReads.length, 0)
  const id = 'x'.repeat(160)
  await h.client.mutate(`notifications.read:${id}`, 'POST', `/api/v1/notifications/${id}/read`, {})
  assert.equal(h.calls.length, 1)
})

test('401 refresh reuses the operation key; another failed authentication is bounded', async () => {
  const h = harness()
  h.state.onRequest = req => h.calls.length === 1 ? reject(req, 'UNAUTHORIZED', 401) : reply(req, { saved: true })
  await h.client.mutate('profile.update', 'PATCH', '/api/v1/me', { name: 'A' })
  assert.equal(h.bridges.length, 2)
  assert.equal(h.calls[0].header['Idempotency-Key'], h.calls[1].header['Idempotency-Key'])
  h.state.onRequest = req => reject(req, 'UNAUTHORIZED', 401)
  await assert.rejects(h.client.get('/api/v1/me'), is('UNAUTHORIZED'))
  assert.equal(h.calls.length, 4)
})

test('switching account or logging out suppresses late write ACKs and preserves uncertain receipts', async () => {
  for (const useLogout of [false, true]) {
    const h = harness(); h.state.onRequest = req => req.url.endsWith('/logout') ? reply(req, {}) : undefined
    const write = h.client.mutate('profile.update', 'PATCH', '/api/v1/me', { name: 'A' })
    await tick()
    if (useLogout) await h.client.logout()
    else h.storage.openid = 'different-openid-user'
    reply(h.calls[0], { name: 'A' })
    await assert.rejects(write, is('REQUEST_CANCELLED'))
    assert.equal(h.storage[PENDING_KEY][0].userId, userId)
    if (useLogout) await assert.rejects(h.client.get('/api/v1/me'), is('UNAUTHORIZED'))
  }
})

test('logout remains effective when removing the persisted token fails', async () => {
  const h = harness(); await h.client.login()
  h.state.onSave = key => { if (key === SESSION_KEY) throw new Error('storage failure') }
  await h.client.logout()
  assert.ok(h.storage[SESSION_KEY], 'test retains inaccessible old disk value')
  await assert.rejects(h.client.get('/api/v1/me'), is('UNAUTHORIZED'))
  assert.equal(h.calls.length, 1, 'only the best-effort remote logout is sent')
})

test('image uploads use original binary bytes and retain the same key across lost ACK retries', async () => {
  const h = harness(); let lose = true
  h.state.onRequest = req => lose ? (lose = false, req.fail({})) : reply(req, { fileId: imageId })
  await assert.rejects(h.client.uploadImage('/tmp/a.png', 'profile.avatar'), is('NETWORK_ERROR'))
  await h.make().uploadImage('/tmp/a.png', 'profile.avatar')
  assert.equal(h.calls[0].data, h.state.files.get('/tmp/a.png'))
  assert.equal(h.calls[0].header['content-type'], 'application/octet-stream')
  assert.equal(h.calls[0].header['Idempotency-Key'], h.calls[1].header['Idempotency-Key'])
  h.state.files.set('/tmp/b.png', new Uint8Array([1, 2, 3]).buffer)
  await h.client.uploadImage('/tmp/b.png', 'profile.avatar')
  assert.notEqual(h.calls[0].header['Idempotency-Key'], h.calls[2].header['Idempotency-Key'])
  const before = h.calls.length
  h.state.files.set('/tmp/large.png', new ArrayBuffer(2 * 1024 * 1024 + 1))
  await assert.rejects(h.client.uploadImage('/tmp/large.png', 'profile.avatar'), is('INVALID_IMAGE'))
  await assert.rejects(h.client.uploadImage('/tmp/missing.png', 'profile.avatar'), is('IMAGE_READ_FAILED'))
  assert.equal(h.calls.length, before)
})

test('image URL cache expires early, never serves stale URLs after failure and is account scoped', async () => {
  const h = harness(); let count = 0
  h.state.onRequest = req => reply(req, { items: req.data.fileIds.map(fileId => ({ fileId,
    url: `https://files.invalid/${fileId}?signature=${++count}` })), expiresIn: 300 })
  const first = await h.client.resolveImages([imageId])
  assert.deepEqual(await h.client.resolveImages([imageId]), first)
  assert.equal(h.calls.length, 1)
  h.advance(284000); assert.deepEqual(await h.client.resolveImages([imageId]), first)
  h.advance(1000)
  h.state.onRequest = req => req.fail({})
  await assert.rejects(h.client.resolveImages([imageId]), is('NETWORK_ERROR'))
  await assert.rejects(h.client.resolveImages([imageId]), is('NETWORK_ERROR'))
  assert.equal(h.calls.length, 3)
  h.state.onRequest = req => reply(req, { items: [{ fileId: imageId, url: 'https://files.invalid/new' }], expiresIn: 300 })
  assert.notDeepEqual(await h.client.resolveImages([imageId]), first)
  h.storage.isGuest = true; delete h.storage.openid
  await h.client.resolveImages([imageId], { public: true })
  assert.equal(h.calls.at(-1).header.Authorization, undefined)
  assert.equal(h.calls.length, 5)
  assert.equal(JSON.stringify(h.storage).includes('https://files.invalid'), false)
})

test('partial, duplicate, null and unsafe URL batches cannot poison the image cache', async () => {
  for (const data of [{ items: [], expiresIn: 300 }, { items: [null], expiresIn: 300 },
    { items: [{ fileId: imageId, url: 'http://files.invalid/a' }], expiresIn: 300 },
    { items: [{ fileId: imageId, url: 'https://files.invalid/a' }], expiresIn: 3600 },
    { items: [{ fileId: otherImageId, url: 'https://files.invalid/a' }], expiresIn: 300 }]) {
    const h = harness(); h.state.onRequest = req => reply(req, data)
    await assert.rejects(h.client.resolveImages([imageId]), is('INVALID_RESPONSE'))
  }
})

test('evicting the oldest of 200 cached images does not remove this call\'s already resolved hit', async () => {
  const h = harness(), ids = Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, '0')}`)
  h.state.onRequest = req => reply(req, { items: req.data.fileIds.map(fileId => ({ fileId, url: `https://files.invalid/${fileId}` })), expiresIn: 300 })
  for (let start = 0; start < 200; start += 50) await h.client.resolveImages(ids.slice(start, start + 50))
  const result = await h.client.resolveImages([ids[0], ids[200]])
  assert.deepEqual(result.map(row => row.fileId), [ids[0], ids[200]])
  assert.deepEqual(h.calls.at(-1).data.fileIds, [ids[200]])
  assert.equal(result.every(row => row.url.startsWith('https://files.invalid/')), true)
})

test('request timeout aborts once and retains the operation instead of falling back to CloudBase', async () => {
  const timers = new Map(); let id = 0
  const h = harness({ setTimeout: fn => { timers.set(++id, fn); return id }, clearTimeout: id => timers.delete(id) })
  h.state.onRequest = () => {}
  const mutation = h.client.mutate('profile.update', 'PATCH', '/api/v1/me', {})
  await tick()
  assert.equal(timers.size, 1)
  for (const callback of timers.values()) callback()
  await assert.rejects(mutation, is('NETWORK_ERROR'))
  assert.equal(h.calls[0].aborted, true)
  assert.equal(h.storage[PENDING_KEY].length, 1)
  assert.equal(h.bridges.length, 1)
  assert.equal(h.calls.length, 1)
  reply(h.calls[0], { late: true })
  assert.equal(h.storage[PENDING_KEY].length, 1)
})

test('SHA-256 is byte exact for boundary-sized binary data, typed-array views and Unicode', () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 129, 1024, 65536]) {
    const bytes = Uint8Array.from({ length: size }, (_, i) => i % 256)
    const before = new Uint8Array(bytes)
    assert.equal(sha256Bytes(bytes), createHash('sha256').update(bytes).digest('hex'))
    assert.deepEqual(bytes, before)
    if (size > 2) assert.equal(sha256Bytes(bytes.subarray(1, -1)), createHash('sha256').update(bytes.subarray(1, -1)).digest('hex'))
  }
  for (const text of ['', 'abc', '你好🙂', '\ud800']) assert.equal(sha256(text), createHash('sha256').update(text).digest('hex'))
})

test('malformed successful business receipts retain the exact original operation until verified', async () => {
  const h = harness(), keys = []
  const validate = data => typeof data.rideId === 'string' && data.version === 1
  h.state.onRequest = req => { keys.push(req.header['Idempotency-Key']); reply(req, {}) }
  await assert.rejects(h.client.mutate('rides.create', 'POST', '/api/v1/rides', { synthetic: true }, { validate }), is('INVALID_RESPONSE'))
  assert.equal(h.storage[PENDING_KEY].length, 1)
  h.state.onRequest = req => { keys.push(req.header['Idempotency-Key']); reply(req, { rideId: 'confirmed', version: 1 }) }
  assert.equal((await h.make().retryPending('rides.create', { validate })).rideId, 'confirmed')
  assert.equal(keys[0], keys[1]); assert.equal(h.storage[PENDING_KEY], undefined)
})

test('anonymous previews never authenticate or reuse private image links, including overlapping reads', async () => {
  const h = harness()
  h.state.onRequest = req => reply(req, { items: req.data.fileIds.map(fileId => ({ fileId,
    url: `https://files.invalid/${req.header.Authorization ? 'private' : 'public'}/${fileId}` })), expiresIn: 300 })
  assert.match((await h.client.resolveImages([imageId]))[0].url, /private/)
  assert.match((await h.client.resolveImages([imageId], { anonymous: true }))[0].url, /public/)
  assert.equal(h.bridges.length, 1)
  assert.equal(h.calls[1].header.Authorization, undefined)
  assert.match((await h.client.resolveImages([imageId]))[0].url, /private/)
  h.state.onRequest = () => {}
  h.advance(300000)
  const privateRead = h.client.resolveImages([imageId])
  await tick()
  const privateReq = h.calls.at(-1)
  const publicRead = h.client.resolveImages([otherImageId], { anonymous: true })
  await tick()
  const publicReq = h.calls.at(-1)
  reply(privateReq, { items: [{ fileId: imageId, url: 'https://files.invalid/private-late' }], expiresIn: 300 })
  reply(publicReq, { items: [{ fileId: otherImageId, url: 'https://files.invalid/public-late' }], expiresIn: 300 })
  await Promise.all([privateRead, publicRead])
  h.state.onRequest = req => { assert.equal(req.header.Authorization, undefined); reply(req, { items: [{ fileId: imageId, url: 'https://files.invalid/public-fresh' }], expiresIn: 300 }) }
  assert.match((await h.client.resolveImages([imageId], { anonymous: true }))[0].url, /public-fresh/)
  const fresh = harness()
  fresh.state.onRequest = req => { assert.equal(req.header.Authorization, undefined); reply(req, {}) }
  await fresh.client.get('/api/v1/market/listings', { anonymous: true })
  assert.equal(fresh.bridges.length, 0)
})

test('image-load recovery can refresh an unexpired URL while retaining the same authorization boundary', async()=>{
  const h=harness();let count=0;
  h.state.onRequest=req=>reply(req,{items:[{fileId:imageId,url:`https://files.invalid/${++count}`}],expiresIn:300});
  assert.match((await h.client.resolveImages([imageId],{anonymous:true}))[0].url,/\/1$/);
  assert.match((await h.client.resolveImages([imageId],{anonymous:true}))[0].url,/\/1$/);
  assert.match((await h.client.resolveImages([imageId],{anonymous:true,refresh:true}))[0].url,/\/2$/);
  assert.ok(h.calls.every(req=>!req.header.Authorization));assert.equal(h.bridges.length,0);
});

test('an explicit visitor city request preserves guest state and recovers its original intent after a lost ACK', async () => {
  const h = harness(); h.storage.isGuest = true; delete h.storage.openid
  let applications = 0, loseAck = true
  const receipts = new Map()
  h.state.onRequest = req => {
    assert.equal(req.url, 'https://collect.linkx.ink/api/v1/locations/requests')
    const key = req.header['Idempotency-Key']
    if (!receipts.has(key)) { applications++; receipts.set(key, { requestId: imageId, cityKey: req.data.cityKey, status: 'recorded' }) }
    if (loseAck) { loseAck = false; req.fail({}) } else reply(req, receipts.get(key))
  }
  await assert.rejects(h.client.submitLocationRequest({ cityKey: 'boston', sourcePage: 'home' }), is('NETWORK_ERROR'))
  assert.equal(h.storage.isGuest, true); assert.equal(h.storage.openid, undefined)
  const oldKey = h.calls[0].header['Idempotency-Key']
  const restarted = h.make()
  assert.deepEqual(await restarted.submitLocationRequest({ cityKey: 'atlanta', sourcePage: 'carpoolList' }), {
    requestId: imageId, cityKey: 'boston', status: 'recorded', recovered: true
  })
  assert.equal(h.calls[1].header['Idempotency-Key'], oldKey); assert.equal(applications, 1)
  await assert.rejects(restarted.get('/api/v1/me'), is('UNAUTHORIZED'))
  await assert.rejects(restarted.mutate('profile.update', 'PATCH', '/api/v1/me', {}), is('UNAUTHORIZED'))
  assert.equal(h.storage.isGuest, true); assert.equal(h.storage.openid, undefined)
  await restarted.submitLocationRequest({ cityKey: 'atlanta', sourcePage: 'carpoolList' })
  assert.equal(applications, 2)
})

test('visitor city requests guard identity changes, restrict input, and retain malformed receipts', async () => {
  const h = harness(); h.storage.isGuest = true; delete h.storage.openid
  await assert.rejects(h.client.submitLocationRequest({ cityKey: 'boston', sourcePage: 'home', openid }), is('INVALID_REQUEST'))
  assert.equal(h.bridges.length, 0)
  h.state.onRequest = req => reply(req, { status: 'recorded', cityKey: 'boston' })
  await assert.rejects(h.client.submitLocationRequest({ cityKey: 'boston', sourcePage: 'home' }), is('INVALID_RESPONSE'))
  assert.equal(h.storage[PENDING_KEY].length, 1)
  const waiting = deferred(); h.state.onBridge = () => waiting.promise
  const action = h.client.submitLocationRequest({ cityKey: 'boston', sourcePage: 'home' })
  await tick(); h.storage.isGuest = false; h.storage.openid = openid
  waiting.resolve({ result: { ok: true, data: h.proof() } })
  await assert.rejects(action, is('REQUEST_CANCELLED')); assert.equal(h.calls.length, 1)
})
