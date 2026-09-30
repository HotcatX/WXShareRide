import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { listMyRides } from '../src/rides/participants.ts';
import { rateRide } from '../src/ratings/service.ts';
import { createTestDatabase } from './helpers/database.ts';

const require = createRequire(import.meta.url);
const { toHistoryRide } = require('../../../utils/compat/rideHistory.js');
const { createFollowupController, eligibleTrip } = require('../../../utils/tripFollowup.js');
const { validateEvent } = require('../../../utils/analyticsSchema.js');

test('actual private history DTO drives all existing followup roles without exposing other OpenIDs or changing prompts',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
    const database = await createTestDatabase(); t.after(database.close);
    const { pool } = database;
    const users: Record<string, { id: string; openid: string }> = {};
    for (const name of ['driver', 'creator', 'passenger', 'outsider']) {
      users[name] = (await pool.query(`INSERT INTO users(app_id,openid) VALUES('history-fixture',$1) RETURNING id,openid`,
        [`synthetic-private-openid-${name}`])).rows[0];
    }
    const now = Date.now(), first = new Date(now - 3 * 86400000), last = new Date(now - 2 * 86400000);
    for (const kind of ['offer', 'request']) {
      const creator = users[kind === 'offer' ? 'driver' : 'creator']!;
      await pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone,listed_price_cents,listed_price_label)
        VALUES($1,$2,$3,'ny_nj','closed',4,$4,'America/New_York',1525,'15.25美元/人')`, [kind, kind, creator.id, first]);
      for (const name of kind === 'offer' ? ['driver', 'passenger'] : ['driver', 'creator', 'passenger']) {
        await pool.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state) VALUES($1,$2,$3,$4,'active')`,
          [kind, users[name]!.id, name === 'driver' ? 'driver' : 'passenger', name === 'driver' ? 0 : name === 'creator' ? 2 : 1]);
      }
      await pool.query(`INSERT INTO ride_stops(ride_id,position,kind,address,departure_at) VALUES
        ($1,0,'departure','First stop',$2),($1,1,'departure','Last stop',$3),($1,2,'destination','Destination',NULL)`, [kind, first, last]);
    }
    for (const [kind, name, historyRole] of [['offer', 'driver', 'driver_create'], ['offer', 'passenger', 'passenger'],
      ['request', 'driver', 'driver_join'], ['request', 'creator', 'passenger_create'], ['request', 'passenger', 'passenger']]) {
      const own = users[name!]!;
      const data = await listMyRides(pool, own.id, { scope: 'history' });
      const wire = JSON.parse(JSON.stringify(data));
      assert.doesNotMatch(JSON.stringify(wire), /openid|synthetic-private/);
      const row = wire.rides.find((ride: { id: string }) => ride.id === kind);
      assert.equal(row.latestDepartureAt, last.toISOString());
      assert.equal(row.isCreator, name === (kind === 'offer' ? 'driver' : 'creator'));
      assert.equal(row.followupEligible, true);
      assert.equal(row.driverUserId, name === 'driver' ? null : users.driver!.id);
      assert.equal(row.myRating, null);
      const trip = toHistoryRide(row, own.openid);
      assert.equal(trip.historyRole, historyRole);
      assert.equal(eligibleTrip(trip, own.openid, now).departureAt, last.getTime());
      for (const other of Object.values(users).filter(user => user !== own)) assert.ok(!JSON.stringify(trip).includes(other.openid));
      const events: any[] = [], storage: Record<string, unknown> = { openid: own.openid };
      const page = { data: {} as Record<string, unknown>, setData(value: object) { Object.assign(this.data, value); } };
      const controller = createFollowupController({ now: () => now,
        wx: { getStorageSync: (key: string) => storage[key], setStorageSync: (key: string, value: unknown) => { storage[key] = value; } },
        analytics: { getCollectionScope: () => 'real:participant_00000001:1', makeEventId: () => `synthetic_event_${events.length.toString().padStart(10, '0')}`,
          recordEvent(eventName: string, data: object, meta: object) {
            const event = { schemaVersion: 1, eventName, data, ...meta }; assert.equal(validateEvent(event, now), true); events.push(event); return { ok: true };
          } },
      });
      assert.equal(controller.considerTrips(page, [trip]), true);
      assert.equal(page.data.followupQuestion, name === 'driver' ? '您接到乘客了吗？' : '您坐上车了吗？');
      assert.equal(controller.answer(page, 'yes').ok, true);
      assert.equal(events[1].data.referencePriceCents, 1525);
      assert.equal(events[1].data.outcomeScope, name === 'driver' ? 'driver_any_passenger' : 'respondent_booking');
    }
    await rateRide(pool, users.passenger!.id, 'history.inline.rating', 'request', { targetId: users.driver!.id, score: 4 });
    const ownRating = (await listMyRides(pool, users.passenger!.id, { scope: 'history' })).rides.find(row => row.id === 'request');
    assert.equal(ownRating?.myRating, 4);
    assert.equal((await listMyRides(pool, users.creator!.id, { scope: 'history' })).rides[0].myRating, null,
      'another passenger never inherits the first passenger rating');
    assert.equal((await listMyRides(pool, users.driver!.id, { scope: 'history' })).rides[0].driverUserId, null,
      'a driver never receives a self-rating target');
    assert.deepEqual((await listMyRides(pool, users.outsider!.id, { scope: 'history' })).rides, []);
    await pool.query("UPDATE ride_members SET state='left',left_at=now() WHERE ride_id='offer' AND user_id=$1", [users.passenger!.id]);
    assert.ok(!(await listMyRides(pool, users.passenger!.id, { scope: 'history' })).rides.some(row => row.id === 'offer'));
    await pool.query("UPDATE rides SET status='cancelled' WHERE id='offer'");
    assert.deepEqual((await listMyRides(pool, users.driver!.id, { scope: 'history' })).rides.map(row => row.id), ['request']);
    await pool.query("UPDATE ride_stops SET departure_at=now()+interval '1 day' WHERE ride_id='request' AND position=1");
    const earlyClose = JSON.parse(JSON.stringify((await listMyRides(pool, users.creator!.id, { scope: 'history' })).rides[0]));
    assert.equal(earlyClose.followupEligible, false);
    assert.equal(earlyClose.driverUserId, null);
    assert.equal(earlyClose.myRating, null);
    assert.equal(eligibleTrip(toHistoryRide(earlyClose, users.creator!.openid), users.creator!.openid, now), null);
    await pool.query("UPDATE rides SET status='open' WHERE id='request'");
    const overdueOpen = (await listMyRides(pool, users.creator!.id, { scope: 'history' })).rides[0];
    assert.equal(overdueOpen.followupEligible, false, 'an elapsed timestamp never fabricates a closed fact');
    assert.equal(overdueOpen.driverUserId, null);
  });
