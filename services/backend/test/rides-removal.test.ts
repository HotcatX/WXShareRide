import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { createApp } from '../src/app.ts';
import { AppError } from '../src/errors.ts';
import { createTestDatabase } from './helpers/database.ts';
import { createRide, getRide, joinRide, leaveRide, removeRideMember } from '../src/rides/service.ts';
import { getRideParticipants } from '../src/rides/participants.ts';

const enabled = { skip: !process.env.BACKEND_TEST_DATABASE_URL };
const reason = { reason: '双方协商取消' };
const hasCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
const account = async (pool: Pool) => (await pool.query("INSERT INTO users(app_id,openid) VALUES ('remove-test',$1) RETURNING id", [randomUUID()])).rows[0].id as string;
const offer = (seatCapacity = 3) => ({ kind: 'offer', cityKey: 'ny_nj', timeZone: 'America/New_York',
  stops: [{ kind: 'departure', address: 'Fort Lee', departureAt: new Date(Date.now() + 86400000).toISOString() },
    { kind: 'destination', address: 'Columbia' }], listedPriceCents: 1200, seatCapacity });
const request = (partySize = 1) => { const { seatCapacity: _, ...base } = offer(); return { ...base, kind: 'request', partySize }; };
const passenger = (seatCount = 1) => ({ role: 'passenger', seatCount, pickupAddress: 'Private pickup', dropoffAddress: 'Private dropoff' });
const id = (result: { data: Record<string, unknown> }) => result.data.rideId as string;
const events = async (pool: Pool, rideId: string) => (await pool.query('SELECT action,ride_version,payload FROM business_events WHERE ride_id=$1 ORDER BY ride_version', [rideId])).rows;

test('offer creator removes passenger atomically, frees all reserved seats and preserves one relationship', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const [owner, target, other] = await Promise.all([account(db.pool), account(db.pool), account(db.pool)]);
  const rideId = id(await createRide(db.pool, owner, 'remove.create.offer', offer()));
  await joinRide(db.pool, target, 'remove.join.target', rideId, passenger(2));
  await joinRide(db.pool, other, 'remove.join.other', rideId, passenger());
  const before = (await db.pool.query('SELECT * FROM ride_members WHERE ride_id=$1 AND user_id=$2', [rideId, target])).rows[0];
  const result = await removeRideMember(db.pool, owner, 'remove.member.target', rideId, target, reason);
  assert.equal(result.data.changed, true);
  assert.equal(result.data.version, 4);
  const after = (await db.pool.query('SELECT * FROM ride_members WHERE ride_id=$1 AND user_id=$2', [rideId, target])).rows[0];
  assert.equal(after.state, 'left');
  assert.ok(after.left_at >= after.joined_at);
  assert.deepEqual(after.joined_at, before.joined_at);
  assert.deepEqual(after.details, before.details);
  assert.equal(after.seat_count, 2);
  assert.equal((await getRide(db.pool, rideId)).availableSeats, 2);
  await assert.rejects(getRideParticipants(db.pool, target, rideId), hasCode('RIDE_NOT_FOUND'));
  const ledger = await events(db.pool, rideId);
  assert.deepEqual(ledger.at(-1).payload, { memberId: target, role: 'passenger', seatCount: 2, ...reason });
  const notices = (await db.pool.query("SELECT user_id,type,content FROM notifications WHERE ride_id=$1 AND type='member_removed'", [rideId])).rows;
  assert.equal(notices.length, 1);
  assert.equal(notices[0].user_id, target);
  assert.match(notices[0].content, /双方协商取消/);
  assert.doesNotMatch(notices[0].content, /Private pickup|Private dropoff/);
  assert.equal((await db.pool.query('SELECT count(*)::int AS count FROM ride_members WHERE ride_id=$1', [rideId])).rows[0].count, 3);
});

test('request creator alone can remove passengers and accepted driver, without altering creator party seats', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const [owner, driver, target, other] = await Promise.all(Array.from({ length: 4 }, () => account(db.pool)));
  const rideId = id(await createRide(db.pool, owner!, 'remove.create.request', request(2)));
  await joinRide(db.pool, target!, 'remove.request.passenger', rideId, { role: 'passenger', seatCount: 1 });
  await joinRide(db.pool, driver!, 'remove.request.driver', rideId, { role: 'driver' });
  for (const actor of [driver!, target!, other!]) {
    await assert.rejects(removeRideMember(db.pool, actor, 'remove.not.creator', rideId, actor === target ? driver : target, reason), hasCode('NOT_RIDE_CREATOR'));
  }
  await assert.rejects(removeRideMember(db.pool, owner!, 'remove.creator.self', rideId, owner, reason), hasCode('CREATOR_MUST_CANCEL'));
  await removeRideMember(db.pool, owner!, 'remove.request.target', rideId, target, reason);
  // Old accepted-driver records can have no recorded join instant. Removing
  // such a future relationship records only a real departure from membership.
  await db.pool.query('UPDATE ride_members SET joined_at=NULL WHERE ride_id=$1 AND user_id=$2', [rideId, driver]);
  await removeRideMember(db.pool, owner!, 'remove.request.accepted', rideId, driver, reason);
  const removedDriver = (await db.pool.query('SELECT joined_at,left_at,state FROM ride_members WHERE ride_id=$1 AND user_id=$2', [rideId, driver])).rows[0];
  assert.equal(removedDriver.joined_at, null);
  assert.ok(removedDriver.left_at instanceof Date);
  assert.equal(removedDriver.state, 'left');
  const detail = await getRide(db.pool, rideId);
  assert.equal(detail.availableSeats, 2);
  assert.equal(detail.hasDriver, false);
  const active = (await db.pool.query("SELECT user_id,role,seat_count FROM ride_members WHERE ride_id=$1 AND state='active'", [rideId])).rows;
  assert.deepEqual(active, [{ user_id: owner, role: 'passenger', seat_count: 2 }]);
  const recipients = (await db.pool.query("SELECT user_id FROM notifications WHERE ride_id=$1 AND type='member_removed'", [rideId])).rows.map(row => row.user_id);
  assert.deepEqual(recipients.sort(), [target, driver].sort());
  await assert.rejects(getRideParticipants(db.pool, driver!, rideId), hasCode('RIDE_NOT_FOUND'));
  await joinRide(db.pool, other!, 'remove.replacement.driver', rideId, { role: 'driver' });
  assert.equal((await getRide(db.pool, rideId)).hasDriver, true);
});

test('missing members and historical rides reject new removals; receipts retain their original result', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const [owner, target, stranger] = await Promise.all([account(db.pool), account(db.pool), account(db.pool)]);
  await assert.rejects(removeRideMember(db.pool, owner, 'remove.missing.ride', 'absent-ride', target, reason), hasCode('RIDE_NOT_FOUND'));
  const rideId = id(await createRide(db.pool, owner, 'remove.boundary.offer', offer()));
  await assert.rejects(removeRideMember(db.pool, owner, 'remove.missing.member', rideId, stranger, reason), hasCode('MEMBER_NOT_FOUND'));
  await assert.rejects(removeRideMember(db.pool, owner, 'remove.owner.member', rideId, owner, reason), hasCode('CREATOR_MUST_CANCEL'));
  await joinRide(db.pool, target, 'remove.boundary.join', rideId, passenger());
  const removed = await removeRideMember(db.pool, owner, 'remove.boundary.once', rideId, target, reason);
  assert.equal((await removeRideMember(db.pool, owner, 'remove.already.left', rideId, target, reason)).data.changed, false);
  for (const status of ['closed', 'cancelled']) {
    await db.pool.query('UPDATE rides SET status=$2 WHERE id=$1', [rideId, status]);
    await assert.rejects(removeRideMember(db.pool, owner, `remove.boundary.${status}`, rideId, target, reason), hasCode('RIDE_NOT_OPEN'));
    assert.deepEqual(await removeRideMember(db.pool, owner, 'remove.boundary.once', rideId, target, reason), removed);
  }
  await db.pool.query("UPDATE rides SET status='open',departure_at=now()-interval '1 hour' WHERE id=$1", [rideId]);
  await assert.rejects(removeRideMember(db.pool, owner, 'remove.boundary.past', rideId, target, reason), hasCode('RIDE_NOT_OPEN'));
  assert.equal((await events(db.pool, rideId)).filter(event => event.action === 'removed').length, 1);
});

test('concurrent retries remove once, reject payload reuse, and cannot remove a later rejoin on replay', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const [owner, target] = await Promise.all([account(db.pool), account(db.pool)]);
  const rideId = id(await createRide(db.pool, owner, 'remove.replay.create', offer()));
  await joinRide(db.pool, target, 'remove.replay.join', rideId, passenger());
  const results = await Promise.all(Array.from({ length: 16 }, () => removeRideMember(db.pool, owner, 'remove.replay.same', rideId, target, reason)));
  for (const result of results) assert.deepEqual(result, results[0]);
  await assert.rejects(removeRideMember(db.pool, owner, 'remove.replay.same', rideId, target, { reason: 'Other reason' }), hasCode('IDEMPOTENCY_CONFLICT'));
  await joinRide(db.pool, target, 'remove.replay.rejoin', rideId, passenger());
  assert.deepEqual(await removeRideMember(db.pool, owner, 'remove.replay.same', rideId, target, reason), results[0]);
  assert.equal((await getRide(db.pool, rideId)).availableSeats, 2);
  const fresh = await Promise.all(Array.from({ length: 8 }, (_, index) => removeRideMember(db.pool, owner, `remove.replay.fresh.${index}`, rideId, target, reason)));
  assert.equal(fresh.filter(result => result.data.changed).length, 1);
  assert.equal((await events(db.pool, rideId)).filter(event => event.action === 'removed').length, 2);
  assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM notifications WHERE ride_id=$1 AND type='member_removed'", [rideId])).rows[0].count, 2);
  assert.equal((await db.pool.query('SELECT count(*)::int AS count FROM user_blocks')).rows[0].count, 0);
});

test('competing removal and voluntary exit change the membership and free seats only once', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const [owner, target] = await Promise.all([account(db.pool), account(db.pool)]);
  const rideId = id(await createRide(db.pool, owner, 'remove.leave.create', offer(2)));
  await joinRide(db.pool, target, 'remove.leave.join', rideId, passenger(2));
  const results = await Promise.all([
    removeRideMember(db.pool, owner, 'remove.leave.removal', rideId, target, reason),
    leaveRide(db.pool, target, 'remove.leave.voluntary', rideId, reason),
  ]);
  assert.equal(results.filter(result => result.data.changed).length, 1);
  assert.equal((await getRide(db.pool, rideId)).availableSeats, 2);
  const ledger = await events(db.pool, rideId);
  assert.equal(ledger.length, 3);
  assert.ok(['removed', 'left'].includes(ledger.at(-1).action));
  assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM notifications WHERE ride_id=$1 AND type='member_removed'", [rideId])).rows[0].count, ledger.at(-1).action === 'removed' ? 1 : 0);
});

test('competing removal and joins preserve capacity and driver uniqueness', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const [owner, target, newcomer] = await Promise.all([account(db.pool), account(db.pool), account(db.pool)]);
  const rideId = id(await createRide(db.pool, owner, 'remove.join.create', offer(1)));
  await joinRide(db.pool, target, 'remove.join.original', rideId, passenger());
  const results = await Promise.allSettled([
    removeRideMember(db.pool, owner, 'remove.join.removal', rideId, target, reason),
    joinRide(db.pool, newcomer, 'remove.join.newcomer', rideId, passenger()),
  ]);
  assert.equal(results[0]!.status, 'fulfilled');
  if (results[1]!.status === 'rejected') assert.ok(hasCode('INSUFFICIENT_SEATS')(results[1]!.reason));
  const activeSeats = (await db.pool.query("SELECT COALESCE(sum(seat_count),0)::int AS seats FROM ride_members WHERE ride_id=$1 AND state='active'", [rideId])).rows[0].seats;
  assert.ok(activeSeats === 0 || activeSeats === 1);
  assert.equal((await getRide(db.pool, rideId)).availableSeats, 1 - activeSeats);
  const requestId = id(await createRide(db.pool, owner, 'remove.driver.create', request()));
  await joinRide(db.pool, target, 'remove.driver.original', requestId, { role: 'driver' });
  const driverRace = await Promise.allSettled([
    removeRideMember(db.pool, owner, 'remove.driver.removal', requestId, target, reason),
    joinRide(db.pool, newcomer, 'remove.driver.newcomer', requestId, { role: 'driver' }),
  ]);
  assert.equal(driverRace[0]!.status, 'fulfilled');
  if (driverRace[1]!.status === 'rejected') assert.ok(hasCode('DRIVER_ALREADY_ASSIGNED')(driverRace[1]!.reason));
  assert.ok((await db.pool.query("SELECT count(*)::int AS count FROM ride_members WHERE ride_id=$1 AND state='active' AND role='driver'", [requestId])).rows[0].count <= 1);
});

test('event or directed-notification failure rolls back removal, version, event and retry receipt', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const [owner, target] = await Promise.all([account(db.pool), account(db.pool)]);
  const rideId = id(await createRide(db.pool, owner, 'remove.rollback.create', offer()));
  await joinRide(db.pool, target, 'remove.rollback.join', rideId, passenger());
  for (const table of ['business_events', 'notifications']) {
    const column = table === 'business_events' ? 'action' : 'type';
    const value = table === 'business_events' ? 'removed' : 'member_removed';
    await db.pool.query(`CREATE FUNCTION reject_removal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.${column} = '${value}' THEN RAISE EXCEPTION 'synthetic removal failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER reject_removal BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_removal()`);
    try {
      await assert.rejects(removeRideMember(db.pool, owner, 'remove.rollback.retry', rideId, target, reason), /synthetic removal failure/);
      assert.equal((await getRide(db.pool, rideId)).version, 2);
      assert.equal((await getRide(db.pool, rideId)).availableSeats, 2);
      assert.equal((await db.pool.query('SELECT state FROM ride_members WHERE ride_id=$1 AND user_id=$2', [rideId, target])).rows[0].state, 'active');
      assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM idempotency_requests WHERE request_key='remove.rollback.retry'")).rows[0].count, 0);
      assert.equal((await events(db.pool, rideId)).length, 2);
      assert.equal((await db.pool.query("SELECT count(*)::int AS count FROM notifications WHERE ride_id=$1 AND type='member_removed'", [rideId])).rows[0].count, 0);
    } finally { await db.pool.query(`DROP TRIGGER reject_removal ON ${table}; DROP FUNCTION reject_removal()`); }
  }
  await removeRideMember(db.pool, owner, 'remove.rollback.retry', rideId, target, reason);
  assert.equal((await getRide(db.pool, rideId)).version, 3);
});

test('a removal waiting for the ride lock rechecks the committed departure before changing history', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const [owner, target] = await Promise.all([account(db.pool), account(db.pool)]);
  const rideId = id(await createRide(db.pool, owner, 'remove.wait.create', offer()));
  await joinRide(db.pool, target, 'remove.wait.join', rideId, passenger());
  const writer = await db.pool.connect();
  await writer.query('BEGIN');
  await writer.query('SELECT id FROM rides WHERE id=$1 FOR UPDATE', [rideId]);
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const observingPool = { async connect() {
    const client = await db.pool.connect();
    return { query(sql: string, values?: unknown[]) { if (sql.includes('FOR UPDATE')) started(); return client.query(sql, values); }, release() { client.release(); } };
  } } as unknown as Pool;
  const pending = removeRideMember(observingPool, owner, 'remove.wait.pending', rideId, target, reason);
  const rejected = assert.rejects(pending, hasCode('RIDE_NOT_OPEN'));
  await reading;
  try { await writer.query("UPDATE rides SET departure_at=clock_timestamp()-interval '1 second' WHERE id=$1", [rideId]); }
  finally { await writer.query('COMMIT'); writer.release(); }
  await rejected;
  assert.equal((await db.pool.query('SELECT state FROM ride_members WHERE ride_id=$1 AND user_id=$2', [rideId, target])).rows[0].state, 'active');
  assert.equal((await events(db.pool, rideId)).length, 2);
});

test('HTTP removal authenticates the actor, uses internal target UUID, and rejects ownership injection', enabled, async t => {
  const db = await createTestDatabase();
  const app = await createApp({ pool: db.pool, config: { databaseUrl: process.env.BACKEND_TEST_DATABASE_URL!, host: '127.0.0.1', port: 3100,
    appId: 'wx1234567890123456', sessionTtlSeconds: 3600 }, exchange: async code => ({ openid: `private-${code}` }) });
  t.after(async () => { await app.close(); await db.close(); });
  const login = async (code: string) => (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { code } })).json().data;
  const owner = await login('owner'), target = await login('target'), outsider = await login('outsider');
  const rideId = id(await createRide(db.pool, owner.user.id, 'remove.http.create', offer()));
  await joinRide(db.pool, target.user.id, 'remove.http.join', rideId, passenger());
  const url = `/api/v1/rides/${rideId}/members/${target.user.id}/remove`;
  const headers = { authorization: `Bearer ${owner.token}`, 'idempotency-key': 'remove.http.request' };
  assert.equal((await app.inject({ method: 'POST', url, payload: reason })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url, headers: { authorization: headers.authorization }, payload: reason })).statusCode, 400);
  const denied = await app.inject({ method: 'POST', url, headers: { ...headers, authorization: `Bearer ${outsider.token}` }, payload: reason });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, 'NOT_RIDE_CREATOR');
  for (const payload of [{}, { reason: '' }, { reason: 'x'.repeat(501) }, { ...reason, targetOpenid: target.user.openid }, { ...reason, userId: owner.user.id }]) {
    assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 400);
  }
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/rides/${rideId}/members/${target.user.openid}/remove`, headers, payload: reason })).statusCode, 400);
  const missing = await app.inject({ method: 'POST', url: `/api/v1/rides/${rideId}/members/${outsider.user.id}/remove`, headers, payload: reason });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'MEMBER_NOT_FOUND');
  const removed = await app.inject({ method: 'POST', url, headers, payload: reason });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().data.changed, true);
  assert.deepEqual((await app.inject({ method: 'POST', url, headers, payload: reason })).json().data, removed.json().data);
  for (const privateValue of [owner.token, target.token, owner.user.openid, target.user.openid, 'Private pickup', 'Private dropoff']) assert.equal(removed.body.includes(privateValue), false);
});
