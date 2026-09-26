import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { ZodError } from 'zod';
import { AppError } from '../src/errors.ts';
import { sessionService } from '../src/auth/session.ts';
import { listAds, recordAdClick } from '../src/ads/service.ts';
import { registerAdRoutes } from '../src/ads/routes.ts';
import { createTestDatabase } from './helpers/database.ts';

const enabled = { skip: !process.env.BACKEND_TEST_DATABASE_URL, timeout: 30000 };
const appId = 'ads-fixture';
const target = { kind: 'contact', sessionFrom: 'synthetic-market-card',
  messageCard: { enabled: false, title: 'Synthetic contact card', path: '/pages/market/market' } };
async function ad(pool: Pool, id: string, patch: Record<string, unknown> = {}) {
  const row = { appId, id, placement: 'market_feed', status: 'online', priority: 0, weight: 1,
    startAt: null, endAt: null, createdAt: '2025-01-01T00:00:00.000Z', updatedAt: null, ...patch };
  await pool.query(`INSERT INTO ads(app_id,id,status,placement,title,subtitle,badge_text,cta_text,weight,priority,
    start_at,end_at,target,created_at,updated_at) VALUES($1,$2,$3,$4,'Synthetic ad','Synthetic detail','广告','查看',$5,$6,$7,$8,$9,$10,$11)`,
  [row.appId, row.id, row.status, row.placement, row.weight, row.priority, row.startAt, row.endAt, target, row.createdAt, row.updatedAt]);
}
async function account(pool: Pool, application = appId) {
  return (await pool.query<{ id: string }>('INSERT INTO users(app_id,openid) VALUES($1,$2) RETURNING id',
    [application, `synthetic-${randomUUID()}`])).rows[0]!.id;
}
async function image(pool: Pool, adId: string, slot: string, status = 'ready', application = appId) {
  const id = randomUUID();
  await pool.query(`INSERT INTO files(id,app_id,provider,locator,legacy_readonly,status)
    VALUES($1,$2,'cloudbase',$3,true,$4)`, [id, application, `cloud://synthetic/${id}`, status]);
  await pool.query(`INSERT INTO file_references(app_id,resource_kind,resource_id,slot,file_id)
    VALUES($1,'ad',$2,$3,$4)`, [application, adId, slot, id]);
  return id;
}
async function counts(pool: Pool) {
  return (await pool.query(`SELECT (SELECT count(*)::integer FROM ad_clicks) AS clicks,
    (SELECT count(*)::integer FROM idempotency_requests) AS receipts`)).rows[0];
}

test('ads read filters the complete application/placement/window before ordering and limiting', enabled, async t => {
  const db = await createTestDatabase(); t.after(db.close); const { pool } = db;
  await ad(pool, 'offline-high', { status: 'offline', priority: 999 });
  await ad(pool, 'deleted-high', { status: 'deleted', priority: 999 });
  await ad(pool, 'future-high', { startAt: '2099-01-01T00:00:00Z', priority: 999 });
  await ad(pool, 'expired-high', { endAt: '2020-01-01T00:00:00Z', priority: 999 });
  await ad(pool, 'other-placement', { placement: 'other_feed', priority: 999 });
  await ad(pool, 'other-application', { appId: 'foreign-app', priority: 999 });
  for (let index = 0; index < 24; index++) await ad(pool, `early-low-${index}`);
  await ad(pool, 'winner-late', { priority: 5, weight: 3 });
  assert.deepEqual((await listAds(pool, appId, { limit: '1' })).items.map(row => row.id), ['winner-late']);
  assert.equal((await listAds(pool, appId, {})).items.length, 20);
  assert.equal((await listAds(pool, appId, { limit: 50 })).items.length, 25);
  assert.deepEqual((await listAds(pool, appId, { placement: 'other_feed' })).items.map(row => row.id), ['other-placement']);
  assert.deepEqual((await listAds(pool, 'unknown-app', {})).items, []);
  assert.deepEqual(await counts(pool), { clicks: 0, receipts: 0 });
});

test('ads order by priority then known effective update time with deterministic ties; windows include both endpoints', enabled, async t => {
  const db = await createTestDatabase(); t.after(db.close); const { pool } = db;
  const at = '2030-01-01T00:00:00.000Z';
  await ad(pool, 'z-high-priority', { priority: 2, createdAt: null });
  await ad(pool, 'start-end-exact', { priority: 1, startAt: at, endAt: at });
  await ad(pool, 'too-early', { startAt: '2030-01-01T00:00:00.001Z', priority: 99 });
  await ad(pool, 'too-late', { endAt: '2029-12-31T23:59:59.999Z', priority: 99 });
  await ad(pool, 'updated', { updatedAt: '2027-01-01T00:00:00Z' });
  await ad(pool, 'created', { createdAt: '2026-01-01T00:00:00Z' });
  await ad(pool, 'tie-b'); await ad(pool, 'tie-a');
  await ad(pool, 'unknown-time', { createdAt: null });
  // A schema-local clock freezes the production SQL at an exact millisecond.
  // The explicit test search_path is connection-local; pg_catalog is unchanged.
  const client = await pool.connect();
  try {
    await client.query(`CREATE FUNCTION statement_timestamp() RETURNS timestamptz LANGUAGE sql STABLE
      AS $$ SELECT TIMESTAMPTZ '2030-01-01T00:00:00.000Z' $$`);
    const schema = (await client.query('SELECT current_schema() AS name')).rows[0].name;
    assert.match(schema, /^test_[a-f0-9]+$/);
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path=${schema},pg_catalog`);
    assert.deepEqual((await listAds(client, appId, { limit: 50 })).items.map(row => row.id),
      ['z-high-priority', 'start-end-exact', 'updated', 'created', 'tie-a', 'tie-b', 'unknown-time']);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('ads project only display/contact fields and ready UUID attachments from the same app/resource', enabled, async t => {
  const db = await createTestDatabase(); t.after(db.close); const { pool } = db;
  await ad(pool, 'public-card'); await ad(pool, 'thumbnail-only'); await ad(pool, 'pending-image');
  await ad(pool, 'public-card', { appId: 'foreign-app' });
  const imageId = await image(pool, 'public-card', 'image');
  const thumbId = await image(pool, 'public-card', 'thumbnail');
  const standaloneThumb = await image(pool, 'thumbnail-only', 'thumbnail');
  await image(pool, 'pending-image', 'image', 'pending');
  await image(pool, 'public-card', 'unrelated-slot');
  await image(pool, 'public-card', 'image', 'ready', 'foreign-app');
  const result = await listAds(pool, appId, {});
  const card = result.items.find(item => item.id === 'public-card');
  assert.deepEqual(card, { id: 'public-card', placement: 'market_feed', title: 'Synthetic ad', subtitle: 'Synthetic detail',
    badgeText: '广告', ctaText: '查看', weight: 1, priority: 0, imageFileId: imageId, thumbFileId: thumbId, target });
  assert.equal(result.items.find(item => item.id === 'thumbnail-only')!.thumbFileId, standaloneThumb);
  assert.equal(result.items.find(item => item.id === 'thumbnail-only')!.imageFileId, null);
  assert.equal(result.items.find(item => item.id === 'pending-image')!.imageFileId, null);
  assert.doesNotMatch(JSON.stringify(result), /cloud:\/\/|locator|appId|openid|actor|owner|createdAt|updatedAt|status/);
  await pool.query("UPDATE files SET status='deleted' WHERE id=$1", [imageId]);
  assert.equal((await listAds(pool, appId, {})).items.find(item => item.id === 'public-card')!.imageFileId, null);
});

test('one tap retries once, distinct taps and actors remain separate; missing/removed ads stay absent', enabled, async t => {
  const db = await createTestDatabase(); t.after(db.close); const { pool } = db;
  const first = await account(pool), second = await account(pool), foreign = await account(pool, 'foreign-app');
  const results = await Promise.all(Array.from({ length: 24 }, () => recordAdClick(pool, first, 'same-tap-retry', 'missing-ad', {})));
  results.forEach(result => assert.deepEqual(result, results[0]));
  assert.equal(results[0]!.status, 201); assert.deepEqual(await counts(pool), { clicks: 1, receipts: 1 });
  await assert.rejects(recordAdClick(pool, first, 'same-tap-retry', 'missing-ad', { listingType: 'sublet' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(recordAdClick(pool, first, 'same-tap-retry', 'other-ad', {}), { code: 'IDEMPOTENCY_CONFLICT' });
  await recordAdClick(pool, first, 'fresh-tap-key', 'missing-ad', { listingType: 'sublet' });
  await recordAdClick(pool, second, 'same-tap-retry', 'missing-ad', {});
  await recordAdClick(pool, foreign, 'same-tap-retry', 'missing-ad', {});
  for (const status of ['offline', 'deleted']) {
    await ad(pool, status, { status }); await recordAdClick(pool, first, `cached-tap-${status}`, status, {});
  }
  assert.deepEqual(await counts(pool), { clicks: 6, receipts: 6 });
  assert.equal((await pool.query("SELECT count(*)::integer AS n FROM ads WHERE id='missing-ad'")).rows[0].n, 0);
  const rows = (await pool.query('SELECT app_id,actor_user_id,listing_type,created_at FROM ad_clicks')).rows;
  assert.equal(rows.filter(row => row.app_id === appId).length, 5);
  assert.equal(rows.find(row => row.app_id === 'foreign-app')!.actor_user_id, foreign);
  assert.equal(rows.filter(row => row.listing_type === 'sublet').length, 1);
  rows.forEach(row => assert.ok(row.created_at instanceof Date));
  assert.deepEqual(Object.keys(results[0]!.data).sort(), ['adId', 'clickId', 'recorded']);
});

test('click insertion and permanent receipt commit together and failures are retryable', enabled, async t => {
  const db = await createTestDatabase(); t.after(db.close); const { pool } = db;
  const userId = await account(pool);
  await pool.query(`CREATE FUNCTION fail_ad_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic ad transaction failure'; END; $$`);
  for (const table of ['ad_clicks', 'idempotency_requests']) {
    await pool.query(`CREATE TRIGGER fail_ad_write BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_ad_write()`);
    await assert.rejects(recordAdClick(pool, userId, 'retry-after-rollback', 'missing-ad', {}), /synthetic ad transaction failure/);
    assert.deepEqual(await counts(pool), { clicks: 0, receipts: 0 });
    await pool.query(`DROP TRIGGER fail_ad_write ON ${table}`);
  }
  assert.equal((await recordAdClick(pool, userId, 'retry-after-rollback', 'missing-ad', {})).status, 201);
  await assert.rejects(recordAdClick(pool, randomUUID(), 'nonexistent-user-key', 'missing-ad', {}), { code: 'UNAUTHORIZED' });
  assert.deepEqual(await counts(pool), { clicks: 1, receipts: 1 });
});

test('ad HTTP display is public; clicks require a trusted configured-app session and strict bounded input', enabled, async t => {
  const db = await createTestDatabase();
  const config = { databaseUrl: process.env.BACKEND_TEST_DATABASE_URL!, host: '127.0.0.1', port: 3100, appId, sessionTtlSeconds: 3600 };
  const sessions = sessionService(db.pool, config, async code => ({ openid: `synthetic-http-${code}` }));
  const foreignSessions = sessionService(db.pool, { ...config, appId: 'foreign-app' }, async code => ({ openid: `synthetic-http-${code}` }));
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500)
    .send({ ok: false, error: { code: error instanceof AppError ? error.code : error instanceof ZodError ? 'INVALID_INPUT' : 'INTERNAL_ERROR' } }));
  registerAdRoutes(app, { pool: db.pool, appId, requireUser: sessions.requireUser });
  t.after(async () => { await app.close(); await db.close(); });
  await ad(db.pool, 'public-ad');
  const login = await sessions.login('actor'), foreignLogin = await foreignSessions.login('actor');
  const headers = { authorization: `Bearer ${login.token}`, 'idempotency-key': 'http-tap-key' };
  const display = await app.inject({ method: 'GET', url: '/api/v1/ads' });
  assert.equal(display.statusCode, 200); assert.equal(display.headers['cache-control'], 'no-store');
  assert.equal(display.json().data.items[0].id, 'public-ad');
  assert.deepEqual(await counts(db.pool), { clicks: 0, receipts: 0 });
  for (const query of ['appId=foreign-app', 'openid=pretend', 'limit=51', 'limit=1.5', 'limit=0', 'limit=-1', 'limit=Infinity',
    'placement=', `placement=${'x'.repeat(81)}`, 'placement=%00bad', 'limit=1&limit=2']) {
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/ads?${query}` })).statusCode, 400, query);
  }
  const url = '/api/v1/ads/public-ad/clicks';
  for (const authorization of [undefined, 'Bearer invalid', `Bearer ${foreignLogin.token}`]) {
    const response = await app.inject({ method: 'POST', url, payload: {}, headers: { 'idempotency-key': 'unauthorized-tap', ...(authorization ? { authorization } : {}) } });
    assert.equal(response.statusCode, 401);
  }
  const response = await app.inject({ method: 'POST', url, headers, payload: {} });
  assert.equal(response.statusCode, 201); assert.equal(response.headers['cache-control'], 'private, no-store');
  const retry = await app.inject({ method: 'POST', url, headers, payload: { listingType: 'goods', placement: 'market_feed' } });
  assert.equal(retry.statusCode, 201); assert.deepEqual(retry.json().data, response.json().data);
  for (const payload of [{ openid: 'pretend' }, { userId: foreignLogin.user.id }, { appId: 'foreign-app' },
    { contactSucceeded: true }, { listingType: 'all' }, { placement: '\n' }, { placement: 'x'.repeat(81) }, [], null]) {
    assert.equal((await app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': 'invalid-body-tap',
      'content-type': 'application/json' }, payload: JSON.stringify(payload) })).statusCode, 400);
  }
  assert.equal((await app.inject({ method: 'POST', url: `${url}?appId=foreign-app`, headers, payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url, headers: { authorization: headers.authorization }, payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/ads/bad%20id/clicks', headers, payload: {} })).statusCode, 400);
  await db.pool.query('UPDATE sessions SET expires_at=clock_timestamp()-interval \'1 second\'');
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: {} })).statusCode, 401);
  assert.deepEqual(await counts(db.pool), { clicks: 1, receipts: 1 });
  const event = (await db.pool.query('SELECT app_id,actor_user_id FROM ad_clicks')).rows[0];
  assert.deepEqual(event, { app_id: appId, actor_user_id: login.user.id });
});
