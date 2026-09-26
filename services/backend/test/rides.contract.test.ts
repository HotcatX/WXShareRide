import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import type { Pool } from 'pg';
import { createTestDatabase } from './helpers/database.ts';
import { createRideSchema, rideStopsSchema } from '../src/rides/schemas.ts';
import { createRide, getRide, joinRide, leaveRide } from '../src/rides/service.ts';

const start = () => Date.now() + 86400000;
const departure = (at: number, address = 'Public fixture departure') => ({ kind: 'departure', address, departureAt: new Date(at).toISOString() });
const destination = (address = 'Public fixture destination') => ({ kind: 'destination', address });
function offer(stops = [departure(start()), destination()]) {
  return { kind: 'offer', cityKey: 'ny_nj', timeZone: 'America/New_York', stops, listedPriceCents: 1200, seatCapacity: 3 };
}
const pickup = { role: 'passenger', seatCount: 1, pickupAddress: 'Private fixture pickup', dropoffAddress: 'Private fixture dropoff' };
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
const rideId = (result: { data: object }) => (result.data as { rideId: string }).rideId;
async function user(pool: Pool) {
  return (await pool.query<{ id: string }>(`INSERT INTO users(app_id, openid) VALUES ('ride-contract-fixture',$1) RETURNING id`, [randomUUID()])).rows[0].id;
}

test('ride stops reject unsupported aliases, times, order and resource bounds', () => {
  const at = start();
  const valid = offer([departure(at), departure(at), destination(), destination()]);
  assert.equal(createRideSchema.parse(valid).stops.length, 4);
  const tenEach = [...Array.from({ length: 10 }, (_, i) => departure(at + i * 60000)), ...Array.from({ length: 10 }, () => destination())];
  assert.equal(rideStopsSchema.parse(tenEach).length, 20);
  const invalidStops = [
    [], [departure(at)], [destination(), destination()], [departure(at), departure(at)],
    [destination(), departure(at)], [departure(at), destination(), departure(at)],
    [departure(at + 1), departure(at), destination()],
    [...Array.from({ length: 11 }, () => departure(at)), destination()],
    [departure(at), ...Array.from({ length: 11 }, () => destination())],
    [...tenEach, destination()],
    [{ ...departure(at), address: ' ' }, destination()],
    [{ ...departure(at), address: 'x'.repeat(301) }, destination()],
    [{ ...departure(at), placeId: 'x'.repeat(101) }, destination()],
    [{ ...departure(at), position: 0 }, destination()],
    [{ ...departure(at), departureAt: '2027-01-05T15:00:00-05:00' }, destination()],
    [{ ...departure(at), departureAt: '2027-01-05T15:00:00' }, destination()],
    [departure(at), { ...destination(), departureAt: new Date(at).toISOString() }],
    [departure(at), { ...destination(), arrivalAt: new Date(at).toISOString() }],
  ];
  for (const stops of invalidStops) assert.equal(createRideSchema.safeParse({ ...valid, stops }).success, false);
  for (const aliases of [
    { origin: { address: 'Legacy start' } }, { destination: { address: 'Legacy end' } },
    { departureAt: new Date(at).toISOString() }, { departures: [] }, { zelleDisplay: true },
    { vehicle: { plate: 'Synthetic' } }, { largeLuggageCount: 1 },
  ]) assert.equal(createRideSchema.safeParse({ ...valid, ...aliases }).success, false);
  const { seatCapacity: _capacity, ...common } = valid;
  assert.equal(createRideSchema.parse({ ...common, kind: 'request', partySize: 1 }).kind, 'request');
  for (const largeLuggageCount of [-1, 21, 0.5, '2', true]) {
    assert.equal(createRideSchema.safeParse({ ...common, kind: 'request', partySize: 1, largeLuggageCount }).success, false);
  }
});

test('multi-stop rides, per-ride disclosure and pickup instructions persist atomically',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL, timeout: 30000 }, async t => {
    const database = await createTestDatabase();
    const { pool } = database;
    t.after(database.close);

    await t.test('every stop and its sequence survives, including identical addresses and equal departure times', async () => {
      const creator = await user(pool), at = start();
      const stops = [departure(at), { ...departure(at), placeId: 'fixture-place' }, departure(at + 3600000), destination(), destination('Second destination')];
      const id = rideId(await createRide(pool, creator, 'multiple-stop-create', offer(stops)));
      const saved = await pool.query(`SELECT position, kind, address, place_id, departure_at FROM ride_stops WHERE ride_id=$1 ORDER BY position`, [id]);
      assert.equal(saved.rows.length, stops.length);
      saved.rows.forEach((row, i) => {
        assert.equal(row.position, i);
        assert.equal(row.kind, stops[i].kind);
        assert.equal(row.address, stops[i].address);
        assert.equal(row.departure_at?.getTime() ?? null, 'departureAt' in stops[i] ? Date.parse(stops[i].departureAt!) : null);
      });
      const visible = await getRide(pool, id);
      assert.equal(new Date(visible.departureAt).getTime(), at);
      assert.equal(visible.stops.length, 5);
      assert.deepEqual(visible.stops.map((stop: { position: number }) => stop.position), [0, 1, 2, 3, 4]);
      assert.equal(visible.availableSeats, 3);
    });

    await t.test('the first departure closes the whole-ride booking even when a later departure is still future', async () => {
      const [creator, rider] = await Promise.all([user(pool), user(pool)]);
      const at = start();
      const id = rideId(await createRide(pool, creator, 'deadline-fixture', offer([departure(at), departure(at + 3600000), destination()])));
      await pool.query(`UPDATE rides SET departure_at=now()-interval '1 minute' WHERE id=$1`, [id]);
      await pool.query(`UPDATE ride_stops SET departure_at=(SELECT departure_at FROM rides WHERE id=$1) WHERE ride_id=$1 AND position=0`, [id]);
      await assert.rejects(joinRide(pool, rider, 'deadline-join', id, pickup), code('RIDE_NOT_OPEN'));
      await assert.rejects(createRide(pool, creator, 'expired-first-stop', offer([departure(Date.now() - 60000), departure(at), destination()])), code('INVALID_DEPARTURE'));
    });

    await t.test('a failure at a later stop rolls back the ride, all earlier stops, event and receipt', async () => {
      const creator = await user(pool), at = start();
      const input = offer([departure(at), departure(at + 60000), destination()]);
      await pool.query(`CREATE FUNCTION reject_fixture_stop() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.position=2 THEN RAISE EXCEPTION 'synthetic stop failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_fixture_stop BEFORE INSERT ON ride_stops FOR EACH ROW EXECUTE FUNCTION reject_fixture_stop()`);
      try { await assert.rejects(createRide(pool, creator, 'stops-rollback', input), /synthetic stop failure/); }
      finally { await pool.query('DROP TRIGGER reject_fixture_stop ON ride_stops'); }
      assert.equal((await pool.query('SELECT 1 FROM rides WHERE creator_id=$1', [creator])).rowCount, 0);
      assert.equal((await pool.query('SELECT 1 FROM business_events WHERE actor_id=$1', [creator])).rowCount, 0);
      assert.equal((await pool.query('SELECT 1 FROM idempotency_requests WHERE user_id=$1', [creator])).rowCount, 0);
      const id = rideId(await createRide(pool, creator, 'stops-rollback', input));
      assert.equal((await pool.query('SELECT 1 FROM ride_stops WHERE ride_id=$1', [id])).rowCount, 3);
    });

    await t.test('offer creation snapshots only a strict boolean disclosure default; replay cannot change it', async () => {
      const creator = await user(pool);
      const input = offer();
      await pool.query(`UPDATE users SET profile='{"zelle":{"public":true,"name":"private-payee","account":"private-account"}}'::jsonb WHERE id=$1`, [creator]);
      const first = await createRide(pool, creator, 'disclosure-create', input);
      const id = rideId(first);
      await pool.query(`UPDATE users SET profile=jsonb_set(profile,'{zelle,public}','false'::jsonb) WHERE id=$1`, [creator]);
      assert.deepEqual(await createRide(pool, creator, 'disclosure-create', input), first);
      const old = (await pool.query('SELECT details FROM rides WHERE id=$1', [id])).rows[0].details;
      assert.deepEqual(old, { note: '', zelleDisplay: true });
      const next = rideId(await createRide(pool, creator, 'disclosure-next', offer()));
      assert.equal((await pool.query('SELECT details FROM rides WHERE id=$1', [next])).rows[0].details.zelleDisplay, false);
      for (const value of ['"true"', '1', 'null']) {
        await pool.query(`UPDATE users SET profile=jsonb_set(profile,'{zelle,public}',$2::jsonb) WHERE id=$1`, [creator, value]);
        const id = rideId(await createRide(pool, creator, randomUUID(), offer()));
        assert.equal((await pool.query('SELECT details FROM rides WHERE id=$1', [id])).rows[0].details.zelleDisplay, false);
      }
      for (const secret of ['zelleDisplay', 'private-payee', 'private-account']) assert.equal(JSON.stringify(await getRide(pool, id)).includes(secret), false);
    });

    await t.test('creation waits for an earlier profile update before taking its disclosure snapshot', async () => {
      const creator = await user(pool);
      const writer = await pool.connect();
      await writer.query('BEGIN');
      await writer.query(`UPDATE users SET profile='{"zelle":{"public":true}}'::jsonb WHERE id=$1`, [creator]);
      let started!: (pid: number) => void;
      const reading = new Promise<number>(resolve => { started = resolve; });
      const observingPool = { async connect() {
        const client = await pool.connect();
        const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        return {
          async query(sql: string, values?: unknown[]) {
            if (sql.includes('FROM users WHERE id = $1 FOR SHARE')) started(pid);
            return client.query(sql, values);
          },
          release() { client.release(); },
        };
      } } as unknown as Pool;
      const created = createRide(observingPool, creator, 'locked-profile', offer());
      try {
        const pid = await reading;
        let waiting = false;
        for (let i = 0; i < 200; i++) {
          if ((await pool.query('SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted', [pid])).rowCount) { waiting = true; break; }
          await setTimeout(5);
        }
        assert.equal(waiting, true, 'creation must wait on the pending profile write');
      } finally { await writer.query('COMMIT'); writer.release(); }
      const id = rideId(await created);
      assert.equal((await pool.query('SELECT details FROM rides WHERE id=$1', [id])).rows[0].details.zelleDisplay, true);
    });

    await t.test('time elapsed during profile or block-pair locking cannot admit a departed ride', async () => {
      const [creator, rider] = await Promise.all([user(pool), user(pool)]);
      const at = start(), realNow = Date.now;
      // Advance the application clock after a real locked query returns,
      // representing a lock wait that crossed the first departure boundary.
      const elapsedPool = (query: string) => ({ async connect() {
        const client = await pool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            const result = await client.query(sql, values);
            if (sql.includes(query)) Date.now = () => at + 1;
            return result;
          },
          release() { client.release(); },
        };
      } } as unknown as Pool);
      const input = offer([departure(at), destination()]);
      try {
        await assert.rejects(createRide(elapsedPool('FROM users WHERE id = $1 FOR SHARE'), creator,
          'create-crossed-deadline', input), code('INVALID_DEPARTURE'));
      } finally { Date.now = realNow; }
      assert.equal((await pool.query('SELECT 1 FROM rides WHERE creator_id=$1', [creator])).rowCount, 0);
      const id = rideId(await createRide(pool, creator, 'create-before-deadline', input));
      try {
        await assert.rejects(joinRide(elapsedPool('FROM user_blocks WHERE active'), rider,
          'join-crossed-deadline', id, pickup), code('RIDE_NOT_OPEN'));
      } finally { Date.now = realNow; }
      assert.equal((await pool.query('SELECT 1 FROM ride_members WHERE ride_id=$1 AND user_id=$2', [id, rider])).rowCount, 0);
      assert.equal((await pool.query('SELECT 1 FROM idempotency_requests WHERE user_id=$1', [rider])).rowCount, 0);
    });

    await t.test('request luggage defaults to zero or retains its explicit value without an offer disclosure field', async () => {
      const creator = await user(pool);
      const { seatCapacity: _capacity, ...common } = offer();
      for (const supplied of [undefined, 0, 20]) {
        const id = rideId(await createRide(pool, creator, randomUUID(), { ...common, kind: 'request', partySize: 2,
          ...(supplied === undefined ? {} : { largeLuggageCount: supplied }) }));
        assert.deepEqual((await pool.query('SELECT details FROM rides WHERE id=$1', [id])).rows[0].details,
          { note: '', largeLuggageCount: supplied ?? 0 });
      }
    });

    await t.test('join instructions are required only for offers and cannot mutate an existing membership', async () => {
      const [creator, rider] = await Promise.all([user(pool), user(pool)]);
      const id = rideId(await createRide(pool, creator, 'pickup-create', offer()));
      await assert.rejects(joinRide(pool, rider, 'pickup-missing', id, { role: 'passenger', seatCount: 1 }), code('PICKUP_DROPOFF_REQUIRED'));
      for (const input of [{ ...pickup, pickupAddress: ' ' }, { ...pickup, dropoffAddress: 'x'.repeat(61) }, { ...pickup, passengerInfo: {} }]) {
        await assert.rejects(joinRide(pool, rider, 'pickup-invalid', id, input));
      }
      const first = await joinRide(pool, rider, 'pickup-join', id, pickup);
      assert.deepEqual(await joinRide(pool, rider, 'pickup-join', id, pickup), first);
      const changed = { ...pickup, pickupAddress: 'Private new pickup' };
      await assert.rejects(joinRide(pool, rider, 'pickup-join', id, changed), code('IDEMPOTENCY_CONFLICT'));
      await assert.rejects(joinRide(pool, rider, 'pickup-change', id, changed), code('MEMBERSHIP_EXISTS'));
      assert.equal((await joinRide(pool, rider, 'pickup-noop', id, pickup)).data.changed, false);
      await leaveRide(pool, rider, 'pickup-leave', id, {});
      await joinRide(pool, rider, 'pickup-rejoin', id, changed);
      assert.deepEqual((await pool.query('SELECT details FROM ride_members WHERE ride_id=$1 AND user_id=$2', [id, rider])).rows[0].details,
        { pickupAddress: changed.pickupAddress, dropoffAddress: changed.dropoffAddress });
      const events = (await pool.query('SELECT payload FROM business_events WHERE ride_id=$1', [id])).rows;
      const notifications = (await pool.query('SELECT content FROM notifications WHERE ride_id=$1', [id])).rows;
      const visible = await getRide(pool, id);
      for (const text of [pickup.pickupAddress, pickup.dropoffAddress, changed.pickupAddress]) {
        assert.equal(JSON.stringify({ events, notifications, visible }).includes(text), false);
      }
      const { seatCapacity: _capacity, ...common } = offer();
      const requestId = rideId(await createRide(pool, creator, 'pickup-request', { ...common, kind: 'request', partySize: 1 }));
      await assert.rejects(joinRide(pool, rider, 'request-instructions', requestId, pickup), code('INVALID_JOIN_DETAILS'));
      await joinRide(pool, rider, 'request-no-instructions', requestId, { role: 'passenger', seatCount: 1 });
      assert.deepEqual((await pool.query('SELECT details FROM ride_members WHERE ride_id=$1 AND user_id=$2', [requestId, rider])).rows[0].details, {});
    });
  });
