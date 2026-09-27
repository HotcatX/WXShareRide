import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { registerRideRoutes } from '../src/rides/routes.ts';
import { registerPrivateRideRoutes } from '../src/rides/private-routes.ts';
import { registerRatingRoutes } from '../src/ratings/routes.ts';
import { registerBlockRoutes } from '../src/blocks/routes.ts';
import { createRide } from '../src/rides/service.ts';
import { sessionService } from '../src/auth/session.ts';
import { AppError } from '../src/errors.ts';
import { createTestDatabase } from './helpers/database.ts';
const require = createRequire(import.meta.url);
const { createRideClient } = require('../../../utils/compat/rides.js');
const { createBackendClient } = require('../../../utils/backendClient.js');
const rideTime = require('../../../utils/rideTime.js');

test('real mini rides SDK: public/ACL reads, original-key recovery after re-login, leave/remove/block/cancel use PG truth',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
    const db = await createTestDatabase(), app = Fastify();
    const sessions = sessionService(db.pool, { databaseUrl: '', host: '127.0.0.1', port: 3100,
      appId: 'mini-rides-test', sessionTtlSeconds: 3600 }, async openid => ({ openid }));
    app.setErrorHandler((error, request, reply) => reply.code(error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500)
      .send({ ok: false, error: { code: error instanceof AppError ? error.code : 'INVALID_INPUT', message: error instanceof Error ? error.message : 'failure' }, requestId: request.id }));
    const deps = { pool: db.pool, appId: 'mini-rides-test', requireUser: sessions.requireUser };
    registerRideRoutes(app, deps); registerPrivateRideRoutes(app, deps); registerRatingRoutes(app, deps); registerBlockRoutes(app, deps);
    t.after(async () => { await app.close(); await db.close(); });
    const owner = await sessions.login('synthetic-mini-rides-owner'), passenger = await sessions.login('synthetic-mini-rides-passenger');
    await db.pool.query(`UPDATE users SET name=CASE id WHEN $1 THEN 'Driver' ELSE 'Passenger' END,
      profile='{"wechatId":"private-contact","phone":"private-phone"}' WHERE id=ANY($2::uuid[])`, [owner.user.id, [owner.user.id, passenger.user.id]]);
    const at = new Date(Date.now() + 2 * 86400000).toISOString(), localDate = rideTime.getRideDateTime(Date.parse(at)).date;
    const created = await createRide(db.pool, owner.user.id, 'synthetic-create-offer', { kind: 'offer', cityKey: 'ny_nj', seatCapacity: 3,
      listedPriceCents: null, listedPriceLabel: '11-13$', note: '', timeZone: 'America/New_York',
      stops: [{ kind: 'departure', address: 'Fort Lee', placeId: 'fort_lee', departureAt: at }, { kind: 'destination', address: 'Columbia', placeId: 'columbia' }] });
    const id = created.data.rideId;
    const store = new Map<string, any>([['openid', passenger.user.openid], ['isGuest', false]]), requests: any[] = [];
    let responseMode = '', bridges = 0;
    const wx = {
      getStorageSync: (key: string) => structuredClone(store.get(key)),
      setStorageSync: (key: string, value: unknown) => { store.set(key, structuredClone(value)); },
      removeStorageSync: (key: string) => { store.delete(key); },
      cloud: { async callFunction(options: any) {
        assert.equal(options.name, 'backend'); bridges++;
        return { result: { ok: true, data: await sessions.login(store.get('openid')) } };
      }, database() { throw Error('No legacy database in server mode'); } },
      request(options: any) {
        requests.push(options);
        void app.inject({ method: options.method, url: options.url.replace('https://collect.linkx.ink', ''), headers: options.header,
          ...(options.data === undefined ? {} : { payload: options.data }) }).then(result => {
          if (options.method === 'POST' && result.statusCode < 300 && responseMode === 'drop') { responseMode = ''; options.fail({}); }
          else if (options.method === 'POST' && result.statusCode < 300 && responseMode === 'malformed') {
            responseMode = ''; options.success({ statusCode: result.statusCode, data: { ok: true, data: { rideId: id } } });
          } else options.success({ statusCode: result.statusCode, data: result.json() });
        }).catch(error => options.fail(error));
        return { abort() {} };
      },
    };
    const factory = () => createRideClient({ wx, backend: createBackendClient({ wx, config: { mode: 'server' } }) });
    let api = factory();
    store.set('isGuest', true);
    const guest = await api.getTripDetail('carpool', id);
    assert.equal(guest.driverInfo, null); assert.equal(bridges, 0); assert.equal(guest.data.referencePrice, '11-13$');
    store.set('isGuest', false);
    const outsider = await api.getTripDetail('carpool', id);
    assert.equal(outsider.viewer.role, null); assert.equal(outsider.driverInfo, null);
    const join = { type: 'carpool', tripId: id, pickupAddress: 'Lobby', dropoffAddress: 'Gate' };
    responseMode = 'drop';
    await assert.rejects(api.joinTrip(join), { code: 'NETWORK_ERROR' });
    const first = requests.filter(r => r.url.endsWith('/join')).at(-1);
    await db.pool.query('DELETE FROM sessions WHERE user_id=$1', [passenger.user.id]);
    api = factory();
    const recovered = await api.joinTrip({ ...join, pickupAddress: 'Edited after uncertain submit' });
    assert.equal(recovered.result.recovered, true);
    for (const request of requests.filter(r => r.url.endsWith('/join'))) {
      assert.equal(request.header['Idempotency-Key'], first.header['Idempotency-Key']); assert.deepEqual(request.data, first.data);
    }
    assert.equal((await db.pool.query(`SELECT count(*)::int n FROM ride_members WHERE ride_id=$1 AND user_id=$2 AND state='active'`, [id, passenger.user.id])).rows[0].n, 1);
    const detail = await api.getTripDetail('carpool', id);
    assert.equal(detail.viewer.role, 'passenger'); assert.equal(detail.driverInfo.userId, owner.user.id);
    assert.equal(detail.driverInfo.wechatID, 'private-contact'); assert.equal(detail.data.creatorUserId, owner.user.id);
    assert.equal(detail.participants.find((m: any) => m.userId === passenger.user.id).pickupAddress, 'Lobby');
    assert.equal(detail.participants.some((m: any) => '_openid' in m), false);
    const list = await api.callTripList({ type: 'all', startDate: localDate, endDateExclusive: rideTime.shiftRideDate(localDate, 1) });
    assert.equal(list.result.data.carpool[0].availSeatNum, 2);
    const calendar = await api.callTripList({ month: localDate.slice(0, 7), type: 'all', fromPlace: 'Fort Lee' });
    assert.equal(calendar.result.data.days.find((day: any) => day.date === localDate).carpoolCount, 1);
    assert.equal((await api.getHomeTripList()).result.data.passenger.joinList.length, 1);
    responseMode = 'malformed';
    await assert.rejects(api.callTripManage({ action: 'quitTrip', tripId: id, reason: 'First reason' }), { code: 'INVALID_RESPONSE' });
    api = factory();
    assert.equal((await api.callTripManage({ action: 'quitTrip', tripId: id, reason: 'Different reason' })).recovered, true);
    assert.equal((await api.getTripDetail('carpool', id)).driverInfo, null);
    await api.joinTrip(join);
    store.set('openid', owner.user.openid); api = factory();
    await api.callTripManage({ action: 'kickPassenger', tripId: id, targetUserId: passenger.user.id, reason: 'Changed plan' });
    await api.callTripManage({ action: 'blockUser', targetUserId: passenger.user.id });
    assert.equal((await api.callTripManage({ action: 'getBlockList' })).list[0].targetUserId, passenger.user.id);
    store.set('openid', passenger.user.openid); api = factory();
    await assert.rejects(api.joinTrip(join), { code: 'USER_BLOCKED' });
    store.set('openid', owner.user.openid); api = factory();
    await api.callTripManage({ action: 'unblockUser', targetUserId: passenger.user.id });
    await api.callTripManage({ action: 'deleteTrip', tripId: id, reason: 'Cancelled' });
    await assert.rejects(api.getTripDetail('carpool', id), { code: 'RIDE_NOT_FOUND' });
    assert.equal((await db.pool.query('SELECT status FROM rides WHERE id=$1', [id])).rows[0].status, 'cancelled');
  });

test('actual HTTP/PG keeps public GET and joins within one app while same-app last-seat joins remain serialized',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
    const db = await createTestDatabase(), app = Fastify();
    const makeSessions = (appId: string) => sessionService(db.pool, { databaseUrl: '', host: '127.0.0.1', port: 3100,
      appId, sessionTtlSeconds: 3600 }, async openid => ({ openid }));
    const sessions = makeSessions('mini-rides-app-a'), otherSessions = makeSessions('mini-rides-app-b');
    app.setErrorHandler((error, request, reply) => reply.code(error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500)
      .send({ ok: false, error: { code: error instanceof AppError ? error.code : 'INVALID_INPUT' }, requestId: request.id }));
    const deps = { pool: db.pool, appId: 'mini-rides-app-a', requireUser: sessions.requireUser };
    registerRideRoutes(app, deps); registerPrivateRideRoutes(app, deps);
    t.after(async () => { await app.close(); await db.close(); });
    const [owner, one, two, outsider] = await Promise.all([
      sessions.login('synthetic-cross-app-owner'), sessions.login('synthetic-cross-app-one'), sessions.login('synthetic-cross-app-two'),
      otherSessions.login('synthetic-cross-app-owner'),
    ]);
    const input = { kind: 'offer', cityKey: 'ny_nj', seatCapacity: 1, listedPriceCents: 1000, listedPriceLabel: '$10',
      note: '', timeZone: 'America/New_York', stops: [{ kind: 'departure', address: 'Fort Lee', departureAt: new Date(Date.now() + 86400000).toISOString() },
        { kind: 'destination', address: 'Columbia' }] };
    const ownRide = (await createRide(db.pool, owner.user.id, 'cross-app-own-create', input)).data.rideId;
    const foreignRide = (await createRide(db.pool, outsider.user.id, 'cross-app-foreign-create', input)).data.rideId;
    assert.notEqual(owner.user.id, outsider.user.id, 'same OpenID string in different applications has separate authoritative identity');
    for (const suffix of ['', '/membership', '/participants']) {
      const result = await app.inject({ url: `/api/v1/rides/${foreignRide}${suffix}`, ...(suffix ? { headers: { authorization: `Bearer ${one.token}` } } : {}) });
      assert.equal(result.statusCode, 404); assert.equal(result.json().error.code, 'RIDE_NOT_FOUND');
    }
    const body = { role: 'passenger', seatCount: 1, pickupAddress: 'Lobby', dropoffAddress: 'Gate' };
    const call = (ride: unknown, token: string, key: string) => app.inject({ method: 'POST', url: `/api/v1/rides/${ride}/join`,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': key }, payload: body });
    const rejected = await call(foreignRide, one.token, 'cross-app-forbidden-join');
    assert.equal(rejected.statusCode, 404); assert.equal(rejected.json().error.code, 'RIDE_NOT_FOUND');
    assert.equal((await call(ownRide, outsider.token, 'foreign-token-forbidden')).statusCode, 401);
    const replies = await Promise.all([call(ownRide, one.token, 'last-seat-one'), call(ownRide, two.token, 'last-seat-two'),
      call(foreignRide, two.token, 'cross-app-parallel-forbidden')]);
    assert.deepEqual(replies.slice(0, 2).map(r => r.statusCode).sort(), [200, 409]);
    assert.equal(replies.find(r => r.statusCode === 409)!.json().error.code, 'INSUFFICIENT_SEATS');
    assert.equal(replies[2].statusCode, 404);
    const winner = replies[0].statusCode === 200 ? one : two, key = replies[0].statusCode === 200 ? 'last-seat-one' : 'last-seat-two';
    assert.deepEqual((await call(ownRide, winner.token, key)).json().data, replies.find(r => r.statusCode === 200)!.json().data);
    const counts = (await db.pool.query(`SELECT r.id,count(m.*) FILTER(WHERE m.role='passenger' AND m.state='active')::int AS passengers,
      sum(m.seat_count) FILTER(WHERE m.state='active')::int AS occupied FROM rides r JOIN ride_members m ON m.ride_id=r.id
      GROUP BY r.id ORDER BY r.id`)).rows;
    assert.equal(counts.find(r => r.id === ownRide).passengers, 1); assert.equal(counts.find(r => r.id === ownRide).occupied, 1);
    assert.equal(counts.find(r => r.id === foreignRide).passengers, 0);
    assert.equal((await db.pool.query(`SELECT count(*)::int n FROM business_events WHERE ride_id=$1 AND action='joined'`, [ownRide])).rows[0].n, 1);
    assert.equal((await db.pool.query(`SELECT count(*)::int n FROM idempotency_requests WHERE operation='rides.join' AND user_id=ANY($1::uuid[])`, [[one.user.id, two.user.id]])).rows[0].n, 1);
  });
