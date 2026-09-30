import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Pool } from 'pg';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createApp } from '../src/app.ts';
import { compatBridgePath, compatQueryKey } from '../src/compat/bridge.ts';
import type { FileStorage } from '../src/files/routes.ts';
import { createTestDatabase } from './helpers/database.ts';

const require = createRequire(import.meta.url);
const { createQueryHandler, send, ENDPOINT } = require('../../../cloudfunctions/compat/query-bridge.js');
const { getIdentity } = require('../../../cloudfunctions/backend/context.js');
const appId = 'wx8a8a389199aa2a0e', openid = 'synthetic-query-owner', root = Buffer.alloc(32, 72);
const config = { databaseUrl: '', host: '127.0.0.1', port: 3100, appId,
  businessMode: 'active' as const, sessionTtlSeconds: 3600, authBridgeKey: root };
const pg = { skip: !process.env.BACKEND_TEST_DATABASE_URL };
const context = (id = openid) => ({ environment: JSON.stringify({ TCB_SOURCE: 'wx_client', WX_APPID: appId, WX_OPENID: id }) });

function signed(action = 'profile.get', input: Record<string, unknown> = {}, options: {
  leaf?: Buffer; identity?: string; extra?: Record<string, unknown>; at?: number; domain?: string
} = {}) {
  const raw = JSON.stringify({ purpose: 'compat-read', appId, openid: options.identity ?? openid,
    source: 'wx_client', action, body: input, ...options.extra });
  const at = String(options.at ?? Date.now()), nonce = randomBytes(16).toString('hex');
  const leaf = options.leaf ?? compatQueryKey(root, 'profile.get');
  const signature = createHmac('sha256', leaf).update(`${options.domain ?? 'linkx-compat-read-v1'}\nPOST\n${compatBridgePath}\n${appId}\n${at}\n${nonce}\n${raw}`).digest('hex');
  return { method: 'POST' as const, url: compatBridgePath, payload: raw,
    headers: { 'content-type': 'application/json', 'x-linkx-compat-timestamp': at,
      'x-linkx-compat-nonce': nonce, 'x-linkx-compat-signature': signature } };
}
async function seed(pool: Awaited<ReturnType<typeof createTestDatabase>>['pool']) {
  const id = randomUUID();
  await pool.query('INSERT INTO users(id,app_id,openid,name,profile) VALUES($1,$2,$3,$4,$5)',
    [id, appId, openid, '当前资料', { phone: 'current-private-phone', wechatId: 'current-private-wechat' }]);
  return id;
}

test('action-bound legacy query key cannot sign another action, mutation or session request', pg, async t => {
  const db = await createTestDatabase(); t.after(db.close); const id = await seed(db.pool);
  const app = await createApp({ pool: db.pool, config }); t.after(() => app.close());
  const valid = signed(), reply = await app.inject(valid);
  assert.equal(reply.statusCode, 200); assert.equal(reply.json().actor.id, id);
  assert.equal(reply.json().data.data[0].phone, 'current-private-phone');
  assert.equal((await app.inject(valid)).json().error.code, 'COMPAT_BRIDGE_REPLAY');
  const wrongLeaf = createHmac('sha256', root).update('linkx-compat-read-key-v1\nrides.home').digest();
  for (const request of [signed('identity'), signed('templates.create', {}, { extra: { key: 'forged-write-key' } }),
    signed('profile.get', {}, { leaf: wrongLeaf }), signed('profile.get', {}, { extra: { purpose: 'compat' } }),
    signed('profile.get', {}, { extra: { source: 'wx_cloudfunction' } }),
    signed('profile.get', {}, { extra: { appId: 'wx0000000000000000' } }),
    signed('profile.get', {}, { extra: { key: 'read-with-write-key' } }),
    signed('profile.get', {}, { domain: 'linkx-login-bridge-v1' }),
    signed('profile.get', {}, { at: Date.now() - 120000 })]) {
    const denied = await app.inject(request);
    assert.equal(denied.statusCode, 401); assert.equal(denied.json().error.code, 'COMPAT_BRIDGE_UNAUTHORIZED');
    assert.doesNotMatch(denied.body, /current-private-phone|current-private-wechat/);
  }
  assert.equal((await app.inject({ ...signed(), url: `${compatBridgePath}?admin=true` })).statusCode, 401);
  assert.equal((await app.inject({ ...signed(), url: '/internal/v1/auth/cloudbase' })).statusCode, 401);
  assert.equal((await app.inject(signed('profile.get', { openid: 'synthetic-forged-id' }))).statusCode, 400);
  assert.equal((await app.inject(signed('profile.get', {}, { identity: 'synthetic-no-query-user' }))).statusCode, 404);
  const bom = signed();
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(bom.payload)]);
  bom.headers['x-linkx-compat-signature'] = createHmac('sha256', compatQueryKey(root, 'profile.get'))
    .update(`linkx-compat-read-v1\nPOST\n${compatBridgePath}\n${appId}\n${bom.headers['x-linkx-compat-timestamp']}\n${bom.headers['x-linkx-compat-nonce']}\n`)
    .update(withBom).digest('hex');
  assert.equal((await app.inject({ ...bom, payload: withBom })).statusCode, 401);
  assert.equal((await db.pool.query('SELECT * FROM users')).rowCount, 1);
  for (const table of ['sessions', 'idempotency_requests', 'ride_templates', 'rides']) {
    assert.equal((await db.pool.query(`SELECT * FROM ${table}`)).rowCount, 0);
  }
  assert.equal((await db.pool.query('SELECT * FROM auth_bridge_nonces')).rowCount, 1);
});

test('real trusted Cloud query adapter returns only the original inner projection and current PG data', pg, async t => {
  const db = await createTestDatabase(); t.after(db.close); const id = await seed(db.pool);
  const app = await createApp({ pool: db.pool, config }); t.after(() => app.close());
  let requests = 0;
  const request = (url: string, options: any, callback: (response: any) => void) => {
    assert.equal(url, ENDPOINT); const req = new EventEmitter() as any; req.destroy = () => {};
    req.end = (raw: Buffer) => { void (async () => {
      requests++;
      const reply = await app.inject({ method: options.method, url: new URL(url).pathname, headers: options.headers, payload: raw });
      const res = Object.assign(new PassThrough(), { statusCode: reply.statusCode, headers: reply.headers, complete: true });
      callback(res); if (!res.destroyed) res.end(reply.rawPayload);
    })().catch(error => req.emit('error', error)); }; return req;
  };
  const handler = createQueryHandler({ action: 'profile.get', fields: [], getIdentity,
    getKey: () => compatQueryKey(root, 'profile.get'), transport: (body: unknown, leaf: Buffer) => send(body, leaf, { request }) });
  const event = Object.defineProperties({}, { userInfo: { enumerable: true, get: () => assert.fail('platform metadata must not be read') },
    tcbContext: { enumerable: true, get: () => assert.fail('platform metadata must not be read') } });
  const first = await handler(event, context());
  assert.equal(first.data[0]._id, id); assert.equal(first.data[0]._openid, openid);
  assert.equal(first.data[0].name, '当前资料'); assert.equal(first.actor, undefined); assert.equal(first.token, undefined);
  await db.pool.query('UPDATE users SET name=$2 WHERE id=$1', [id, '已更新资料']);
  assert.equal((await handler({}, context())).data[0].name, '已更新资料');
  const count = requests;
  for (const input of [{ openid }, { action: 'templates.create' }, { key: 'injected-key' }, { url: 'https://example.invalid/' }, null, []]) {
    assert.equal((await handler(input, context())).ok, false);
  }
  assert.equal((await handler({ userInfo: { openId: openid } }, {})).ok, false);
  assert.equal((await handler({}, { environment: JSON.stringify({ TCB_SOURCE: 'wx_cloudfunction', WX_APPID: appId, WX_OPENID: openid }) })).ok, false);
  assert.equal(requests, count);
  const mismatched = createQueryHandler({ action: 'profile.get', fields: [], getIdentity,
    getKey: () => Buffer.alloc(32), transport: async () => ({ ok: true, actor: { appId, openid: 'synthetic-other-account', id }, data: first }) });
  assert.equal((await mismatched({}, context())).ok, false);
});

test('profile bridge avatar signing uses current file ACL and returns no private partial data on signing failure', pg, async t => {
  const db = await createTestDatabase(); t.after(db.close); const id = await seed(db.pool);
  const fileId = (await db.pool.query(`INSERT INTO files(app_id,provider,locator,legacy_readonly,status)
    VALUES($1,'cloudbase','cloud://synthetic-private-avatar',true,'ready') RETURNING id`, [appId])).rows[0].id;
  await db.pool.query(`INSERT INTO file_references(app_id,resource_kind,resource_id,slot,file_id)
    VALUES($1,'user',$2,'avatar',$3)`, [appId, id, fileId]);
  const calls: unknown[][] = []; let failed = false;
  const storage = { readUrl: async (file: unknown, ttl: number) => {
    calls.push([file, ttl]); if (failed) throw Error('private-provider-secret');
    return 'https://images.example.invalid/avatar?expires=short';
  } } as FileStorage;
  const app = await createApp({ pool: db.pool, config, storage }); t.after(() => app.close());
  const reply = await app.inject(signed()); assert.equal(reply.statusCode, 200);
  assert.equal(reply.json().data.data[0].avatarUrl, 'https://images.example.invalid/avatar?expires=short');
  assert.deepEqual(calls, [[{ id: fileId, provider: 'cloudbase', locator: 'cloud://synthetic-private-avatar' }, 300]]);
  assert.doesNotMatch(reply.body, /synthetic-private-avatar|private-provider/);
  failed = true; const rejected = await app.inject(signed());
  assert.equal(rejected.statusCode, 503); assert.equal(rejected.json().error.code, 'FILE_STORAGE_UNAVAILABLE');
  assert.doesNotMatch(rejected.body, /private-phone|private-wechat|private-provider/);
  assert.equal((await db.pool.query('SELECT * FROM auth_bridge_nonces')).rowCount, 1);
  const staged = await createApp({ pool: db.pool, config: { ...config, businessMode: 'staged' }, storage }); t.after(() => staged.close());
  assert.equal((await staged.inject(signed())).statusCode, 503); assert.equal(calls.length, 2);
});

test('eight avatar-bearing queries finish with a one-connection pool and never nest file transactions', pg, async t => {
  const db = await createTestDatabase(); t.after(db.close); const id = await seed(db.pool);
  const fileId = (await db.pool.query(`INSERT INTO files(app_id,provider,locator,legacy_readonly,status)
    VALUES($1,'cloudbase','cloud://synthetic-concurrent-avatar',true,'ready') RETURNING id`, [appId])).rows[0].id;
  await db.pool.query(`INSERT INTO file_references(app_id,resource_kind,resource_id,slot,file_id)
    VALUES($1,'user',$2,'avatar',$3)`, [appId, id, fileId]);
  const pool = new Pool({ ...db.pool.options, max: 1, connectionTimeoutMillis: 750 });
  t.after(() => pool.end());
  let signings = 0;
  const storage = { readUrl: async (_file: unknown, _ttl: number) => { signings++; await new Promise(resolve => setTimeout(resolve, 5));
    return 'https://images.example.invalid/concurrent-avatar'; } } as FileStorage;
  const app = await createApp({ pool, config, storage }); t.after(() => app.close());
  const replies = await Promise.all(Array.from({ length: 8 }, () => app.inject(signed())));
  assert.ok(replies.every(reply => reply.statusCode === 200)); assert.equal(signings, 8);
  assert.equal(pool.totalCount, 1); assert.equal(pool.waitingCount, 0);
  assert.equal((await db.pool.query('SELECT * FROM auth_bridge_nonces')).rowCount, 8);
  assert.equal((await db.pool.query('SELECT * FROM sessions')).rowCount, 0);
});

test('an oversized legacy history fails explicitly before committing its nonce or returning a partial list', pg, async t => {
  const db = await createTestDatabase(); t.after(db.close); const id = await seed(db.pool);
  await db.pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone,details)
    SELECT 'large-query-'||n,'offer',$1,'ny_nj','closed',4,now()-interval '1 day','America/New_York',$2::jsonb
    FROM generate_series(1,1000) n`, [id, JSON.stringify({ note: '文'.repeat(999) })]);
  await db.pool.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state)
    SELECT id,$1,'driver',0,'active' FROM rides`, [id]);
  await db.pool.query(`INSERT INTO ride_stops(ride_id,position,kind,address,departure_at)
    SELECT id,0,'departure','Fort Lee',departure_at FROM rides`);
  const app = await createApp({ pool: db.pool, config }); t.after(() => app.close());
  const reply = await app.inject(signed('rides.history', {}, { leaf: compatQueryKey(root, 'rides.history') }));
  assert.equal(reply.statusCode, 409); assert.equal(reply.json().error.code, 'QUERY_REQUIRES_NEW_CLIENT');
  assert.equal(reply.json().data, undefined); assert.equal((await db.pool.query('SELECT * FROM auth_bridge_nonces')).rowCount, 0);
  assert.equal((await db.pool.query('SELECT * FROM rides')).rowCount, 1000);
});

test('query HTTPS transport rejects length mismatch, redirect, encoding, invalid UTF-8 and incomplete bodies', async () => {
  const body = { purpose: 'compat-read', appId, openid, source: 'wx_client', action: 'profile.get', body: {} };
  const valid = Buffer.from(JSON.stringify({ ok: true, actor: { appId, openid, id: randomUUID() }, data: { data: [] } }));
  const transport = (options: { raw?: Buffer; length?: string; status?: number; encoding?: string; complete?: boolean; aborted?: boolean } = {}) => {
    let calls = 0;
    const request = (url: string, opts: any, callback: (response: any) => void) => {
      assert.equal(url, ENDPOINT); assert.equal(opts.method, 'POST'); calls++;
      const req = new EventEmitter() as any; req.destroy = () => {};
      req.end = () => queueMicrotask(() => {
        const raw = options.raw ?? valid;
        const res = Object.assign(new PassThrough(), { statusCode: options.status ?? 200, complete: options.complete ?? true,
          headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': options.length ?? String(raw.length),
            ...(options.encoding ? { 'content-encoding': options.encoding } : {}) } });
        callback(res);
        if (!res.destroyed) { if (options.aborted) res.emit('aborted'); else res.end(raw); }
      }); return req;
    };
    return { call: () => send(body, compatQueryKey(root, 'profile.get'), { request }), count: () => calls };
  };
  const good = transport(); assert.equal((await good.call()).ok, true); assert.equal(good.count(), 1);
  for (const options of [{ length: String(valid.length + 1) }, { length: String(valid.length - 1) },
    { status: 302 }, { encoding: 'gzip' }, { complete: false }, { aborted: true },
    { raw: Buffer.from([0xff]) }, { length: String(2097153) }]) {
    const bad = transport(options); await assert.rejects(bad.call(), /QUERY_UNAVAILABLE/); assert.equal(bad.count(), 1);
  }
});
