import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../src/errors.ts';
import { sessionService } from '../src/auth/session.ts';
import { registerPrivateRideRoutes } from '../src/rides/private-routes.ts';
import { createTestDatabase } from './helpers/database.ts';

test('private ride HTTP routes authenticate, reject identity overrides and never cache responses',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
    const database = await createTestDatabase();
    const sessions = sessionService(database.pool, {
      databaseUrl: process.env.BACKEND_TEST_DATABASE_URL!, host: '127.0.0.1', port: 3100,
      appId: 'wx-private-routes', sessionTtlSeconds: 3600,
    }, async code => ({ openid: `private-http-${code}` }));
    const app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => {
      const status = error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500;
      return reply.code(status).send({ ok: false, error: { code: error instanceof AppError ? error.code : 'INVALID_INPUT' } });
    });
    // Register this module explicitly: root owns the main application's wiring.
    registerPrivateRideRoutes(app, { pool: database.pool, requireUser: sessions.requireUser });
    t.after(async () => { await app.close(); await database.close(); });
    const [owner, stranger] = await Promise.all([sessions.login('owner'), sessions.login('stranger')]);
    const ownerHeaders = { authorization: `Bearer ${owner.token}` };
    const strangerHeaders = { authorization: `Bearer ${stranger.token}` };
    await database.pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone,details)
      VALUES('private-http-ride','offer',$1,'ny_nj','open',2,now()+interval '1 day','America/New_York','{}')`, [owner.user.id]);
    await database.pool.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state)
      VALUES('private-http-ride',$1,'driver',0,'active')`, [owner.user.id]);

    await t.test('missing, malformed and expired sessions cannot query either private endpoint', async () => {
      for (const url of ['/api/v1/rides/private-http-ride/participants', '/api/v1/me/rides']) {
        for (const headers of [{}, { authorization: 'Bearer invalid' }, { authorization: `Bearer ${'x'.repeat(43)}` }]) {
          const response = await app.inject({ method: 'GET', url, headers });
          assert.equal(response.statusCode, 401);
          assert.equal(response.headers['cache-control'], 'private, no-store');
        }
      }
      const expired = await sessions.login('expired');
      await database.pool.query(`UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1`, [expired.user.id]);
      const response = await app.inject({ method: 'GET', url: '/api/v1/me/rides', headers: { authorization: `Bearer ${expired.token}` } });
      assert.equal(response.statusCode, 401);
      assert.equal(response.headers['cache-control'], 'private, no-store');
    });

    await t.test('members receive the canonical envelope while a different authenticated user gets 404', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/rides/private-http-ride/participants', headers: ownerHeaders });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'private, no-store');
      assert.equal(response.json().ok, true);
      assert.equal(typeof response.json().requestId, 'string');
      assert.equal(response.json().data.participants[0].id, owner.user.id);
      for (const forbidden of [owner.user.openid, owner.token, stranger.user.id]) assert.equal(response.body.includes(forbidden), false);
      for (const id of ['private-http-ride', 'missing']) {
        const denied = await app.inject({ method: 'GET', url: `/api/v1/rides/${id}/participants`, headers: strangerHeaders });
        assert.equal(denied.statusCode, 404);
        assert.equal(denied.json().error.code, 'RIDE_NOT_FOUND');
        assert.equal(denied.headers['cache-control'], 'private, no-store');
      }
    });

    await t.test('caller OpenID/user IDs and extra query keys cannot override the session', async () => {
      for (const query of [`callerOpenID=${owner.user.openid}`, `userId=${owner.user.id}`, 'unused=1']) {
        const response = await app.inject({ method: 'GET', url: `/api/v1/rides/private-http-ride/participants?${query}`, headers: strangerHeaders });
        assert.equal(response.statusCode, 400);
        assert.equal(response.headers['cache-control'], 'private, no-store');
      }
      const overridden = await app.inject({ method: 'GET', url: `/api/v1/me/rides?userId=${owner.user.id}`, headers: strangerHeaders });
      assert.equal(overridden.statusCode, 400);
      const mine = await app.inject({ method: 'GET', url: '/api/v1/me/rides?scope=current&limit=1&page=1', headers: strangerHeaders });
      assert.equal(mine.statusCode, 200);
      assert.deepEqual(mine.json().data, { rides: [], nextPage: null });
      assert.equal(mine.headers['cache-control'], 'private, no-store');
      const owned = await app.inject({ method: 'GET', url: '/api/v1/me/rides', headers: ownerHeaders });
      assert.equal(owned.json().data.rides[0].id, 'private-http-ride');
      assert.equal(owned.json().data.rides[0].role, 'driver');
    });

    await t.test('after cancellation, a previously authorized caller loses private access immediately', async () => {
      await database.pool.query(`UPDATE rides SET status='cancelled' WHERE id='private-http-ride'`);
      const response = await app.inject({ method: 'GET', url: '/api/v1/rides/private-http-ride/participants', headers: ownerHeaders });
      assert.equal(response.statusCode, 404);
      assert.equal(response.headers['cache-control'], 'private, no-store');
      assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/me/rides?scope=history', headers: ownerHeaders })).json().data.rides, []);
    });
  });
