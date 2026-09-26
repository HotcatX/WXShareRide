import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { recordListingView } from '../src/market/activity.ts';
import { createTestDatabase } from './helpers/database.ts';

async function seed(pool: Pool) {
  const appId = 'view-test';
  const users = (await pool.query("INSERT INTO users(app_id,openid) VALUES($1,'one'),($1,'two'),('other-app','three') RETURNING id", [appId])).rows.map(row => row.id);
  const id = randomUUID();
  const content = { listingType: 'goods', title: 'Synthetic', description: '', priceCents: 100, category: '其他', condition: '',
    region: { state: 'NJ', county: 'Bergen', area: 'Fort Lee' }, buildingName: '', location: null,
    startDate: '2026-09-01', endDate: '2099-01-01', sellerContact: null, sublet: null };
  await pool.query("INSERT INTO market_listings(app_id,id,owner_user_id,content,expires_at) VALUES($1,$2,$3,$4,'2099-01-01')", [appId, id, users[0], content]);
  return { appId, users, id };
}
test('market views: retries count once, concurrent openings honor daily cap and actor buckets remain separate', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const { appId, users, id } = await seed(db.pool);
  const first = await Promise.all(Array.from({ length: 6 }, () => recordListingView(db.pool, users[1], 'same-view-opening', id, {})));
  first.forEach(result => assert.deepEqual(result, first[0]));
  const openings = await Promise.all(Array.from({ length: 15 }, (_, i) => recordListingView(db.pool, users[1], `fresh-opening-${i}`, id, {})));
  assert.equal(openings.filter(row => row.data.counted).length, 9);
  assert.equal(openings.filter(row => row.data.reason === 'daily_limit').length, 6);
  assert.equal((await db.pool.query('SELECT count FROM market_views WHERE actor_user_id=$1', [users[1]])).rows[0].count, '10');
  assert.equal((await db.pool.query(`SELECT day::text AS day FROM market_views WHERE actor_user_id=$1`, [users[1]])).rows[0].day,
    (await db.pool.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS day")).rows[0].day);
  assert.equal((await recordListingView(db.pool, users[0], 'owner-view-opening', id, {})).data.viewCount, 11);
  await assert.rejects(recordListingView(db.pool, users[2], 'cross-app-opening', id, {}), { code: 'LISTING_NOT_FOUND' });
  await assert.rejects(recordListingView(db.pool, users[1], 'spoof-actor-opening', id, { appId, userId: users[0] }));
});
test('market views: visibility and tombstones prevent new views; historical over-limit buckets remain intact', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const { appId, users, id } = await seed(db.pool);
  await db.pool.query(`INSERT INTO market_views(app_id,id,listing_id,actor_user_id,day,count)
    VALUES($1,'historical',$2,$3,(clock_timestamp() AT TIME ZONE 'America/New_York')::date,15)`, [appId, id, users[1]]);
  const result = await recordListingView(db.pool, users[1], 'historical-cap-view', id, {});
  assert.deepEqual(result.data, { counted: false, dailyCount: 15, dailyLimit: 10, viewCount: 15, reason: 'daily_limit' });
  await db.pool.query("UPDATE market_listings SET status='offline' WHERE id=$1", [id]);
  await assert.rejects(recordListingView(db.pool, users[1], 'offline-public-view', id, {}), { code: 'LISTING_NOT_FOUND' });
  assert.equal((await recordListingView(db.pool, users[0], 'offline-owner-view', id, {})).data.counted, true);
  await db.pool.query("UPDATE market_listings SET status='deleted' WHERE id=$1", [id]);
  await assert.rejects(recordListingView(db.pool, users[0], 'deleted-owner-view', id, {}), { code: 'LISTING_NOT_FOUND' });
  assert.deepEqual(await recordListingView(db.pool, users[1], 'historical-cap-view', id, {}), result);
});
test('market views: receipt failure rolls back count and unsafe aggregate never rounds silently', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const { appId, users, id } = await seed(db.pool);
  await db.pool.query(`CREATE FUNCTION fail_view_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.operation='market.view' THEN RAISE EXCEPTION 'synthetic view failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_view_receipt BEFORE INSERT ON idempotency_requests FOR EACH ROW EXECUTE FUNCTION fail_view_receipt()`);
  await assert.rejects(recordListingView(db.pool, users[1], 'rollback-view-count', id, {}), /synthetic view failure/);
  assert.equal((await db.pool.query('SELECT count(*) FROM market_views')).rows[0].count, '0');
  await db.pool.query('DROP TRIGGER fail_view_receipt ON idempotency_requests');
  await db.pool.query("INSERT INTO market_views(app_id,id,listing_id,day,count) VALUES($1,'historical-unknown',$2,'2020-01-01',9007199254740991)", [appId, id]);
  await assert.rejects(recordListingView(db.pool, users[1], 'overflow-view-count', id, {}), { code: 'INVALID_VIEW_COUNT' });
  assert.equal((await db.pool.query('SELECT count(*) FROM market_views')).rows[0].count, '1');
  await db.pool.query('UPDATE market_views SET count=count-1');
  const results = await Promise.allSettled(users.slice(0, 2).map((user, i) => recordListingView(db.pool, user, `concurrent-overflow-${i}`, id, {})));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'INVALID_VIEW_COUNT');
  assert.equal((await db.pool.query('SELECT sum(count)::text AS total FROM market_views')).rows[0].total, '9007199254740991');
});
