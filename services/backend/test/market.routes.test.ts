import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../src/errors.ts';
import { sessionService } from '../src/auth/session.ts';
import { registerMarketRoutes } from '../src/market/routes.ts';
import { createTestDatabase } from './helpers/database.ts';

test('market HTTP routes use real sessions, private projections and the existing idempotent transaction service', async t => {
  const database = await createTestDatabase();
  const appId = 'market-http-fixture';
  const config = { databaseUrl: process.env.BACKEND_TEST_DATABASE_URL!, host: '127.0.0.1', port: 3100, appId, sessionTtlSeconds: 3600 };
  const sessions = sessionService(database.pool, config, async code => ({ openid: `market-http-${code}` }));
  const foreignSessions = sessionService(database.pool, { ...config, appId: 'other-app' }, async code => ({ openid: `market-http-${code}` }));
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => reply.code(error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500)
    .send({ ok: false, error: { code: error instanceof AppError ? error.code : 'INVALID_INPUT' }, requestId: request.id }));
  registerMarketRoutes(app, { pool: database.pool, appId, requireUser: sessions.requireUser });
  t.after(async () => { await app.close(); await database.close(); });
  const [owner, stranger, foreign, expired] = await Promise.all([sessions.login('owner'), sessions.login('stranger'),
    foreignSessions.login('foreign'), sessions.login('expired')]);
  await database.pool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1", [expired.user.id]);
  const ownerHeaders = { authorization: `Bearer ${owner.token}` };
  const strangerHeaders = { authorization: `Bearer ${stranger.token}` };
  const endDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const payload = { listingType: 'goods', title: 'Synthetic desk', description: 'Synthetic listing', priceCents: 500,
    category: '家具', condition: '99新', region: { state: 'NJ', county: 'Bergen', area: 'Fort Lee' },
    buildingName: '', location: null, startDate: endDate, endDate, sellerContact: null, sublet: null, images: [] };

  await t.test('create requires a real local session and a key, and query/body identity cannot replace the owner', async () => {
    for (const headers of [{}, { authorization: 'Bearer malformed' }, { authorization: `Bearer ${foreign.token}` },
      { authorization: `Bearer ${expired.token}` }]) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/market/listings', headers: { ...headers, 'idempotency-key': 'unauthorized-create' }, payload });
      assert.equal(response.statusCode, 401); assert.equal(response.headers['cache-control'], 'private, no-store');
    }
    const missingKey = await app.inject({ method: 'POST', url: '/api/v1/market/listings', headers: ownerHeaders, payload });
    assert.equal(missingKey.statusCode, 400);
    const forged = await app.inject({ method: 'POST', url: '/api/v1/market/listings',
      headers: { ...ownerHeaders, 'idempotency-key': 'forged-create' }, payload: { ...payload, ownerUserId: stranger.user.id } });
    assert.equal(forged.statusCode, 400);
    assert.equal((await database.pool.query('SELECT count(*)::integer AS count FROM market_listings')).rows[0].count, 0);
  });

  const createOptions = { method: 'POST' as const, url: '/api/v1/market/listings', headers: { ...ownerHeaders, 'idempotency-key': 'valid-create' }, payload };
  const created = await app.inject(createOptions);
  assert.equal(created.statusCode, 201);
  const id = created.json().data.id;
  const url = `/api/v1/market/listings/${id}`;
  assert.deepEqual((await app.inject(createOptions)).json().data, created.json().data);

  await t.test('guest, logged-in and owner representations use the canonical envelope without identity leaks', async () => {
    for (const path of ['/api/v1/market/listings', url, `/api/v1/market/sellers/${owner.user.id}/listings`]) {
      const guest = await app.inject({ method: 'GET', url: path });
      assert.equal(guest.statusCode, 200); assert.equal(guest.headers['cache-control'], 'private, no-store');
      assert.equal(guest.headers.vary, 'Authorization'); assert.equal(guest.json().ok, true);
      assert.equal(typeof guest.json().requestId, 'string');
      assert.ok(!guest.body.includes('sellerContact')); assert.ok(!guest.body.includes('wechatId'));
      assert.ok(!guest.body.includes(owner.user.openid)); assert.ok(!guest.body.includes(owner.token));
      const loggedIn = await app.inject({ method: 'GET', url: path, headers: strangerHeaders });
      assert.equal(loggedIn.statusCode, 200); assert.ok(loggedIn.body.includes('sellerContact'));
      assert.ok(!loggedIn.body.includes(owner.user.openid));
      for (const token of ['invalid', foreign.token, expired.token]) {
        const denied = await app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${token}` } });
        assert.equal(denied.statusCode, 401); assert.ok(!denied.body.includes('sellerContact'));
      }
    }
    const mine = await app.inject({ method: 'GET', url: '/api/v1/me/market/listings', headers: ownerHeaders });
    assert.deepEqual(mine.json().data.items.map((item: { id: string }) => item.id), [id]);
    assert.equal(mine.json().data.items[0].isOwner, true);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/me/market/listings', headers: strangerHeaders })).json().data.items, []);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/me/market/listings' })).statusCode, 401);
    for (const path of ['/api/v1/market/listings', url, '/api/v1/me/market/listings']) {
      const forged = await app.inject({ method: 'GET', url: `${path}?callerOpenID=${owner.user.openid}`, headers: strangerHeaders });
      assert.equal(forged.statusCode, 400);
    }
  });

  await t.test('update, status and delete preserve service authorization, version conflicts and permanent receipts', async () => {
    for (const [method, path, body] of [['PATCH', url, { expectedVersion: 0, patch: { title: 'Denied' } }],
      ['POST', `${url}/status`, { expectedVersion: 0, status: 'offline' }], ['DELETE', url, { expectedVersion: 0 }]] as const) {
      const response = await app.inject({ method, url: path, headers: { ...strangerHeaders, 'idempotency-key': `denied-${method}` }, payload: body });
      assert.equal(response.statusCode, 404); assert.equal(response.json().error.code, 'LISTING_NOT_FOUND');
    }
    const update = { method: 'PATCH' as const, url, headers: { ...ownerHeaders, 'idempotency-key': 'update-item' },
      payload: { expectedVersion: 0, patch: { title: 'Updated title' } } };
    const updated = await app.inject(update);
    assert.equal(updated.statusCode, 200); assert.equal(updated.json().data.version, 1);
    assert.deepEqual((await app.inject(update)).json().data, updated.json().data);
    const conflict = await app.inject({ ...update, headers: { ...ownerHeaders, 'idempotency-key': 'stale-edit' } });
    assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().error.code, 'LISTING_VERSION_CONFLICT');
    const offline = await app.inject({ method: 'POST', url: `${url}/status`, headers: { ...ownerHeaders, 'idempotency-key': 'offline-item' },
      payload: { expectedVersion: 1, status: 'offline' } });
    assert.equal(offline.statusCode, 200); assert.equal(offline.json().data.status, 'offline');
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url, headers: ownerHeaders })).statusCode, 200);
    const deletion = { method: 'DELETE' as const, url, headers: { ...ownerHeaders, 'idempotency-key': 'delete-item' }, payload: { expectedVersion: 2 } };
    const deleted = await app.inject(deletion);
    assert.equal(deleted.statusCode, 200); assert.equal(deleted.json().data.status, 'deleted');
    assert.deepEqual((await app.inject(deletion)).json().data, deleted.json().data);
    assert.deepEqual((await app.inject(createOptions)).json().data, created.json().data);
    assert.equal((await app.inject({ method: 'GET', url, headers: ownerHeaders })).statusCode, 404);
    assert.equal((await database.pool.query('SELECT status FROM market_listings WHERE id=$1', [id])).rows[0].status, 'deleted');
  });
});
