import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { createTestDatabase } from './helpers/database.ts';
import { closeDueRides } from '../src/rides/completion.ts';
import { AppError } from '../src/errors.ts';

const enabled = { skip: !process.env.BACKEND_TEST_DATABASE_URL };
const appId = 'completion-test';
async function account(pool: Pool, app = appId) {
  return (await pool.query('INSERT INTO users(app_id,openid) VALUES($1,$2) RETURNING id', [app, randomUUID()])).rows[0].id as string;
}
async function fixture(pool: Pool, options: { kind?: 'offer' | 'request'; seats?: number; matched?: boolean;
  status?: string; futureLast?: boolean; app?: string } = {}) {
  const kind = options.kind ?? 'offer';
  const creator = await account(pool, options.app);
  const peer = await account(pool, options.app);
  const rideId = randomUUID();
  const driver = kind === 'offer' ? creator : peer;
  const passenger = kind === 'request' ? creator : peer;
  await pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone)
    VALUES($1,$2,$3,'ny_nj',$4,8,clock_timestamp()-interval '2 hours','America/New_York')`,
  [rideId, kind, creator, options.status ?? 'open']);
  await pool.query(`INSERT INTO ride_stops(ride_id,position,kind,address,departure_at) VALUES
    ($1,0,'departure','Fort Lee',clock_timestamp()-interval '2 hours'),
    ($1,1,'departure','Columbia',clock_timestamp()+$2::interval),
    ($1,2,'destination','Airport',NULL)`, [rideId, options.futureLast ? '1 hour' : '-1 hour']);
  const rows = kind === 'offer' ? [[driver, 'driver', 0]] : [[passenger, 'passenger', options.seats ?? 1]];
  if (options.matched !== false) rows.push(kind === 'offer' ? [passenger, 'passenger', options.seats ?? 1] : [driver, 'driver', 0]);
  for (const [user, role, seats] of rows) await pool.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state)
    VALUES($1,$2,$3,$4,'active')`, [rideId, user, role, seats]);
  return { rideId, creator, driver, passenger };
}
async function baseline(pool: Pool, value = 8875, app = appId) {
  await pool.query('INSERT INTO public_statistics(app_id,served_count) VALUES($1,$2)', [app, value]);
}
async function total(pool: Pool) {
  return (await pool.query('SELECT served_count::integer AS value FROM public_statistics WHERE app_id=$1', [appId])).rows[0]?.value;
}

test('closure counts accounts separately from public seats, caps public person-trips and invites matched members once', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close()); await baseline(db.pool);
  const offer = await fixture(db.pool, { seats: 7 });
  const request = await fixture(db.pool, { kind: 'request', seats: 3 });
  assert.deepEqual(await closeDueRides(db.pool, appId), { closed: 2, completions: 4, servedDelta: 9 });
  assert.equal(await total(db.pool), 8884);
  const facts = (await db.pool.query('SELECT user_id,role,counted_at,event_id FROM ride_completions ORDER BY user_id')).rows;
  assert.equal(facts.length, 4);
  for (const receipt of facts) assert.ok(receipt.counted_at instanceof Date && receipt.event_id);
  assert.deepEqual(facts.map(f => f.role).sort(), ['driver', 'driver', 'passenger', 'passenger']);
  const events = (await db.pool.query("SELECT actor_id,payload FROM business_events WHERE action='closed'")).rows;
  assert.ok(events.every(event => event.actor_id === null));
  assert.deepEqual(events.map(event => event.payload.servedDelta).sort(), [4, 5]);
  const recipients = (await db.pool.query("SELECT user_id FROM notifications WHERE type='rating_invitation'")).rows.map(row => row.user_id).sort();
  assert.deepEqual(recipients, [offer.driver, offer.passenger, request.driver, request.passenger].sort());
  assert.deepEqual(await closeDueRides(db.pool, appId), { closed: 0, completions: 0, servedDelta: 0 });
  assert.equal(await total(db.pool), 8884);
});

test('lone driver contributes only public count; unmatched request, closed, cancelled and future-last-stop do not get personal counts', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close()); await baseline(db.pool);
  await fixture(db.pool, { matched: false });
  await fixture(db.pool, { kind: 'request', matched: false });
  await fixture(db.pool, { status: 'closed' });
  await fixture(db.pool, { status: 'cancelled' });
  const future = await fixture(db.pool, { futureLast: true });
  await fixture(db.pool, { app: 'other-app' });
  assert.deepEqual(await closeDueRides(db.pool, appId), { closed: 2, completions: 0, servedDelta: 1 });
  assert.equal(await total(db.pool), 8876);
  assert.equal((await db.pool.query('SELECT count(*)::int AS count FROM notifications')).rows[0].count, 0);
  assert.equal((await db.pool.query('SELECT status FROM rides WHERE id=$1', [future.rideId])).rows[0].status, 'open');
  assert.equal((await db.pool.query('SELECT count(*)::int AS count FROM ride_completions')).rows[0].count, 0);
});

test('concurrent closure workers process each ride once without losing the imported public baseline', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close()); await baseline(db.pool);
  for (let i = 0; i < 12; i++) await fixture(db.pool);
  const attempts = await Promise.all(Array.from({ length: 20 }, () => closeDueRides(db.pool, appId, 2)));
  assert.equal(attempts.reduce((sum, result) => sum + result.closed, 0), 12);
  assert.equal(attempts.reduce((sum, result) => sum + result.completions, 0), 24);
  assert.equal(await total(db.pool), 8875 + 24);
  assert.equal((await db.pool.query('SELECT count(*)::int AS count FROM business_events')).rows[0].count, 12);
  assert.equal((await db.pool.query('SELECT count(*)::int AS count FROM notifications')).rows[0].count, 24);
  assert.ok((await db.pool.query('SELECT version,status FROM rides')).rows.every(row => row.version === 2 && row.status === 'closed'));
});

test('missing statistics baseline fails closed and preserves all ride state for a safe retry', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close()); const ride = await fixture(db.pool);
  await assert.rejects(closeDueRides(db.pool, appId), error => error instanceof AppError && error.code === 'STATISTICS_NOT_INITIALIZED');
  assert.deepEqual((await db.pool.query('SELECT status,version FROM rides WHERE id=$1', [ride.rideId])).rows[0], { status: 'open', version: 1 });
  for (const table of ['business_events', 'ride_completions', 'notifications']) {
    assert.equal((await db.pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0);
  }
  await baseline(db.pool, 500);
  assert.deepEqual(await closeDueRides(db.pool, appId), { closed: 1, completions: 2, servedDelta: 2 });
  assert.equal(await total(db.pool), 502);
});

test('event, notification, receipt or statistics failure rolls back the entire closure batch', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close()); await baseline(db.pool);
  await fixture(db.pool); await fixture(db.pool);
  await db.pool.query("CREATE FUNCTION reject_closure_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$");
  for (const table of ['business_events', 'notifications', 'ride_completions', 'public_statistics']) {
    await db.pool.query(`CREATE TRIGGER fail_closure BEFORE ${table === 'public_statistics' ? 'UPDATE' : 'INSERT'} ON ${table}
      FOR EACH ROW EXECUTE FUNCTION reject_closure_write()`);
    await assert.rejects(closeDueRides(db.pool, appId));
    await db.pool.query(`DROP TRIGGER fail_closure ON ${table}`);
    assert.ok((await db.pool.query('SELECT status,version FROM rides')).rows.every(row => row.status === 'open' && row.version === 1));
    assert.equal(await total(db.pool), 8875);
    for (const facts of ['business_events', 'notifications', 'ride_completions']) {
      assert.equal((await db.pool.query(`SELECT count(*)::int AS count FROM ${facts}`)).rows[0].count, 0);
    }
  }
  assert.deepEqual(await closeDueRides(db.pool, appId), { closed: 2, completions: 4, servedDelta: 4 });
});

test('an imported completion receipt keeps its unknown time and original role without creating membership', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close()); await baseline(db.pool);
  const ride = await fixture(db.pool);
  const former = await account(db.pool);
  await db.pool.query(`INSERT INTO ride_completions(ride_id,user_id,role) VALUES($1,$2,'passenger'),($1,$3,'passenger')`,
  [ride.rideId, ride.driver, former]);
  assert.deepEqual(await closeDueRides(db.pool, appId), { closed: 1, completions: 1, servedDelta: 2 });
  const receipt = (await db.pool.query('SELECT role,counted_at,event_id FROM ride_completions WHERE user_id=$1', [ride.driver])).rows[0];
  assert.deepEqual(receipt, { role: 'passenger', counted_at: null, event_id: null });
  assert.equal((await db.pool.query('SELECT count(*)::int AS count FROM ride_members WHERE user_id=$1', [former])).rows[0].count, 0);
});

test('workers skip a held ride and retry it later; job parameters cannot silently widen the app or batch', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close()); await baseline(db.pool);
  const ride = await fixture(db.pool);
  const lock = await db.pool.connect();
  try {
    await lock.query('BEGIN'); await lock.query('SELECT id FROM rides WHERE id=$1 FOR UPDATE', [ride.rideId]);
    assert.deepEqual(await closeDueRides(db.pool, appId), { closed: 0, completions: 0, servedDelta: 0 });
  } finally { await lock.query('ROLLBACK'); lock.release(); }
  for (const size of [0, 501, 1.5, NaN]) await assert.rejects(closeDueRides(db.pool, appId, size));
  await assert.rejects(closeDueRides(db.pool, ' '));
  assert.equal((await closeDueRides(db.pool, appId)).closed, 1);
});

test('database admits an absent actor only for system closure and requires provenance pairs for new receipts', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close()); const ride = await fixture(db.pool);
  for (const [action, actor] of [['rated', null], ['closed', ride.creator]]) {
    await assert.rejects(db.pool.query('INSERT INTO business_events(id,ride_id,ride_version,action,actor_id,payload) VALUES($1,$2,1,$3,$4,$5)',
      [randomUUID(), ride.rideId, action, actor, {}]), /business_events_system_actor/);
  }
  await assert.rejects(db.pool.query("INSERT INTO ride_completions(ride_id,user_id,role,counted_at) VALUES($1,$2,'driver',clock_timestamp())",
    [ride.rideId, ride.driver]), /check constraint/);
});
