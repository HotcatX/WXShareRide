import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createApp } from '../src/app.ts';
import { getRidePreview, listRidePreviews } from '../src/rides/preview.ts';
import { createTestDatabase } from './helpers/database.ts';

const enabled = { skip: !process.env.BACKEND_TEST_DATABASE_URL };
const appId = 'wx1234567890abcdef';
async function fixture(t: { after: (work: () => Promise<void>) => void }) {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = (await db.pool.query('INSERT INTO users(app_id,openid) VALUES($1,$2) RETURNING id', [appId, 'synthetic-preview-owner'])).rows[0].id;
  return { pool: db.pool, owner };
}

test('public ride preview advances to the next pickup and disappears after the final pickup', enabled, async t => {
  const { pool, owner } = await fixture(t);
  const first = new Date(Date.now() - 60_000), next = new Date(Date.now() + 3_600_000), last = new Date(Date.now() + 7_200_000);
  await pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone)
    VALUES('multi-pickup','offer',$1,'ny_nj','open',4,$2,'America/New_York')`, [owner, first]);
  await pool.query(`INSERT INTO ride_stops(ride_id,position,kind,address,departure_at)
    VALUES('multi-pickup',0,'departure','Fort Lee',$1),('multi-pickup',1,'departure','Fort Lee',$2),
      ('multi-pickup',2,'departure','Fort Lee',$3),('multi-pickup',3,'destination','Columbia',NULL)`, [first, next, last]);
  assert.equal((await getRidePreview(pool, appId, 'multi-pickup')).departureAt.getTime(), next.getTime());
  assert.equal((await listRidePreviews(pool, appId, {})).items[0]!.departureAt.getTime(), next.getTime());
  const between = new Date(next.getTime() + 1_800_000);
  await pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone)
    VALUES('later-next-stop','offer',$1,'ny_nj','open',4,$2,'America/New_York')`, [owner, between]);
  await pool.query(`INSERT INTO ride_stops(ride_id,position,kind,address,departure_at)
    VALUES('later-next-stop',0,'departure','Fort Lee',$1),('later-next-stop',1,'destination','Columbia',NULL)`, [between]);
  assert.deepEqual((await listRidePreviews(pool, appId, {})).items.map(item => item.id), ['multi-pickup', 'later-next-stop']);
  await pool.query("UPDATE ride_stops SET departure_at=$1 WHERE ride_id='multi-pickup' AND kind='departure' AND position<2", [first]);
  assert.equal((await getRidePreview(pool, appId, 'multi-pickup')).departureAt.getTime(), last.getTime());
  await pool.query("UPDATE ride_stops SET departure_at=$1 WHERE ride_id='multi-pickup' AND kind='departure'", [first]);
  await assert.rejects(getRidePreview(pool, appId, 'multi-pickup'), { code: 'RIDE_NOT_FOUND' });
  assert.deepEqual((await listRidePreviews(pool, appId, {})).items.map(item => item.id), ['later-next-stop']);
});

test('public preview HTTP stays app-scoped, redacted and read-only after legacy website routes retire', enabled, async t => {
  const { pool, owner } = await fixture(t);
  const departure = new Date(Date.now() + 3_600_000);
  const foreign = (await pool.query('INSERT INTO users(app_id,openid) VALUES($1,$2) RETURNING id', ['wxabcdef1234567890', 'synthetic-foreign-owner'])).rows[0].id;
  for (const [id, creator] of [['public-ride', owner], ['foreign-ride', foreign]]) {
    await pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone,listed_price_cents,details)
      VALUES($1,'offer',$2,'ny_nj','open',4,$3,'America/New_York',1200,'{"note":"private-note"}')`, [id, creator, departure]);
    await pool.query(`INSERT INTO ride_stops(ride_id,position,kind,address,departure_at)
      VALUES($1,0,'departure','Fort Lee 123 Private Street',$2),($1,1,'destination','哥大 Columbia door 9876',NULL)`, [id, departure]);
  }
  const readOnly = new Pool({ ...pool.options, options: `${pool.options.options} -c default_transaction_read_only=on` });
  t.after(() => readOnly.end());
  const app = await createApp({ pool: readOnly, config: { appId, databaseUrl: '', host: '127.0.0.1', port: 3100,
    sessionTtlSeconds: 3600, businessMode: 'active' } });
  t.after(() => app.close());
  const list = await app.inject({ url: '/api/v1/previews/rides' });
  assert.equal(list.statusCode, 200); assert.deepEqual(list.json().data.items.map((item: { id: string }) => item.id), ['public-ride']);
  const detail = await app.inject({ url: '/api/v1/previews/rides/public-ride' });
  assert.equal(detail.statusCode, 200); assert.equal(detail.json().data.listedPriceCents, 1200);
  for (const secret of [owner, foreign, '123 Private Street', '9876', 'private-note', 'synthetic-preview-owner']) {
    assert.equal(list.body.includes(secret), false); assert.equal(detail.body.includes(secret), false);
  }
  assert.equal((await app.inject({ url: '/api/v1/previews/rides/foreign-ride' })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/v1/previews/rides?limit=21' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/compat/public-web', payload: { operation: 'tripList' } })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/v1/compat/house-share?operation=marketList' })).statusCode, 404);
  assert.equal((await pool.query('SELECT count(*) FROM sessions')).rows[0].count, '0');
  assert.equal((await pool.query('SELECT count(*) FROM business_events')).rows[0].count, '0');
});
