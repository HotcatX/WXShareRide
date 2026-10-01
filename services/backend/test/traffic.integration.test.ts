import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.ts';
import { createTestDatabase } from './helpers/database.ts';

const integration = { skip: !process.env.BACKEND_TEST_DATABASE_URL };
const appId = 'wx1234567890abcdef';

test('traffic monitor requires its private token and counts registered response routes, including errors, without unknown/admin/health pollution', integration, async t => {
  const db = await createTestDatabase();
  let now = Math.floor(Date.now() / 60_000) * 60_000;
  const startedAt = now, token = randomBytes(32).toString('hex');
  t.mock.method(Date, 'now', () => now);
  const app = await createApp({ pool: db.pool, config: { appId, databaseUrl: '', host: '127.0.0.1', port: 0,
    businessMode: 'active', sessionTtlSeconds: 3600, authBridgeKey: randomBytes(32),
    adminMonitor: { socketPath: '/nonexistent/synthetic-monitor.sock', token } } });
  t.after(async () => { await app.close(); await db.close(); });
  for (const authorization of [undefined, `Bearer ${'x'.repeat(token.length)}`, `Bearer ${token}x`]) {
    const response = await app.inject({ url: '/internal/v1/monitor', headers: authorization ? { authorization } : {} });
    assert.equal(response.statusCode, 401); assert.equal(response.json().error.code, 'UNAUTHORIZED');
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(response.body.includes(token), false);
  }
  const headers = { authorization: `Bearer ${token}` };
  const first = await app.inject({ url: '/internal/v1/monitor', headers });
  assert.equal(first.statusCode, 200); assert.deepEqual(first.json(), { ok: true, sampledAt: now, startedAt, minutes: [] });
  assert.equal((await app.inject({ url: '/internal/v1/monitor?token=forbidden', headers })).statusCode, 400);
  assert.equal((await app.inject('/api/v1/previews/rides')).statusCode, 200);
  assert.equal((await app.inject('/api/v1/previews/rides/missing')).statusCode, 404);
  assert.equal((await app.inject('/api/v1/unknown-synthetic-route')).statusCode, 404);
  assert.equal((await app.inject('/healthz')).statusCode, 200);
  assert.equal((await app.inject('/api/v1/admin/session')).statusCode, 403);
  assert.equal((await app.inject({ method: 'OPTIONS', url: '/api/v1/previews/rides' })).statusCode, 404);
  for (const url of ['/internal/v1/auth/cloudbase', '/internal/v1/compat/cloudbase']) {
    assert.equal((await app.inject({ method: 'POST', url, payload: {} })).statusCode, 401);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/analytics/session', payload: {} })).statusCode, 401);
  now += 60_000;
  const snapshot = await app.inject({ url: '/internal/v1/monitor', headers });
  assert.equal(snapshot.statusCode, 200);
  assert.deepEqual(snapshot.json(), { ok: true, sampledAt: now, startedAt,
    minutes: [{ at: startedAt, direct: 2, bridge: 2, collection: 1 }] });
  assert.deepEqual((await app.inject({ url: '/internal/v1/monitor', headers })).json(), snapshot.json());
  for (const table of ['users', 'sessions', 'auth_bridge_nonces', 'admin_sessions', 'business_events']) {
    assert.equal((await db.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count, '0');
  }
});

test('traffic monitor stays unavailable without explicitly configured private credentials', integration, async t => {
  const db = await createTestDatabase();
  const app = await createApp({ pool: db.pool, config: { appId, databaseUrl: '', host: '127.0.0.1', port: 0,
    businessMode: 'active', sessionTtlSeconds: 3600 } });
  t.after(async () => { await app.close(); await db.close(); });
  const response = await app.inject({ url: '/internal/v1/monitor', headers: { authorization: `Bearer ${'x'.repeat(64)}` } });
  assert.equal(response.statusCode, 401); assert.equal(response.json().error.code, 'UNAUTHORIZED');
});
