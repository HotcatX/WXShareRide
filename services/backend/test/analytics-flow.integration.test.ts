import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDatabase } from './helpers/database.ts';
import { createRide, joinRide, leaveRide, cancelRide } from '../src/rides/service.ts';
import { deliverBusinessEvents } from '../src/analytics/delivery.ts';

test('committed ride facts survive a lost ACK and update the actual collector once',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
    // @ts-expect-error The existing independent collector is JavaScript, exercised unchanged.
    const { openStore } = await import('../../analytics-collector/src/store.mjs');
    const database = await createTestDatabase();
    t.after(() => database.close());
    const directory = mkdtempSync(join(tmpdir(), 'linkx-delivery-flow-'));
    const store = openStore(join(directory, 'collector.sqlite'), { realEnabled: true });
    t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    const { pool } = database;
    const appId = 'delivery-flow-app';
    const driverOpenid = 'synthetic_flow_driver';
    const passengerOpenid = 'synthetic_flow_passenger';
    async function user(openid: string) {
      return (await pool.query<{ id: string }>('INSERT INTO users(app_id,openid) VALUES($1,$2) RETURNING id',
        [appId, openid])).rows[0]!.id;
    }
    const driver = await user(driverOpenid), passenger = await user(passengerOpenid);
    const input = { kind: 'offer', cityKey: 'ny_nj', timeZone: 'America/New_York', seatCapacity: 2,
      listedPriceCents: 1200, note: '', stops: [
        { kind: 'departure', address: 'Fort Lee', placeId: 'fort_lee', departureAt: new Date(Date.now() + 86_400_000).toISOString() },
        { kind: 'destination', address: 'Columbia', placeId: 'columbia' }
      ] };
    const created = await createRide(pool, driver, 'flow-create', input);
    assert.deepEqual(await createRide(pool, driver, 'flow-create', input), created);
    const rideId = created.data.rideId as string;
    const booking = { role: 'passenger', seatCount: 1, pickupAddress: 'Fort Lee', dropoffAddress: 'Columbia' };
    await joinRide(pool, passenger, 'flow-join', rideId, booking);
    await joinRide(pool, passenger, 'flow-join', rideId, booking);
    await leaveRide(pool, passenger, 'flow-leave', rideId, {});
    await joinRide(pool, passenger, 'flow-rejoin', rideId, booking);
    await cancelRide(pool, driver, 'flow-cancel', rideId, { reason: 'Synthetic cancellation' });
    const rows = (await pool.query<{ collector_payload: string }>(
      'SELECT collector_payload FROM business_events WHERE ride_id=$1 ORDER BY ride_version', [rideId])).rows;
    assert.equal(rows.length, 5);
    const frozen = rows.map(row => row.collector_payload);
    const last = JSON.parse(frozen.at(-1)!);
    assert.equal(last.version, 5);
    assert.equal(last.after.status, 'cancelled');
    assert.deepEqual(last.after.participantEdges, []);
    assert.equal(last.before.participantEdges.length, 2);

    let firstBody = '';
    await assert.rejects(deliverBusinessEvents(pool, appId, async body => {
      firstBody = body;
      const ack = store.places.ingestBusiness(JSON.parse(body), Date.now());
      assert.equal(ack.acceptedEventIds.length, 5);
      throw new Error('simulated lost ACK after receiver commit');
    }), { code: 'COLLECTOR_DELIVERY_UNAVAILABLE' });
    assert.equal((await pool.query('SELECT count(*)::int n FROM business_events WHERE collector_delivered_at IS NOT NULL')).rows[0].n, 0);
    const result = await deliverBusinessEvents(pool, appId, async body => {
      assert.equal(body, firstBody, 'retry preserves every frozen byte');
      const ack = store.places.ingestBusiness(JSON.parse(body), Date.now());
      assert.equal(ack.duplicateEventIds.length, 5);
      return ack;
    });
    assert.deepEqual(result, { sent: 5, delivered: 5, lockSkipped: 0 });
    assert.equal(store.db.prepare('SELECT count(*) n FROM place_business_events').get().n, 5);
    assert.deepEqual(store.db.prepare('SELECT openid,active FROM place_participation_history WHERE event_id=? ORDER BY openid').all(last.eventId),
      [{ openid: driverOpenid, active: 0 }, { openid: passengerOpenid, active: 0 }]);
    assert.equal(store.db.prepare('SELECT count(*) n FROM place_followup_population WHERE active=1').get().n, 0);
    assert.deepEqual((await pool.query<{ collector_payload: string }>(
      'SELECT collector_payload FROM business_events WHERE ride_id=$1 ORDER BY ride_version', [rideId])).rows.map(row => row.collector_payload), frozen);
    assert.deepEqual(await deliverBusinessEvents(pool, appId, async () => assert.fail('ACKed events were resent')),
      { sent: 0, delivered: 0, lockSkipped: 0 });
  });
