import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { runProfileRead } from '../src/compat/legacy-profile.ts';
import { AppError } from '../src/errors.ts';
import { updateUser } from '../src/users/service.ts';
import { createRide, joinRide } from '../src/rides/service.ts';
import { createTestDatabase } from './helpers/database.ts';

const appId = 'wx1234567890123456';
const otherAppId = 'wx6543210987654321';
const hasCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
const account = async (pool: Pool, openid = `profile-${randomUUID()}`, app = appId, profile: object = {}) =>
  (await pool.query<{ id: string; openid: string }>(`INSERT INTO users(app_id,openid,name,profile)
    VALUES($1,$2,$3,$4) RETURNING id,openid`, [app, openid, 'Profile fixture', profile])).rows[0];

async function read(pool: Pool, openid: string, app = appId, deps: Parameters<typeof runProfileRead>[3] = {}) {
  const client = await pool.connect();
  await client.query('BEGIN READ ONLY');
  const commands: string[] = [];
  // Real PG executes every read. The read-only transaction also rejects any
  // hidden insert/update; recorded statements catch archive/provider access.
  const observed = { query(sql: string, values: unknown[]) {
    commands.push(sql); return client.query(sql, values);
  } } as unknown as PoolClient;
  try {
    const result = await runProfileRead(observed, app, openid, deps);
    assert.ok(commands.every(sql => /^\s*SELECT\b/.test(sql)));
    assert.ok(commands.every(sql => !/migration_sources|migration_batches|locator|\bBEGIN\b|\bCOMMIT\b/i.test(sql)));
    assert.equal((await client.query('SELECT txid_current_if_assigned() AS id')).rows[0].id, null);
    return result;
  } finally { await client.query('ROLLBACK'); client.release(); }
}

async function storedFacts(pool: Pool) {
  const result: Record<string, unknown> = {};
  for (const table of ['users', 'sessions', 'rides', 'ride_members', 'ride_ratings', 'ride_completions', 'user_blocks',
    'idempotency_requests', 'business_events', 'files', 'file_references', 'migration_sources', 'referral_codes', 'referral_bindings']) {
    result[table] = (await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${table} t`)).rows[0].rows;
  }
  return result;
}

test('legacy self profile reflects canonical profile changes and a newly joined ride without writing a second profile', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = await account(db.pool, 'profile-owner-openid', appId, { wechatId: 'owner-wechat' });
  const driver = await account(db.pool, 'profile-driver-openid', appId, { wechatId: 'driver-wechat' });
  const initial = (await read(db.pool, owner.openid)).data[0]!;
  assert.equal(initial._id, owner.id); assert.equal(initial._openid, owner.openid);
  assert.deepEqual(initial.tripPassenger, []);
  assert.equal(initial.avatarFileId, null); assert.ok(!Object.hasOwn(initial, 'avatarUrl'));
  await updateUser(db.pool, owner.id, 'profile-fixture-save', { name: 'Changed profile', profile: {
    phone: 'synthetic-phone', phoneRegion: 'US', wechatId: 'changed-wechat', bio: 'About the caller',
    vehicle: { plate: 'TEST', brand: 'Example', model: 'Model' }, zelle: { name: 'Caller', account: 'caller@example.invalid', public: false },
    region: { state: 'New Jersey', county: 'Bergen', area: 'Fort Lee', key: 'fort_lee', label: 'Fort Lee' },
    location: { label: 'Selected map place', address: 'Map address', residence: 'Private residence', latitude: 40.85, longitude: -73.97 },
    preferences: { pickupAddresses: ['Private pickup'], dropoffAddresses: ['Private dropoff'], comments: ['Saved comment'], routePrices: { fortLeeNonCore: '15美元/人' } },
    profileCompleted: true,
  } });
  const departureAt = new Date(Date.now() + 86400000).toISOString();
  const created = await createRide(db.pool, driver.id, 'profile-fixture-publish', {
    kind: 'offer', cityKey: 'ny_nj', seatCapacity: 3, listedPriceCents: 1500, note: '', timeZone: 'America/New_York',
    stops: [{ kind: 'departure', address: 'Fort Lee', departureAt }, { kind: 'destination', address: 'Columbia' }],
  });
  await joinRide(db.pool, owner.id, 'profile-fixture-join', created.data.rideId,
    { role: 'passenger', seatCount: 1, pickupAddress: 'Booking-only pickup', dropoffAddress: 'Booking-only dropoff' });
  const before = await storedFacts(db.pool);
  const refreshed = (await read(db.pool, owner.openid)).data[0]!;
  assert.equal(refreshed._id, owner.id); assert.equal(refreshed.name, 'Changed profile');
  assert.equal(refreshed.wechatID, 'changed-wechat'); assert.equal(refreshed.phone, 'synthetic-phone');
  assert.equal(refreshed.buildingName, 'Private residence'); assert.equal(refreshed.Apartment, 'Private residence');
  assert.deepEqual(refreshed.location, { displayName: 'Selected map place', address: 'Map address', lat: 40.85, lng: -73.97 });
  assert.deepEqual(refreshed.pickupSpot, ['Private pickup']); assert.deepEqual(refreshed.customPrice, { fortLeeNonCore: '15美元/人' });
  assert.equal(refreshed.zelleAccount, 'caller@example.invalid'); assert.equal(refreshed.defaultShowZelle, false);
  assert.deepEqual(refreshed.tripPassenger, [created.data.rideId]); assert.deepEqual(refreshed.tripPassengerHistory, []);
  assert.doesNotMatch(JSON.stringify(refreshed), /Booking-only pickup|profile-driver-openid|driver-wechat/);
  assert.deepEqual(await storedFacts(db.pool), before);
});

test('self identity uses app plus trusted OpenID and never reads raw archives or creates a missing account', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const openid = 'same-openid-two-apps';
  const own = await account(db.pool, openid, appId, { phone: 'own-phone', hiddenToken: 'profile-extra-must-not-leak', tripDriver: ['stale-profile-array'], referralCode: 'ref_333333333333' });
  const other = await account(db.pool, openid, otherAppId, { phone: 'other-app-phone' });
  const stranger = await account(db.pool, 'stranger-openid', appId, { phone: 'stranger-phone' });
  await db.pool.query('INSERT INTO referral_codes(user_id,code) VALUES($1,$2),($3,$4)',
    [own.id, 'ref_111111111111', other.id, 'ref_222222222222']);
  const batch = (await db.pool.query(`INSERT INTO migration_batches(app_id,source_sha256) VALUES($1,$2) RETURNING id`, [appId, 'a'.repeat(64)])).rows[0].id;
  await db.pool.query(`INSERT INTO migration_sources(batch_id,collection,source_id,document_json,sha256)
    VALUES($1,'userInfo','old-private-doc',$2,encode(sha256(convert_to($2,'UTF8')),'hex'))`,
  [batch, JSON.stringify({ _openid: openid, phone: 'stale-archive-phone', secret: 'private-raw-evidence', referralCode: 'ref_444444444444' })]);
  const before = await storedFacts(db.pool);
  const a = (await read(db.pool, openid)).data[0]!;
  assert.equal(a._id, own.id); assert.equal(a.phone, 'own-phone'); assert.deepEqual(a.tripDriver, []);
  assert.equal(a.referralCode, 'ref_111111111111');
  assert.doesNotMatch(JSON.stringify(a), /other-app-phone|stranger-phone|raw-evidence|stale-archive|hiddenToken|profile-extra|stale-profile-array|old-private-doc/);
  const b = (await read(db.pool, openid, otherAppId)).data[0]!;
  assert.equal(b._id, other.id); assert.equal(b.phone, 'other-app-phone'); assert.notEqual(a._id, b._id);
  assert.equal(b.referralCode, 'ref_222222222222');
  const missingCode = (await read(db.pool, stranger.openid)).data[0]!;
  assert.equal(missingCode._id, stranger.id); assert.ok(!Object.hasOwn(missingCode, 'referralCode'));
  assert.deepEqual(await read(db.pool, 'unknown-openid'), { data: [] });
  assert.deepEqual(await read(db.pool, `${openid}' OR TRUE --`), { data: [] });
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM referral_codes')).rows[0].n, 2);
  assert.deepEqual(await storedFacts(db.pool), before);
});

test('legacy ride arrays derive retained role and time while statistics use completions and received ratings', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = await account(db.pool, 'profile-membership-owner', appId, { rideStats: { completedTrips: 99999 } });
  const peer = await account(db.pool, 'profile-membership-peer');
  const arrays: Record<string, string[]> = {};
  for (const history of [false, true]) {
    for (const [kind, role, isCreator, field] of [
      ['offer', 'driver', true, 'tripDriver'], ['request', 'driver', false, 'tripDriverJoin'],
      ['request', 'passenger', true, 'tripPassengerCreate'], ['offer', 'passenger', false, 'tripPassenger'],
    ] as const) {
      const id = `${field}${history ? 'History' : ''}`;
      arrays[id] = [id];
      await db.pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone)
        VALUES($1,$2,$3,'ny_nj',$4,4,now()+$5::interval,'America/New_York')`,
      [id, kind, isCreator ? owner.id : peer.id, history ? 'closed' : 'open', history ? '-1 day' : '1 day']);
      await db.pool.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state) VALUES($1,$2,$3,$4,'active')`, [id, owner.id, role, role === 'driver' ? 0 : 1]);
    }
  }
  await db.pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone)
    VALUES('departed','offer',$1,'ny_nj','closed',4,now()-interval '1 day','America/New_York'),
      ('cancelled','offer',$1,'ny_nj','cancelled',4,now()+interval '1 day','America/New_York')`, [peer.id]);
  await db.pool.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state,left_at)
    VALUES('departed',$1,'passenger',1,'left',now()),('cancelled',$1,'passenger',1,'active',NULL)`, [owner.id]);
  await db.pool.query(`INSERT INTO ride_completions(ride_id,user_id,role)
    VALUES('departed',$1,'passenger'),('tripDriverHistory',$1,'driver')`, [owner.id]);
  await db.pool.query(`INSERT INTO ride_ratings(id,ride_id,rater_id,target_id,rater_role,target_role,score)
    VALUES($1,'tripDriverHistory',$2,$3,'passenger','driver',5)`, [randomUUID(), peer.id, owner.id]);
  await db.pool.query('INSERT INTO user_blocks(blocker_id,target_id) VALUES($1,$2)', [owner.id, peer.id]);
  const before = await storedFacts(db.pool), result = (await read(db.pool, owner.openid)).data[0]!;
  for (const [field, expected] of Object.entries(arrays)) assert.deepEqual(result[field as keyof typeof result], expected);
  assert.equal(result._id, owner.id); assert.deepEqual(result.blockedUsers, [peer.openid]);
  assert.deepEqual(result.rideStats, { completedTrips: 2, completedDriverTrips: 1, completedPassengerTrips: 1,
    ratingCount: 1, ratingAvg: 5, ratingWeightedAvg: 4.8, driverRatingCount: 1, driverRatingAvg: 5,
    driverRatingWeightedAvg: 4.8, passengerRatingCount: 0, passengerRatingAvg: null, passengerRatingWeightedAvg: null });
  assert.doesNotMatch(JSON.stringify(result), /99999|departed|cancelled/);
  assert.deepEqual(await storedFacts(db.pool), before);
  // Joining somebody else's request is a passenger relationship, not creating
  // a request. An elapsed first departure follows the current history reader,
  // even while a later stop is in the future; it does not invent completion.
  await db.pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone)
    VALUES('joined-request','request',$1,'ny_nj','open',4,now()+interval '1 day','America/New_York'),
      ('overdue-request','request',$1,'ny_nj','open',4,now()-interval '1 hour','America/New_York')`, [peer.id]);
  await db.pool.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state)
    VALUES('joined-request',$1,'passenger',1,'active'),('overdue-request',$1,'passenger',1,'active')`, [owner.id]);
  await db.pool.query(`INSERT INTO ride_stops(ride_id,position,kind,address,departure_at)
    VALUES('overdue-request',0,'departure','Already departed',now()-interval '1 hour'),
      ('overdue-request',1,'departure','Later stop',now()+interval '1 hour')`);
  const changed = (await read(db.pool, owner.openid)).data[0]!;
  assert.deepEqual([...changed.tripPassenger].sort(), ['joined-request', 'tripPassenger']);
  assert.deepEqual([...changed.tripPassengerHistory].sort(), ['overdue-request', 'tripPassengerHistory']);
  assert.deepEqual(changed.tripPassengerCreate, ['tripPassengerCreate']);
  assert.deepEqual(changed.rideStats, result.rideStats);
});

test('bounded legacy arrays reject an oversized result instead of silently truncating the account history', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = await account(db.pool);
  await db.pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone)
    SELECT 'large-history-'||n,'offer',$1,'ny_nj','closed',4,now()-interval '1 day','America/New_York'
    FROM generate_series(1,10001) n`, [owner.id]);
  await db.pool.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state)
    SELECT id,$1,'driver',0,'active' FROM rides`, [owner.id]);
  await assert.rejects(read(db.pool, owner.openid), hasCode('PROFILE_REQUIRES_NEW_CLIENT'));
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM ride_members')).rows[0].n, 10001);
});

test('a current self avatar requires trusted signing, and signing failure returns no partial profile', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = await account(db.pool, 'profile-avatar-owner', appId, { phone: 'private-owner-phone' });
  const avatar = (await db.pool.query(`INSERT INTO files(app_id,provider,locator,legacy_readonly,status)
    VALUES($1,'cloudbase','cloud://private-provider-locator',true,'ready') RETURNING id`, [appId])).rows[0].id;
  await db.pool.query(`INSERT INTO file_references(app_id,resource_kind,resource_id,slot,file_id)
    VALUES($1,'user',$2,'avatar',$3)`, [appId, owner.id, avatar]);
  const before = await storedFacts(db.pool), calls: string[][] = [];
  const signed = (await read(db.pool, owner.openid, appId, { avatarUrl: async (fileId, userId) => {
    calls.push([fileId, userId]); return 'https://images.example.invalid/current-avatar?short-lived=1';
  } })).data[0]!;
  assert.deepEqual(calls, [[avatar, owner.id]]); assert.equal(signed.avatarFileId, avatar);
  assert.equal(signed.avatarUrl, 'https://images.example.invalid/current-avatar?short-lived=1');
  assert.doesNotMatch(JSON.stringify(signed), /private-provider-locator/);
  await assert.rejects(read(db.pool, owner.openid), hasCode('FILE_STORAGE_UNAVAILABLE'));
  await assert.rejects(read(db.pool, owner.openid, appId, { avatarUrl: async () => { throw Error('private signing error'); } }),
    error => hasCode('FILE_STORAGE_UNAVAILABLE')(error) && error instanceof Error && !error.message.includes('private signing'));
  for (const url of ['', 'http://images.example.invalid/avatar', 'https://user:secret@images.example.invalid/avatar', 'https://images.example.invalid/avatar#fragment']) {
    await assert.rejects(read(db.pool, owner.openid, appId, { avatarUrl: async () => url }), hasCode('FILE_STORAGE_UNAVAILABLE'));
  }
  assert.deepEqual(await storedFacts(db.pool), before);
  await db.pool.query("UPDATE files SET status='deleted' WHERE id=$1", [avatar]);
  assert.equal((await read(db.pool, owner.openid, appId, { avatarUrl: async () => { throw Error('no unavailable avatar signing'); } })).data[0]!.avatarFileId, null);
});
