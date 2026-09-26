import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { createApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { createTestDatabase } from './helpers/database.ts';

const config: Config = { databaseUrl: '', host: '127.0.0.1', port: 3100,
  appId: 'wx8a8a389199aa2a0e', sessionTtlSeconds: 3600 };
const origin = 'https://admin.example.test';
const password = 'synthetic-admin-password-only';

test('assembled app: admin and WeChat identities stay isolated, with private parser errors and 404s', async t => {
  const db = await createTestDatabase();
  const app = await createApp({ config, pool: db.pool, exchange: async () => ({ openid: 'synthetic-user-openid' }) });
  t.after(async () => { await app.close(); await db.close(); });
  const salt = Buffer.alloc(32, 11);
  await db.pool.query(`INSERT INTO admin_accounts(app_id,id,owner_key,enabled,credential_version,password_salt,password_hash)
    VALUES($1,'app_admin','app_owner',true,1,$2,$3)`, [config.appId, salt, scryptSync(password, salt, 64)]);
  const request = { method: 'POST' as const, url: '/api/v1/admin/auth/login', headers: { origin }, payload: { username: 'app_admin', password } };
  const denied = await app.inject(request);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, 'ADMIN_ORIGIN_NOT_ALLOWED');
  assert.equal(denied.headers['cache-control'], 'private, no-store');
  assert.equal((await db.pool.query('SELECT count(*) FROM admin_login_attempts')).rows[0].count, '0');
  await db.pool.query('INSERT INTO admin_origins VALUES($1,$2)', [config.appId, origin]);
  const login = await app.inject(request);
  assert.equal(login.statusCode, 200, login.body);
  assert.equal(login.headers['access-control-allow-origin'], origin);
  assert.equal(login.headers['cache-control'], 'private, no-store');
  assert.equal((await db.pool.query('SELECT count(*) FROM users')).rows[0].count, '0');
  const adminHeaders = { origin, authorization: `Bearer ${login.json().data.token}` };
  const session = await app.inject({ method: 'GET', url: '/api/v1/admin/session', headers: adminHeaders });
  assert.equal(session.statusCode, 200);
  assert.deepEqual(session.json().data.admin, { accountId: 'app_admin', ownerKey: 'app_owner' });
  const userLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { code: 'synthetic-code' } });
  assert.equal(userLogin.statusCode, 200, userLogin.body);
  const userHeaders = { authorization: `Bearer ${userLogin.json().data.token}` };
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/me', headers: userHeaders })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/me', headers: adminHeaders })).statusCode, 401);
  const wrongRole = await app.inject({ method: 'GET', url: '/api/v1/admin/session', headers: { ...userHeaders, origin } });
  assert.equal(wrongRole.statusCode, 401);
  assert.equal(wrongRole.json().error.code, 'ADMIN_UNAUTHORIZED');
  for (const [type, payload, status] of [
    ['application/json', '{', 400],
    ['application/x-unsupported', 'invalid', 415],
    ['application/json', JSON.stringify({ value: 'x'.repeat(66000) }), 413]
  ] as const) {
    const response = await app.inject({ method: 'POST', url: request.url, headers: { origin, 'content-type': type }, payload });
    assert.equal(response.statusCode, status, response.body);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(response.headers['access-control-allow-origin'], origin);
    assert.equal(response.json().ok, false);
    assert.ok(response.json().requestId);
    assert.ok(!response.body.includes('synthetic-admin-password'));
  }
  const missing = await app.inject({ method: 'GET', url: '/api/v1/admin/missing?token=untrusted', headers: adminHeaders });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.headers['cache-control'], 'private, no-store');
  assert.equal(missing.headers['access-control-allow-origin'], undefined);
  const preflight = await app.inject({ method: 'OPTIONS', url: '/api/v1/admin/session', headers: { origin,
    'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], origin);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/auth/logout', headers: adminHeaders })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/session', headers: adminHeaders })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/me', headers: userHeaders })).statusCode, 200);
});

test('assembled app: admin credentials work independently of missing WeChat AppSecret', async t => {
  const db = await createTestDatabase();
  const app = await createApp({ config, pool: db.pool });
  t.after(async () => { await app.close(); await db.close(); });
  const salt = Buffer.alloc(32, 12);
  await db.pool.query(`INSERT INTO admin_accounts(app_id,id,owner_key,enabled,credential_version,password_salt,password_hash)
    VALUES($1,'app_admin','app_owner',true,1,$2,$3)`, [config.appId, salt, scryptSync(password, salt, 64)]);
  await db.pool.query('INSERT INTO admin_origins VALUES($1,$2)', [config.appId, origin]);
  const response = await app.inject({ method: 'POST', url: '/api/v1/admin/auth/login', headers: { origin }, payload: { username: 'app_admin', password } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { code: 'synthetic-code' } })).statusCode, 503);
  assert.equal((await db.pool.query('SELECT count(*) FROM users')).rows[0].count, '0');
});
