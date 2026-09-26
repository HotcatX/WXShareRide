import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.ts';
import { createTestDatabase } from './helpers/database.ts';

test('ride HTTP routes use sessions, one idempotency contract and public projections', { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
  const database = await createTestDatabase();
  const app = await createApp({
    pool: database.pool,
    config: { databaseUrl: process.env.BACKEND_TEST_DATABASE_URL!, host: '127.0.0.1', port: 3100,
      appId: 'wx1234567890123456', sessionTtlSeconds: 3600 },
    // Only the external WeChat exchange is replaced; real sessions and route
    // authentication still run against the isolated PostgreSQL fixture.
    exchange: async code => ({ openid: `private-http-fixture-${code}` }),
  });
  t.after(async () => { await app.close(); await database.close(); });
  const input = {
    kind: 'offer', cityKey: 'ny_nj', timeZone: 'America/New_York',
    departureAt: new Date(Date.now() + 86400000).toISOString(),
    origin: { address: 'Fort Lee' }, destination: { address: 'Columbia' },
    listedPriceCents: 1200, seatCapacity: 1,
  };
  const ownerLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { code: 'owner' } });
  const owner = ownerLogin.json().data;
  const passengerLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { code: 'passenger' } });
  const passenger = passengerLogin.json().data;
  const ownerHeaders = { authorization: `Bearer ${owner.token}` };
  const passengerHeaders = { authorization: `Bearer ${passenger.token}` };

  await t.test('writes reject missing authentication or idempotency before changing data', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/rides', payload: input })).statusCode, 401);
    for (const key of [undefined, 'short']) {
      const headers = key ? { ...ownerHeaders, 'idempotency-key': key } : ownerHeaders;
      const result = await app.inject({ method: 'POST', url: '/api/v1/rides', headers, payload: input });
      assert.equal(result.statusCode, 400);
      assert.equal(result.json().error.code, 'IDEMPOTENCY_KEY_REQUIRED');
    }
    assert.equal((await database.pool.query('SELECT count(*)::integer AS count FROM rides')).rows[0].count, 0);
  });

  let id: string;
  await t.test('canonical create returns the saved mutation result on replay with a fresh request ID', async () => {
    const headers = { ...ownerHeaders, 'idempotency-key': 'http.create.fixture' };
    const first = await app.inject({ method: 'POST', url: '/api/v1/rides', headers, payload: input });
    const replay = await app.inject({ method: 'POST', url: '/api/v1/rides', headers, payload: input });
    assert.equal(first.statusCode, 201);
    assert.equal(replay.statusCode, 201);
    assert.equal(first.json().ok, true);
    assert.deepEqual(replay.json().data, first.json().data);
    assert.notEqual(replay.json().requestId, first.json().requestId);
    id = first.json().data.rideId;
    const forged = await app.inject({ method: 'POST', url: '/api/v1/rides',
      headers: { ...ownerHeaders, 'idempotency-key': 'http.forged.fixture' }, payload: { ...input, _openid: 'someone-else' } });
    assert.equal(forged.statusCode, 400);
    assert.equal(forged.json().error.code, 'INVALID_INPUT');
  });

  await t.test('public reading and member writes use the documented envelopes without exposing identities', async () => {
    const joined = await app.inject({ method: 'POST', url: `/api/v1/rides/${id}/join`,
      headers: { ...passengerHeaders, 'idempotency-key': 'http.join.fixture' }, payload: { role: 'passenger', seatCount: 1 } });
    assert.equal(joined.statusCode, 200);
    assert.equal(joined.json().data.changed, true);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/rides/${id}` });
    const list = await app.inject({ method: 'GET', url: '/api/v1/rides?kind=offer&limit=1' });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().data.availableSeats, 0);
    assert.equal(list.statusCode, 200);
    for (const response of [detail, list]) {
      for (const value of [owner.token, passenger.token, owner.user.id, passenger.user.id,
        owner.user.openid, passenger.user.openid]) assert.equal(response.body.includes(value), false);
    }
    const cancel = await app.inject({ method: 'POST', url: `/api/v1/rides/${id}/cancel`,
      headers: { ...passengerHeaders, 'idempotency-key': 'http.cancel.fixture' }, payload: { reason: 'Not owner' } });
    assert.equal(cancel.statusCode, 403);
    assert.equal(cancel.json().error.code, 'NOT_RIDE_CREATOR');
    const left = await app.inject({ method: 'POST', url: `/api/v1/rides/${id}/leave`,
      headers: { ...passengerHeaders, 'idempotency-key': 'http.leave.fixture' }, payload: {} });
    assert.equal(left.statusCode, 200);
    assert.equal(left.json().data.changed, true);
  });
});
