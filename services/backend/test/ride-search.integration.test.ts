import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { listRides, rideCalendar } from '../src/rides/read.ts';
import { getRideMembership } from '../src/rides/participants.ts';
import { createApp } from '../src/app.ts';
import { createTestDatabase } from './helpers/database.ts';

const enabled = { skip: !process.env.BACKEND_TEST_DATABASE_URL };
test('calendar counts a complete busy leap day and keeps New York month and year boundaries', enabled, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const appId = 'synthetic-calendar-boundaries';
  const owner = (await db.pool.query("INSERT INTO users(app_id,openid) VALUES($1,'calendar-owner') RETURNING id", [appId])).rows[0].id;
  for (const [kind, count] of [['offer', 135], ['request', 110]] as const) {
    await db.pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone)
      SELECT $1||'-'||lpad(i::text,3,'0'),$1,$2,'ny_nj','open',4,'2036-02-29T15:00:00Z','America/New_York'
      FROM generate_series(1,$3::int) i`, [kind, owner, count]);
  }
  for (const [id, at] of [
    ['before-month', '2036-02-01T04:59:59.999Z'], ['month-start', '2036-02-01T05:00:00Z'],
    ['month-end', '2036-03-01T04:59:59.999Z'], ['next-month', '2036-03-01T05:00:00Z'],
    ['year-end', '2037-01-01T04:59:59.999Z'], ['new-year', '2037-01-01T05:00:00Z'],
  ]) {
    await db.pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone)
      VALUES($1,'offer',$2,'ny_nj','open',4,$3,'America/New_York')`, [id, owner, at]);
  }
  assert.deepEqual(await rideCalendar(db.pool, { month: '2036-02' }, undefined, appId), {
    month: '2036-02', days: [{ date: '2036-02-01', offerCount: 1, requestCount: 0 },
      { date: '2036-02-29', offerCount: 136, requestCount: 110 }],
  });
  assert.deepEqual((await rideCalendar(db.pool, { month: '2036-02', kind: 'request' }, undefined, appId)).days,
    [{ date: '2036-02-29', offerCount: 0, requestCount: 110 }]);
  assert.deepEqual((await rideCalendar(db.pool, { month: '2036-12' }, undefined, appId)).days,
    [{ date: '2036-12-31', offerCount: 1, requestCount: 0 }]);
  assert.deepEqual((await rideCalendar(db.pool, { month: '2037-01' }, undefined, appId)).days,
    [{ date: '2037-01-01', offerCount: 1, requestCount: 0 }]);
  const ids: string[] = [];
  for (let page = 1; page <= 5; page++) {
    const result = await listRides(db.pool,
      { startDate: '2036-02-29', endDateExclusive: '2036-03-01', page, limit: 50 }, undefined, appId);
    assert.equal(result.rides.length, page < 5 ? 50 : 46);
    assert.equal(result.nextPage, page < 5 ? page + 1 : null);
    assert.equal(result.nextDate, '2036-03-01');
    ids.push(...result.rides.map(row => row.id));
  }
  assert.equal(ids.length, 246); assert.equal(new Set(ids).size, 246);
  assert.ok(ids.includes('month-end')); assert.ok(!ids.includes('next-month'));
});

test('SQL list and calendar share airport and neighborhood aliases without widening custom addresses', enabled, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const appId = 'synthetic-place-boundaries';
  const owner = (await db.pool.query("INSERT INTO users(app_id,openid) VALUES($1,'place-owner') RETURNING id", [appId])).rows[0].id;
  const groups = [
    ['EWR', ['EWR', 'Newark Liberty International Airport', 'EWR Terminal C', '纽瓦克机场 T1']],
    ['JSQ', ['Journal Square', 'JSQ PATH']],
    ['LIC', ['Long Island City', 'LIC']],
    ['Inwood', ['Inwood', 'Inwood Manhattan', 'Inwood Park entrance']],
    ['中城', ['Midtown', 'Midtown Manhattan', 'Midtown West', '中城 Bryant Park']],
  ] as const;
  const unrelated = ['Newark', '纽瓦克', 'Newark Broad Street', 'fewr station', 'Jersey City', 'Long Island',
    'Inwoodman', 'Midtown Jersey City', 'Downtown Brooklyn', 'Queensboro Plaza'];
  const rows = [...groups.flatMap(([group, addresses]) => addresses.map((address, i) => ({ id: `${group}-${i}`, address }))),
    ...unrelated.map((address, i) => ({ id: `unrelated-${i}`, address }))];
  for (const { id, address } of rows) {
    await db.pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone)
      VALUES($1,'offer',$2,'ny_nj','open',4,'2036-04-10T15:00:00Z','America/New_York')`, [id, owner]);
    await db.pool.query(`INSERT INTO ride_stops(ride_id,position,kind,address,departure_at)
      VALUES($1,0,'departure',$2,'2036-04-10T15:00:00Z'),($1,1,'destination',$2,NULL)`, [id, address]);
  }
  for (const [group, addresses] of groups) {
    const filter = { fromPlace: group, toPlace: group };
    assert.deepEqual((await listRides(db.pool, filter, undefined, appId)).rides.map(row => row.id).sort(),
      addresses.map((_, i) => `${group}-${i}`).sort());
    assert.deepEqual((await rideCalendar(db.pool, { ...filter, month: '2036-04' }, undefined, appId)).days,
      [{ date: '2036-04-10', offerCount: addresses.length, requestCount: 0 }]);
  }
  for (const address of ['EWR Terminal C', 'Inwood Park entrance', 'Midtown West']) {
    const filter = { fromPlace: address, toPlace: address };
    assert.deepEqual((await listRides(db.pool, filter, undefined, appId)).rides.map(row => row.id),
      [rows.find(row => row.address === address)!.id]);
    assert.equal((await rideCalendar(db.pool, { ...filter, month: '2036-04' }, undefined, appId)).days[0].offerCount, 1);
  }
  const other = { fromPlace: '其他', fromPresets: JSON.stringify(groups.map(([group]) => group)) };
  assert.deepEqual((await listRides(db.pool, other, undefined, appId)).rides.map(row => row.id).sort(),
    unrelated.map((_, i) => `unrelated-${i}`).sort());
  assert.deepEqual((await rideCalendar(db.pool, { ...other, month: '2036-04' }, undefined, appId)).days,
    [{ date: '2036-04-10', offerCount: unrelated.length, requestCount: 0 }]);
});

test('calendar rejects malformed month and filter inputs without returning a successful empty month', enabled, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  assert.deepEqual(await rideCalendar(db.pool, { month: '2036-02' }, undefined, 'synthetic-empty-calendar'),
    { month: '2036-02', days: [] });
  for (const change of [
    { month: undefined }, { month: '' }, { month: '2036-2' }, { month: '2036-00' }, { month: '2036-13' },
    { month: '2036-02-01' }, { month: '2036-02 ' }, { month: { month: '2036-02' } }, { month: '9999-12' },
    { kind: 'driver' }, { kind: null }, { cityKey: {} }, { cityKey: 'a'.repeat(81) },
    { fromPlace: 12 }, { toPlace: {} }, { fromPlace: 'a'.repeat(201) }, { fromPlace: 'Fort\u0000Lee' },
    { fromPresets: 'Fort Lee' }, { toPresets: Array(101).fill('x') }, { toPresets: ['a'.repeat(201)] },
  ]) {
    await assert.rejects(rideCalendar(db.pool, { month: '2036-02', ...change }, undefined, 'synthetic-empty-calendar'),
      { name: 'ZodError' });
  }
});

test('ride search paginates the New York day, finds next nonempty day, and groups DST correctly', enabled, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const appId = 'synthetic-search', owner = (await db.pool.query("INSERT INTO users(app_id,openid) VALUES($1,'search-owner') RETURNING id", [appId])).rows[0].id;
  const make = async (id: string, at: string, kind = 'offer', address = 'Fort Lee', to = '哥大 Columbia') => {
    await db.pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone)
      VALUES($1,$2,$3,'ny_nj','open',4,$4,'America/New_York')`, [id, kind, owner, at]);
    await db.pool.query(`INSERT INTO ride_stops(ride_id,position,kind,address,departure_at)
      VALUES($1,0,'departure',$2,$3),($1,1,'destination',$4,NULL)`, [id,address,at,to]);
  };
  await make('previous', '2035-11-04T03:59:00Z');
  await make('early', '2035-11-04T04:00:00Z');
  await make('first-one', '2035-11-04T05:30:00Z');
  await make('second-one', '2035-11-04T06:30:00Z', 'request');
  await make('late', '2035-11-05T04:59:00Z');
  await make('next', '2035-11-07T05:00:00Z', 'request', 'JFK Airport', 'Queens');
  const query = { startDate: '2035-11-04', endDateExclusive: '2035-11-05', limit: 2 };
  const first = await listRides(db.pool, query, undefined, appId);
  assert.deepEqual(first.rides.map(r => r.id), ['early','first-one']); assert.equal(first.nextPage, 2); assert.equal(first.nextDate, '2035-11-07');
  const second = await listRides(db.pool, {...query,page:2}, undefined, appId);
  assert.deepEqual(second.rides.map(r => r.id), ['second-one','late']); assert.equal(second.nextPage, null);
  const empty = await listRides(db.pool, { startDate: '2035-11-05', endDateExclusive: '2035-11-06' }, undefined, appId);
  assert.deepEqual(empty.rides, []); assert.equal(empty.nextDate, '2035-11-07');
  assert.deepEqual((await rideCalendar(db.pool, {month:'2035-11'}, undefined, appId)).days,
    [{date:'2035-11-03',offerCount:1,requestCount:0},{date:'2035-11-04',offerCount:3,requestCount:1},{date:'2035-11-07',offerCount:0,requestCount:1}]);
  await make('literal', '2035-11-09T15:00:00Z', 'offer', '[.*] Queens');
  assert.deepEqual((await listRides(db.pool, {keyword:'[.*]'}, undefined, appId)).rides.map(r=>r.id), ['literal']);
  assert.deepEqual((await rideCalendar(db.pool, {month:'2035-11',fromPlace:'其他',fromPresets:JSON.stringify(['Fort Lee','JFK'])}, undefined, appId)).days,
    [{date:'2035-11-09',offerCount:1,requestCount:0}]);
  assert.deepEqual((await listRides(db.pool, {fromPlace:'肯尼迪',toPlace:'queens'}, undefined, appId)).rides.map(r=>r.id), ['next']);
  const nyuAliases = ['NYU', '下城', 'Lower Manhattan', 'New York University', '纽约大学'];
  for (let i = 0; i < nyuAliases.length; i++) await make(`nyu-${i}`, '2035-11-10T15:00:00Z', 'offer', nyuAliases[i], nyuAliases[i]);
  await make('other-downtown', '2035-11-10T15:00:00Z', 'offer', 'Downtown Brooklyn', 'Downtown Brooklyn');
  const nyuIds = nyuAliases.map((_, i) => `nyu-${i}`);
  for (const alias of nyuAliases) {
    assert.deepEqual((await listRides(db.pool, {fromPlace:alias,toPlace:alias}, undefined, appId)).rides.map(r=>r.id).sort(), nyuIds);
    assert.deepEqual((await rideCalendar(db.pool, {month:'2035-11',fromPlace:alias,toPlace:alias}, undefined, appId)).days,
      [{date:'2035-11-10',offerCount:nyuAliases.length,requestCount:0}]);
  }
  assert.deepEqual((await listRides(db.pool, {}, undefined, 'another-app')).rides, []);
  for (const query of [{startDate:'2035-02-30',endDateExclusive:'2035-03-01'}, {startDate:'2035-11-04'},
    {startDate:'2035-11-04',endDateExclusive:'2035-11-07'}, {fromPresets:'not-json'}, {fromPresets:Array(101).fill('JFK')}]) await assert.rejects(listRides(db.pool,query));
});

test('membership reports nonmembers explicitly and block-filtered calendar agrees with list', enabled, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const appId = 'wx8a8a389199aa2a0e';
  const ids: string[] = [];
  for(const name of ['owner','viewer','passenger','foreign']) ids.push((await db.pool.query('INSERT INTO users(app_id,openid) VALUES($1,$2) RETURNING id',
    [name==='foreign'?'other-app':appId,`synthetic-${name}`])).rows[0].id);
  const [owner,viewer,passenger,foreign] = ids;
  const rideId = randomUUID();
  await db.pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone)
    VALUES($1,'offer',$2,'ny_nj','open',4,'2035-11-05T15:00:00Z','America/New_York')`, [rideId,owner]);
  await db.pool.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state)
    VALUES($1,$2,'driver',0,'active'),($1,$3,'passenger',1,'active')`,[rideId,owner,passenger]);
  assert.deepEqual(await getRideMembership(db.pool,viewer!,rideId), {rideId,version:1,userId:viewer,isCreator:false,role:null,seatCount:0});
  assert.deepEqual(await getRideMembership(db.pool,owner!,rideId), {rideId,version:1,userId:owner,isCreator:true,role:'driver',seatCount:0});
  await assert.rejects(getRideMembership(db.pool,foreign!,rideId),{code:'RIDE_NOT_FOUND'});
  await db.pool.query('INSERT INTO user_blocks(blocker_id,target_id,reason) VALUES($1,$2,$3)',[passenger,viewer,'synthetic']);
  assert.equal((await listRides(db.pool,{},viewer,appId)).rides.length,0);
  assert.deepEqual((await rideCalendar(db.pool,{month:'2035-11'},viewer,appId)).days,[]);
  await db.pool.query('INSERT INTO user_blocks(blocker_id,target_id,reason) VALUES($1,$2,$3)',[owner,passenger,'synthetic']);
  assert.equal((await listRides(db.pool,{},owner,appId)).rides.length,1);
  const app = await createApp({pool:db.pool,config:{databaseUrl:'',host:'127.0.0.1',port:3100,appId,sessionTtlSeconds:3600,businessMode:'active'},
    exchange:async()=>({openid:'synthetic-viewer'})}); t.after(()=>app.close());
  const token = (await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{code:'synthetic'}})).json().data.token;
  const headers = {authorization:`Bearer ${token}`};
  assert.equal((await app.inject({url:`/api/v1/rides/${rideId}/membership`})).statusCode,401);
  const membership = await app.inject({url:`/api/v1/rides/${rideId}/membership`,headers});
  assert.equal(membership.statusCode,200);assert.equal(membership.headers['cache-control'],'private, no-store');
  assert.equal(membership.body.includes('synthetic-viewer'),false);
  const calendar = await app.inject({url:'/api/v1/rides/calendar?month=2035-11',headers});
  assert.equal(calendar.statusCode,200);assert.deepEqual(calendar.json().data.days,[]);
  assert.equal((await app.inject({url:`/api/v1/rides/${rideId}/membership?userId=${owner}`,headers})).statusCode,400);
  await db.pool.query("UPDATE rides SET status='cancelled' WHERE id=$1",[rideId]);
  await assert.rejects(getRideMembership(db.pool,owner!,rideId),{code:'RIDE_NOT_FOUND'});
});

test('timeline ride preview returns fixed area names only and refuses ended/private source details', enabled, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const appId = 'wx8a8a389199aa2a0e';
  const user = (await db.pool.query("INSERT INTO users(app_id,openid,name) VALUES($1,'private-preview-openid','Private name') RETURNING id",[appId])).rows[0].id;
  await db.pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone,listed_price_label,details)
    VALUES('preview','offer',$1,'ny_nj','open',3,'2035-11-04T05:30:00Z','America/New_York','请联系 2125550199','{"note":"private note wechat secret"}')`,[user]);
  await db.pool.query(`INSERT INTO ride_stops(ride_id,position,kind,address,departure_at)
    VALUES('preview',0,'departure','Fort Lee 123 Private Street Apt 8','2035-11-04T05:30:00Z'),
      ('preview',1,'destination','Columbia private door code 9876',NULL)`);
  const app = await createApp({pool:db.pool,config:{databaseUrl:'',host:'127.0.0.1',port:3100,appId,sessionTtlSeconds:3600,businessMode:'active'}});
  t.after(()=>app.close());
  const response = await app.inject({url:'/api/v1/previews/rides/preview'});
  assert.equal(response.statusCode,200);
  assert.equal(response.json().data.fromArea,'Fort Lee');assert.equal(response.json().data.toArea,'哥大');
  for(const secret of [user,'private-preview-openid','Private name','2125550199','9876','private note','Private Street','listedPriceLabel']) assert.ok(!response.body.includes(secret),secret);
  assert.equal(response.json().data.listedPriceCents,null);
  const list = await app.inject({url:'/api/v1/previews/rides?kind=offer&limit=1'});
  assert.equal(list.statusCode,200);assert.deepEqual(list.json().data.items,[response.json().data]);
  assert.equal((await app.inject({url:'/api/v1/previews/rides?ownerId=forged'})).statusCode,400);
  await db.pool.query("UPDATE rides SET status='closed' WHERE id='preview'");
  assert.equal((await app.inject({url:'/api/v1/previews/rides/preview'})).statusCode,404);
  assert.deepEqual((await app.inject({url:'/api/v1/previews/rides'})).json().data.items,[]);
});
