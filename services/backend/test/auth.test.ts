import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { createTestDatabase } from './helpers/database.ts';

const config: Config = { databaseUrl: '', host: '127.0.0.1', port: 3100,
  appId: 'wx8a8a389199aa2a0e', sessionTtlSeconds: 3600 };

test('real DB: trusted identity, concurrent login, private profile, retries and logout', { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
  const db = await createTestDatabase();
  const app = await createApp({ config, pool: db.pool, exchange: async code => ({ openid: `test-openid-${code}` }) });
  t.after(async () => { await app.close(); await db.close(); });
  const login = (code = 'same-user') => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { code } });
  const results = await Promise.all(Array.from({ length: 6 }, () => login()));
  assert.ok(results.every(response => response.statusCode === 200));
  const identities = results.map(response => response.json().data.user.id);
  assert.equal(new Set(identities).size, 1, 'simultaneous first login creates exactly one account');
  const token = results[0].json().data.token;
  const stored = await db.pool.query('SELECT token_hash FROM sessions');
  assert.equal(stored.rows.length, 6);
  assert.ok(stored.rows.every(row => row.token_hash !== token && row.token_hash.length === 64));
  const headers = { authorization: `Bearer ${token}`, 'idempotency-key': 'update-profile-001' };
  const unauth = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { 'x-openid': 'test-openid-same-user' } });
  assert.equal(unauth.statusCode, 401);
  const forged = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { code: 'same-user', openid: 'someone-else' } });
  assert.equal(forged.statusCode, 400);
  const unsupported = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'content-type': 'application/x-unsupported' }, payload: 'untrusted' });
  assert.equal(unsupported.statusCode, 415);
  assert.equal(unsupported.json().error.code, 'UNSUPPORTED_MEDIA_TYPE');
  const patch = { name: 'Test member', profile: { phone: 'synthetic-number', vehicle: { brand: 'Test brand' } } };
  const first = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers, payload: patch });
  assert.equal(first.statusCode, 200, first.body);
  const retry = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers, payload: patch });
  assert.deepEqual(retry.json().data, first.json().data);
  const conflict = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers, payload: { name: 'Changed' } });
  assert.equal(conflict.statusCode, 409);
  const second = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: { ...headers, 'idempotency-key': 'update-profile-002' }, payload: { profile: { vehicle: { model: 'Test model' } } } });
  assert.deepEqual(second.json().data.profile.vehicle, { brand: 'Test brand', model: 'Test model' });
  const noKey = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: { authorization: headers.authorization }, payload: { name: 'Duplicate risk' } });
  assert.equal(noKey.statusCode, 400);
  const alias = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers, payload: { wechatID: 'legacy' } });
  assert.equal(alias.statusCode, 400);
  const other = (await login('other-user')).json().data;
  const otherProfile = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${other.token}` } });
  assert.deepEqual(otherProfile.json().data.profile, {});
  await db.pool.query('UPDATE sessions SET expires_at=now()-interval \'1 second\' WHERE token_hash=$1', [createHash('sha256').update(other.token).digest('hex')]);
  const expired = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${other.token}` } });
  assert.equal(expired.statusCode, 401);
  const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers });
  assert.equal(logout.statusCode, 200);
  const loggedOut = await app.inject({ method: 'GET', url: '/api/v1/me', headers });
  assert.equal(loggedOut.statusCode, 401);
});

test('login disabled without credential: never invent identity', { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
  const db = await createTestDatabase();
  const app = await createApp({ config, pool: db.pool });
  t.after(async () => { await app.close(); await db.close(); });
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { code: 'synthetic' } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'LOGIN_UNAVAILABLE');
  assert.equal((await db.pool.query('SELECT count(*) FROM users')).rows[0].count, '0');
});
