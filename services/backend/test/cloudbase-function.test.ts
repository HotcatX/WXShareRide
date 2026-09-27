import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createTestDatabase } from './helpers/database.ts';
import { createCloudBaseLoginBridge } from '../src/auth/cloudbase.ts';

const require = createRequire(import.meta.url);
const { APPID, getIdentity } = require('../../../cloudfunctions/backend/context.js');
const { createHandler, send, projectReply, PATH, ENDPOINT } = require('../../../cloudfunctions/backend/bridge.js');
const key = Buffer.alloc(32, 71), openid = 'synthetic-openid-cloudbase';
const context = (id = openid, source = 'wx_client') => ({ environment: JSON.stringify({ TCB_SOURCE: source, WX_APPID: APPID, WX_OPENID: id }) });
const session = (id = openid) => ({ ok: true, data: { token: 't'.repeat(43), expiresAt: new Date(Date.now() + 3600000).toISOString(),
  user: { id: randomUUID(), openid: id, referralCode: 'ref_0123456789ab' } } });
const unavailable = { ok: false, error: { code: 'LOGIN_UNAVAILABLE', message: '登录服务暂不可用，请重试' } };

test('CloudBase identity requires this invocation and rejects forged, cross-app, relay and trigger contexts', () => {
  assert.deepEqual(getIdentity(context()), { appId: APPID, openid, source: 'wx_client' });
  assert.deepEqual(getIdentity(context(openid, 'wx_devtools')), { appId: APPID, openid, source: 'wx_devtools' });
  assert.deepEqual(getIdentity({ environ: `TCB_SOURCE=wx_client;WX_APPID=${APPID};WX_OPENID=${openid};UNRELATED=x` }),
    { appId: APPID, openid, source: 'wx_client' });
  const fields = { TCB_SOURCE: 'wx_client', WX_APPID: APPID, WX_OPENID: openid };
  for (const ctx of [undefined, {}, [], { environment: '{' }, { environment: '[]' }, { environment: '{}', environ: `TCB_SOURCE=wx_client;WX_APPID=${APPID};WX_OPENID=${openid}` },
    { environment: JSON.stringify({ ...fields, WX_APPID: 'wx0000000000000000' }) },
    { environment: JSON.stringify({ ...fields, WX_FROM_APPID: APPID }) }, { environment: JSON.stringify({ ...fields, WX_FROM_OPENID: openid }) },
    { environment: JSON.stringify({ ...fields, WX_OPENID: '' }) }, { environment: JSON.stringify({ ...fields, TCB_SOURCE: 'wx_trigger' }) },
    { environment: JSON.stringify({ ...fields, TCB_SOURCE: 'wx_cloudfunction' }) },
    { environ: `TCB_SOURCE=wx_client;WX_APPID=${APPID};WX_OPENID=${openid};WX_OPENID=another-synthetic-id` },
    { environment: ' '.repeat(16385) }, Object.create(context())]) assert.equal(getIdentity(ctx), null);
});

test('CloudBase handler accepts login only and ignores platform metadata without trusting caller OpenID or globals', async () => {
  const seen: unknown[] = [];
  const handler = createHandler({ getKey: () => key, transport: async (body: { openid: string }) => { seen.push(body); return session(body.openid); } });
  const original = process.env.WX_OPENID;
  try {
    process.env.WX_OPENID = 'synthetic-global-stale';
    const result = await handler({ action: 'login', userInfo: { openId: 'synthetic-forged' }, tcbContext: { OPENID: 'synthetic-forged' } }, context());
    assert.equal(result.ok, true); assert.equal(result.data.user.openid, openid);
    assert.deepEqual(await handler({ action: 'login' }, {}), unavailable);
  } finally { if (original === undefined) delete process.env.WX_OPENID; else process.env.WX_OPENID = original; }
  assert.ok(seen.every(value => (value as { openid: string }).openid === openid));
  const before = seen.length;
  for (const event of [{}, { action: 'updateUser' }, { action: 'login', openid: 'synthetic-forged' }, { action: 'login', appId: APPID },
    { action: 'login', payload: {} }, [], null]) assert.deepEqual(await handler(event, context()), unavailable);
  assert.deepEqual(await handler({ action: 'login', userInfo: { openId: openid } }, {}), unavailable);
  assert.equal(seen.length, before);
  const first = 'synthetic-concurrent-user-one', second = 'synthetic-concurrent-user-two';
  const values = await Promise.all([handler({ action: 'login' }, context(first)), handler({ action: 'login' }, context(second))]);
  assert.deepEqual(values.map(value => value.data.user.openid), [first, second]);
});

test('CloudBase response projection cannot return another account, leaked profile or collector JWT', () => {
  const valid = session();
  assert.deepEqual(projectReply({ ...valid, requestId: 'ignored-envelope-metadata' }, { openid }), valid);
  for (const value of [{ ...valid, data: { ...valid.data, token: 'synthetic.collector.jwt' } },
    { ...valid, data: { ...valid.data, user: { ...valid.data.user, openid: 'synthetic-other-user' } } },
    { ...valid, data: { ...valid.data, profile: { phone: 'synthetic-secret' } } },
    { ...valid, data: { ...valid.data, expiresAt: new Date(Date.now() - 1).toISOString() } },
    { ...valid, data: { ...valid.data, user: { ...valid.data.user, referralCode: 'invalid' } } }]) {
    assert.throws(() => projectReply(value, { openid }), /LOGIN_UNAVAILABLE/);
  }
});

type Outgoing = { method: string; headers: Record<string, string | number> };
type MockResponse = { status?: number; headers?: Record<string, string>; body: string | Buffer };
function requestStub(handler: (url: string, options: Outgoing, raw: string) => Promise<MockResponse> | MockResponse) {
  return (url: string, options: Outgoing, callback: (response: PassThrough) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: (raw: string) => void; destroy: () => void };
    req.destroy = () => {};
    req.end = raw => { queueMicrotask(() => {
      void Promise.resolve().then(() => handler(url, options, raw)).then(result => {
        const response = Object.assign(new PassThrough(), { statusCode: result.status ?? 200, headers: result.headers ?? {} });
        callback(response); if (!response.destroyed) response.end(result.body);
      }, error => { req.emit('error', error); });
    }); };
    return req;
  };
}

test('CloudBase sender uses fixed route and independent signed purpose, fresh nonce, bounded response, no redirect/retry', async () => {
  const identity = { purpose: 'login', appId: APPID, openid, source: 'wx_client' };
  const nonces = new Set<string>();
  const request = requestStub((url, options, raw) => {
    assert.equal(url, ENDPOINT); assert.equal(new URL(url).pathname, '/internal/v1/auth/cloudbase'); assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Length'], Buffer.byteLength(raw)); assert.deepEqual(JSON.parse(raw), identity);
    const at = String(options.headers['X-Linkx-Auth-Timestamp']), nonce = String(options.headers['X-Linkx-Auth-Nonce']);
    assert.match(nonce, /^[a-f0-9]{32}$/); assert.equal(nonces.has(nonce), false); nonces.add(nonce);
    assert.equal(options.headers['X-Linkx-Auth-Signature'], createHmac('sha256', key)
      .update(['linkx-auth-bridge-v1', 'POST', '/internal/v1/auth/cloudbase', APPID, at, nonce, raw].join('\n')).digest('hex'));
    return { body: JSON.stringify(session()) };
  });
  await send(identity, key, { request }); await send(identity, key, { request }); assert.equal(nonces.size, 2);
  for (const response of [{ status: 302, headers: { location: 'https://attacker.example' }, body: '' },
    { status: 503, body: 'synthetic-private-diagnostic' }, { headers: { 'content-length': '8193' }, body: '' },
    { headers: { 'content-length': '1' }, body: '{}' }, { headers: { 'content-length': '10' }, body: '{}' },
    { headers: { 'content-encoding': 'gzip' }, body: '{}' }, { body: 'x'.repeat(8193) }, { body: 'not-json' }, { body: Buffer.from([0xff]) }] as MockResponse[]) {
    let calls = 0;
    await assert.rejects(send(identity, key, { request: requestStub(() => { calls++; return response; }) }), /LOGIN_UNAVAILABLE/);
    assert.equal(calls, 1);
  }
});

test('CloudBase signer and actual PostgreSQL verifier interoperate without creating a parallel identity', { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const backend = createCloudBaseLoginBridge({ pool: db.pool, appId: APPID, key, sessionTtlSeconds: 3600, isActive: () => true });
  const request = requestStub(async (url, options, raw) => {
    const data = await backend.login({ method: options.method, path: new URL(url).pathname,
      rawHeaders: Object.entries(options.headers).flatMap(([name, value]) => [name, String(value)]), body: Buffer.from(raw) });
    return { body: JSON.stringify({ ok: true, data }) };
  });
  const handler = createHandler({ getKey: () => key, transport: (body: unknown, secret: Buffer) => send(body, secret, { request }) });
  const result = await handler({ action: 'login' }, context());
  assert.equal(PATH, '/internal/v1/auth/cloudbase'); assert.equal(result.ok, true); assert.equal(result.data.user.openid, openid);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 1);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM auth_bridge_nonces')).rows[0].n, 1);
});

test('CloudBase sender deadline covers stalled headers and a stalled body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const identity = { purpose: 'login', appId: APPID, openid, source: 'wx_client' };
  for (const withHeaders of [false, true]) {
    let destroyed = 0;
    const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
    const request = (_url: string, _options: Outgoing, callback: (value: PassThrough) => void) => {
      const req = Object.assign(new EventEmitter(), {
        end() { if (withHeaders) callback(response); },
        destroy() { destroyed++; response.destroy(); }
      });
      return req;
    };
    const pending = send(identity, key, { request });
    t.mock.timers.tick(5000);
    await assert.rejects(pending, /LOGIN_UNAVAILABLE/);
    assert.equal(destroyed, 1);
  }
});
