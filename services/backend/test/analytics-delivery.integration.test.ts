import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { deliverBusinessEvents } from '../src/analytics/delivery.ts';
import { AppError } from '../src/errors.ts';
import { createTestDatabase } from './helpers/database.ts';

const enabled = { skip: !process.env.BACKEND_TEST_DATABASE_URL };
const appId = 'delivery-test';
const unavailable = (error: unknown) => {
  assert.ok(error instanceof AppError); assert.equal(error.code, 'COLLECTOR_DELIVERY_UNAVAILABLE');
  assert.doesNotMatch(error.message, /synthetic|secret|openid|哥大/); return true;
};
const eventIds = (body: string): string[] => JSON.parse(body).events.map((event: { eventId: string }) => event.eventId);
const accepted = (body: string) => ({ ok: true, acceptedEventIds: eventIds(body), duplicateEventIds: [] });
async function fixture(pool: Pool, options: { app?: string; id?: string; at?: number; frozen?: boolean; large?: boolean; malformed?: boolean } = {}) {
  const openid = randomUUID();
  const user = (await pool.query('INSERT INTO users(app_id,openid) VALUES($1,$2) RETURNING id', [options.app ?? appId, openid])).rows[0].id;
  const rideId = randomUUID(), id = options.id ?? randomUUID(), at = options.at ?? Date.now() - 1000;
  await pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone,version)
    VALUES($1,'offer',$2,'ny_nj','open',8,clock_timestamp()+interval '1 day','America/New_York',2)`, [rideId, user]);
  const snapshot = (version: number) => ({ cityKey: 'ny_nj', status: 'open',
    departures: Array.from({ length: options.large ? 12 : 1 }, () => ({ address: options.large ? '地'.repeat(200) : '哥大', placeId: '', date: '2026-09-26', time: '15:00' })),
    destinations: Array.from({ length: options.large ? 12 : 1 }, () => ({ address: options.large ? '点'.repeat(200) : 'Fort Lee', placeId: '', date: '', time: '' })),
    referencePriceCents: 800, currency: 'USD', priceKind: 'listed_reference', availableSeats: 7, passengerCount: 1,
    creatorOpenid: openid, driverOpenid: openid, passengerOpenids: [], participantEdges: [{ openid, role: 'driver' }],
    serviceDate: '2026-09-26', departureAtMs: at, latestDepartureAtMs: at, tripVersion: version });
  const event = { schemaVersion: 1, eventId: id, tripId: rideId, tripType: 'carpool', action: 'join', actorOpenid: openid,
    eventAtMs: at, version: 2, before: snapshot(1), after: snapshot(2), affectedOpenids: [openid], synthetic: false, source: 'transaction' };
  const payload = options.frozen === false ? null : options.malformed ? JSON.stringify({ ...event, eventId: 'wrong-event' }) : JSON.stringify(event);
  await pool.query(`INSERT INTO business_events(id,ride_id,ride_version,action,actor_id,payload,created_at,collector_payload)
    VALUES($1,$2,2,'joined',$3,'{}',$4,$5)`, [id, rideId, user, new Date(at), payload]);
  return { id, rideId, user, payload };
}
async function delivered(pool: Pool) {
  return (await pool.query('SELECT id FROM business_events WHERE collector_delivered_at IS NOT NULL ORDER BY id')).rows.map(row => row.id as string);
}

test('delivery scopes by creator app, skips historical events, preserves exact frozen bytes, and completes only selected facts', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const own = await fixture(db.pool, { id: createHash('sha256').update('synthetic non-UUID event').digest('hex') });
  await fixture(db.pool, { app: 'other-app' }); await fixture(db.pool, { frozen: false });
  await db.pool.query("UPDATE rides SET city_key='changed-city' WHERE id=$1", [own.rideId]);
  let calls = 0;
  assert.deepEqual(await deliverBusinessEvents(db.pool, appId, async body => {
    calls++; assert.equal(body, `{"schemaVersion":1,"events":[${own.payload}]}`);
    return accepted(body);
  }), { sent: 1, delivered: 1, lockSkipped: 0 });
  assert.deepEqual(await delivered(db.pool), [own.id]);
  assert.equal((await db.pool.query('SELECT collector_payload FROM business_events WHERE id=$1', [own.id])).rows[0].collector_payload, own.payload);
  assert.deepEqual(await deliverBusinessEvents(db.pool, appId, async () => { throw new Error('must not send'); }), { sent: 0, delivered: 0, lockSkipped: 0 });
  assert.equal(calls, 1);
});

test('one app delivery holds only its session lock over I/O while ride writes and other apps can progress', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close()); const own = await fixture(db.pool);
  await fixture(db.pool, { app: 'another-app' });
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const sending = new Promise<void>(resolve => { entered = resolve; });
  const first = deliverBusinessEvents(db.pool, appId, async body => { entered(); await wait; return accepted(body); });
  await sending;
  try {
    const concurrent = await Promise.all(Array.from({ length: 6 }, () => deliverBusinessEvents(db.pool, appId, async () => { throw new Error('must not send'); })));
    assert.ok(concurrent.every(result => result.lockSkipped === 1 && result.sent === 0));
    await db.pool.query("UPDATE rides SET city_key='still-writable' WHERE id=$1", [own.rideId]);
    assert.deepEqual(await deliverBusinessEvents(db.pool, 'another-app', async body => accepted(body)), { sent: 1, delivered: 1, lockSkipped: 0 });
  } finally { release(); }
  assert.deepEqual(await first, { sent: 1, delivered: 1, lockSkipped: 0 });
});

test('partial ACK and duplicate ACK retry only pending immutable events after response loss', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const start = Date.now() - 10000;
  const fixtures = await Promise.all([0, 1, 2].map(i => fixture(db.pool, { at: start + i })));
  const bodies: string[] = [];
  assert.deepEqual(await deliverBusinessEvents(db.pool, appId, async body => {
    bodies.push(body); return { ok: true, acceptedEventIds: [fixtures[0]!.id], duplicateEventIds: [] };
  }), { sent: 3, delivered: 1, lockSkipped: 0 });
  await assert.rejects(deliverBusinessEvents(db.pool, appId, async body => {
    bodies.push(body); throw new Error('synthetic ACK lost after receiver committed');
  }), unavailable);
  assert.deepEqual(await delivered(db.pool), [fixtures[0]!.id]);
  assert.deepEqual(await deliverBusinessEvents(db.pool, appId, async body => {
    bodies.push(body); const ids = eventIds(body); return { ok: true, acceptedEventIds: ids, duplicateEventIds: ids };
  }), { sent: 2, delivered: 2, lockSkipped: 0 });
  assert.equal(bodies[1], bodies[2]); assert.deepEqual(eventIds(bodies[2]!), fixtures.slice(1).map(row => row.id));
  assert.deepEqual(await delivered(db.pool), fixtures.map(row => row.id).sort());
});

test('malformed or foreign acknowledgements never mark a partial success and release the lock for retry', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close()); const own = await fixture(db.pool);
  const other = await fixture(db.pool, { app: 'other-app' });
  for (const ack of [null, { ok: false, acceptedEventIds: [own.id], duplicateEventIds: [] },
    { ok: true, acceptedEventIds: [own.id] }, { ok: true, acceptedEventIds: [own.id, other.id], duplicateEventIds: [] },
    { ok: true, acceptedEventIds: [], duplicateEventIds: [other.id] }, { ok: true, acceptedEventIds: [own.id, own.id], duplicateEventIds: [] },
    { ok: true, acceptedEventIds: [], duplicateEventIds: [], unexpected: 'synthetic-private' }]) {
    await assert.rejects(deliverBusinessEvents(db.pool, appId, async () => ack), unavailable);
    assert.deepEqual(await delivered(db.pool), []);
  }
  assert.deepEqual(await deliverBusinessEvents(db.pool, appId, async () => ({ ok: true, acceptedEventIds: [], duplicateEventIds: [] })),
    { sent: 1, delivered: 0, lockSkipped: 0 });
  assert.deepEqual(await deliverBusinessEvents(db.pool, appId, async body => accepted(body)), { sent: 1, delivered: 1, lockSkipped: 0 });
});

test('database ACK failure leaves the entire batch pending for receiver deduplication', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close()); await fixture(db.pool); await fixture(db.pool);
  await db.pool.query(`CREATE FUNCTION reject_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic write failure'; END $$`);
  await db.pool.query('CREATE TRIGGER reject_delivery BEFORE UPDATE ON business_events FOR EACH ROW EXECUTE FUNCTION reject_delivery()');
  let first = '';
  await assert.rejects(deliverBusinessEvents(db.pool, appId, async body => { first = body; return accepted(body); }), unavailable);
  assert.deepEqual(await delivered(db.pool), []);
  await db.pool.query('DROP TRIGGER reject_delivery ON business_events');
  assert.deepEqual(await deliverBusinessEvents(db.pool, appId, async body => {
    assert.equal(body, first); return { ok: true, acceptedEventIds: eventIds(body), duplicateEventIds: eventIds(body) };
  }), { sent: 2, delivered: 2, lockSkipped: 0 });
});

test('batch selection has a ten-event and exact UTF-8 byte budget without dropping pending rows', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  for (let i = 0; i < 11; i++) await fixture(db.pool);
  assert.deepEqual(await deliverBusinessEvents(db.pool, appId, async body => {
    assert.equal(eventIds(body).length, 10); assert.ok(Buffer.byteLength(body) <= 112 * 1024); return accepted(body);
  }), { sent: 10, delivered: 10, lockSkipped: 0 });
  assert.deepEqual(await deliverBusinessEvents(db.pool, appId, async body => accepted(body)), { sent: 1, delivered: 1, lockSkipped: 0 });
  for (let i = 0; i < 5; i++) await fixture(db.pool, { large: true });
  const result = await deliverBusinessEvents(db.pool, appId, async body => {
    assert.ok(Buffer.byteLength(body) <= 112 * 1024); assert.ok(eventIds(body).length < 5); return accepted(body);
  });
  assert.ok(result.sent > 0 && result.sent < 5); assert.equal(result.delivered, result.sent);
  assert.equal((await db.pool.query('SELECT count(*)::int AS count FROM business_events WHERE collector_payload IS NOT NULL AND collector_delivered_at IS NULL')).rows[0].count, 5 - result.sent);
});

test('invalid frozen event identity fails before I/O and session connection loss never completes or leaks its lock', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close()); await fixture(db.pool, { malformed: true });
  await assert.rejects(deliverBusinessEvents(db.pool, appId, async () => { assert.fail('invalid payload must not send'); }), unavailable);
  assert.deepEqual(await delivered(db.pool), []);
  const other = 'disconnect-app'; await fixture(db.pool, { app: other });
  const schema = (await db.pool.query('SELECT current_schema() AS name')).rows[0].name;
  const application = `delivery_termination_${randomUUID()}`;
  const workerPool = new Pool({ connectionString: process.env.BACKEND_TEST_DATABASE_URL, max: 1,
    options: `-c search_path=${schema}`, application_name: application });
  try {
    await assert.rejects(deliverBusinessEvents(workerPool, other, async body => {
      // Terminate only the dedicated synthetic connection owned by this test.
      const sessions = (await db.pool.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1', [application])).rows;
      assert.equal(sessions.length, 1);
      await db.pool.query('SELECT pg_terminate_backend($1)', [sessions[0].pid]);
      return accepted(body);
    }), unavailable);
    assert.deepEqual(await deliverBusinessEvents(workerPool, other, async body => accepted(body)), { sent: 1, delivered: 1, lockSkipped: 0 });
  } finally { await workerPool.end(); }
});
