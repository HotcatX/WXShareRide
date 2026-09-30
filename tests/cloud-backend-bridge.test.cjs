const test = require('node:test')
const assert = require('node:assert/strict')
const { createBackendHandler } = require('../cloudfunctions/backend/handler')

const appId = 'wx8a8a389199aa2a0e', openid = 'synthetic-bridge-owner'
const actor = { appId, openid, id: '00000000-0000-4000-8000-000000000001' }
const context = { environment: JSON.stringify({ TCB_SOURCE: 'wx_client', WX_APPID: appId, WX_OPENID: openid }) }
const input = (action = 'templates.delete', write = true) => ({ action, body: write ? { id: 'historical-template' } : {},
  expectedOpenid: openid, ...(write ? { key: 'original-operation-key' } : {}), expectedAuthority: 'server' })

test('missing, invalid and retired authority reject metadata and all operations without loading keys or using transport', async () => {
  for (const authority of [undefined, null, '', 'auto', 'cloudbase']) {
    let keys = 0, requests = 0
    const handler = createBackendHandler({ authority, getKey() { keys++; throw Error('must not load') },
      transport() { requests++; throw Error('must not send') } })
    for (const event of [{ action: 'authority' }, { action: 'login' }, input(), input('identity', false),
      { ...input(), expectedAuthority: undefined }, { action: 'templates.delete', body: { id: 'x' }, key: 'original-operation-key', expectedOpenid: openid }]) {
      const result = await handler(event, context)
      assert.equal(result.ok, false); assert.equal(result.error.status, 503)
    }
    assert.equal(keys, 0); assert.equal(requests, 0)
  }
})

test('server compatibility forwards only finite operations and the original key/body with trusted per-invocation identity', async () => {
  const calls = [], key = Buffer.alloc(32, 41)
  const handler = createBackendHandler({ authority: 'server', getKey: () => key, transport: async (body, secret) => {
    assert.equal(secret, key); calls.push(structuredClone(body)); return { ok: true, actor, data: { acknowledged: true } }
  } })
  const reads = ['identity', 'templates.list', 'templates.get', 'notifications.list', 'notifications.unread']
  const writes = ['templates.create', 'templates.update', 'templates.delete', 'notifications.read', 'notifications.readAll',
    'notifications.clear', 'profile.spots.add', 'profile.spots.remove']
  for (const [action, write] of [...reads.map(action => [action, false]), ...writes.map(action => [action, true])]) {
    const event = { ...input(action, write), userInfo: { openId: 'untrusted-client-owner' }, tcbContext: { OPENID: 'untrusted-client-owner' } }
    assert.deepEqual(await handler(event, context), { ok: true, actor, data: { acknowledged: true } })
    assert.deepEqual(calls.at(-1), { purpose: 'compat', appId, openid, source: 'wx_client', action, body: event.body,
      ...(write ? { key: event.key } : {}) })
  }
  assert.equal(calls.length, reads.length + writes.length)
})

test('server bridge rejects caller identity, action, authority and read/write key mismatches before sending', async () => {
  let sent = 0
  const handler = createBackendHandler({ authority: 'server', getKey: () => Buffer.alloc(32, 41), transport: () => { sent++; throw Error('must not send') } })
  const { key, ...withoutKey } = input()
  for (const event of [null, [], {}, { ...input(), expectedOpenid: 'synthetic-other-owner' }, { ...input(), action: 'arbitrary.collection' },
    { ...input(), expectedAuthority: 'cloudbase' }, { ...input(), openid }, { ...input(), url: 'https://attacker.example' },
    { ...input(), body: [] }, withoutKey, { ...input('identity', false), key }]) assert.equal((await handler(event, context)).ok, false)
  assert.equal((await handler(input(), {})).ok, false)
  assert.equal(sent, 0)
})

test('server bridge validates reply actor and preserves known PG errors without retry or alternate database access', async () => {
  for (const reply of [undefined, { ok: true, actor: { ...actor, openid: 'synthetic-other-owner' }, data: {} },
    { ok: true, actor: { ...actor, appId: 'another-app' }, data: {} }, { ok: true, actor: { ...actor, id: 'invalid' }, data: {} },
    { ok: true, actor, data: [] }]) {
    let sent = 0
    const handler = createBackendHandler({ authority: 'server', getKey: () => Buffer.alloc(32, 41), transport: async () => { sent++; return reply } })
    assert.equal((await handler(input(), context)).error.code, 'OPERATION_UNAVAILABLE'); assert.equal(sent, 1)
  }
  for (const code of ['IDEMPOTENCY_CONFLICT', 'OPERATION_PENDING']) {
    let sent = 0
    const status = code === 'IDEMPOTENCY_CONFLICT' ? 409 : 503
    const handler = createBackendHandler({ authority: 'server', getKey: () => Buffer.alloc(32, 41), transport: async () => {
      sent++; return { ok: false, error: { code, status, message: 'private diagnostic' } }
    } })
    const result = await handler(input(), context)
    assert.equal(result.error.code, code); assert.equal(result.error.status, status)
    assert.doesNotMatch(result.error.message, /private diagnostic/); assert.equal(sent, 1)
  }
  let sent = 0
  const handler = createBackendHandler({ authority: 'server', getKey: () => Buffer.alloc(32, 41), transport: async () => { sent++; throw Error('offline') } })
  assert.equal((await handler(input(), context)).error.code, 'OPERATION_UNAVAILABLE'); assert.equal(sent, 1)
})
