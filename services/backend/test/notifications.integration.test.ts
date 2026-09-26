import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.ts';
import { createTestDatabase } from './helpers/database.ts';
import { createRide, joinRide, leaveRide, cancelRide } from '../src/rides/service.ts';
import { clearNotifications, listNotifications, markAllNotificationsRead, markNotificationRead } from '../src/notifications/service.ts';

test('notifications preserve ownership, transaction atomicity, recipient rules and retry boundaries', async t => {
  const db = await createTestDatabase();
  t.after(() => db.close());
  const user = async (openid: string) => (await db.pool.query("INSERT INTO users(app_id,openid) VALUES ('fixture',$1) RETURNING id", [openid])).rows[0].id as string;
  const owner = await user('owner'), passenger = await user('passenger'), other = await user('other'), driver = await user('driver');
  const body = { kind: 'offer', cityKey: 'ny_nj', timeZone: 'America/New_York',
    stops: [{ kind: 'departure', address: 'Fort Lee', departureAt: new Date(Date.now() + 86400000).toISOString() },
      { kind: 'destination', address: 'Columbia' }], seatCapacity: 3, listedPriceCents: 1000 };
  const created = await createRide(db.pool, owner, 'notify.create.offer', body);
  const rideId = created.data.rideId as string;
  await t.test('join generates only a creator notice and replay does not duplicate it', async () => {
    await joinRide(db.pool, passenger, 'notify.join.passenger', rideId, { role: 'passenger', seatCount: 1, pickupAddress: 'Private pickup', dropoffAddress: 'Private dropoff' });
    await joinRide(db.pool, passenger, 'notify.join.passenger', rideId, { role: 'passenger', seatCount: 1, pickupAddress: 'Private pickup', dropoffAddress: 'Private dropoff' });
    await joinRide(db.pool, passenger, 'notify.join.noop', rideId, { role: 'passenger', seatCount: 1, pickupAddress: 'Private pickup', dropoffAddress: 'Private dropoff' });
    const result = await listNotifications(db.pool, owner, {});
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].type, 'passenger_joined');
    assert.equal(result.items[0].rideId, rideId);
    assert.equal(result.unreadCount, 1);
    assert.equal((await listNotifications(db.pool, passenger, {})).items.length, 0);
    assert.equal(JSON.stringify(result).includes(passenger), false);
  });
  await t.test('a notice insertion failure rolls back membership, event, version and receipt', async () => {
    await db.pool.query(`CREATE FUNCTION reject_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic notification failure'; END $$;
      CREATE TRIGGER reject_notice BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION reject_notice()`);
    const before = (await db.pool.query('SELECT version FROM rides WHERE id=$1', [rideId])).rows[0].version;
    await assert.rejects(joinRide(db.pool, other, 'notify.join.rollback', rideId, { role: 'passenger', seatCount: 1, pickupAddress: 'Private pickup', dropoffAddress: 'Private dropoff' }));
    assert.equal((await db.pool.query('SELECT version FROM rides WHERE id=$1', [rideId])).rows[0].version, before);
    assert.equal((await db.pool.query('SELECT 1 FROM ride_members WHERE ride_id=$1 AND user_id=$2', [rideId, other])).rowCount, 0);
    assert.equal((await db.pool.query("SELECT 1 FROM idempotency_requests WHERE request_key='notify.join.rollback'")).rowCount, 0);
    assert.equal((await db.pool.query('SELECT 1 FROM business_events WHERE ride_id=$1', [rideId])).rowCount, 2);
    await db.pool.query('DROP TRIGGER reject_notice ON notifications; DROP FUNCTION reject_notice()');
  });
  await t.test('cancel reaches active members but not users who already left', async () => {
    await joinRide(db.pool, other, 'notify.join.rollback', rideId, { role: 'passenger', seatCount: 1, pickupAddress: 'Private pickup', dropoffAddress: 'Private dropoff' });
    await leaveRide(db.pool, other, 'notify.other.leave', rideId, { reason: '测试退出' });
    await cancelRide(db.pool, owner, 'notify.owner.cancel', rideId, { reason: '测试取消' });
    assert.equal((await listNotifications(db.pool, passenger, {})).items[0].type, 'ride_cancelled');
    assert.equal((await listNotifications(db.pool, other, {})).items.length, 0);
    assert.equal((await db.pool.query("SELECT 1 FROM ride_members WHERE ride_id=$1 AND state='active'", [rideId])).rowCount, 0);
  });
  await t.test('request passenger changes notify creator and driver; driver changes notify passengers', async () => {
    const { seatCapacity: _, ...base } = body;
    const req = await createRide(db.pool, owner, 'notify.create.request', { ...base, kind: 'request', partySize: 1 });
    const id = req.data.rideId as string;
    await joinRide(db.pool, passenger, 'notify.request.passenger', id, { role: 'passenger', seatCount: 1 });
    await joinRide(db.pool, driver, 'notify.request.driver', id, { role: 'driver' });
    await joinRide(db.pool, other, 'notify.request.other', id, { role: 'passenger', seatCount: 1 });
    await leaveRide(db.pool, driver, 'notify.request.leave', id, {});
    const notes = (await db.pool.query('SELECT user_id,type FROM notifications WHERE ride_id=$1', [id])).rows;
    assert.deepEqual(notes.filter(n => n.type === 'driver_assigned').map(n => n.user_id).sort(), [owner, passenger].sort());
    assert.deepEqual(notes.filter(n => n.type === 'driver_left').map(n => n.user_id).sort(), [owner, passenger, other].sort());
    assert.equal(notes.filter(n => n.type === 'passenger_joined' && n.user_id === driver).length, 1);
    assert.equal(notes.filter(n => n.type === 'passenger_joined' && n.user_id === passenger).length, 0);
  });
  await t.test('read and clear are owner-scoped; replays leave later notifications untouched', async () => {
    const notification = (await listNotifications(db.pool, owner, {})).items[0];
    await assert.rejects(markNotificationRead(db.pool, other, 'notify.forged.read', notification.id, {}), { status: 404 });
    await markNotificationRead(db.pool, owner, 'notify.correct.read', notification.id, {});
    const marked = await markAllNotificationsRead(db.pool, owner, 'notify.read.all', {});
    const add = async (id: string) => db.pool.query("INSERT INTO notifications(id,user_id,type,title,content) VALUES ($1,$2,'fixture','合成通知','测试')", [id, owner]);
    await add('after-read-all');
    assert.deepEqual(await markAllNotificationsRead(db.pool, owner, 'notify.read.all', {}), marked);
    assert.equal((await listNotifications(db.pool, owner, {})).unreadCount, 1);
    const otherCount = (await listNotifications(db.pool, passenger, {})).items.length;
    const cleared = await clearNotifications(db.pool, owner, 'notify.clear.all', {});
    await add('after-clear-all');
    assert.deepEqual(await clearNotifications(db.pool, owner, 'notify.clear.all', {}), cleared);
    assert.equal((await listNotifications(db.pool, owner, {})).items.length, 1);
    assert.equal((await listNotifications(db.pool, passenger, {})).items.length, otherCount);
  });
  await t.test('keyset cursor preserves microseconds and tie IDs without skips', async () => {
    await db.pool.query('DELETE FROM notifications WHERE user_id=$1', [owner]);
    const expected = ['page-d','page-c','page-b','page-a'];
    for (const [id,at] of [['page-a','2026-01-01T00:00:00.000001Z'], ['page-b','2026-01-01T00:00:00.000002Z'],
      ['page-c','2026-01-01T00:00:00.000002Z'], ['page-d','2026-01-01T00:00:00.000009Z']]) {
      await db.pool.query("INSERT INTO notifications(id,user_id,type,title,content,created_at) VALUES ($1,$2,'fixture','','',$3)", [id, owner, at]);
    }
    let cursor: string | null = null;
    const found: string[] = [];
    do {
      const page = await listNotifications(db.pool, owner, { limit: 1, ...(cursor ? { cursor } : {}) });
      found.push(...page.items.map(item => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(found, expected);
    await assert.rejects(listNotifications(db.pool, owner, { cursor: 'e30' }), { code: 'INVALID_CURSOR' });
  });
});

test('notification HTTP endpoints authenticate, reject injected owner fields and have no public send operation', async t => {
  const db = await createTestDatabase();
  const app = await createApp({ pool: db.pool, config: { databaseUrl: process.env.BACKEND_TEST_DATABASE_URL!, host: '127.0.0.1', port: 3100,
    appId: 'wx1234567890123456', sessionTtlSeconds: 3600 }, exchange: async code => ({ openid: code }) });
  t.after(async () => { await app.close(); await db.close(); });
  assert.equal((await app.inject({ url: '/api/v1/notifications' })).statusCode, 401);
  const login = (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { code: 'synthetic-owner' } })).json().data;
  const headers = { authorization: `Bearer ${login.token}`, 'idempotency-key': 'http.notifications' };
  assert.equal((await app.inject({ url: '/api/v1/notifications', headers })).json().data.unreadCount, 0);
  assert.equal((await app.inject({ url: '/api/v1/notifications/unread', headers })).json().data.unreadCount, 0);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/notifications/read-all', headers, payload: { userId: 'another' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/notifications', headers, payload: { title: 'forged' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/notifications', headers })).statusCode, 200);
});
