import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { runLegacyRideRead, legacyRideSchemas } from '../src/compat/legacy-rides.ts';
import { AppError } from '../src/errors.ts';
import { authorizeFileReads } from '../src/files/read.ts';
import { createTestDatabase } from './helpers/database.ts';

const app = 'wx1234567890123456', otherApp = 'wx6543210987654321';
const hasCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
const account = async (pool: Pool, openid = `ride-${randomUUID()}`, appId = app) =>
  (await pool.query<{ id: string; openid: string }>(`INSERT INTO users(app_id,openid,name,profile)
    VALUES($1,$2,$2,$3) RETURNING id,openid`, [appId, openid, { phone: `${openid}-phone`, wechatId: `${openid}-wechat`,
      location: { residence: 'private-profile-home' }, hiddenToken: 'never-disclose-token',
      vehicle: { plate: 'SYNTHETIC-PLATE' }, zelle: { name: 'Synthetic owner', account: 'private-payment@example.invalid' } }])).rows[0]!;
async function ride(pool: Pool, id: string, creator: string, options: {
  kind?: 'offer' | 'request'; status?: 'open' | 'closed' | 'cancelled'; departure?: string; capacity?: number;
  extraDeparture?: string; from?: string; to?: string;
} = {}) {
  const at = options.departure ?? new Date(Date.now() + 86400000).toISOString();
  await pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone,listed_price_cents,details)
    VALUES($1,$2,$3,'ny_nj',$4,$5,$6,'America/New_York',1250,$7)`,
  [id, options.kind ?? 'offer', creator, options.status ?? 'open', options.capacity ?? 4, at,
    { note: 'Public route note', zelleDisplay: false, rawSecret: 'never-disclose-ride-secret', largeLuggageCount: 2 }]);
  await pool.query(`INSERT INTO ride_stops(ride_id,position,kind,address,departure_at)
    VALUES($1,0,'departure',$2,$3),($1,1,'destination',$4,NULL)`, [id, options.from ?? 'Fort Lee', at, options.to ?? 'Columbia']);
  if (options.extraDeparture) {
    await pool.query('UPDATE ride_stops SET position=2 WHERE ride_id=$1 AND position=1', [id]);
    await pool.query(`INSERT INTO ride_stops(ride_id,position,kind,address,departure_at)
      VALUES($1,1,'departure','Second stop',$2)`, [id, options.extraDeparture]);
  }
}
async function member(pool: Pool, id: string, user: string, role: 'driver' | 'passenger', seats = 1, left = false) {
  await pool.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state,left_at,details)
    VALUES($1,$2,$3,$4,$5,CASE WHEN $5='left' THEN now() END,$6)`,
  [id, user, role, role === 'driver' ? 0 : seats, left ? 'left' : 'active',
    { pickupAddress: `${user}-private-pickup`, dropoffAddress: `${user}-private-dropoff`, rawSecret: 'never-disclose-member-secret' }]);
}
// These assertions exercise the JSON wire shape, independently of inferred TS
// response unions. All domain reads execute in a real read-only PG transaction.
async function read(pool: Pool, openid: string, action: string, body: unknown = {}, appId = app,
  deps: Parameters<typeof runLegacyRideRead>[5] = {}) {
  const client = await pool.connect(), commands: string[] = [];
  await client.query('BEGIN READ ONLY');
  const observed = { query(sql: string, values: unknown[]) { commands.push(sql); return client.query(sql, values); } } as unknown as PoolClient;
  try {
    const result = await runLegacyRideRead(observed, appId, openid, action, body, deps);
    assert.ok(commands.every(sql => /^\s*SELECT\b/.test(sql)));
    assert.ok(commands.every(sql => !/migration_sources|migration_batches|locator|\bBEGIN\b|\bCOMMIT\b/i.test(sql)));
    assert.equal((await client.query('SELECT txid_current_if_assigned() AS id')).rows[0].id, null);
    return JSON.parse(JSON.stringify(result));
  } finally { await client.query('ROLLBACK'); client.release(); }
}

test('legacy home/history derive retained roles and first-departure boundary from current PG, preserving raw ride IDs', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const actor = await account(db.pool, 'home-owner'), peer = await account(db.pool, 'home-peer');
  for (const historical of [false, true]) {
    for (const [name, kind, role, creator] of [
      ['driverCreate', 'offer', 'driver', actor.id], ['driverJoin', 'request', 'driver', peer.id],
      ['passengerCreate', 'request', 'passenger', actor.id], ['passenger', 'offer', 'passenger', peer.id],
    ] as const) {
      const id = `${historical ? 'history_' : ''}${name}`;
      await ride(db.pool, id, creator, { kind, status: historical ? 'closed' : 'open',
        departure: new Date(Date.now() + (historical ? -1 : 1) * 86400000).toISOString() });
      await member(db.pool, id, actor.id, role);
    }
  }
  await ride(db.pool, 'elapsed-first-future-last', peer.id, {
    departure: new Date(Date.now() - 3600000).toISOString(), extraDeparture: new Date(Date.now() + 3600000).toISOString() });
  await member(db.pool, 'elapsed-first-future-last', actor.id, 'passenger');
  await ride(db.pool, 'cancelled-route', actor.id, { status: 'cancelled' });
  await member(db.pool, 'cancelled-route', actor.id, 'driver');
  await ride(db.pool, 'left-route', peer.id); await member(db.pool, 'left-route', actor.id, 'passenger', 1, true);
  const home = await read(db.pool, actor.openid, 'rides.home');
  assert.equal(home.ok, true); assert.equal(home.success, true);
  assert.deepEqual(home.statuses, ['open', 'full', 'past']);
  assert.deepEqual(home.data.driver.createList.map((r: { _id: string }) => r._id), ['driverCreate']);
  assert.deepEqual(home.data.driver.joinList.map((r: { role: string }) => r.role), ['driverJoin']);
  assert.deepEqual(home.data.passenger.createList.map((r: { role: string }) => r.role), ['passengerCreate']);
  assert.deepEqual(home.data.passenger.joinList.map((r: { role: string }) => r.role), ['passenger']);
  assert.equal(home.data.createList.length, 2); assert.equal(home.data.joinList.length, 2);
  const shown = home.data.driver.createList[0].tripData;
  assert.equal(shown._id, 'driverCreate'); assert.equal(shown.referencePrice, '12.50');
  assert.equal(shown.departures[0].address, 'Fort Lee'); assert.equal(shown.destinations[0].address, 'Columbia');
  assert.match(shown._timeLabel, /^\d+月\d+日 周. \d\d:\d\d$/);
  assert.doesNotMatch(JSON.stringify(home), /home-peer-phone|home-peer-wechat|private-pickup|never-disclose|cancelled-route|left-route|elapsed-first/);
  const history = await read(db.pool, actor.openid, 'rides.history');
  assert.equal(history.data.length, 5);
  const past = new Map(history.data.map((row: { _id: string; historyRole: string }) => [row._id, row.historyRole]));
  assert.equal(past.get('history_driverCreate'), 'driver_create'); assert.equal(past.get('history_driverJoin'), 'driver_join');
  assert.equal(past.get('history_passengerCreate'), 'passenger_create'); assert.equal(past.get('elapsed-first-future-last'), 'passenger');
  assert.ok(history.data.every((row: { status: string }) => row.status === 'past'));
  assert.deepEqual((await read(db.pool, actor.openid, 'rides.home', { statuses: ['past'] })).data.createList, []);
  assert.deepEqual((await read(db.pool, 'not-created', 'rides.history')).data, []);
  assert.deepEqual((await read(db.pool, 'not-created', 'rides.home')).data.driver, { createList: [], joinList: [] });
  const other = await account(db.pool, actor.openid, otherApp);
  assert.notEqual(other.id, actor.id);
  assert.deepEqual((await read(db.pool, actor.openid, 'rides.history', {}, otherApp)).data, []);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 3);
});

test('detail discloses only canonical current participant fields; visitor, passenger, driver and departed views stay separated', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const driver = await account(db.pool, 'detail-driver'), p1 = await account(db.pool, 'detail-p1'), p2 = await account(db.pool, 'detail-p2'),
    visitor = await account(db.pool, 'detail-visitor');
  await ride(db.pool, 'raw_legacy:offer', driver.id); await member(db.pool, 'raw_legacy:offer', driver.id, 'driver');
  await member(db.pool, 'raw_legacy:offer', p1.id, 'passenger'); await member(db.pool, 'raw_legacy:offer', p2.id, 'passenger', 2);
  const publicView = await read(db.pool, visitor.openid, 'rides.detail', { tripId: 'raw_legacy:offer' });
  assert.equal(publicView.data._id, 'raw_legacy:offer'); assert.equal(publicView.openid, visitor.openid);
  assert.equal(publicView.driverInfo, null); assert.equal(publicView.driverStats.completedDriverTrips, 0);
  assert.ok(!Object.hasOwn(publicView.data, 'passengers')); assert.ok(!Object.hasOwn(publicView.data, '_openid'));
  assert.doesNotMatch(JSON.stringify(publicView), /detail-driver|detail-p1|detail-p2|private-payment|private-pickup|SYNTHETIC-PLATE/);
  const passengerView = await read(db.pool, p1.openid, 'rides.detail', { id: 'raw_legacy:offer', type: 'carpool' });
  assert.equal(passengerView.driverInfo._openid, driver.openid); assert.equal(passengerView.driverInfo.phone, 'detail-driver-phone');
  assert.equal(passengerView.driverInfo.carNumber, 'SYNTHETIC-PLATE'); assert.equal(passengerView.driverInfo.zelleAccount, '');
  assert.equal(passengerView.data.zelle, 'no');
  assert.equal(passengerView.data._openid, driver.openid);
  assert.deepEqual(passengerView.data.passengers.map((p: { _openid: string }) => p._openid), [p1.openid]);
  assert.equal(passengerView.data.passengers[0].pickupAddress, `${p1.id}-private-pickup`);
  assert.doesNotMatch(JSON.stringify(passengerView), /detail-p2|private-profile-home|never-disclose/);
  const driverView = await read(db.pool, driver.openid, 'rides.detail', { id: 'raw_legacy:offer' });
  assert.equal(driverView.data.passengers.length, 2); assert.match(JSON.stringify(driverView), new RegExp(`${p2.id}-private-pickup`));
  await db.pool.query(`UPDATE rides SET details=jsonb_set(details,'{zelleDisplay}','true') WHERE id='raw_legacy:offer'`);
  const disclosed = await read(db.pool, p1.openid, 'rides.detail', { id: 'raw_legacy:offer' });
  assert.equal(disclosed.data.zelle, 'yes'); assert.equal(disclosed.driverInfo.zelleAccount, 'private-payment@example.invalid');
  await db.pool.query("UPDATE ride_members SET state='left',left_at=clock_timestamp() WHERE ride_id=$1 AND user_id=$2", ['raw_legacy:offer', p1.id]);
  const left = await read(db.pool, p1.openid, 'rides.detail', { id: 'raw_legacy:offer' });
  assert.equal(left.driverInfo, null); assert.ok(!Object.hasOwn(left.data, 'passengers'));
  await db.pool.query('INSERT INTO user_blocks(blocker_id,target_id) VALUES($1,$2)', [driver.id, visitor.id]);
  const blocked = await read(db.pool, visitor.openid, 'rides.detail', { id: 'raw_legacy:offer' });
  assert.equal(blocked.blocked, true); assert.equal(blocked.success, false); assert.ok(!Object.hasOwn(blocked, 'data'));
  await db.pool.query('INSERT INTO user_blocks(blocker_id,target_id) VALUES($1,$2)', [p2.id, driver.id]);
  assert.equal((await read(db.pool, p2.openid, 'rides.detail', { id: 'raw_legacy:offer' })).ok, true, 'current members retain their required contacts');
  const missing = { ok: false, success: false, notFound: true, errorMsg: '该路线不存在或已被删除', openid: visitor.openid, type: 'carpool' };
  assert.deepEqual(await read(db.pool, visitor.openid, 'rides.detail', { id: 'raw_legacy:offer', type: 'request' }),
    { ...missing, type: 'request', errorMsg: '该求车路线不存在或已被删除' });
  assert.deepEqual(await read(db.pool, visitor.openid, 'rides.detail', { id: 'raw_legacy:offer' }, otherApp), missing);
  assert.deepEqual(await read(db.pool, visitor.openid, 'rides.detail', { id: 'missing-route' }), missing);
  await db.pool.query("UPDATE rides SET status='cancelled' WHERE id='raw_legacy:offer'");
  assert.deepEqual(await read(db.pool, visitor.openid, 'rides.detail', { id: 'raw_legacy:offer' }), missing);
});

test('request driver roster and caller-only ratings use current ACL, and avatars need trusted authorized signing', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = await account(db.pool, 'request-owner'), driver = await account(db.pool, 'request-driver'), peer = await account(db.pool, 'request-peer'), visitor = await account(db.pool, 'request-visitor');
  await ride(db.pool, 'raw_request', owner.id, { kind: 'request', status: 'closed', departure: new Date(Date.now() - 86400000).toISOString() });
  await member(db.pool, 'raw_request', owner.id, 'passenger'); await member(db.pool, 'raw_request', peer.id, 'passenger'); await member(db.pool, 'raw_request', driver.id, 'driver');
  const file = (await db.pool.query(`INSERT INTO files(app_id,provider,locator,legacy_readonly,status)
    VALUES($1,'cloudbase','cloud://private-avatar-locator',true,'ready') RETURNING id`, [app])).rows[0].id;
  await db.pool.query(`INSERT INTO file_references(app_id,resource_kind,resource_id,slot,file_id) VALUES($1,'user',$2,'avatar',$3)`, [app, owner.id, file]);
  await db.pool.query(`INSERT INTO ride_ratings(id,ride_id,rater_id,target_id,rater_role,target_role,score)
    VALUES($1,'raw_request',$2,$3,'driver','passenger',4),($4,'raw_request',$5,$2,'passenger','driver',5)`, [randomUUID(), driver.id, owner.id, randomUUID(), peer.id]);
  const publicView = await read(db.pool, visitor.openid, 'rides.detail', { requestId: 'raw_request', type: 'request' }, app,
    { avatarUrl: async () => { throw Error('public projection must never sign private avatars'); } });
  assert.equal(publicView.driverStats, null); assert.deepEqual(publicView.passengerProfiles, []);
  const signed: string[][] = [], deps = { avatarUrl: async (fileId: string, viewerId: string) => {
    await authorizeFileReads(db.pool, app, [fileId], { userId: viewerId });
    signed.push([fileId, viewerId]); return 'https://images.example.invalid/current-avatar?token=synthetic';
  } };
  const result = await read(db.pool, driver.openid, 'rides.detail', { id: 'raw_request', type: 'request' }, app, deps);
  assert.deepEqual(signed, [[file, driver.id]]); assert.equal(result.data._openid, owner.openid);
  assert.equal(result.data.driverOpenid, driver.openid); assert.equal(result.data.largeLuggageCount, 2);
  assert.deepEqual([...result.data.passengerID].sort(), [owner.openid, peer.openid].sort());
  assert.equal(result.passengerProfiles.length, 2); assert.equal(result.passengerProfilesError, false);
  assert.deepEqual(result.ratedTargetOpenids, [owner.openid]); assert.deepEqual(result.ratingState, { ratedTargetOpenids: [owner.openid] });
  assert.equal(result.driverInfo.zelleAccount, 'private-payment@example.invalid');
  assert.equal(result.driverStats.driverRatingCount, 1); assert.equal(result.driverStats.driverRatingAvg, 5);
  assert.doesNotMatch(JSON.stringify(result), /private-avatar-locator|private-profile-home|private-pickup|never-disclose/);
  const passengerView = await read(db.pool, peer.openid, 'rides.detail', { id: 'raw_request', type: 'request' }, app, deps);
  assert.deepEqual(passengerView.passengerProfiles, []); assert.deepEqual(passengerView.ratedTargetOpenids, [driver.openid]);
  await assert.rejects(read(db.pool, driver.openid, 'rides.detail', { id: 'raw_request', type: 'request' }), hasCode('FILE_STORAGE_UNAVAILABLE'));
  for (const url of ['http://images.example.invalid/a', 'https://user:secret@images.example.invalid/a', 'https://images.example.invalid/a#fragment', '']) {
    await assert.rejects(read(db.pool, driver.openid, 'rides.detail', { id: 'raw_request', type: 'request' }, app, { avatarUrl: async () => url }), hasCode('FILE_STORAGE_UNAVAILABLE'));
  }
});

test('NYC day list traverses every page and DST midnight, while calendar, type aliases, block directions and next date agree', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const driver = await account(db.pool, 'list-driver'), viewer = await account(db.pool, 'list-viewer'), blocked = await account(db.pool, 'list-blocked'),
    reverse = await account(db.pool, 'list-reverse'), other = await account(db.pool, 'list-other', otherApp);
  // 2032-03-14 is the 23-hour New York spring transition. 04:59Z belongs
  // to the previous day; next midnight is 04:00Z rather than 05:00Z.
  for (const [id, at] of [['before', '2032-03-14T04:59:00Z'], ['first', '2032-03-14T05:00:00Z'],
    ['last', '2032-03-15T03:59:00Z'], ['next', '2032-03-15T04:00:00Z']] as const) {
    await ride(db.pool, id, driver.id, { departure: at }); await member(db.pool, id, driver.id, 'driver');
  }
  await db.pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone)
    SELECT 'paged-'||lpad(n::text,3,'0'),'offer',$1,'ny_nj','open',4,'2032-03-14T12:00:00Z'::timestamptz+n*interval '1 minute','America/New_York'
    FROM generate_series(1,105) n`, [driver.id]);
  await db.pool.query(`INSERT INTO ride_stops(ride_id,position,kind,address,departure_at)
    SELECT id,0,'departure','Fort Lee',departure_at FROM rides WHERE id LIKE 'paged-%'
    UNION ALL SELECT id,1,'destination','Columbia',NULL FROM rides WHERE id LIKE 'paged-%'`);
  for (const [id, owner] of [['blocked', blocked], ['reverse', reverse], ['wrong-app', other]] as const) {
    await ride(db.pool, id, owner.id, { departure: '2032-03-14T12:00:00Z' }); await member(db.pool, id, owner.id, 'driver');
  }
  await ride(db.pool, 'request-day', driver.id, { kind: 'request', departure: '2032-03-14T13:00:00Z' });
  await member(db.pool, 'request-day', driver.id, 'passenger');
  await db.pool.query('INSERT INTO user_blocks(blocker_id,target_id) VALUES($1,$2),($3,$1)', [viewer.id, blocked.id, reverse.id]);
  const range = { startDate: '2032-03-14', endDateExclusive: '2032-03-15', cityKey: 'ny', limit: 20 };
  const result = await read(db.pool, viewer.openid, 'rides.list', range);
  assert.equal(result.data.carpool.length, 107); assert.equal(result.data.request.length, 1);
  assert.equal(result.data.carpool[0]._id, 'first'); assert.equal(result.data.carpool.at(-1)._id, 'last');
  assert.equal(result.data.carpool[0].departures[0].time, '00:00');
  assert.equal(result.data.carpool.at(-1).departures[0].time, '23:59');
  assert.deepEqual(result.carpoolList, result.data.carpool); assert.deepEqual(result.requestList, result.data.request);
  assert.deepEqual(result.page, { startDate: '2032-03-14', endDateExclusive: '2032-03-15', nextDate: '2032-03-15', hasMore: true });
  assert.doesNotMatch(JSON.stringify(result), /list-driver|list-blocked|list-reverse|list-other|wrong-app|never-disclose/);
  const calendar = await read(db.pool, viewer.openid, 'rides.list', { action: 'calendar', month: '2032-03', cityKey: 'nj', fromPlace: 'Fort Lee' });
  assert.deepEqual(calendar.data.days.find((d: { date: string }) => d.date === '2032-03-14'), { date: '2032-03-14', carpoolCount: 107, requestCount: 1 });
  const typed = await read(db.pool, viewer.openid, 'rides.list', { ...range, cityKey: 'ny_nj', type: 'request' });
  assert.equal(typed.type, 'request'); assert.equal(typed.data[0]._id, 'request-day'); assert.equal(typed.data.length, 1);
  assert.deepEqual(typed.page, { startDate: '2032-03-14', endDateExclusive: '2032-03-15', nextDate: '', hasMore: false });
  const limited = await read(db.pool, viewer.openid, 'rides.list', { type: 'carpool', limit: 80, quick: true, fastOnly: true });
  assert.equal(limited.data.length, 80); assert.ok(!Object.hasOwn(limited, 'page'));
  const empty = await read(db.pool, viewer.openid, 'rides.list', { ...range, fromPlace: 'Nowhere' });
  assert.deepEqual(empty.data.carpool, []); assert.deepEqual(empty.data.request, []); assert.equal(empty.page.hasMore, false);
});

test('overlarge complete legacy lists fail explicitly rather than silently omitting records', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const actor = await account(db.pool);
  await db.pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone)
    SELECT 'large-'||n,'offer',$1,'ny_nj','open',4,'2032-03-14T12:00:00Z','America/New_York' FROM generate_series(1,1001) n`, [actor.id]);
  await db.pool.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state) SELECT id,$1,'driver',0,'active' FROM rides`, [actor.id]);
  await assert.rejects(read(db.pool, actor.openid, 'rides.home'), hasCode('LEGACY_READ_UPGRADE_REQUIRED'));
  await assert.rejects(read(db.pool, actor.openid, 'rides.list', { startDate: '2032-03-14', endDateExclusive: '2032-03-15' }), hasCode('LEGACY_READ_UPGRADE_REQUIRED'));
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM rides')).rows[0].n, 1001);
});

test('strict legacy read schemas reject unsupported operations, forged identity and ambiguous IDs before querying', async () => {
  const noQuery = { query() { throw Error('invalid input reached database'); } } as unknown as PoolClient;
  const invalid: [string, unknown][] = [
    ['rides.list', { action: 'places' }], ['rides.list', { action: 'delete' }], ['rides.history', { openid: 'another-account' }],
    ['rides.home', { statuses: [] }], ['rides.home', { statuses: ['cancelled'] }],
    ['rides.list', { limit: 101 }], ['rides.list', { cityKey: 'arbitrary-city' }],
    ['rides.list', { startDate: '2032-02-30', endDateExclusive: '2032-03-01' }],
    ['rides.list', { startDate: '2032-03-14' }], ['rides.list', { startDate: '2032-03-14', endDateExclusive: '2032-03-17' }],
    ['rides.list', { action: 'calendar', month: '2032-03', startDate: '2032-03-14', endDateExclusive: '2032-03-15' }],
    ['rides.list', { action: 'calendar', month: '2032-13' }], ['rides.list', { fromPlace: 'x'.repeat(201) }],
    ['rides.list', { fromPresets: Array(101).fill('Fort Lee') }], ['rides.detail', {}],
    ['rides.detail', { id: 'one', tripId: 'another' }], ['rides.detail', { id: 'one', openid: 'forged-owner' }],
    ['rides.detail', { id: '../../different' }], ['rides.remove', { id: 'one' }],
  ];
  for (const [action, body] of invalid) await assert.rejects(runLegacyRideRead(noQuery, app, 'trusted', action, body), hasCode('LEGACY_READ_UPGRADE_REQUIRED'));
  assert.ok(legacyRideSchemas['rides.detail'].safeParse({ id: 'same', tripId: 'same', requestId: 'same' }).success);
  assert.ok(legacyRideSchemas['rides.list'].safeParse({ action: 'calendar', month: '2032-03', fromPresets: [] }).success);
});

test('a version change between public and private snapshots never combines stale disclosure', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = await account(db.pool), passenger = await account(db.pool);
  await ride(db.pool, 'changing', owner.id); await member(db.pool, 'changing', owner.id, 'driver'); await member(db.pool, 'changing', passenger.id, 'passenger');
  const client = await db.pool.connect(); await client.query('BEGIN READ ONLY');
  let changed = false;
  const observed = { async query(sql: string, values: unknown[]) {
    const result = await client.query(sql, values);
    if (!changed && sql.includes('r.id AS "rideId",r.version')) {
      changed = true; await db.pool.query("UPDATE rides SET version=version+1 WHERE id='changing'");
    }
    return result;
  } } as unknown as PoolClient;
  try { await assert.rejects(runLegacyRideRead(observed, app, passenger.openid, 'rides.detail', { id: 'changing' }), hasCode('RIDE_CHANGED')); }
  finally { await client.query('ROLLBACK'); client.release(); }
  assert.equal(changed, true);
});

test('the parent repeatable-read snapshot keeps paginated membership stable across cancellation, departure and a new join', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = await account(db.pool, 'snapshot-driver'), viewer = await account(db.pool, 'snapshot-passenger');
  await db.pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone)
    SELECT 'snapshot-'||lpad(n::text,3,'0'),'offer',$1,'ny_nj','open',4,
      '2032-03-14T12:00:00Z'::timestamptz+n*interval '1 minute','America/New_York'
    FROM generate_series(1,60) n`, [owner.id]);
  await db.pool.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state)
    SELECT id,$1::uuid,'driver',0,'active' FROM rides UNION ALL SELECT id,$2::uuid,'passenger',1,'active' FROM rides`, [owner.id, viewer.id]);
  await ride(db.pool, 'newly-joined', owner.id, { departure: '2032-03-14T12:00:00Z' });
  await member(db.pool, 'newly-joined', owner.id, 'driver');
  await ride(db.pool, 'unrelated-private-ride', owner.id, { departure: '2032-03-14T12:00:00Z' });
  await member(db.pool, 'unrelated-private-ride', owner.id, 'driver');
  const client = await db.pool.connect();
  await client.query('BEGIN READ ONLY');
  // The verified bridge sets this before its first nonce/domain query. The
  // compatibility module must reuse this transaction, never open another one.
  await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  assert.equal((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'repeatable read');
  let pageReads = 0;
  const observed = { async query(sql: string, values: unknown[]) {
    assert.match(sql, /^\s*SELECT\b/);
    const result = await client.query(sql, values);
    if (sql.includes('FROM rides r JOIN ride_members mine')) {
      pageReads++;
      if (pageReads === 1) {
        const mutator = await db.pool.connect();
        try {
          await mutator.query('BEGIN');
          await mutator.query("UPDATE rides SET status='cancelled',version=version+1 WHERE id='snapshot-001'");
          await mutator.query(`UPDATE ride_members SET state='left',left_at=clock_timestamp()
            WHERE ride_id='snapshot-055' AND user_id=$1`, [viewer.id]);
          await mutator.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state)
            VALUES('newly-joined',$1,'passenger',1,'active')`, [viewer.id]);
          await mutator.query('COMMIT');
        } catch (error) { await mutator.query('ROLLBACK'); throw error; }
        finally { mutator.release(); }
      }
    }
    return result;
  } } as unknown as PoolClient;
  try {
    const result = JSON.parse(JSON.stringify(await runLegacyRideRead(observed, app, viewer.openid, 'rides.home', {})));
    const ids = result.data.passenger.joinList.map((row: { _id: string }) => row._id);
    assert.equal(pageReads, 2);
    assert.deepEqual(ids, Array.from({ length: 60 }, (_, n) => `snapshot-${String(n + 1).padStart(3, '0')}`));
    assert.equal(new Set(ids).size, 60);
    assert.doesNotMatch(JSON.stringify(result), /unrelated-private-ride|newly-joined|snapshot-driver-phone|private-pickup/);
    assert.equal((await client.query('SELECT txid_current_if_assigned() AS id')).rows[0].id, null);
  } finally { await client.query('ROLLBACK'); client.release(); }
  const refreshed = await read(db.pool, viewer.openid, 'rides.home');
  const after = refreshed.data.passenger.joinList.map((row: { _id: string }) => row._id);
  assert.equal(after.length, 59); assert.ok(after.includes('newly-joined'));
  assert.ok(!after.includes('snapshot-001')); assert.ok(!after.includes('snapshot-055'));
  assert.ok(!after.includes('unrelated-private-ride'));
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 0);
});
