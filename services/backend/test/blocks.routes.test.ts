import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.ts';
import { createTestDatabase } from './helpers/database.ts';

test('block HTTP routes authenticate the actor, reject aliases and preserve idempotency',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
    const database = await createTestDatabase();
    const app = await createApp({
      pool: database.pool,
      config: { databaseUrl: process.env.BACKEND_TEST_DATABASE_URL!, host: '127.0.0.1', port: 3100,
        appId: 'wx1234567890123456', sessionTtlSeconds: 3600 },
      exchange: async code => ({ openid: `private-block-http-${code}` }),
    });
    t.after(async () => { await app.close(); await database.close(); });
    async function login(code: string) {
      const result = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { code } });
      assert.equal(result.statusCode, 200);
      const { user, token } = result.json().data;
      return { ...user, headers: { authorization: `Bearer ${token}` } };
    }
    const [a, b, c] = await Promise.all([login('a'), login('b'), login('c')]);

    await t.test('every endpoint requires a session; every write requires the central idempotency key', async () => {
      for (const request of [
        { method: 'GET' as const, url: '/api/v1/blocks' },
        { method: 'POST' as const, url: '/api/v1/blocks', payload: { targetUserId: b.id } },
        { method: 'DELETE' as const, url: `/api/v1/blocks/${b.id}` },
      ]) assert.equal((await app.inject(request)).statusCode, 401);
      for (const headers of [a.headers, { ...a.headers, 'idempotency-key': 'short' }]) {
        const created = await app.inject({ method: 'POST', url: '/api/v1/blocks', headers, payload: { targetUserId: b.id } });
        const removed = await app.inject({ method: 'DELETE', url: `/api/v1/blocks/${b.id}`, headers });
        for (const result of [created, removed]) {
          assert.equal(result.statusCode, 400);
          assert.equal(result.json().error.code, 'IDEMPOTENCY_KEY_REQUIRED');
        }
      }
      assert.equal((await database.pool.query('SELECT count(*)::integer AS count FROM user_blocks')).rows[0].count, 0);
    });

    await t.test('canonical block writes replay their saved result and refuse actor/body aliases', async () => {
      const headers = { ...a.headers, 'idempotency-key': 'http.block.fixture' };
      const payload = { targetUserId: b.id, reason: 'Fixture scheduling issue' };
      const first = await app.inject({ method: 'POST', url: '/api/v1/blocks', headers, payload });
      const second = await app.inject({ method: 'POST', url: '/api/v1/blocks', headers, payload });
      assert.equal(first.statusCode, 200);
      assert.equal(second.statusCode, 200);
      assert.equal(first.json().ok, true);
      assert.deepEqual(second.json().data, first.json().data);
      assert.notEqual(second.json().requestId, first.json().requestId);
      const conflicting = await app.inject({ method: 'POST', url: '/api/v1/blocks', headers, payload: { ...payload, reason: 'Different' } });
      assert.equal(conflicting.statusCode, 409);
      assert.equal(conflicting.json().error.code, 'IDEMPOTENCY_CONFLICT');
      const forged = await app.inject({ method: 'POST', url: '/api/v1/blocks',
        headers: { ...a.headers, 'idempotency-key': 'http.alias.fixture' }, payload: { targetUserId: c.id, blockerOpenid: b.openid } });
      assert.equal(forged.statusCode, 400);
      assert.equal(forged.json().error.code, 'INVALID_INPUT');
    });

    await t.test('listing is owner-only and cannot disclose incoming blocks or account secrets', async () => {
      const incoming = await app.inject({ method: 'POST', url: '/api/v1/blocks',
        headers: { ...c.headers, 'idempotency-key': 'http.incoming.fixture' }, payload: { targetUserId: a.id, reason: 'Incoming private reason' } });
      assert.equal(incoming.statusCode, 200);
      const mine = await app.inject({ method: 'GET', url: '/api/v1/blocks', headers: a.headers });
      assert.equal(mine.statusCode, 200);
      assert.equal(mine.json().data.blocks.length, 1);
      assert.equal(mine.json().data.blocks[0].targetUserId, b.id);
      for (const secret of [a.openid, b.openid, c.id, 'Incoming private reason']) assert.equal(mine.body.includes(secret), false);
      const other = await app.inject({ method: 'GET', url: '/api/v1/blocks', headers: b.headers });
      assert.deepEqual(other.json().data, { blocks: [], nextPage: null });
      const forged = await app.inject({ method: 'GET', url: `/api/v1/blocks?userId=${a.id}`, headers: b.headers });
      assert.equal(forged.statusCode, 400);
    });

    await t.test('deletion can only clear the authenticated actor’s outgoing relation and replays safely', async () => {
      const headers = { ...b.headers, 'idempotency-key': 'http.wrong-direction' };
      const wrong = await app.inject({ method: 'DELETE', url: `/api/v1/blocks/${a.id}`, headers });
      assert.equal(wrong.statusCode, 200);
      assert.equal(wrong.json().data.changed, false);
      assert.equal((await app.inject({ method: 'GET', url: '/api/v1/blocks', headers: a.headers })).json().data.blocks.length, 1);
      const request = { method: 'DELETE' as const, url: `/api/v1/blocks/${b.id}`,
        headers: { ...a.headers, 'idempotency-key': 'http.delete.fixture' } };
      const first = await app.inject(request);
      const second = await app.inject(request);
      assert.equal(first.statusCode, 200);
      assert.equal(first.json().data.changed, true);
      assert.deepEqual(second.json().data, first.json().data);
      assert.equal((await app.inject({ method: 'GET', url: '/api/v1/blocks', headers: a.headers })).json().data.blocks.length, 0);
      assert.equal((await app.inject({ method: 'GET', url: '/api/v1/blocks', headers: c.headers })).json().data.blocks.length, 1);
    });
  });
