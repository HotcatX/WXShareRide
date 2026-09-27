import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createApp } from '../src/app.ts';
import { createCompatBridge, compatBridgePath } from '../src/compat/bridge.ts';
import { parseCompatAction } from '../src/compat/contract.ts';
import { runCompatAction } from '../src/compat/service.ts';
import { transaction, idempotencyInput } from '../src/db.ts';
import { templateId } from '../src/templates/identity.ts';
import { templateIdSchema } from '../src/templates/schemas.ts';
import { normalizeOperationReceipts } from '../src/migration/operation-receipts.ts';
import { normalizeTemplates } from '../src/migration/templates.ts';
import { migrationUserId } from '../src/migration/users.ts';
import { sessionService } from '../src/auth/session.ts';
import { createTestDatabase } from './helpers/database.ts';

const require = createRequire(import.meta.url);
const { createBackendHandler } = require('../../../cloudfunctions/backend/handler.js');
const { send } = require('../../../cloudfunctions/backend/compat-bridge.js');
const { createBackendClient, PENDING_KEY, SESSION_KEY } = require('../../../utils/backendClient.js');
const { createRideTemplateClient } = require('../../../utils/compat/rideTemplates.js');
const createStore = require('../../../tests/helpers/cloud-transaction-store.cjs');
const appId = 'wx8a8a389199aa2a0e', openid = 'synthetic-compat-owner', key = Buffer.alloc(32, 71);
const form = { templateName: '周二上课', departureAddress: 'Fort Lee', destinationAddress: '哥大', weekdayIndex: 1,
  weekdayText: '周二', departureTime: '15:00', passengerCount: 3, referencePrice: '11-13$', comment: '', carBrand: 'snapshot only' };
const context = (id = openid) => ({ environment: JSON.stringify({ TCB_SOURCE: 'wx_client', WX_APPID: appId, WX_OPENID: id }) });
const config = { databaseUrl: '', host: '127.0.0.1', port: 3100, appId, businessMode: 'active' as const, sessionTtlSeconds: 3600, authBridgeKey: key };
const pg = { skip: !process.env.BACKEND_TEST_DATABASE_URL };
test('generated mini locator shares the imported app-scoped algorithm, including legacy and unusual UUID inputs', () => {
  const mini = require('../../../utils/compat/templateIdentity.generated.js');
  const { sha256 } = require('../../../utils/hash.js');
  for (const sourceId of ['old-template-source', '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF', randomUUID(), randomUUID().toUpperCase()]) {
    const bytes = createHash('sha256').update(JSON.stringify(['linkx-template-v1', appId, sourceId])).digest().subarray(0, 16);
    bytes[6] = (bytes[6]! & 15) | 128; bytes[8] = (bytes[8]! & 63) | 128;
    const h = bytes.toString('hex'), original = templateIdSchema.safeParse(sourceId).success ? sourceId.toLowerCase()
      : `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
    assert.equal(templateId(appId, sourceId), original);
    assert.equal(mini.templateId(appId, sourceId, sha256), original);
  }
});
function proof(action: string, body: unknown = {}, requestKey?: string, extra: Record<string, unknown> = {}) {
  const raw = Buffer.from(JSON.stringify({ purpose: 'compat', appId, openid, source: 'wx_client', action, body, ...(requestKey ? { key: requestKey } : {}), ...extra }));
  const at = String(Date.now()), nonce = randomBytes(16).toString('hex');
  const derived = createHmac('sha256', key).update('linkx-compat-bridge-key-v1').digest();
  const signature = createHmac('sha256', derived).update(`linkx-compat-bridge-v1\nPOST\n${compatBridgePath}\n${appId}\n${at}\n${nonce}\n`).update(raw).digest('hex');
  return { method: 'POST', path: compatBridgePath, body: raw,
    rawHeaders: ['X-Linkx-Compat-Timestamp', at, 'X-Linkx-Compat-Nonce', nonce, 'X-Linkx-Compat-Signature', signature] };
}
test('the deployed wire body is validated without rewriting its receipt identity', () => {
  const body = { form }; assert.equal(parseCompatAction('templates.create', body), body);
  for (const value of [{ ...form, comment: ' trim ' }, { ...form, passengerCount: '3' }, { ...form, weekdayText: '周日' }, { ...form, privateField: true }]) {
    assert.throws(() => parseCompatAction('templates.create', { form: value }));
  }
  assert.throws(() => parseCompatAction('arbitrary.collection', {}));
  assert.throws(() => parseCompatAction('identity', {}, { writeOnly: true }));
});

test('all finite PG compatibility actions reuse canonical facts and immutable original receipts', pg, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const owner = migrationUserId(appId, openid), other = randomUUID();
  await db.pool.query('INSERT INTO users(id,app_id,openid) VALUES($1,$2,$3),($4,$2,$5)', [owner, appId, openid, other, 'synthetic-compat-other']);
  const call = (action: string, body: unknown = {}, requestKey?: string) => transaction(db.pool, c => runCompatAction(c, appId, openid, action, body, requestKey));
  const created = await call('templates.create', { form }, 'create-original');
  assert.equal((created.data as any).referencePrice, '11-13$');
  assert.equal((created.data as any).carBrand, form.carBrand);
  const id = created.data._id as string;
  const updated = await call('templates.update', { id, form: { ...form, departureTime: '16:00' } }, 'update-original');
  assert.equal(updated.data.departureTime, '16:00');
  assert.equal((await call('templates.get', { id })).data._id, id);
  assert.equal(((await call('templates.list', { page: 1 })).data.items as unknown[]).length, 1);
  await db.pool.query(`UPDATE ride_templates SET definition=jsonb_set(definition,'{stops}', $2::jsonb) WHERE id=$1`, [id,
    JSON.stringify([{ kind: 'departure', address: 'Fort Lee', offsetMinutes: 0 }, { kind: 'departure', address: 'Pickup B', offsetMinutes: 60 },
      { kind: 'destination', address: '哥大' }, { kind: 'destination', address: 'Destination B' }])]);
  for (const [action, body, key] of [['templates.get', { id }, undefined], ['templates.list', { page: 1 }, undefined],
    ['templates.update', { id, form }, 'multi-no-truncate']] as const) await assert.rejects(call(action, body, key), { code: 'TEMPLATE_REQUIRES_NEW_CLIENT' });
  const definition = (await db.pool.query('SELECT definition FROM ride_templates WHERE id=$1', [id])).rows[0].definition;
  assert.equal(definition.stops.length, 4); assert.equal(definition.stops[1].offsetMinutes, 60);
  assert.equal(definition.carBrand, undefined); assert.equal(definition.listedPriceCents, null);
  assert.equal((await call('identity')).actor.id, owner);
  await call('templates.delete', { id }, 'delete-original');
  assert.deepEqual(await call('templates.create', { form }, 'create-original'), created);
  assert.deepEqual(await call('templates.update', { id, form: { ...form, departureTime: '16:00' } }, 'update-original'), updated);
  assert.equal((await db.pool.query('SELECT * FROM ride_templates')).rowCount, 0);
  await assert.rejects(call('templates.create', { form: { ...form, comment: 'different' } }, 'create-original'), { code: 'IDEMPOTENCY_CONFLICT' });
  const add = (id: string, user = owner) => db.pool.query("INSERT INTO notifications(id,user_id,type,title,content) VALUES($1,$2,'rating_invitation','Title','Content')", [id, user]);
  await add('notice-a'); await add('foreign', other);
  await assert.rejects(call('notifications.read', { id: 'foreign' }, 'foreign-notice'), { code: 'NOTIFICATION_NOT_FOUND' });
  await call('notifications.read', { id: 'notice-a' }, 'read-notice'); await add('notice-b');
  const all = await call('notifications.readAll', {}, 'read-all-original'); await add('later');
  assert.deepEqual(await call('notifications.readAll', {}, 'read-all-original'), all);
  assert.equal((await call('notifications.unread')).data.unreadCount, 1);
  assert.equal(((await call('notifications.list')).data.items as any[])[0]._openid, openid);
  const cleared = await call('notifications.clear', {}, 'clear-original'); await add('after-clear');
  assert.deepEqual(await call('notifications.clear', {}, 'clear-original'), cleared);
  assert.equal((await db.pool.query('SELECT * FROM notifications')).rowCount, 2);
  await Promise.all(['A', 'B'].map(value => call('profile.spots.add', { field: 'pickupSpot', value }, `spot-add-${value}`)));
  const saved = await call('profile.spots.remove', { field: 'pickupSpot', value: 'A' }, 'spot-remove');
  assert.deepEqual(saved.data.values, ['B']);
  await db.pool.query(`UPDATE users SET profile=$2 WHERE id=$1`, [owner, { bio: 'preserved', preferences: { pickupAddresses: [' Fort Lee ', 'Fort Lee'], comments: ['keep'] } }]);
  const preserved = await call('profile.spots.add', { field: 'pickupSpot', value: 'JFK' }, 'spot-preserve');
  assert.deepEqual(preserved.data.values, [' Fort Lee ', 'Fort Lee', 'JFK']);
  const profile = (await db.pool.query('SELECT profile FROM users WHERE id=$1', [owner])).rows[0].profile;
  assert.deepEqual(profile, { bio: 'preserved', preferences: { pickupAddresses: [' Fort Lee ', 'Fort Lee', 'JFK'], comments: ['keep'] } });
  assert.deepEqual((await db.pool.query('SELECT DISTINCT operation FROM idempotency_requests')).rows.every(row => row.operation.startsWith('compat.')), true);
  assert.equal((await db.pool.query('SELECT * FROM sessions')).rowCount, 0);
});

test('compat proof purpose, identity, replay and staging are enforced inside the mutation transaction', pg, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const owner = migrationUserId(appId, openid);
  await db.pool.query('INSERT INTO users(id,app_id,openid) VALUES($1,$2,$3)', [owner, appId, openid]);
  const bridge = createCompatBridge({ pool: db.pool, appId, key, isActive: () => true });
  const p = proof('templates.create', { form }, 'nonce-template');
  const result = await bridge(p); await assert.rejects(bridge(p), { code: 'COMPAT_BRIDGE_REPLAY' });
  assert.deepEqual(await bridge(proof('templates.create', { form }, 'nonce-template')), result);
  const duplicate = proof('identity'); duplicate.rawHeaders.push('x-linkx-compat-nonce', duplicate.rawHeaders[3]!);
  for (const p of [duplicate, proof('identity', {}, undefined, { purpose: 'login' }), proof('identity', {}, undefined, { appId: 'wx0000000000000000' }),
    proof('identity', {}, undefined, { source: 'wx_trigger' }), { ...proof('identity'), path: `${compatBridgePath}?next=admin` }]) {
    await assert.rejects(bridge(p), { code: 'COMPAT_BRIDGE_UNAUTHORIZED' });
  }
  await assert.rejects(bridge(proof('identity', {}, undefined, { openid: 'synthetic-unknown-owner' })), { code: 'USER_NOT_FOUND' });
  assert.equal((await db.pool.query('SELECT * FROM users')).rowCount, 1);
  await db.pool.query(`CREATE FUNCTION reject_compat_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$;
    CREATE TRIGGER reject_compat_receipt BEFORE INSERT ON idempotency_requests FOR EACH ROW EXECUTE FUNCTION reject_compat_receipt()`);
  const failed = proof('templates.create', { form }, 'rollback-original');
  const count = (await db.pool.query('SELECT * FROM auth_bridge_nonces')).rowCount;
  await assert.rejects(bridge(failed), { code: 'OPERATION_UNAVAILABLE' });
  assert.equal((await db.pool.query('SELECT * FROM auth_bridge_nonces')).rowCount, count);
  assert.equal((await db.pool.query('SELECT * FROM ride_templates')).rowCount, 1);
  await db.pool.query('DROP TRIGGER reject_compat_receipt ON idempotency_requests; DROP FUNCTION reject_compat_receipt()');
  await bridge(failed);
  let checks = 0;
  await assert.rejects(createCompatBridge({ pool: db.pool, appId, key, isActive: () => ++checks < 3 })(proof('templates.create', { form }, 'staged-during-write')), { code: 'BACKEND_STAGED' });
  assert.equal((await db.pool.query('SELECT * FROM ride_templates')).rowCount, 2);
  const app = await createApp({ pool: db.pool, config: { ...config, businessMode: 'staged' } }); t.after(() => app.close());
  for (const path of [compatBridgePath, '/internal/v1/%63ompat/cloudbase']) {
    assert.equal((await app.inject({ method: 'POST', url: path, payload: {} })).statusCode, 503);
  }
  const activeApp = await createApp({ pool: db.pool, config }); t.after(() => activeApp.close());
  const otherSession = await sessionService(db.pool, config, async () => ({ openid: 'synthetic-other-alias-owner' })).login('synthetic');
  const alias = await activeApp.inject({ method: 'GET', url: `/api/v1/templates/legacy/${result.data._id}`,
    headers: { authorization: `Bearer ${otherSession.token}` } });
  assert.equal(alias.statusCode, 404); assert.equal(alias.json().error.code, 'TEMPLATE_NOT_FOUND');
});

// Actual Cloud handler -> source normalization -> PostgreSQL receipt -> actual
// SDK and signed Cloud transport. All identities/data are synthetic and local.
test('lost Cloud ACK survives cutover, authority mismatch, denied retries and expired login with its original key/body', pg, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const owner = migrationUserId(appId, openid), store = createStore(), storage: Record<string, any> = { openid, isGuest: false };
  const oldId = 'old-template-source'; store.seed('CarpoolTemplate', oldId, { ...form, _openid: openid, createdAt: new Date('2026-09-01T12:00:00Z') });
  let authority = 'cloudbase', drop = true, denied = 0, failAlias = false; const requests: any[] = [];
  const app = await createApp({ pool: db.pool, config, exchange: async () => ({ openid }) }); t.after(() => app.close());
  const sessions = sessionService(db.pool, config, async () => ({ openid }));
  const request = (url: string, options: any, callback: (response: any) => void) => {
    const req = new EventEmitter() as any; req.destroy = () => {};
    req.end = (raw: string) => { void (async () => {
      const result = await app.inject({ method: 'POST', url: new URL(url).pathname, headers: options.headers, payload: raw });
      const response = new PassThrough() as any; response.statusCode = result.statusCode; response.headers = result.headers;
      callback(response); response.end(result.rawPayload);
    })().catch(error => req.emit('error', error)); }; return req;
  };
  const handler = () => createBackendHandler({ authority, getKey: () => key,
    getDb: () => { assert.equal(authority, 'cloudbase'); return store.db; }, transport: (body: unknown, secret: Buffer) => send(body, secret, { request }) });
  const wx: any = { getStorageSync: (k: string) => structuredClone(storage[k]), setStorageSync: (k: string, v: unknown) => { storage[k] = structuredClone(v); },
    removeStorageSync: (k: string) => { delete storage[k]; }, cloud: { callFunction: async ({ data }: any) => {
      if (data.action === 'login') return { result: { ok: true, data: await sessions.login('synthetic') } };
      requests.push(structuredClone(data));
      if (denied) return { result: { ok: false, error: { code: 'UNAUTHORIZED', status: denied, message: 'denied' } } };
      const result = await handler()(data, context());
      if (drop && data.key && result.ok) { drop = false; throw Error('lost ACK'); }
      return { result: JSON.parse(JSON.stringify(result)) };
    } }, request: (options: any) => {
      void (async () => {
        if (failAlias && options.url.includes('/legacy/')) { options.fail({ errMsg: 'offline' }); return; }
        const response = await app.inject({ method: options.method, url: new URL(options.url).pathname, headers: options.header, payload: options.data });
        options.success({ statusCode: response.statusCode, data: response.json() });
      })().catch(options.fail); return { abort() {} };
    } };
  const make = (mode: string) => createBackendClient({ wx, config: { mode, origin: 'https://collect.linkx.ink' } });
  const old = make('cloudbase');
  await assert.rejects(old.cloudMutate(`templates.update:${oldId}`, 'templates.update', { id: oldId, form }, { validate: (row: any) => row._id === oldId }), { code: 'NETWORK_ERROR' });
  const pending = structuredClone(storage[PENDING_KEY]), original = requests.find(row => row.key);
  const receipts = normalizeOperationReceipts(JSON.parse(JSON.stringify(store.all('OperationReceipts'))), { appId, users: [{ id: owner, appId, openid }] }, () => assert.fail('invalid receipt'));
  const templates = normalizeTemplates(JSON.parse(JSON.stringify(store.all('CarpoolTemplate'))), [{ id: owner, appId, openid }], (_c, _code, _f, severity) => { if (severity !== 'notice') assert.fail('invalid template'); });
  await db.pool.query('INSERT INTO users(id,app_id,openid) VALUES($1,$2,$3)', [owner, appId, openid]);
  for (const row of templates) await db.pool.query('INSERT INTO ride_templates(id,user_id,name,weekday,local_time,time_zone,definition,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [row.id, row.userId, row.name, row.weekday, row.localTime, row.timeZone, row.definition, row.createdAt, row.updatedAt]);
  for (const row of receipts) await db.pool.query('INSERT INTO idempotency_requests(user_id,operation,request_key,payload_hash,response_status,response_body) VALUES($1,$2,$3,$4,$5,$6)',
    [row.userId, row.operation, row.requestKey, row.payloadHash, row.responseStatus, row.responseBody]);
  let client = make('server'); await assert.rejects(client.retryCloudPending(`templates.update:${oldId}`, { validate: () => true }), { code: 'AUTHORITY_NOT_READY' });
  assert.deepEqual(storage[PENDING_KEY], pending); authority = 'server';
  for (const status of [401, 403]) { denied = status; await assert.rejects(make('server').retryCloudPending(`templates.update:${oldId}`, { validate: () => true }), { code: 'UNAUTHORIZED' }); assert.deepEqual(storage[PENDING_KEY], pending); }
  denied = 0; storage[SESSION_KEY].expiresAt = new Date(Date.now() - 1000).toISOString(); client = make('server');
  const api = createRideTemplateClient({ wx, backend: client });
  failAlias = true; await assert.rejects(api.recoverRideTemplate(oldId), { code: 'NETWORK_ERROR' }); assert.deepEqual(storage[PENDING_KEY], pending);
  failAlias = false;
  // Cold start only sees canonical list IDs. It must locate the original
  // non-UUID pending scope without substituting its action, body or key.
  const canonicalId = templateId(appId, oldId), visible = (await api.loadRideTemplates())[0];
  assert.equal(visible._id, canonicalId);
  const duplicate = { ...pending[0], key: 'second-uncertain-key' };
  storage[PENDING_KEY] = [...pending, duplicate];
  await assert.rejects(api.saveRideTemplate({ ...visible, departureTime: '16:00' }, { id: canonicalId, previous: visible }), { code: 'PENDING_OPERATION' });
  assert.equal(storage[PENDING_KEY].length, 2);
  storage[PENDING_KEY] = pending;
  const recovered = await api.saveRideTemplate({ ...visible, departureTime: '16:00' }, { id: canonicalId, previous: visible });
  assert.equal(recovered._id, templateId(appId, oldId)); assert.equal(recovered.recovered, true); assert.equal(storage[PENDING_KEY], undefined);
  assert.equal((await db.pool.query('SELECT local_time FROM ride_templates')).rows[0].local_time, '15:00');
  const replay = requests.filter(row => row.key).at(-1); assert.deepEqual(replay, { ...original, expectedAuthority: 'server' });
  assert.equal((await db.pool.query('SELECT * FROM ride_templates')).rowCount, 1);
  assert.equal((await db.pool.query('SELECT * FROM idempotency_requests')).rowCount, 1);
  assert.equal(store.all('OperationReceipts').length, 1);
  assert.equal(idempotencyInput(original.key, original.body).hash, receipts[0]!.payloadHash);
  await api.saveRideTemplate({ ...recovered, departureTime: '16:00' }, { id: recovered._id, previous: recovered });
  assert.equal((await db.pool.query('SELECT local_time FROM ride_templates')).rows[0].local_time, '16:00');
  assert.equal((await db.pool.query('SELECT * FROM ride_templates')).rowCount, 1);
});
