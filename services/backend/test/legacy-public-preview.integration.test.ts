import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { registerLegacyPublicRoutes, publicWebPath, houseSharePath } from '../src/compat/public-preview.ts';
import { createTestDatabase } from './helpers/database.ts';
import { createApp } from '../src/app.ts';
import { getRidePreview, listRidePreviews } from '../src/rides/preview.ts';

const enabled = {skip:!process.env.BACKEND_TEST_DATABASE_URL};
const appId = 'synthetic-public-compat', secret = 'synthetic_public_preview_secret_0001';
const headers = {authorization:`Bearer ${secret}`,'content-type':'application/json'};
async function fixture(t: {after:(fn:()=>Promise<unknown>)=>void}, storage?: {readUrl:()=>Promise<string>}) {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = (await db.pool.query("INSERT INTO users(app_id,openid,name) VALUES($1,'hidden-openid','Hidden seller') RETURNING id",[appId])).rows[0].id;
  const app = Fastify();
  registerLegacyPublicRoutes(app,{pool:db.pool,appId,publicWebSecret:secret,storage});
  t.after(()=>app.close());
  const post = (payload:object) => app.inject({method:'POST',url:publicWebPath,headers,payload});
  return {...db,owner,app,post};
}
const content = (type = 'sublet', state = 'NJ') => ({listingType:type,title:'Current canonical listing',description:'Nice desk. wechat hidden-contact',
  priceCents:125050,category:'家具',condition:'全新',region:{state,county:'Private county',area:'Private address'},
  buildingName:'Private Building',location:null,startDate:'2035-01-01',endDate:'2035-12-31',sellerContact:null,sublet:null});
async function listing(pool:Pool,owner:string,id:string, options:{kind?:string;state?:string;status?:string;expires?:string;created?:string} = {}) {
  await pool.query(`INSERT INTO market_listings(app_id,id,owner_user_id,status,expires_at,created_at,content)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[appId,id,owner,options.status ?? 'online',options.expires ?? '2035-12-31',
    options.created ?? '2035-01-01',JSON.stringify(content(options.kind,options.state))]);
}
async function archive(pool:Pool,ids:string[], application = appId) {
  const batch = (await pool.query('INSERT INTO migration_batches(app_id,source_sha256) VALUES($1,$2) RETURNING id',
    [application,createHash('sha256').update(randomUUID()).digest('hex')])).rows[0].id;
  for (const id of ids) {
    const document = JSON.stringify({_id:id,title:'Stale archived title',price:999,desc:'private archived payload'});
    await pool.query('INSERT INTO migration_sources VALUES($1,$2,$3,$4,$5)',[batch,'houseShare',id,document,createHash('sha256').update(document).digest('hex')]);
  }
}

test('public web authenticates, strictly validates the legacy wire, and refuses oversized/non-JSON bodies', enabled, async t => {
  const {app,post} = await fixture(t);
  const payload = {operation:'marketList',kind:'all',locale:'en'};
  assert.equal((await post(payload)).statusCode,200);
  for (const invalid of [{}, {operation:'deleteListing'}, {...payload,openid:'forged'}, {...payload,limit:'20'},
    {...payload,offset:81}, {...payload,locale:'zh'}, {...payload,cityKey:'forged'},
    {operation:'marketDetail',kind:'all',id:'x'}, {operation:'tripDetail',kind:'all',id:'x'}]) {
    const response = await post(invalid); assert.equal(response.statusCode,400); assert.equal(response.json().error,'invalid_request');
  }
  assert.equal((await app.inject({method:'POST',url:publicWebPath,payload})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:publicWebPath,headers:{...headers,authorization:'Bearer '+ 'x'.repeat(32)},payload})).statusCode,401);
  assert.equal((await app.inject({url:publicWebPath})).statusCode,405);
  assert.equal((await app.inject({method:'POST',url:publicWebPath,headers:{...headers,'content-type':'text/plain'},payload:'{}'})).statusCode,415);
  assert.equal((await app.inject({method:'POST',url:publicWebPath,headers,payload:'{'})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:publicWebPath,headers,payload:' '.repeat(2049)})).statusCode,413);
  assert.equal((await app.inject({method:'POST',url:publicWebPath+'?id=forged',headers,payload})).statusCode,400);
});

test('public markets preserve DTO/pagination/city/kind filtering and only current guest data and authorized images', enabled, async t => {
  let signed = 0;
  const {pool,owner,post} = await fixture(t,{readUrl:async()=>{signed++;return 'https://synthetic.myqcloud.com/image.jpg?sign=synthetic';}});
  await listing(pool,owner,'a',{created:'2035-01-03'});
  await listing(pool,owner,'b',{kind:'goods',state:'NY',created:'2035-01-02'});
  await listing(pool,owner,'c',{state:'CA'});
  await listing(pool,owner,'expired',{expires:'2020-01-01',created:'2035-01-09'});
  await listing(pool,owner,'offline',{status:'offline',created:'2035-01-09'});
  await archive(pool,['a']);
  const file = randomUUID();
  await pool.query(`INSERT INTO files(id,app_id,provider,locator,legacy_readonly,status) VALUES($1,$2,'cloudbase','cloud://private-locator/market/private.jpg',true,'ready')`,[file,appId]);
  await pool.query("INSERT INTO file_references VALUES($1,'listing','a','image.0',$2)",[appId,file]);
  const first = await post({operation:'marketList',kind:'all',cityKey:'ny',limit:1});
  assert.equal(first.statusCode,200); assert.equal(first.headers['cache-control'],'no-store');
  const page = first.json(); assert.equal(page.hasMore,true);assert.equal(page.nextOffset,1);assert.equal(page.items[0].id,'a');
  assert.deepEqual(Object.keys(page.items[0]).sort(),['id','kind','title','description','priceText','regionText','timeText','availabilityText','images','tags'].sort());
  assert.equal(page.items[0].priceText,'$1250.5/month');assert.equal(page.items[0].regionText,'NJ');
  assert.deepEqual(page.items[0].tags,['Furniture','New']);assert.equal(page.items[0].images.length,1);assert.equal(signed,1);
  for (const value of ['hidden-openid','hidden-contact','Private county','Private address','private-locator','Stale archived title','private archived payload']) assert.equal(first.body.includes(value),false,value);
  const second = (await post({operation:'marketList',kind:'all',cityKey:'ny_nj',limit:1,offset:1})).json();
  assert.deepEqual(second.items.map((item:{id:string})=>item.id),['b']);assert.equal(second.hasMore,false);
  assert.equal((await post({operation:'marketDetail',kind:'goods',id:'a'})).statusCode,404);
  assert.equal((await post({operation:'marketDetail',kind:'sublet',id:'expired'})).statusCode,404);
  assert.deepEqual((await post({operation:'marketList',kind:'sublet',cityKey:'la'})).json().items.map((item:{id:string})=>item.id),['c']);
  assert.equal((await pool.query('SELECT count(*) FROM market_views')).rows[0].count,'0');
  assert.equal((await pool.query('SELECT count(*) FROM business_events')).rows[0].count,'0');
  await pool.query("UPDATE market_listings SET status='offline' WHERE id='a'");
  assert.equal((await post({operation:'marketDetail',kind:'sublet',id:'a'})).statusCode,404);assert.equal(signed,1);
});

test('public ride ranges, seat semantics, fixed areas, app isolation and expired status follow canonical PG', enabled, async t => {
  const {pool,owner,post} = await fixture(t);
  for (const [id,kind,city,label] of [['offer','offer','ny_nj','11-13'],['request','request','nj','联系 2125550199'],['far','offer','boston','0']]) {
    await pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone,listed_price_label,details)
      VALUES($1,$2,$3,$4,'open',4,'2035-11-04T05:30:00Z','America/New_York',$5,'{"note":"hidden note"}')`,[id,kind,owner,city,label]);
    await pool.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state) VALUES($1,$2,'passenger',4,'active')`,[id,owner]);
    await pool.query(`INSERT INTO ride_stops(ride_id,position,kind,address,departure_at)
      VALUES($1,0,'departure','Fort Lee 123 Private Street','2035-11-04T05:30:00Z'),($1,1,'destination','哥大 Columbia door 9876',NULL)`,[id]);
  }
  const result = await post({operation:'tripList',kind:'all',cityKey:'ny'});
  assert.equal(result.statusCode,200);const items = result.json().items;
  assert.equal(items.length,2);assert.equal(items[0].kind,'carpool');assert.equal(items[0].priceText,'$11–$13/person');
  assert.equal(items[0].full,true);assert.equal(items[0].seats,0);assert.equal(items[1].full,false);assert.equal(items[1].seats,4);
  assert.equal(items[1].priceText,'Price to be confirmed');assert.equal(items[0].timeText,'2035-11-04 01:30');
  assert.equal(items[0].fromLabel,'Fort Lee');assert.equal(items[0].toLabel,'Columbia University');
  for (const value of ['123 Private Street','9876','2125550199','hidden note','hidden-openid',owner]) assert.equal(result.body.includes(value),false,value);
  assert.equal((await post({operation:'tripDetail',kind:'request',id:'offer'})).statusCode,404);
  await pool.query("UPDATE rides SET status='cancelled' WHERE id='offer'");
  assert.equal((await post({operation:'tripDetail',kind:'carpool',id:'offer'})).statusCode,404);
  const foreignApp = Fastify();registerLegacyPublicRoutes(foreignApp,{pool,appId:'other-app',publicWebSecret:secret});t.after(()=>foreignApp.close());
  assert.deepEqual((await foreignApp.inject({method:'POST',url:publicWebPath,headers,payload:{operation:'tripList'}})).json().items,[]);
});

test('houseShare uses imported membership only, current PG content, and stable cursor across expired rows', enabled, async t => {
  const {pool,owner,app} = await fixture(t);
  await listing(pool,owner,'a-expired',{expires:'2020-01-01'});
  await listing(pool,owner,'b-current');await listing(pool,owner,'c-not-in-house');await listing(pool,owner,'d-foreign-archive');
  await archive(pool,['a-expired','b-current']);await archive(pool,['d-foreign-archive'],'other-app');
  const first = await app.inject({url:houseSharePath+'?operation=marketList&limit=1'});
  assert.deepEqual(first.json(),{ok:true,items:[],hasMore:true,nextCursor:'a-expired'});
  const second = await app.inject({url:houseSharePath+'?operation=marketList&limit=1&cursor=a-expired'});
  const result = second.json();assert.equal(result.hasMore,false);assert.equal(result.nextCursor,null);assert.equal(result.items[0].id,'b-current');
  assert.equal(result.items[0].title,'Current canonical listing');assert.equal(result.items[0].availabilityText,'在租 / Available');
  assert.equal(result.items[0].timeText,'2035-01-01 — 2035-12-31');assert.equal(result.items[0].priceText,'1,250.5');
  assert.equal(second.body.includes('archived'),false);
  for (const id of ['a-expired','c-not-in-house','d-foreign-archive']) assert.equal((await app.inject({url:houseSharePath+`?operation=marketDetail&id=${id}`})).statusCode,404);
  await pool.query("UPDATE market_listings SET content=jsonb_set(content,'{title}','\"Updated canonical title\"') WHERE id='b-current'");
  assert.equal((await app.inject({url:houseSharePath+'?operation=marketDetail&id=b-current'})).json().item.title,'Updated canonical title');
  await pool.query("UPDATE market_listings SET status='deleted' WHERE id='b-current'");
  assert.equal((await app.inject({url:houseSharePath+'?operation=marketDetail&id=b-current'})).statusCode,404);
});

test('a multi-pickup public ride shows its next future stop until the final pickup passes', enabled, async t => {
  const {pool,owner,post} = await fixture(t);
  const first = new Date(Date.now()-60_000), next = new Date(Date.now()+3600_000), last = new Date(Date.now()+7200_000);
  await pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone)
    VALUES('multi-pickup','offer',$1,'ny_nj','open',4,$2,'America/New_York')`,[owner,first]);
  await pool.query(`INSERT INTO ride_stops(ride_id,position,kind,address,departure_at)
    VALUES('multi-pickup',0,'departure','Fort Lee',$1),('multi-pickup',1,'departure','Fort Lee',$2),
      ('multi-pickup',2,'departure','Fort Lee',$3),('multi-pickup',3,'destination','Columbia',NULL)`,[first,next,last]);
  assert.equal((await getRidePreview(pool,appId,'multi-pickup')).departureAt.getTime(),next.getTime());
  assert.equal((await listRidePreviews(pool,appId,{})).items[0]!.departureAt.getTime(),next.getTime());
  const list = await post({operation:'tripList',cityKey:'ny_nj'});
  assert.equal(list.statusCode,200);assert.equal(list.json().items[0].departureAtMs,next.getTime());
  assert.equal((await post({operation:'tripDetail',kind:'carpool',id:'multi-pickup'})).json().item.departureAtMs,next.getTime());
  const between = new Date(next.getTime()+1800_000);
  await pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone)
    VALUES('earlier-last-stop','offer',$1,'ny_nj','open',4,$2,'America/New_York')`,[owner,between]);
  await pool.query(`INSERT INTO ride_stops(ride_id,position,kind,address,departure_at)
    VALUES('earlier-last-stop',0,'departure','Fort Lee',$1),('earlier-last-stop',1,'destination','Columbia',NULL)`,[between]);
  // The old website sorts by the final departure while displaying the next one.
  assert.deepEqual((await post({operation:'tripList'})).json().items.map((item:{id:string})=>item.id),['earlier-last-stop','multi-pickup']);
  await pool.query("UPDATE ride_stops SET departure_at=$1 WHERE ride_id='multi-pickup' AND kind='departure'",[first]);
  assert.equal((await post({operation:'tripDetail',kind:'carpool',id:'multi-pickup'})).statusCode,404);
  assert.deepEqual((await post({operation:'tripList'})).json().items.map((item:{id:string})=>item.id),['earlier-last-stop']);
});

test('houseShare exact origins, methods, unknown/duplicate query rejection do not grant business writes', enabled, async t => {
  const {app,pool} = await fixture(t);
  const origin = 'https://linkxweb.xshawh.workers.dev';
  const options = await app.inject({method:'OPTIONS',url:houseSharePath,headers:{origin}});
  assert.equal(options.statusCode,204);assert.equal(options.headers['access-control-allow-origin'],origin);assert.equal(options.body,'');
  assert.equal((await app.inject({url:houseSharePath+'?operation=marketList',headers:{origin:'https://attacker.invalid'}})).statusCode,403);
  for (const query of ['operation=marketList&limit=21','operation=marketList&limit=1&limit=2','operation=marketList&kind=goods',
    'operation=marketDetail&id=x&cursor=a','operation=marketList&id=x','operation=deleteListing','operation=marketList&openid=x']) {
    assert.equal((await app.inject({url:houseSharePath+'?'+query})).statusCode,400,query);
  }
  assert.equal((await app.inject({method:'POST',url:houseSharePath,payload:{operation:'deleteListing'}})).statusCode,405);
  for (const table of ['sessions','idempotency_requests','business_events','market_views']) assert.equal((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count,'0',table);
});

test('real application staged gate protects both compatibility routes before any canonical read', enabled, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const app = await createApp({pool:db.pool,config:{databaseUrl:'',host:'127.0.0.1',port:3100,appId,sessionTtlSeconds:3600,
    businessMode:'staged',legacyPublic:{secret,houseShareOrigins:[],houseShareCurrency:''}}});t.after(()=>app.close());
  for (const response of [await app.inject({method:'POST',url:publicWebPath,headers,payload:{operation:'marketList'}}),
    await app.inject({url:houseSharePath+'?operation=marketList'}),await app.inject({method:'OPTIONS',url:houseSharePath})]) {
    assert.equal(response.statusCode,503);assert.equal(response.json().ok,false);assert.equal(response.body.includes('items'),false);
  }
  assert.equal((await db.pool.query('SELECT count(*) FROM sessions')).rows[0].count,'0');
});

test('active application works through a PostgreSQL read-only connection with the existing credential', enabled, async t => {
  const {pool,owner} = await fixture(t);
  await listing(pool,owner,'read-only-house');await archive(pool,['read-only-house']);
  const readOnly = new Pool({...pool.options,options:`${pool.options.options} -c default_transaction_read_only=on`});
  t.after(()=>readOnly.end());
  const app = await createApp({pool:readOnly,config:{databaseUrl:'',host:'127.0.0.1',port:3100,appId,sessionTtlSeconds:3600,
    businessMode:'active',legacyPublic:{secret,houseShareOrigins:['https://approved.invalid'],houseShareCurrency:'USD'}}});t.after(()=>app.close());
  const publicResponse = await app.inject({method:'POST',url:publicWebPath,headers,payload:{operation:'marketDetail',kind:'sublet',id:'read-only-house'}});
  assert.equal(publicResponse.statusCode,200);assert.equal(publicResponse.json().item.id,'read-only-house');
  const houseResponse = await app.inject({url:houseSharePath+'?operation=marketDetail&id=read-only-house',headers:{origin:'https://approved.invalid'}});
  assert.equal(houseResponse.statusCode,200);assert.equal(houseResponse.json().item.priceText,'USD 1,250.5');
  assert.equal(houseResponse.headers['access-control-allow-origin'],'https://approved.invalid');
  assert.equal((await app.inject({url:houseSharePath+'?operation=marketList',headers:{origin:'https://linkxweb.xshawh.workers.dev'}})).statusCode,403);
  await assert.rejects(readOnly.query("UPDATE market_listings SET status='offline'"),{code:'25006'});
});

test('missing/revoked public credential fails closed; unavailable or unsafe image URL keeps a text preview', enabled, async t => {
  let url = 'https://myqcloud.com.attacker.invalid/private.jpg';
  const {pool,owner,post} = await fixture(t,{readUrl:async()=>{if (!url) throw new Error('synthetic storage unavailable');return url;}});
  await listing(pool,owner,'image-house');const file = randomUUID();
  await pool.query(`INSERT INTO files(id,app_id,provider,locator,legacy_readonly,status) VALUES($1,$2,'cloudbase','cloud://synthetic/market/image.jpg',true,'ready')`,[file,appId]);
  await pool.query("INSERT INTO file_references VALUES($1,'listing','image-house','image.0',$2)",[appId,file]);
  const body = {operation:'marketDetail',kind:'sublet',id:'image-house'};
  assert.deepEqual((await post(body)).json().item.images,[]);
  url = '';const unavailable = await post(body);assert.equal(unavailable.statusCode,200);assert.deepEqual(unavailable.json().item.images,[]);
  for (const publicWebSecret of [undefined,'revoked-invalid']) {
    const app = Fastify();registerLegacyPublicRoutes(app,{pool,appId,publicWebSecret});t.after(()=>app.close());
    const response = await app.inject({method:'POST',url:publicWebPath,headers,payload:body});
    assert.equal(response.statusCode,503);assert.deepEqual(response.json(),{ok:false,error:'service_unavailable'});
  }
});
