import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { createTestDatabase } from './helpers/database.ts';
import { cancelRide, createRide, getRide, joinRide, leaveRide, listRides } from '../src/rides/service.ts';

function offer(overrides = {}) {
  return {
    kind: 'offer', cityKey: 'ny_nj', timeZone: 'America/New_York',
    departureAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    origin: { address: 'Fort Lee', placeId: 'fort_lee' },
    destination: { address: 'Columbia', placeId: 'columbia' },
    listedPriceCents: 1200, note: 'Test fixture', seatCapacity: 1, ...overrides,
  };
}

function request(partySize = 1) {
  const { seatCapacity: _capacity, ...fields } = offer();
  return { ...fields, kind: 'request', partySize };
}

async function account(pool: Pool) {
  const openid = `private-fixture-openid-${randomUUID()}`;
  const result = await pool.query<{ id: string }>(`INSERT INTO users(app_id, openid, name, profile)
    VALUES ('rides-test-app', $1, 'Test rider', '{"phone":"private-phone","sessionSecret":"private-secret"}'::jsonb)
    RETURNING id`, [openid]);
  return { id: result.rows[0].id, openid };
}

const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
const rideId = (result: { data: object }) => (result.data as { rideId: string }).rideId;

test('ride service integrates against isolated PostgreSQL', { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
  const database = await createTestDatabase();
  const { pool } = database;
  t.after(() => database.close());

  await t.test('simultaneous create retries share a result and cannot replay a different payload', async () => {
    const creator = await account(pool);
    const input = offer();
    const results = await Promise.all([
      createRide(pool, creator.id, 'create-once', input),
      createRide(pool, creator.id, 'create-once', input),
    ]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].status, 201);
    const id = rideId(results[0]);
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM rides WHERE id = $1', [id])).rows[0].count, 1);
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM business_events WHERE ride_id = $1', [id])).rows[0].count, 1);
    await assert.rejects(createRide(pool, creator.id, 'create-once', { ...input, listedPriceCents: 1300 }));
    assert.equal((await getRide(pool, id)).listedPriceCents, 1200);
  });

  await t.test('two passengers competing for one seat cannot overbook', async () => {
    const [creator, passengerA, passengerB] = await Promise.all([account(pool), account(pool), account(pool)]);
    const id = rideId(await createRide(pool, creator.id, 'create-fixture', offer()));
    const results = await Promise.allSettled([
      joinRide(pool, passengerA.id, 'join-fixture', id, { role: 'passenger', seatCount: 1 }),
      joinRide(pool, passengerB.id, 'join-fixture', id, { role: 'passenger', seatCount: 1 }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejection = results.find(result => result.status === 'rejected');
    assert.ok(rejection && rejection.status === 'rejected' && code('INSUFFICIENT_SEATS')(rejection.reason));
    assert.equal((await getRide(pool, id)).availableSeats, 0);
    const ledger = (await pool.query('SELECT action, ride_version FROM business_events WHERE ride_id = $1 ORDER BY ride_version', [id])).rows;
    assert.deepEqual(ledger, [{ action: 'created', ride_version: 1 }, { action: 'joined', ride_version: 2 }]);
  });

  await t.test('request creator party seats survive driver acceptance and enforce the four-seat limit', async () => {
    const [creator, driver, passenger] = await Promise.all([account(pool), account(pool), account(pool)]);
    const id = rideId(await createRide(pool, creator.id, 'create-fixture', request(4)));
    await assert.rejects(joinRide(pool, passenger.id, 'join-fixture', id, { role: 'passenger', seatCount: 1 }), code('INSUFFICIENT_SEATS'));
    await joinRide(pool, driver.id, 'accept-fixture', id, { role: 'driver' });
    const members = (await pool.query('SELECT role, seat_count FROM ride_members WHERE ride_id = $1 ORDER BY seat_count', [id])).rows;
    assert.deepEqual(members, [{ role: 'driver', seat_count: 0 }, { role: 'passenger', seat_count: 4 }]);
    const visible = await getRide(pool, id);
    assert.equal(visible.seatCapacity, 4);
    assert.equal(visible.availableSeats, 0);
    assert.equal(visible.hasDriver, true);
  });

  await t.test('competing request drivers serialize; leaving opens the driver position again', async () => {
    const [creator, driverA, driverB] = await Promise.all([account(pool), account(pool), account(pool)]);
    const id = rideId(await createRide(pool, creator.id, 'create-fixture', request(2)));
    const results = await Promise.allSettled([
      joinRide(pool, driverA.id, 'accept-fixture', id, { role: 'driver' }),
      joinRide(pool, driverB.id, 'accept-fixture', id, { role: 'driver' }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const active = (await pool.query(`SELECT user_id FROM ride_members WHERE ride_id = $1 AND role = 'driver' AND state = 'active'`, [id])).rows[0].user_id;
    const other = active === driverA.id ? driverB.id : driverA.id;
    await leaveRide(pool, active, 'leave-fixture', id, {});
    await joinRide(pool, other, 'accept-after-leave', id, { role: 'driver' });
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ride_members WHERE ride_id = $1 AND role = 'driver' AND state = 'active'`, [id])).rows[0].count, 1);
    assert.equal((await getRide(pool, id)).availableSeats, 2);
  });

  await t.test('repeated membership operations are no-ops and a rejoin reserves seats once', async () => {
    const [creator, passenger] = await Promise.all([account(pool), account(pool)]);
    const id = rideId(await createRide(pool, creator.id, 'create-fixture', offer({ seatCapacity: 2 })));
    const joined = await joinRide(pool, passenger.id, 'join-fixture', id, { role: 'passenger', seatCount: 2 });
    assert.deepEqual(await joinRide(pool, passenger.id, 'join-fixture', id, { role: 'passenger', seatCount: 2 }), joined);
    assert.equal((await joinRide(pool, passenger.id, 'join-again', id, { role: 'passenger', seatCount: 2 })).data.changed, false);
    await assert.rejects(joinRide(pool, passenger.id, 'change-seats', id, { role: 'passenger', seatCount: 1 }), code('MEMBERSHIP_EXISTS'));
    await leaveRide(pool, passenger.id, 'leave-fixture', id, {});
    assert.equal((await leaveRide(pool, passenger.id, 'leave-again', id, {})).data.changed, false);
    assert.equal((await getRide(pool, id)).availableSeats, 2);
    await joinRide(pool, passenger.id, 'rejoin-fixture', id, { role: 'passenger', seatCount: 1 });
    assert.equal((await getRide(pool, id)).availableSeats, 1);
    const versions = (await pool.query('SELECT ride_version FROM business_events WHERE ride_id = $1 ORDER BY ride_version', [id])).rows.map(row => row.ride_version);
    assert.deepEqual(versions, [1, 2, 3, 4]);
  });

  await t.test('ownership checks reject unauthorized cancellation, creator leave and role replacement', async () => {
    const [creator, outsider] = await Promise.all([account(pool), account(pool)]);
    const id = rideId(await createRide(pool, creator.id, 'create-fixture', offer()));
    await assert.rejects(cancelRide(pool, outsider.id, 'cancel-fixture', id, { reason: 'Not my ride' }), code('NOT_RIDE_CREATOR'));
    await assert.rejects(leaveRide(pool, creator.id, 'leave-fixture', id, {}), code('CREATOR_MUST_CANCEL'));
    await assert.rejects(joinRide(pool, creator.id, 'join-fixture', id, { role: 'passenger', seatCount: 1 }), code('CREATOR_ALREADY_MEMBER'));
    await assert.rejects(joinRide(pool, outsider.id, 'driver-fixture', id, { role: 'driver' }), code('INVALID_ROLE'));
    await assert.rejects(leaveRide(pool, outsider.id, 'leave-fixture', id, {}), code('NOT_A_MEMBER'));
    await cancelRide(pool, creator.id, 'cancel-fixture', id, { reason: 'Plans changed' });
    assert.equal((await cancelRide(pool, creator.id, 'cancel-again', id, { reason: 'Plans changed' })).data.changed, false);
    await assert.rejects(getRide(pool, id), code('RIDE_NOT_FOUND'));
  });

  await t.test('failed event insertion rolls back seats, version and idempotency so the same key can retry', async () => {
    const [creator, passenger] = await Promise.all([account(pool), account(pool)]);
    const id = rideId(await createRide(pool, creator.id, 'create-fixture', offer()));
    await pool.query(`CREATE FUNCTION reject_test_join() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'joined' THEN RAISE EXCEPTION 'injected ledger failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER reject_test_join BEFORE INSERT ON business_events FOR EACH ROW EXECUTE FUNCTION reject_test_join()`);
    try {
      await assert.rejects(joinRide(pool, passenger.id, 'join-retry', id, { role: 'passenger', seatCount: 1 }), /injected ledger failure/);
      assert.equal((await getRide(pool, id)).version, 1);
      assert.equal((await getRide(pool, id)).availableSeats, 1);
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM idempotency_requests WHERE user_id = $1', [passenger.id])).rows[0].count, 0);
    } finally {
      await pool.query('DROP TRIGGER reject_test_join ON business_events; DROP FUNCTION reject_test_join()');
    }
    await joinRide(pool, passenger.id, 'join-retry', id, { role: 'passenger', seatCount: 1 });
    assert.equal((await getRide(pool, id)).version, 2);
  });

  await t.test('concurrent cancellation and join leave no active member on a cancelled ride', async () => {
    const [creator, passenger] = await Promise.all([account(pool), account(pool)]);
    const id = rideId(await createRide(pool, creator.id, 'create-fixture', offer()));
    const results = await Promise.allSettled([
      cancelRide(pool, creator.id, 'cancel-fixture', id, { reason: 'Plans changed' }),
      joinRide(pool, passenger.id, 'join-fixture', id, { role: 'passenger', seatCount: 1 }),
    ]);
    assert.equal(results[0].status, 'fulfilled', results[0].status === 'rejected' ? String(results[0].reason) : '');
    if (results[1].status === 'rejected') assert.ok(code('RIDE_NOT_OPEN')(results[1].reason));
    const state = (await pool.query('SELECT status FROM rides WHERE id = $1', [id])).rows[0];
    assert.equal(state.status, 'cancelled');
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ride_members WHERE ride_id = $1 AND state = 'active'`, [id])).rows[0].count, 0);
  });

  await t.test('a cancellation transaction started before a later join still records ordered member timestamps', async () => {
    const [creator, passenger] = await Promise.all([account(pool), account(pool)]);
    const id = rideId(await createRide(pool, creator.id, 'create-fixture', offer()));
    let started!: () => void;
    let resume!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const proceed = new Promise<void>(resolve => { resume = resolve; });
    // Both operations still execute on real PostgreSQL. Delay the cancellation
    // after BEGIN to deterministically exercise an older transaction timestamp
    // acquiring the ride lock after the passenger's newer transaction commits.
    const delayedPool = { async connect() {
      const client = await pool.connect();
      return {
        async query(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          if (sql === 'BEGIN') {
            await client.query('SELECT now()');
            started();
            await proceed;
          }
          return result;
        },
        release() { client.release(); },
      };
    } } as unknown as Pool;
    const cancellation = cancelRide(delayedPool, creator.id, 'cancel-fixture', id, { reason: 'Plans changed' });
    await began;
    try { await joinRide(pool, passenger.id, 'join-fixture', id, { role: 'passenger', seatCount: 1 }); }
    finally { resume(); }
    await cancellation;
    const result = await pool.query(`SELECT count(*)::integer AS count FROM ride_members
      WHERE ride_id = $1 AND (state <> 'left' OR left_at < joined_at)`, [id]);
    assert.equal(result.rows[0].count, 0);
  });

  await t.test('public detail/list project approved fields without leaking account or imported private data', async () => {
    const creator = await account(pool);
    const id = rideId(await createRide(pool, creator.id, 'create-fixture', offer()));
    await pool.query(`UPDATE rides SET details = details || '{"openid":"hidden-openid","phone":"hidden-contact","token":"hidden-token"}'::jsonb WHERE id = $1`, [id]);
    const detail = await getRide(pool, id);
    const list = await listRides(pool, { cityKey: 'ny_nj', kind: 'offer', limit: 50 });
    assert.ok(list.rides.some(row => row.id === id));
    const json = JSON.stringify({ detail, list });
    for (const secret of [creator.id, creator.openid, 'private-phone', 'private-secret', 'hidden-openid', 'hidden-contact', 'hidden-token']) assert.equal(json.includes(secret), false);
    assert.deepEqual(Object.keys(detail).sort(), ['id', 'kind', 'cityKey', 'status', 'seatCapacity', 'departureAt', 'timeZone', 'listedPriceCents', 'listedPriceLabel', 'version', 'note', 'availableSeats', 'hasDriver', 'stops'].sort());
    assert.equal(detail.listedPriceLabel, null);
    await pool.query('UPDATE rides SET listed_price_label=$2, listed_price_cents=NULL WHERE id=$1', [id, '2人共30']);
    const historicalQuote = await getRide(pool, id);
    assert.equal(historicalQuote.listedPriceLabel, '2人共30');
    assert.equal(historicalQuote.listedPriceCents, null);
  });

  await t.test('expired departures and unsupported legacy aliases never enter a new booking', async () => {
    const [creator, passenger] = await Promise.all([account(pool), account(pool)]);
    await assert.rejects(createRide(pool, creator.id, 'past-fixture', offer({ departureAt: '2020-01-01T00:00:00.000Z' })), code('INVALID_DEPARTURE'));
    await assert.rejects(createRide(pool, creator.id, 'alias-fixture', { ...offer(), passengerCount: 3 }));
    await assert.rejects(createRide(pool, creator.id, 'bad-price', offer({ listedPriceCents: 12.5 })));
    const id = rideId(await createRide(pool, creator.id, 'create-fixture', offer()));
    await pool.query(`UPDATE rides SET departure_at = now() - interval '1 hour' WHERE id = $1`, [id]);
    await assert.rejects(joinRide(pool, passenger.id, 'join-past', id, { role: 'passenger', seatCount: 1 }), code('RIDE_NOT_OPEN'));
    assert.equal((await listRides(pool, {})).rides.some(row => row.id === id), false);
  });

  await t.test('the last allowed page never advertises an invalid next page', async () => {
    const creator = await account(pool);
    await pool.query(`INSERT INTO rides(id, kind, creator_id, city_key, status, seat_capacity, departure_at, time_zone)
      SELECT 'pagination-' || generate_series, 'offer', $1, 'ny_nj', 'open', 1, now() + interval '2 days', 'America/New_York'
      FROM generate_series(1, 1001)`, [creator.id]);
    const page = await listRides(pool, { page: 1000, limit: 1 });
    assert.equal(page.rides.length, 1);
    assert.equal(page.nextPage, null);
    assert.equal((await listRides(pool, { page: 999, limit: 1 })).nextPage, 1000);
  });
});
