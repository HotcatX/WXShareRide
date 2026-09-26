import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { AppError } from '../src/errors.ts';
import { getRideParticipants, listMyRides } from '../src/rides/participants.ts';
import { createTestDatabase } from './helpers/database.ts';

test('private ride projections enforce current relationships and field boundaries',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
    const database = await createTestDatabase();
    const { pool } = database;
    t.after(database.close);
    const names = ['driver', 'passenger-a', 'passenger-b', 'replacement', 'outsider'] as const;
    const users = {} as Record<typeof names[number], string>;
    for (const name of names) {
      const row = await pool.query(`INSERT INTO users(app_id,openid,name,avatar_url,profile) VALUES($1,$2,$3,$4,$5) RETURNING id`,
        ['wx-fixture', `private-openid-${name}`, name, `https://example.invalid/${name}.png`, {
          phone: `phone-${name}`, phoneRegion: 'US', wechatId: `wechat-${name}`,
          vehicle: { plate: `plate-${name}`, brand: 'Fixture', model: 'Car', internal: 'vehicle-secret' },
          zelle: { name: `payee-${name}`, account: `account-${name}`, public: false, internal: 'zelle-secret' },
          location: { address: `home-${name}`, latitude: 40.1, longitude: -74.1 },
          preferences: { pickupAddresses: ['private-saved-address'] }, bio: 'private-bio', arbitrary: 'profile-secret',
        }]);
      users[name] = row.rows[0].id;
    }
    async function ride(kind: 'offer' | 'request', options: { status?: string; departureAt?: Date; details?: object } = {}) {
      const id = randomUUID();
      await pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone,details)
        VALUES($1,$2,$3,'ny_nj',$4,4,$5,'America/New_York',$6)`,
      [id, kind, kind === 'offer' ? users.driver : users['passenger-a'], options.status ?? 'open',
        options.departureAt ?? new Date(Date.now() + 86400000), options.details ?? {}]);
      for (const name of ['driver', 'passenger-a', 'passenger-b'] as const) {
        await pool.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state,details)
          VALUES($1,$2,$3,$4,'active',$5)`, [id, users[name], name === 'driver' ? 'driver' : 'passenger', name === 'driver' ? 0 : 1,
          { pickupAddress: `pickup-${name}`, dropoffAddress: `dropoff-${name}`, privateField: 'member-secret' }]);
      }
      return id;
    }
    function participant(data: Awaited<ReturnType<typeof getRideParticipants>>, name: typeof names[number]) {
      const member = data.participants.find(value => value.id === users[name]);
      assert.ok(member);
      return member;
    }
    function assertNoProfileLeak(value: unknown) {
      const text = JSON.stringify(value);
      for (const forbidden of ['private-openid', 'home-', 'private-saved-address', 'private-bio', 'profile-secret',
        'vehicle-secret', 'zelle-secret', 'member-secret', 'latitude', 'longitude', 'joinedAt', 'updatedAt', '"public"']) {
        assert.equal(text.includes(forbidden), false, `private projection leaked ${forbidden}`);
      }
    }
    const notFound = (error: unknown) => error instanceof AppError && error.status === 404 && error.code === 'RIDE_NOT_FOUND';

    await t.test('offer driver sees active passenger contacts and per-ride instructions only', async () => {
      const id = await ride('offer');
      const data = await getRideParticipants(pool, users.driver, id);
      assert.equal(data.participants.length, 3);
      assert.equal(data.participants[0].role, 'driver');
      assert.deepEqual(participant(data, 'passenger-a'), {
        id: users['passenger-a'], name: 'passenger-a', avatarUrl: 'https://example.invalid/passenger-a.png',
        role: 'passenger', seatCount: 1, phone: 'phone-passenger-a', phoneRegion: 'US', wechatId: 'wechat-passenger-a',
        pickupAddress: 'pickup-passenger-a', dropoffAddress: 'dropoff-passenger-a',
        statistics: { completedTrips: 0, ratingCount: 0, averageRating: null, weightedRating: null },
      });
      assert.equal(participant(data, 'driver').pickupAddress, undefined);
      assert.equal(participant(data, 'driver').zelle, undefined);
      assert.equal(data.largeLuggageCount, undefined);
      assertNoProfileLeak(data);
    });

    await t.test('offer passenger sees only self and driver, never a fellow passenger', async () => {
      const id = await ride('offer');
      const data = await getRideParticipants(pool, users['passenger-a'], id);
      assert.equal(data.participants.length, 2);
      assert.deepEqual(new Set(data.participants.map(member => member.id)), new Set([users.driver, users['passenger-a']]));
      assert.equal(JSON.stringify(data).includes('passenger-b'), false);
      assert.equal(participant(data, 'passenger-a').pickupAddress, 'pickup-passenger-a');
      assert.deepEqual(participant(data, 'driver').vehicle, { plate: 'plate-driver', brand: 'Fixture', model: 'Car' });
      assertNoProfileLeak(data);
    });

    await t.test('offer Zelle requires exact ride boolean and does not follow profile defaults', async () => {
      const id = await ride('offer');
      for (const value of [false, 'true', 'yes', 1, null]) {
        await pool.query('UPDATE rides SET details=$2 WHERE id=$1', [id, { zelleDisplay: value }]);
        assert.equal(participant(await getRideParticipants(pool, users['passenger-a'], id), 'driver').zelle, undefined);
      }
      await pool.query('UPDATE rides SET details=$2 WHERE id=$1', [id, { zelleDisplay: true }]);
      assert.deepEqual(participant(await getRideParticipants(pool, users['passenger-a'], id), 'driver').zelle,
        { name: 'payee-driver', account: 'account-driver' });
      await pool.query(`UPDATE users SET profile=jsonb_set(profile,'{zelle,public}','true') WHERE id=$1`, [users.driver]);
      await pool.query('UPDATE rides SET details=$2 WHERE id=$1', [id, { zelleDisplay: false }]);
      assert.equal(participant(await getRideParticipants(pool, users['passenger-a'], id), 'driver').zelle, undefined);
    });

    await t.test('request members retain group contacts and assigned driver Zelle, without home addresses', async () => {
      const id = await ride('request', { details: { zelleDisplay: false, largeLuggageCount: 3 } });
      for (const name of ['driver', 'passenger-a', 'passenger-b'] as const) {
        const data = await getRideParticipants(pool, users[name], id);
        assert.equal(data.participants.length, 3);
        assert.equal(data.largeLuggageCount, 3);
        assert.equal(participant(data, 'passenger-b').phone, 'phone-passenger-b');
        assert.deepEqual(participant(data, 'driver').zelle, { name: 'payee-driver', account: 'account-driver' });
        for (const member of data.participants) {
          assert.equal(member.pickupAddress, undefined);
          assert.equal(member.dropoffAddress, undefined);
          if (member.role === 'passenger') {
            assert.equal(member.vehicle, undefined);
            assert.equal(member.zelle, undefined);
          }
        }
        assertNoProfileLeak(data);
      }
    });

    await t.test('vehicle and payment values come from current driver profile, not ride snapshots', async () => {
      const id = await ride('request', { details: { vehicle: { plate: 'obsolete-plate' }, zelle: { account: 'obsolete-account' } } });
      await pool.query(`UPDATE users SET profile=profile||$2::jsonb WHERE id=$1`, [users.driver,
        { vehicle: { plate: 'current-plate', brand: 'Current', model: 'Model' }, zelle: { name: 'current-payee', account: 'current-account', public: false } }]);
      const data = await getRideParticipants(pool, users['passenger-a'], id);
      assert.equal(participant(data, 'driver').vehicle?.plate, 'current-plate');
      assert.equal(participant(data, 'driver').zelle?.account, 'current-account');
      assert.equal(JSON.stringify(data).includes('obsolete'), false);
    });

    await t.test('missing, non-member, left and cancelled access all fail closed, even for creator', async () => {
      const id = await ride('offer');
      await assert.rejects(getRideParticipants(pool, users.outsider, id), notFound);
      await assert.rejects(getRideParticipants(pool, users.driver, 'missing-ride'), notFound);
      await pool.query(`UPDATE ride_members SET state='left',left_at=clock_timestamp() WHERE ride_id=$1 AND user_id=$2`, [id, users['passenger-b']]);
      await assert.rejects(getRideParticipants(pool, users['passenger-b'], id), notFound);
      assert.equal((await getRideParticipants(pool, users.driver, id)).participants.length, 2);
      await pool.query(`UPDATE ride_members SET state='left',left_at=clock_timestamp() WHERE ride_id=$1 AND user_id=$2`, [id, users.driver]);
      await assert.rejects(getRideParticipants(pool, users.driver, id), notFound);
      const cancelled = await ride('offer', { status: 'cancelled' });
      await assert.rejects(getRideParticipants(pool, users.driver, cancelled), notFound);
    });

    await t.test('closed and elapsed rides retain verified active relationships, without asserting completion', async () => {
      for (const options of [{ status: 'closed' }, { departureAt: new Date(Date.now() - 86400000) }]) {
        const id = await ride('request', options);
        assert.equal((await getRideParticipants(pool, users['passenger-a'], id)).participants.length, 3);
      }
    });

    await t.test('unknown history fields remain absent and malformed profile subobjects cannot escape the whitelist', async () => {
      const id = await ride('request', { details: { largeLuggageCount: 'private-text' } });
      await pool.query(`UPDATE users SET profile=profile||$2::jsonb WHERE id=$1`, [users['passenger-b'],
        { phone: { private: 'nested-secret' }, wechatId: ['array-secret'] }]);
      const data = await getRideParticipants(pool, users['passenger-a'], id);
      assert.equal(data.largeLuggageCount, undefined);
      assert.equal(participant(data, 'passenger-b').phone, undefined);
      assert.equal(participant(data, 'passenger-b').wechatId, undefined);
      await pool.query(`UPDATE ride_members SET details='{}' WHERE ride_id=$1 AND user_id=$2`, [id, users['passenger-a']]);
      const offer = await ride('offer');
      await pool.query(`UPDATE ride_members SET details='{}' WHERE ride_id=$1 AND user_id=$2`, [offer, users['passenger-a']]);
      const missing = participant(await getRideParticipants(pool, users.driver, offer), 'passenger-a');
      assert.equal(missing.pickupAddress, undefined);
      assert.equal(missing.dropoffAddress, undefined);
    });

    await t.test('a driver replacement between database response and delivery cannot mix membership snapshots', async () => {
      const id = await ride('request');
      let queries = 0;
      const gatedPool = { query: async (sql: string, values: unknown[]) => {
        const rows = await pool.query(sql, values);
        if (++queries === 1) {
          const writer = await pool.connect();
          try {
            await writer.query('BEGIN');
            await writer.query(`UPDATE ride_members SET state='left',left_at=clock_timestamp() WHERE ride_id=$1 AND user_id=$2`, [id, users.driver]);
            await writer.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state) VALUES($1,$2,'driver',0,'active')`, [id, users.replacement]);
            await writer.query('COMMIT');
          } finally { writer.release(); }
        }
        return rows;
      } } as unknown as Pool;
      const oldSnapshot = await getRideParticipants(gatedPool, users['passenger-a'], id);
      assert.equal(queries, 1, 'authorization and disclosure must share one statement snapshot');
      assert.equal(oldSnapshot.participants.find(member => member.role === 'driver')?.id, users.driver);
      const newSnapshot = await getRideParticipants(pool, users['passenger-a'], id);
      assert.equal(newSnapshot.participants.find(member => member.role === 'driver')?.id, users.replacement);
      assert.equal(JSON.stringify(newSnapshot).includes(users.driver), false);
      await assert.rejects(getRideParticipants(pool, users.driver, id), notFound);
    });
  });

test('my rides separates retained current and historical relationships with the shared public projection',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
    const database = await createTestDatabase();
    const { pool } = database;
    t.after(database.close);
    const owner = (await pool.query(`INSERT INTO users(app_id,openid) VALUES('wx-fixture','private-mine') RETURNING id`)).rows[0].id;
    const other = (await pool.query(`INSERT INTO users(app_id,openid) VALUES('wx-fixture','private-other') RETURNING id`)).rows[0].id;
    const now = Date.now();
    async function seed(id: string, delta: number, status: string, role: string, state = 'active', userId = owner) {
      await pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone,details)
        VALUES($1,'offer',$2,'ny_nj',$3,4,$4,'America/New_York',$5)`,
      [id, userId, status, new Date(now + delta), { note: 'Public note', zelleDisplay: true, secret: 'ride-secret' }]);
      await pool.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state,left_at,details)
        VALUES($1,$2,$3,$4,$5,CASE WHEN $5='left' THEN clock_timestamp() ELSE NULL END,$6)`,
      [id, userId, role, role === 'driver' ? 0 : 1, state, { pickupAddress: 'private-pickup' }]);
      await pool.query(`INSERT INTO ride_stops(ride_id,position,kind,address,departure_at)
        VALUES($1,0,'departure','Fort Lee',$2),($1,1,'destination','Columbia',NULL),($1,2,'destination','Inwood',NULL)`,
      [id, new Date(now + delta)]);
    }
    await seed('future-driver', 86400000, 'open', 'driver');
    await seed('future-passenger', 2 * 86400000, 'open', 'passenger');
    await seed('past-open', -86400000, 'open', 'passenger');
    await seed('closed-future', 3 * 86400000, 'closed', 'driver');
    await seed('cancelled', 86400000, 'cancelled', 'driver');
    await seed('left-future', 86400000, 'open', 'passenger', 'left');
    await seed('left-past', -86400000, 'closed', 'passenger', 'left');
    await seed('other-user', 86400000, 'open', 'driver', 'active', other);

    await t.test('current includes only own active future open membership and paginates deterministically', async () => {
      const first = await listMyRides(pool, owner, { limit: 1 });
      assert.deepEqual(first.rides.map(ride => ride.id), ['future-driver']);
      assert.equal(first.nextPage, 2);
      const second = await listMyRides(pool, owner, { limit: 1, page: 2 });
      assert.deepEqual(second.rides.map(ride => ride.id), ['future-passenger']);
      assert.equal(second.nextPage, null);
      assert.deepEqual((await listMyRides(pool, owner, { role: 'passenger' })).rides.map(ride => ride.id), ['future-passenger']);
      assert.deepEqual((await listMyRides(pool, other, {})).rides.map(ride => ride.id), ['other-user']);
    });

    await t.test('history uses departure/status, keeps active evidence and excludes exited or cancelled relations', async () => {
      const history = await listMyRides(pool, owner, { scope: 'history' });
      assert.deepEqual(history.rides.map(ride => ride.id), ['closed-future', 'past-open']);
      assert.equal(history.nextPage, null);
      assert.deepEqual((await listMyRides(pool, owner, { scope: 'history', role: 'driver' })).rides.map(ride => ride.id), ['closed-future']);
    });

    await t.test('private list adds only own role/seats and preserves every public stop', async () => {
      const current = await listMyRides(pool, owner, {});
      assert.equal(current.rides[0].role, 'driver');
      assert.equal(current.rides[0].seatCount, 0);
      assert.equal(current.rides[0].stops.length, 3);
      assert.equal(current.rides[1].role, 'passenger');
      assert.equal(current.rides[1].seatCount, 1);
      const text = JSON.stringify(current);
      for (const forbidden of ['private-', 'ride-secret', owner, other, 'zelleDisplay', 'profile', 'participants']) {
        assert.equal(text.includes(forbidden), false);
      }
    });

    await t.test('caller identities, arbitrary filters and invalid pagination are rejected', async () => {
      for (const input of [{ userId: other }, { callerOpenID: 'private-other' }, { scope: 'left' }, { role: 'creator' }, { limit: 51 }, { page: 0 }]) {
        await assert.rejects(listMyRides(pool, owner, input), { name: 'ZodError' });
      }
    });

    await t.test('unknown historical capacity, city and membership time stay unknown without losing access', async () => {
      await seed('closed-unknown', -2 * 86400000, 'closed', 'passenger');
      await pool.query(`UPDATE rides SET city_key=NULL,seat_capacity=NULL,updated_at=NULL WHERE id='closed-unknown'`);
      await pool.query(`UPDATE ride_members SET joined_at=NULL WHERE ride_id='closed-unknown'`);
      const history = await listMyRides(pool, owner, { scope: 'history' });
      const row = history.rides.find(ride => ride.id === 'closed-unknown');
      assert.ok(row);
      assert.equal(row.cityKey, null);
      assert.equal(row.seatCapacity, null);
      assert.equal(row.availableSeats, null);
      const data = await getRideParticipants(pool, owner, 'closed-unknown');
      assert.equal(data.participants.length, 1);
      assert.equal(data.participants[0].id, owner);
      assert.equal('joinedAt' in data.participants[0], false);
    });
  });
