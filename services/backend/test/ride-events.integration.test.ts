import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { Pool } from 'pg';
import { createTestDatabase } from './helpers/database.ts';
import { cancelRide, createRide, joinRide, leaveRide, removeRideMember } from '../src/rides/service.ts';
import { closeDueRides } from '../src/rides/completion.ts';
import { rateRide } from '../src/ratings/service.ts';
import { importSnapshot } from '../src/migration/import.ts';
import { migrationUserId } from '../src/migration/users.ts';

// Exercise the actual deployed receiver, not a second local schema that can drift.
const receiver = await import(new URL('../../analytics-collector/src/places.mjs', import.meta.url).href);
const collector = await import(new URL('../../analytics-collector/src/store.mjs', import.meta.url).href);
const enabled = { skip: !process.env.BACKEND_TEST_DATABASE_URL };
const appId = 'collector-event-fixture';
const nowPlus = () => new Date(Date.now() + 86400000).toISOString();
const offer = (overrides = {}) => ({ kind: 'offer', cityKey: 'ny_nj', timeZone: 'America/New_York',
  seatCapacity: 4, listedPriceCents: 1300, stops: [
    { kind: 'departure', address: 'Fort Lee', placeId: 'fort_lee', departureAt: nowPlus() },
    { kind: 'destination', address: '哥大', placeId: 'columbia' },
  ], ...overrides });
const passenger = { role: 'passenger', seatCount: 1, pickupAddress: 'Private pickup', dropoffAddress: 'Private dropoff' };
const id = (result: { data: object }) => (result.data as { rideId: string }).rideId;
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
async function setup(t: TestContext) {
  const db = await createTestDatabase(); t.after(db.close); return db.pool;
}
async function account(pool: Pool, openid = `fixture-${randomUUID()}`, app = appId) {
  return (await pool.query<{ id: string; openid: string }>('INSERT INTO users(app_id,openid) VALUES($1,$2) RETURNING id,openid', [app, openid])).rows[0]!;
}
async function events(pool: Pool, rideId: string) {
  const rows = (await pool.query('SELECT *,collector_payload AS wire FROM business_events WHERE ride_id=$1 ORDER BY ride_version', [rideId])).rows;
  for (const row of rows) {
    if (row.wire === null) continue;
    const event = JSON.parse(row.wire);
    receiver.validateBusinessEvents({ schemaVersion: 1, events: [event] });
    assert.equal(JSON.stringify(event), row.wire);
    assert.equal(event.eventId, row.id);
    assert.equal(event.tripId, row.ride_id);
    assert.equal(event.version, row.ride_version);
    assert.equal(event.eventAtMs, row.created_at.getTime());
  }
  return rows.map(row => ({ ...row, event: row.wire === null ? null : JSON.parse(row.wire) }));
}
async function receiverStore(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'linkx-ride-events-'));
  const store = collector.openStore(join(dir, 'events.sqlite'), { realEnabled: true });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return store;
}

test('every offer mutation freezes real before/after, exact bytes and unchanged cancellation recipients', enabled, async t => {
  const pool = await setup(t);
  const [driver, a, b] = await Promise.all([account(pool), account(pool), account(pool)]);
  const rideId = id(await createRide(pool, driver.id, 'fixture-publish', offer()));
  await joinRide(pool, a.id, 'fixture-join-a', rideId, passenger);
  await joinRide(pool, b.id, 'fixture-join-b', rideId, passenger);
  await leaveRide(pool, a.id, 'fixture-leave', rideId, {});
  await removeRideMember(pool, driver.id, 'fixture-remove-b', rideId, b.id, { reason: 'Fixture removal' });
  await joinRide(pool, b.id, 'fixture-rejoin-b', rideId, passenger);
  await cancelRide(pool, driver.id, 'fixture-cancel', rideId, { reason: 'Fixture cancellation' });
  const rows = await events(pool, rideId);
  assert.deepEqual(rows.map(row => row.event.action), ['publish', 'join', 'join', 'quit', 'kick', 'join', 'cancel']);
  assert.equal(rows[0].event.before, null);
  for (let index = 1; index < rows.length; index++) {
    assert.deepEqual(rows[index].event.before, rows[index - 1].event.after);
    assert.ok(rows[index].event.eventAtMs >= rows[index - 1].event.eventAtMs);
  }
  const removed = rows[4].event;
  assert.ok(removed.before.passengerOpenids.includes(b.openid));
  assert.ok(!removed.after.passengerOpenids.includes(b.openid));
  assert.ok(removed.affectedOpenids.includes(b.openid));
  const cancelled = rows[6].event;
  assert.equal(cancelled.after.status, 'cancelled');
  assert.deepEqual(cancelled.after.participantEdges, []);
  assert.deepEqual(new Set(cancelled.affectedOpenids), new Set([driver.openid, b.openid]));
  assert.deepEqual((await pool.query("SELECT user_id FROM notifications WHERE ride_id=$1 AND type='ride_cancelled'", [rideId])).rows, [{ user_id: b.id }]);
  for (const secret of ['Private pickup', 'Private dropoff', driver.id, a.id, b.id]) {
    assert.equal(rows.some(row => row.wire.includes(secret)), false);
  }
  const frozen = rows.map(row => row.wire);
  await pool.query('UPDATE ride_stops SET address=$2 WHERE ride_id=$1', [rideId, 'Different later address']);
  assert.deepEqual((await events(pool, rideId)).map(row => row.wire), frozen);
  const store = await receiverStore(t);
  // Latest version first is allowed; retired participants must stay retired.
  const body = { schemaVersion: 1, events: rows.map(row => row.event).reverse() };
  assert.equal(store.places.ingestBusiness(body, Date.now()).acceptedEventIds.length, 7);
  assert.equal(store.places.ingestBusiness(body, Date.now()).duplicateEventIds.length, 7);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM place_followup_population WHERE active=1').get().n, 0);
});

test('request acceptance, creator party seats and driver replacement preserve identities and wire actions', enabled, async t => {
  const pool = await setup(t);
  const [creator, a, b] = await Promise.all([account(pool), account(pool), account(pool)]);
  const { seatCapacity: _capacity, ...draft } = offer();
  const rideId = id(await createRide(pool, creator.id, 'fixture-publish', { ...draft, kind: 'request', partySize: 3 }));
  await joinRide(pool, a.id, 'fixture-accept-a', rideId, { role: 'driver' });
  await leaveRide(pool, a.id, 'fixture-quit-a', rideId, {});
  await joinRide(pool, b.id, 'fixture-accept-b', rideId, { role: 'driver' });
  const rows = await events(pool, rideId);
  assert.deepEqual(rows.map(row => row.event.action), ['publish', 'accept', 'quit', 'accept']);
  for (const row of rows) {
    assert.equal(row.event.tripType, 'request');
    assert.equal(row.event.after.passengerCount, 3);
    assert.equal(row.event.after.availableSeats, 1);
    assert.deepEqual(row.event.after.passengerOpenids, [creator.openid]);
  }
  assert.equal(rows[2].event.before.driverOpenid, a.openid);
  assert.equal(rows[2].event.after.driverOpenid, '');
  assert.equal(rows[3].event.after.driverOpenid, b.openid);
});

test('parallel same-key and competing mutations serialize snapshots without duplicate versions', enabled, async t => {
  const pool = await setup(t);
  const [driver, a, b] = await Promise.all([account(pool), account(pool), account(pool)]);
  const draft = offer({ seatCapacity: 1 });
  const created = await Promise.all(Array.from({ length: 4 }, () => createRide(pool, driver.id, 'publish-once', draft)));
  created.forEach(result => assert.deepEqual(result, created[0]));
  const rideId = id(created[0]!);
  const first = await Promise.allSettled([joinRide(pool, a.id, 'fixture-join', rideId, passenger), joinRide(pool, b.id, 'fixture-join', rideId, passenger)]);
  assert.equal(first.filter(result => result.status === 'fulfilled').length, 1);
  const winner = first[0]!.status === 'fulfilled' ? a : b;
  const repeated = await Promise.all(Array.from({ length: 4 }, () => joinRide(pool, winner.id, 'fixture-join', rideId, passenger)));
  repeated.forEach(result => assert.deepEqual(result, repeated[0]));
  const rows = await events(pool, rideId);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].event.before, rows[0].event.after);
  assert.equal(rows[1].event.after.status, 'full');
});

test('event or cancellation notification failure rolls back snapshots, memberships, versions and receipt', enabled, async t => {
  const pool = await setup(t);
  const [driver, a] = await Promise.all([account(pool), account(pool)]);
  const rideId = id(await createRide(pool, driver.id, 'fixture-publish', offer()));
  await joinRide(pool, a.id, 'fixture-join', rideId, passenger);
  const original = (await events(pool, rideId)).map(row => row.wire);
  for (const target of ['business_events', 'notifications']) {
    await pool.query(`CREATE FUNCTION reject_delivery_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected fixture failure'; END; $$;
      CREATE TRIGGER reject_delivery_fixture BEFORE INSERT ON ${target} FOR EACH ROW EXECUTE FUNCTION reject_delivery_fixture()`);
    try {
      await assert.rejects(cancelRide(pool, driver.id, 'cancel-retry', rideId, { reason: 'Fixture' }), /injected fixture failure/);
      assert.deepEqual((await events(pool, rideId)).map(row => row.wire), original);
      assert.equal((await pool.query('SELECT version FROM rides WHERE id=$1', [rideId])).rows[0].version, 2);
      assert.equal((await pool.query("SELECT COUNT(*)::int n FROM ride_members WHERE ride_id=$1 AND state='active'", [rideId])).rows[0].n, 2);
      assert.equal((await pool.query("SELECT COUNT(*)::int n FROM idempotency_requests WHERE user_id=$1 AND request_key='cancel-retry'", [driver.id])).rows[0].n, 0);
    } finally { await pool.query(`DROP TRIGGER reject_delivery_fixture ON ${target}; DROP FUNCTION reject_delivery_fixture()`); }
  }
  await cancelRide(pool, driver.id, 'cancel-retry', rideId, { reason: 'Fixture' });
  assert.equal((await events(pool, rideId)).length, 3);
});

test('real import keeps cloud ride ID, OpenIDs and businessVersion across the first PostgreSQL mutation', enabled, async t => {
  const pool = await setup(t);
  const creatorOpenid = 'legacy_event_driver_account', passengerOpenid = 'legacy_event_passenger_account';
  const createdAt = '2026-01-01T12:00:00.000Z';
  const oldId = '4f8349e066c44499aabbccddeeff0011';
  await importSnapshot(pool, { kind: 'cloudbase-full-export', appId, collections: {
    userInfo: [creatorOpenid, passengerOpenid].map((value, index) => ({ _id: `legacy-user-${index}`, _openid: value, createdAt })),
    Carpool: [{ _id: oldId, _openid: creatorOpenid, status: 'open', cityKey: 'ny_nj', businessVersion: 17,
      passengerCount: 2, availSeatNum: 2, passengers: [], referencePrice: '13',
      departures: [{ address: 'Fort Lee', date: '2027-09-28', time: '15:00' }],
      destinations: [{ address: '哥大' }], createdAt }], CarpoolRequest: [],
    CarpoolTemplate: [], Notifications: [], UserBlocks: [], TripRatings: [], PublicStats: [{ _id: 'home', servedTrips: 0, updatedAt: createdAt }],
  } }, appId);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM business_events')).rows[0].n, 0);
  await joinRide(pool, migrationUserId(appId, passengerOpenid), 'first-pg-join', oldId, passenger);
  const [row] = await events(pool, oldId);
  assert.equal(row.event.tripId, oldId);
  assert.equal(row.event.version, 18);
  assert.equal(row.event.before.tripVersion, 17);
  assert.equal(row.event.before.creatorOpenid, creatorOpenid);
  assert.equal(row.event.actorOpenid, passengerOpenid);
  assert.deepEqual(row.event.after.passengerOpenids, [passengerOpenid]);
  assert.equal((await pool.query('SELECT id FROM rides')).rows[0].id, oldId);
});

test('projection retains full PostgreSQL fields while accepting receiver size, price and New York DST bounds', enabled, async t => {
  const pool = await setup(t), driver = await account(pool);
  const longAddress = '界'.repeat(199) + '😀' + '\n' + 'W'.repeat(60);
  const longPlace = 'x'.repeat(100);
  const rideId = id(await createRide(pool, driver.id, 'boundary', offer({ listedPriceCents: 100_000_000,
    stops: [
      { kind: 'departure', address: longAddress, placeId: longPlace, departureAt: '2027-03-14T06:30:00.000Z' },
      { kind: 'departure', address: '哥大', placeId: 'columbia', departureAt: '2027-03-14T07:30:00.000Z' },
      { kind: 'destination', address: 'JFK', placeId: 'jfk' },
    ] })));
  const [row] = await events(pool, rideId), after = row.event.after;
  assert.equal(after.departures[0].address, '界'.repeat(199));
  assert.equal(after.departures[0].placeId, '');
  assert.equal(after.referencePriceCents, null);
  assert.equal(after.serviceDate, '2027-03-14');
  assert.deepEqual(after.departures.map((point: { time: string }) => point.time), ['01:30', '03:30']);
  assert.equal(after.latestDepartureAtMs, Date.parse('2027-03-14T07:30:00.000Z'));
  const original = (await pool.query('SELECT address,place_id FROM ride_stops WHERE ride_id=$1 AND position=0', [rideId])).rows[0];
  assert.equal(original.address, longAddress);
  assert.equal(original.place_id, longPlace);
  assert.equal((await pool.query('SELECT listed_price_cents FROM rides WHERE id=$1', [rideId])).rows[0].listed_price_cents, 100_000_000);
  const store = await receiverStore(t);
  assert.equal(store.places.ingestBusiness({ schemaVersion: 1, events: [row.event] }, Date.now()).acceptedEventIds[0], row.id);
});

test('closure snapshots qualify real receiver followups; later rating stays local and frozen rows only allow ACK', enabled, async t => {
  const pool = await setup(t);
  const [driver, a] = await Promise.all([account(pool), account(pool)]);
  const rideId = id(await createRide(pool, driver.id, 'fixture-publish', offer()));
  await joinRide(pool, a.id, 'fixture-join', rideId, passenger);
  await pool.query('INSERT INTO public_statistics(app_id,served_count) VALUES($1,0)', [appId]);
  const departure = new Date(Date.now() - 2 * 86400000);
  await pool.query('UPDATE rides SET departure_at=$2 WHERE id=$1', [rideId, departure]);
  await pool.query("UPDATE ride_stops SET departure_at=$2 WHERE ride_id=$1 AND kind='departure'", [rideId, departure]);
  await closeDueRides(pool, appId);
  const closed = (await events(pool, rideId))[2];
  assert.equal(closed.event.action, 'status');
  assert.equal(closed.event.actorOpenid, '');
  assert.equal(closed.event.after.status, 'past');
  assert.equal(closed.event.before.status, 'open');
  assert.equal(closed.event.after.participantEdges.length, 2);
  // Missing city is legal only on imported closed history. Ratings do not
  // fabricate place facts, so they must continue working on these old rows.
  await pool.query('UPDATE rides SET city_key=NULL WHERE id=$1', [rideId]);
  await rateRide(pool, a.id, 'fixture-rating', rideId, { targetId: driver.id, score: 5 });
  const rated = (await events(pool, rideId))[3];
  assert.equal(rated.action, 'rated'); assert.equal(rated.wire, null); assert.equal(rated.collector_delivered_at, null);
  const store = await receiverStore(t);
  store.places.ingestBusiness({ schemaVersion: 1, events: [closed.event] }, Date.now());
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM place_followup_population WHERE active=1').get().n, 2);
  await assert.rejects(pool.query('UPDATE business_events SET collector_payload=$2 WHERE id=$1', [closed.id, rated.wire]), /immutable/);
  await assert.rejects(pool.query('UPDATE business_events SET collector_payload=$2 WHERE id=$1', [rated.id, closed.wire]), /immutable/);
  await assert.rejects(pool.query("UPDATE business_events SET payload='{}' WHERE id=$1", [closed.id]), /immutable/);
  await assert.rejects(pool.query('UPDATE business_events SET collector_delivered_at=clock_timestamp() WHERE id=$1', [rated.id]), /business_events_collector_ack/);
  await pool.query('UPDATE business_events SET collector_delivered_at=clock_timestamp() WHERE id=$1', [closed.id]);
  await assert.rejects(pool.query('UPDATE business_events SET collector_delivered_at=NULL WHERE id=$1', [closed.id]), /immutable/);
  assert.equal((await events(pool, rideId))[2].wire, closed.wire);
});

test('unsupported legacy identity or city fails atomically instead of rewriting collector identities', enabled, async t => {
  const pool = await setup(t);
  const [driver, a] = await Promise.all([account(pool), account(pool)]);
  const rideId = id(await createRide(pool, driver.id, 'fixture-publish', offer()));
  await pool.query('UPDATE rides SET city_key=$2 WHERE id=$1', [rideId, 'City with spaces']);
  await assert.rejects(joinRide(pool, a.id, 'fixture-join', rideId, passenger), code('RIDE_EVENT_INCOMPATIBLE'));
  await pool.query('UPDATE rides SET city_key=$2 WHERE id=$1', [rideId, 'ny_nj']);
  await pool.query('UPDATE users SET openid=$2 WHERE id=$1', [a.id, 'too-short']);
  await assert.rejects(joinRide(pool, a.id, 'fixture-join', rideId, passenger), code('RIDE_EVENT_INCOMPATIBLE'));
  assert.equal((await pool.query('SELECT version FROM rides WHERE id=$1', [rideId])).rows[0].version, 1);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM ride_members WHERE ride_id=$1', [rideId])).rows[0].n, 1);
  assert.equal((await events(pool, rideId)).length, 1);
});
