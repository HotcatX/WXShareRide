import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createCloudBaseLoginBridge, cloudBaseLoginPath } from '../src/auth/cloudbase.ts';
import type { CloudBaseLoginRequest } from '../src/auth/cloudbase.ts';
import { sessionService } from '../src/auth/session.ts';
import { createTestDatabase } from './helpers/database.ts';
import { AppError } from '../src/errors.ts';
import type { Config } from '../src/config.ts';

const enabled = { skip: !process.env.BACKEND_TEST_DATABASE_URL };
const appId = 'wx8a8a389199aa2a0e', key = Buffer.alloc(32, 71), openid = 'synthetic-openid-cloudbase';
const config: Config = { databaseUrl: '', host: '127.0.0.1', port: 3100, appId, sessionTtlSeconds: 3600 };
function proof(options: { body?: unknown; at?: number; nonce?: string; signKey?: Buffer; app?: string; raw?: Buffer } = {}): CloudBaseLoginRequest {
  const body = options.raw ?? Buffer.from(JSON.stringify(options.body ?? { purpose: 'login', appId, openid, source: 'wx_client' }));
  const at = String(options.at ?? Date.now()), nonce = options.nonce ?? randomBytes(16).toString('hex');
  const signature = createHmac('sha256', options.signKey ?? key)
    .update(['linkx-auth-bridge-v1', 'POST', '/internal/v1/auth/cloudbase', options.app ?? appId, at, nonce, ''].join('\n')).update(body).digest('hex');
  return { method: 'POST', path: cloudBaseLoginPath, body,
    rawHeaders: ['X-Linkx-Auth-Timestamp', at, 'X-Linkx-Auth-Nonce', nonce, 'X-Linkx-Auth-Signature', signature] };
}
function rejectsCode(code: string) {
  return (error: unknown) => { assert.ok(error instanceof AppError); assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /synthetic|openid|secret|hash|nonce/); return true; };
}

test('bridge and wx.login use one imported identity, preserve its profile and store only session hashes', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const id = randomUUID(), profile = { bio: 'synthetic imported profile', phone: 'synthetic-private-phone' };
  await db.pool.query(`INSERT INTO users(id,app_id,openid,name,profile,created_at,updated_at)
    VALUES($1,$2,$3,'Preserved member',$4,'2020-01-01Z','2020-01-02Z')`, [id, appId, openid, profile]);
  await db.pool.query("INSERT INTO referral_codes(user_id,code) VALUES($1,'ref_0123456789ab')", [id]);
  const bridge = createCloudBaseLoginBridge({ pool: db.pool, ...config, key, isActive: () => true });
  const fromBridge = await bridge.login(proof());
  const direct = await sessionService(db.pool, config, async () => ({ openid })).login('synthetic-code');
  assert.equal(fromBridge.user.id, id); assert.deepEqual(fromBridge.user, direct.user);
  assert.equal(fromBridge.user.referralCode, 'ref_0123456789ab'); assert.notEqual(fromBridge.token, direct.token);
  const user = (await db.pool.query('SELECT name,profile,created_at,updated_at FROM users WHERE id=$1', [id])).rows[0];
  assert.equal(user.name, 'Preserved member'); assert.deepEqual(user.profile, profile);
  assert.equal(user.created_at.toISOString(), '2020-01-01T00:00:00.000Z'); assert.equal(user.updated_at.toISOString(), '2020-01-02T00:00:00.000Z');
  const stored = (await db.pool.query('SELECT token_hash FROM sessions')).rows.map(row => row.token_hash);
  assert.deepEqual(stored.sort(), [fromBridge.token, direct.token].map(token => createHash('sha256').update(token).digest('hex')).sort());
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 1);
});

test('persistent nonce admits one concurrent proof and remains rejected by a fresh bridge instance', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const factory = () => createCloudBaseLoginBridge({ pool: db.pool, ...config, key, isActive: () => true });
  const request = proof();
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => factory().login(request)));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  for (const row of results) if (row.status === 'rejected') rejectsCode('AUTH_BRIDGE_REPLAY')(row.reason);
  await assert.rejects(factory().login(request), rejectsCode('AUTH_BRIDGE_REPLAY'));
  for (const table of ['users', 'sessions', 'auth_bridge_nonces']) assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 1);
  const sessions = await Promise.all(Array.from({ length: 5 }, () => factory().login(proof())));
  assert.equal(new Set(sessions.map(session => session.user.id)).size, 1);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 6);
});

test('bridge rejects forged app/source/purpose/identity and transport substitutions before persisting anything', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const bridge = createCloudBaseLoginBridge({ pool: db.pool, ...config, key, isActive: () => true });
  const validBody = { purpose: 'login', appId, openid, source: 'wx_client' };
  const bad = [proof({ signKey: Buffer.alloc(32, 99) }), proof({ app: 'wx0000000000000000' }),
    proof({ body: { ...validBody, appId: 'wx0000000000000000' } }), proof({ body: { ...validBody, source: 'wx_trigger' } }),
    proof({ body: { ...validBody, purpose: 'updateUser' } }), proof({ body: { ...validBody, actorOpenid: openid } }),
    proof({ body: { ...validBody, openid: '' } }), proof({ body: { ...validBody, source: 'scf' } }),
    proof({ raw: Buffer.from(' '.repeat(1025)) }), proof({ raw: Buffer.from([0xff]) }),
    proof({ raw: Buffer.from(JSON.stringify(validBody, null, 2)) }), proof({ raw: Buffer.from(`{"purpose":"other",${JSON.stringify(validBody).slice(1)}`) })];
  bad.push({ ...proof(), method: 'GET' }, { ...proof(), path: `${cloudBaseLoginPath}?next=admin` });
  const duplicated = proof(); duplicated.rawHeaders = [...duplicated.rawHeaders, 'x-linkx-auth-nonce', duplicated.rawHeaders[3]!]; bad.push(duplicated);
  const missing = proof(); missing.rawHeaders = missing.rawHeaders.slice(0, 4); bad.push(missing);
  const jwt = proof(); jwt.rawHeaders = ['Authorization', 'Bearer synthetic.collector.signature']; bad.push(jwt);
  const changedBody = proof(); changedBody.body = Buffer.from(JSON.stringify({ ...validBody, openid: 'synthetic-other-openid' })); bad.push(changedBody);
  for (const request of bad) await assert.rejects(bridge.login(request), rejectsCode('AUTH_BRIDGE_UNAUTHORIZED'));
  for (const table of ['users', 'sessions', 'auth_bridge_nonces']) assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
});

test('expired/future proofs fail and old collector HMAC cannot be used as a business-login proof', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close()); const now = Date.now();
  const bridge = createCloudBaseLoginBridge({ pool: db.pool, ...config, key, isActive: () => true, now: () => now });
  for (const at of [now - 60001, now + 60001]) await assert.rejects(bridge.login(proof({ at })), rejectsCode('AUTH_BRIDGE_UNAUTHORIZED'));
  const old = proof({ at: now });
  old.rawHeaders = [...old.rawHeaders.slice(0, 5), createHmac('sha256', key).update(`${now}\n${old.rawHeaders[3]}\n`).update(old.body).digest('hex')];
  await assert.rejects(bridge.login(old), rejectsCode('AUTH_BRIDGE_UNAUTHORIZED'));
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM auth_bridge_nonces')).rows[0].n, 0);
});

test('staged gate denies before writes and activation revoked during issuance rolls nonce and identity back', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const inactive = createCloudBaseLoginBridge({ pool: db.pool, ...config, key, isActive: () => false });
  await assert.rejects(inactive.login(proof()), rejectsCode('LOGIN_UNAVAILABLE'));
  let checks = 0;
  const changing = createCloudBaseLoginBridge({ pool: db.pool, ...config, key, isActive: () => ++checks < 4 });
  await assert.rejects(changing.login(proof()), rejectsCode('LOGIN_UNAVAILABLE'));
  assert.equal(checks, 4);
  for (const table of ['users', 'sessions', 'auth_bridge_nonces', 'referral_codes']) assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
});

test('failed session transaction does not burn its nonce or retain a half-created account', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  await db.pool.query("CREATE FUNCTION reject_bridge_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-private-failure'; END $$");
  await db.pool.query('CREATE TRIGGER reject_bridge_session BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION reject_bridge_session()');
  const bridge = createCloudBaseLoginBridge({ pool: db.pool, ...config, key, isActive: () => true }), request = proof();
  await assert.rejects(bridge.login(request), rejectsCode('LOGIN_UNAVAILABLE'));
  for (const table of ['users', 'sessions', 'auth_bridge_nonces']) assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
  await db.pool.query('DROP TRIGGER reject_bridge_session ON sessions');
  assert.equal((await bridge.login(request)).user.openid, openid);
});

test('nonce cleanup is bounded and app-scoped; valid and other-app nonces remain', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close()); const now = Date.now();
  for (let i = 0; i < 105; i++) await db.pool.query('INSERT INTO auth_bridge_nonces VALUES($1,$2,$3)', [appId, i.toString(16).padStart(32, '0'), new Date(now - 1)]);
  await db.pool.query('INSERT INTO auth_bridge_nonces VALUES($1,$2,$3),($4,$5,$6)',
    [appId, 'e'.repeat(32), new Date(now + 60000), 'other-app', 'f'.repeat(32), new Date(now - 1)]);
  const bridge = createCloudBaseLoginBridge({ pool: db.pool, ...config, key, isActive: () => true, now: () => now });
  await bridge.login(proof({ at: now }));
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM auth_bridge_nonces WHERE app_id=$1', [appId])).rows[0].n, 7);
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM auth_bridge_nonces WHERE app_id='other-app'")).rows[0].n, 1);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM auth_bridge_nonces WHERE nonce=$1', ['e'.repeat(32)])).rows[0].n, 1);
});
