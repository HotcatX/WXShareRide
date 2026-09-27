import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../src/app.ts';
import { cloudBaseLoginPath } from '../src/auth/cloudbase.ts';
import { createTestDatabase } from './helpers/database.ts';

const config = { databaseUrl: '', host: '127.0.0.1', port: 3100,
  appId: 'wx8a8a389199aa2a0e', sessionTtlSeconds: 3600 };
function proof(key: Buffer, text: string) {
  const timestamp = String(Date.now()), nonce = randomBytes(16).toString('hex');
  const signature = createHmac('sha256', key)
    .update(`linkx-auth-bridge-v1\nPOST\n${cloudBaseLoginPath}\n${config.appId}\n${timestamp}\n${nonce}\n${text}`).digest('hex');
  return { 'content-type': 'application/json', 'x-linkx-auth-timestamp': timestamp,
    'x-linkx-auth-nonce': nonce, 'x-linkx-auth-signature': signature };
}
const payload = () => JSON.stringify({ purpose: 'login', appId: config.appId,
  openid: 'synthetic_bridge_openid', source: 'wx_client' });

test('staged deployment rejects every business entry before parsing or authentication and keeps the first-import DB empty', async t => {
  const db = await createTestDatabase();
  let exchanged = 0;
  const app = await createApp({ pool: db.pool, config: { ...config, authBridgeKey: randomBytes(32) },
    exchange: async () => { exchanged++; return { openid: 'must-not-be-created' }; } });
  t.after(async () => { await app.close(); await db.close(); });
  assert.equal((await app.inject('/healthz')).statusCode, 200);
  for (const [method, url] of [['POST', '/api/v1/auth/login'], ['PATCH', '/api/v1/me'],
    ['POST', '/api/v1/files/images'], ['GET', '/api/v1/rides'], ['GET', '/api/v1/market/listings'],
    ['POST', '/api/v1/admin/auth/login'], ['POST', cloudBaseLoginPath],
    ['POST', '/%61pi/v1/auth/login'], ['PATCH', '/%61pi/v1/me'],
    ['POST', '/%69nternal/v1/auth/cloudbase']] as const) {
    const response = await app.inject({ method, url,
      ...(method === 'GET' ? {} : { payload: '{malformed', headers: { 'content-type': 'application/json' } }) });
    assert.equal(response.statusCode, 503, url);
    assert.equal(response.json().error.code, 'BACKEND_STAGED');
    assert.equal(response.headers['cache-control'], 'private, no-store');
  }
  assert.equal(exchanged, 0);
  for (const table of ['users', 'sessions', 'referral_codes', 'auth_bridge_nonces', 'admin_login_attempts', 'files']) {
    assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
  }
});

test('HTTP login bridge preserves signed bytes, rejects replay and issues the existing bearer session only when active', async t => {
  const db = await createTestDatabase(), key = randomBytes(32);
  const app = await createApp({ pool: db.pool, config: { ...config, businessMode: 'active', authBridgeKey: key } });
  t.after(async () => { await app.close(); await db.close(); });
  const raw = payload(), headers = proof(key, raw);
  for (const [body, signedHeaders] of [[raw + '\n', headers], [raw, proof(randomBytes(32), raw)]] as const) {
    const bad = await app.inject({ method: 'POST', url: cloudBaseLoginPath, payload: body, headers: signedHeaders });
    assert.equal(bad.statusCode, 401);
    assert.equal(bad.headers['cache-control'], 'private, no-store');
  }
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
  const first = await app.inject({ method: 'POST', url: cloudBaseLoginPath, payload: raw, headers });
  assert.equal(first.statusCode, 200, first.body);
  const { token, user } = first.json().data;
  const profile = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } });
  assert.equal(profile.statusCode, 200, profile.body);
  assert.equal(profile.json().data.id, user.id);
  assert.equal(profile.json().data.avatarFileId, null);
  const replay = await app.inject({ method: 'POST', url: cloudBaseLoginPath, payload: raw, headers });
  assert.equal(replay.statusCode, 409);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 1);
  const oversized = ' '.repeat(1025);
  assert.equal((await app.inject({ method: 'POST', url: cloudBaseLoginPath, payload: oversized,
    headers: proof(key, oversized) })).statusCode, 413);
  assert.equal((await app.inject({ method: 'POST', url: cloudBaseLoginPath, payload: raw,
    headers: { ...proof(key, raw), 'content-type': 'text/plain' } })).statusCode, 415);
});

test('an active deployment without a bridge key exposes no bridge endpoint', async t => {
  const db = await createTestDatabase();
  const app = await createApp({ pool: db.pool, config: { ...config, businessMode: 'active' } });
  t.after(async () => { await app.close(); await db.close(); });
  assert.equal((await app.inject({ method: 'POST', url: cloudBaseLoginPath, payload: {} })).statusCode, 404);
});
