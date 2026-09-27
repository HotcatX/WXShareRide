import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { registerCityRequestRoutes } from '../src/locations/requests.ts';
import { sessionService } from '../src/auth/session.ts';
import { AppError } from '../src/errors.ts';
import { createTestDatabase } from './helpers/database.ts';
const require = createRequire(import.meta.url);
const { createBackendClient } = require('../../../utils/backendClient.js');
const { createRideClient } = require('../../../utils/compat/rides.js');

test('guest city request uses verified identity, survives lost ACK/restart and never changes product login state',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
    const db = await createTestDatabase(), app = Fastify();
    const sessions = sessionService(db.pool, { databaseUrl: '', host: '127.0.0.1', port: 3100, appId: 'city-test', sessionTtlSeconds: 3600 }, async openid => ({ openid }));
    app.setErrorHandler((error, request, reply) => reply.code(error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500)
      .send({ ok: false, error: { code: error instanceof AppError ? error.code : 'INVALID_INPUT', message: 'failure' }, requestId: request.id }));
    registerCityRequestRoutes(app, { pool: db.pool, requireUser: sessions.requireUser });
    t.after(async () => { await app.close(); await db.close(); });
    const store = new Map<string, any>([['isGuest', true]]), requests: any[] = [];
    let identity = 'synthetic-city-guest', mode = '', bridges = 0;
    const wx = {
      getStorageSync: (key: string) => structuredClone(store.get(key)), setStorageSync: (key: string, value: unknown) => { store.set(key, structuredClone(value)); },
      removeStorageSync: (key: string) => { store.delete(key); },
      cloud: { async callFunction(options: any) { assert.equal(options.name, 'backend'); bridges++; return { result: { ok: true, data: await sessions.login(identity) } }; }, database() { throw Error('No legacy DB'); } },
      request(options: any) {
        requests.push(options);
        if (mode === 'forbidden') { mode = ''; options.success({ statusCode: 403, data: { ok: false, error: { code: 'FORBIDDEN', message: 'temporarily unavailable' } } }); return { abort() {} }; }
        void app.inject({ method: options.method, url: options.url.replace('https://collect.linkx.ink', ''), headers: options.header, payload: options.data })
          .then(result => {
            if (result.statusCode < 300 && mode === 'drop') { mode = ''; options.fail({}); }
            else if (result.statusCode < 300 && mode === 'malformed') { mode = ''; options.success({ statusCode: result.statusCode, data: { ok: true, data: { requestId: 'invalid' } } }); }
            else options.success({ statusCode: result.statusCode, data: result.json() });
          }).catch(error => options.fail(error)); return { abort() {} };
      },
    };
    const factory = () => createRideClient({ wx, backend: createBackendClient({ wx, config: { mode: 'server' } }) });
    let api = factory(); mode = 'drop';
    await assert.rejects(api.requestCity({ cityKey: 'boston', cityLabel: 'Untrusted label', cityAliases: ['untrusted'], sourcePage: 'home' }), { code: 'NETWORK_ERROR' });
    const original = requests[0];
    await db.pool.query('DELETE FROM sessions'); api = factory();
    mode = 'forbidden';
    await assert.rejects(api.requestCity({ cityKey: 'atlanta', sourcePage: 'carpoolList' }), { code: 'FORBIDDEN' });
    api = factory();
    const recovered = await api.requestCity({ cityKey: 'atlanta', sourcePage: 'carpoolList' });
    assert.equal(recovered.result.recovered, true); assert.equal(recovered.result.cityKey, 'boston');
    assert.ok(requests.every(request => request.header['Idempotency-Key'] === original.header['Idempotency-Key']));
    assert.ok(requests.every(request => JSON.stringify(request.data) === JSON.stringify(original.data)));
    assert.equal(store.get('openid'), undefined); assert.equal(store.get('isGuest'), true); assert.equal(bridges, 3);
    const first = (await db.pool.query('SELECT c.*,u.openid,u.app_id FROM city_requests c JOIN users u ON u.id=c.user_id')).rows;
    assert.equal(first.length, 1); assert.equal(first[0].openid, identity); assert.equal(first[0].app_id, 'city-test');
    assert.equal(first[0].city_key, 'boston'); assert.notEqual(first[0].city_label, 'Untrusted label'); assert.equal(first[0].source_page, 'home');
    assert.equal((await api.requestCity({ cityKey: 'atlanta', sourcePage: 'carpoolList' })).result.status, 'recorded');
    mode = 'malformed'; await assert.rejects(api.requestCity({ cityKey: 'boston', sourcePage: 'home' }), { code: 'INVALID_RESPONSE' });
    api = factory(); assert.equal((await api.requestCity({ cityKey: 'atlanta', sourcePage: 'home' })).result.cityKey, 'boston');
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM city_requests')).rows[0].n, 3);
    assert.equal((await api.requestCity({ cityKey: 'ny', sourcePage: 'home' })).result.status, 'already_available');
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM city_requests')).rows[0].n, 3);
    const user = await sessions.login(identity), other = await sessions.login('synthetic-city-other');
    const send = (token: string, key: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/v1/locations/requests', headers: { authorization: `Bearer ${token}`, 'idempotency-key': key }, payload });
    const body = { cityKey: 'boston', sourcePage: 'home' };
    const parallel = await Promise.all([send(user.token, 'same-request-key', body), send(user.token, 'same-request-key', body), send(other.token, 'same-request-key', body)]);
    assert.ok(parallel.every(response => response.statusCode === 201));
    assert.equal(parallel[0]!.json().data.requestId, parallel[1]!.json().data.requestId);
    assert.notEqual(parallel[0]!.json().data.requestId, parallel[2]!.json().data.requestId);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM city_requests')).rows[0].n, 5);
    for (const payload of [{ ...body, openid: 'spoofed' }, { ...body, cityLabel: 'spoofed' }, { ...body, cityKey: 'unknown' }, { ...body, sourcePage: 'arbitrary' }]) {
      assert.equal((await send(user.token, 'rejected-request-key', payload)).statusCode, 400);
    }
    const foreign = sessionService(db.pool, { databaseUrl: '', host: '127.0.0.1', port: 3100, appId: 'foreign-city-app', sessionTtlSeconds: 3600 }, async openid => ({ openid }));
    assert.equal((await send((await foreign.login(identity)).token, 'cross-app-request-key', body)).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/locations/requests', payload: body })).statusCode, 401);
    assert.equal(store.get('openid'), undefined); assert.equal(store.get('isGuest'), true);
  });
