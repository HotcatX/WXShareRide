import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../src/errors.ts';
import { legacyProfilesSchema, runProfilesRead } from '../src/compat/legacy-profiles.ts';
import { authorizeFileReads } from '../src/files/read.ts';
import { createTestDatabase } from './helpers/database.ts';

const appId = 'wx1234567890123456', otherApp = 'wx6543210987654321';
type User = { id: string; openid: string };
const denied = (error: unknown) => error instanceof AppError && error.status === 403 &&
  error.code === 'PROFILES_REQUIRE_NEW_CLIENT' && error.message === '无法查看这批资料，请使用新版小程序';
async function account(pool: Pool, name: string, app = appId, openid = `profile-openid-${name}`): Promise<User> {
  return (await pool.query(`INSERT INTO users(app_id,openid,name,profile) VALUES($1,$2,$3,$4) RETURNING id,openid`,
    [app, openid, name, { phone: `phone-${name}`, phoneRegion: 'US', wechatId: `wechat-${name}`, bio: `bio-${name}`,
      region: { label: 'Fort Lee' }, vehicle: { plate: `plate-${name}`, brand: 'Fixture', model: 'Car', secret: 'nested-vehicle-secret' },
      location: { residence: 'private-residence', address: 'private-address', latitude: 40.123, longitude: -74.234 },
      zelle: { name: 'private-payee', account: 'private-payment', public: false },
      preferences: { pickupAddresses: ['private-saved-address'] }, hidden: 'raw-profile-secret' }])).rows[0];
}
async function ride(pool: Pool, id: string, kind: 'offer' | 'request', driver: User, passengers: User[], options: { status?: string; past?: boolean } = {}) {
  await pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone,details)
    VALUES($1,$2,$3,'ny_nj',$4,4,now()+$5::interval,'America/New_York',$6)`,
  [id, kind, kind === 'offer' ? driver.id : passengers[0]!.id, options.status ?? 'open', options.past ? '-1 day' : '1 day', { zelleDisplay: true }]);
  for (const [user, role] of [[driver, 'driver'], ...passengers.map(user => [user, 'passenger'])] as [User, 'driver' | 'passenger'][]) {
    await pool.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state,details)
      VALUES($1,$2,$3,$4,'active',$5)`, [id, user.id, role, role === 'driver' ? 0 : 1,
      { pickupAddress: 'private-booking-pickup', dropoffAddress: 'private-booking-dropoff' }]);
  }
}
async function listing(pool: Pool, owner: User, status = 'online', extra: { app?: string; expired?: boolean; managed?: boolean } = {}) {
  const id = randomUUID();
  await pool.query(`INSERT INTO market_listings(app_id,id,owner_user_id,status,expires_at,content,shared_admin_management)
    VALUES($1,$2,$3,$4,now()+$5::interval,$6,$7)`, [extra.app ?? appId, id, owner.id, status,
    extra.expired ? '-1 day' : '1 day', { listingType: 'goods', title: 'Synthetic listing' }, extra.managed ?? false]);
  return id;
}
async function avatar(pool: Pool, users: User[]) {
  const id = (await pool.query(`INSERT INTO files(app_id,provider,locator,legacy_readonly,status)
    VALUES($1,'cloudbase','cloud://private-file-locator',true,'ready') RETURNING id`, [appId])).rows[0].id as string;
  for (const user of users) await pool.query(`INSERT INTO file_references(app_id,resource_kind,resource_id,slot,file_id)
    VALUES($1,'user',$2,'avatar',$3)`, [appId, user.id, id]);
  return id;
}
async function read(pool: Pool, actor: User, targets: string[], options: {
  app?: string; deps?: Parameters<typeof runProfilesRead>[4];
  afterQuery?: (sql: string) => Promise<void>; commands?: string[];
} = {}) {
  const client = await pool.connect();
  await client.query('BEGIN READ ONLY');
  const commands = options.commands ?? [];
  const observed = { query: async (sql: string, values: unknown[]) => {
    commands.push(sql);
    assert.match(sql, /^\s*SELECT\b/);
    assert.doesNotMatch(sql, /migration_sources|migration_batches|locator|\bBEGIN\b|\bCOMMIT\b/i);
    const result = await client.query(sql, values);
    await options.afterQuery?.(sql);
    return result;
  } } as unknown as PoolClient;
  try {
    return await runProfilesRead(observed, options.app ?? appId, actor.openid, { openids: targets }, options.deps);
  } finally {
    assert.equal((await client.query('SELECT txid_current_if_assigned() AS id')).rows[0].id, null);
    await client.query('ROLLBACK'); client.release();
  }
}
function noPrivateData(value: unknown) {
  assert.doesNotMatch(JSON.stringify(value), /private-residence|private-address|private-payee|private-payment|private-saved-address|private-booking|raw-profile-secret|nested-vehicle-secret|private-file-locator|latitude|longitude|zelle|pickupAddress|dropoffAddress/);
}

test('profiles.list validates one to twenty exact unique OpenIDs without silently normalizing or truncating', () => {
  const id = 'valid_openid_123456';
  assert.deepEqual(legacyProfilesSchema.parse({ openids: [id] }), { openids: [id] });
  for (const value of [{}, { openids: [] }, { openids: [id, id] }, { openids: [` ${id}`] }, { openids: [id + '\n'] },
    { openids: [1] }, { openids: ['short'] }, { openids: ["valid_openid_' OR 1=1"] }, { openids: [id], rideId: 'untrusted-context' },
    { openids: Array.from({ length: 21 }, (_, n) => `valid_openid_${String(n).padStart(8, '0')}`) }]) {
    assert.equal(legacyProfilesSchema.safeParse(value).success, false);
  }
});

test('legacy self projection uses the trusted app identity, current profile and real statistics without creating rows', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const self = await account(db.pool, 'self'), foreign = await account(db.pool, 'foreign', otherApp, self.openid);
  const first = (await read(db.pool, self, [self.openid])).data[0]!;
  assert.equal(first._id, self.id); assert.equal(first._openid, self.openid);
  assert.equal(first.phone, 'phone-self'); assert.equal(first.carNumber, 'plate-self');
  assert.equal(first.rideStats?.completedTrips, 0); noPrivateData(first);
  await db.pool.query(`UPDATE users SET name='Updated',profile=profile||'{"phone":"current-phone"}'::jsonb WHERE id=$1`, [self.id]);
  const refreshed = (await read(db.pool, self, [self.openid])).data[0]!;
  assert.equal(refreshed._id, self.id); assert.equal(refreshed.name, 'Updated'); assert.equal(refreshed.phone, 'current-phone');
  assert.equal((await read(db.pool, foreign, [foreign.openid], { app: otherApp })).data[0]!._id, foreign.id);
  const missing = { id: randomUUID(), openid: 'missing_actor_openid_123' };
  await assert.rejects(read(db.pool, missing, [self.openid]), denied);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 2);
});

test('retained request contacts reuse one canonical participant read and sign a shared avatar once for the actual viewer', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const driver = await account(db.pool, 'request-driver'), a = await account(db.pool, 'request-a'), b = await account(db.pool, 'request-b');
  await ride(db.pool, 'request-shared', 'request', driver, [a, b], { status: 'closed', past: true });
  const fileId = await avatar(db.pool, [driver, b]);
  await db.pool.query(`INSERT INTO ride_completions(ride_id,user_id,role) VALUES('request-shared',$1,'driver')`, [driver.id]);
  await db.pool.query(`INSERT INTO ride_ratings(id,ride_id,rater_id,target_id,rater_role,target_role,score)
    VALUES($1,'request-shared',$2,$3,'passenger','driver',5)`, [randomUUID(), a.id, driver.id]);
  const commands: string[] = [], calls: string[][] = [];
  const result = await read(db.pool, a, [b.openid, driver.openid], { commands, deps: { avatarUrl: async (id, viewerId) => {
    calls.push([id, viewerId]); await authorizeFileReads(db.pool, appId, [id], { userId: viewerId });
    return 'https://images.example.invalid/authorized-avatar';
  } } });
  assert.equal(result.ok, true); assert.deepEqual(result.data.map(user => user._openid), [b.openid, driver.openid]);
  assert.deepEqual(calls, [[fileId, a.id]]);
  assert.equal(commands.filter(sql => sql.includes('AS participants')).length, 1);
  assert.equal(result.data[0]!.phone, 'phone-request-b'); assert.equal(result.data[0]!.carNumber, undefined);
  assert.equal(result.data[1]!.carNumber, 'plate-request-driver');
  assert.deepEqual(result.data[1]!.rideStats, { completedDriverTrips: 1, driverRatingCount: 1, driverRatingAvg: 5, driverRatingWeightedAvg: 4.8 });
  assert.ok(!Object.hasOwn(result.data[1]!.rideStats!, 'completedTrips'), 'a role subtotal is not a full lifetime total');
  noPrivateData(result);
});

test('offer ACL exposes the current driver to a passenger but does not expose another passenger', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const driver = await account(db.pool, 'offer-driver'), a = await account(db.pool, 'offer-a'), b = await account(db.pool, 'offer-b');
  await ride(db.pool, 'offer-private', 'offer', driver, [a, b]);
  assert.equal((await read(db.pool, a, [driver.openid])).data[0]!.phone, 'phone-offer-driver');
  await assert.rejects(read(db.pool, a, [b.openid]), denied);
  const passengers = await read(db.pool, driver, [a.openid, b.openid]);
  assert.deepEqual(passengers.data.map(user => user.phone), ['phone-offer-a', 'phone-offer-b']); noPrivateData(passengers);
  await db.pool.query(`UPDATE ride_members SET state='left',left_at=clock_timestamp() WHERE ride_id='offer-private' AND user_id=$1`, [b.id]);
  await assert.rejects(read(db.pool, driver, [b.openid]), denied);
  await db.pool.query(`UPDATE rides SET status='cancelled' WHERE id='offer-private'`);
  await assert.rejects(read(db.pool, a, [driver.openid]), denied);
});

test('public seller eligibility is read live and never grants context-free home, GPS, vehicle or payment fields', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const viewer = await account(db.pool, 'seller-viewer'), seller = await account(db.pool, 'public-seller');
  const id = await listing(db.pool, seller);
  const result = (await read(db.pool, viewer, [seller.openid])).data[0]!;
  assert.equal(result.phone, 'phone-public-seller'); assert.equal(result.regionDisplay, 'Fort Lee');
  assert.equal(result.carNumber, undefined); assert.equal(result.rideStats, undefined); noPrivateData(result);
  for (const status of ['offline', 'sold', 'deleted']) {
    await db.pool.query('UPDATE market_listings SET status=$1 WHERE id=$2', [status, id]);
    await assert.rejects(read(db.pool, viewer, [seller.openid]), denied);
  }
  await db.pool.query(`UPDATE market_listings SET status='online',expires_at=now()-interval '1 second' WHERE id=$1`, [id]);
  await assert.rejects(read(db.pool, viewer, [seller.openid]), denied);
  await db.pool.query(`UPDATE market_listings SET expires_at=now()+interval '1 day',shared_admin_management=true WHERE id=$1`, [id]);
  await assert.rejects(read(db.pool, viewer, [seller.openid]), denied);
  await db.pool.query('UPDATE market_listings SET shared_admin_management=false WHERE id=$1', [id]);
  await db.pool.query(`UPDATE users SET profile=profile||'{"phone":"seller-changed"}'::jsonb WHERE id=$1`, [seller.id]);
  assert.equal((await read(db.pool, viewer, [seller.openid])).data[0]!.phone, 'seller-changed');
});

test('unknown, cross-app and unauthorized mixed targets reject the whole batch before any avatar signing', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const viewer = await account(db.pool, 'mixed-viewer'), allowed = await account(db.pool, 'mixed-allowed');
  const stranger = await account(db.pool, 'mixed-stranger'), foreign = await account(db.pool, 'mixed-foreign', otherApp);
  await listing(db.pool, allowed); await listing(db.pool, foreign, 'online', { app: otherApp });
  await avatar(db.pool, [allowed]);
  const calls: string[] = [];
  for (const target of [stranger.openid, foreign.openid, 'unknown_target_openid_123']) {
    await assert.rejects(read(db.pool, viewer, [allowed.openid, target], { deps: { avatarUrl: async id => { calls.push(id); return 'https://images.example.invalid/never'; } } }), denied);
  }
  assert.deepEqual(calls, []);
});

test('candidate keyset paging finds later authorized relationships and the hard bound fails explicitly', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const driver = await account(db.pool, 'paging-driver'), viewer = await account(db.pool, 'paging-viewer'), target = await account(db.pool, 'paging-target');
  for (let n = 0; n < 11; n++) await ride(db.pool, `candidate-${String(n).padStart(2, '0')}`, 'offer', driver, [viewer, target]);
  await ride(db.pool, 'z-authorized', 'request', driver, [viewer, target], { status: 'closed', past: true });
  const commands: string[] = [];
  assert.equal((await read(db.pool, viewer, [target.openid], { commands })).data[0]!.phone, 'phone-paging-target');
  assert.equal(commands.filter(sql => sql.includes('SELECT r.id FROM rides')).length, 2);
  for (let n = 11; n < 20; n++) await ride(db.pool, `candidate-${String(n).padStart(2, '0')}`, 'offer', driver, [viewer, target]);
  commands.length = 0;
  await assert.rejects(read(db.pool, viewer, [target.openid], { commands }), denied);
  assert.equal(commands.filter(sql => sql.includes('SELECT r.id FROM rides')).length, 2);
  assert.equal(commands.filter(sql => sql.includes('AS participants')).length, 20);
});

test('a candidate relationship is not authorization when membership changes before the canonical read', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const driver = await account(db.pool, 'race-driver'), viewer = await account(db.pool, 'race-viewer');
  await ride(db.pool, 'race-ride', 'offer', driver, [viewer]);
  let changed = false;
  await assert.rejects(read(db.pool, viewer, [driver.openid], { afterQuery: async sql => {
    if (!changed && sql.includes('SELECT r.id FROM rides')) {
      changed = true;
      await db.pool.query(`UPDATE ride_members SET state='left',left_at=clock_timestamp() WHERE ride_id='race-ride' AND user_id=$1`, [driver.id]);
    }
  } }), denied);
  assert.equal(changed, true);
});

test('a signing failure rejects the complete authorized batch without substituting stale or unsafe avatar URLs', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const viewer = await account(db.pool, 'avatar-viewer'), target = await account(db.pool, 'avatar-seller');
  await listing(db.pool, target); await avatar(db.pool, [target]);
  const unavailable = (error: unknown) => error instanceof AppError && error.status === 503 && error.code === 'FILE_STORAGE_UNAVAILABLE';
  await assert.rejects(read(db.pool, viewer, [viewer.openid, target.openid]), unavailable);
  for (const value of ['', 'http://images.example.invalid/a', 'https://secret@images.example.invalid/a', 'https://images.example.invalid/a#fragment']) {
    await assert.rejects(read(db.pool, viewer, [viewer.openid, target.openid], { deps: { avatarUrl: async () => value } }), unavailable);
  }
  await assert.rejects(read(db.pool, viewer, [target.openid], { deps: { avatarUrl: async () => { throw Error('provider-private-secret'); } } }),
    error => unavailable(error) && error instanceof Error && !error.message.includes('provider-private-secret'));
});
