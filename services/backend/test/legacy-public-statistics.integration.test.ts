import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage, RequestOptions } from 'node:http';
import test from 'node:test';
import { createApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { createTestDatabase } from './helpers/database.ts';
import { miniProgram } from './helpers/mini-program.ts';

const require = createRequire(import.meta.url);
const appId = 'wx8a8a389199aa2a0e';
const config = { databaseUrl: '', host: '127.0.0.1', port: 3100, appId, sessionTtlSeconds: 3600 };

test('the shipped 5.1 public-statistics wire contract retains exact fields, hash and lifetime over live PG facts', async t => {
  const db = await createTestDatabase();
  const app = await createApp({ pool: db.pool, config: { ...config, businessMode: 'active' } });
  t.after(async () => { await app.close(); await db.close(); });
  await db.pool.query('INSERT INTO public_statistics(app_id,served_count,coverage_text) VALUES($1,123,$2),($3,999,$4)',
    [appId, '纽约 / 新泽西', 'another-app', 'private-other-app']);
  // Assert the released wire contract independently of the current mini source:
  // current builds use the canonical DTO, but 5.1 still validates this snapshot.
  async function readLegacy() {
    const before = Date.now();
    const response = await app.inject('/api/v1/statistics/legacy');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    const value = response.json();
    assert.deepEqual(Object.keys(value).sort(), ['data','expiresAt','ok','revision','schemaVersion','snapshotAt','source']);
    assert.equal(value.ok, true); assert.equal(value.schemaVersion, 1); assert.equal(value.source, 'cloudbase-snapshot');
    assert.deepEqual(Object.keys(value.data).sort(), ['_id','coverageText','servedTrips']);
    assert.equal(value.data._id, 'home');
    assert.ok(Number.isSafeInteger(value.data.servedTrips) && value.data.servedTrips >= 0);
    assert.ok(typeof value.data.coverageText === 'string' && value.data.coverageText.length <= 120);
    assert.ok(Number.isSafeInteger(value.snapshotAt) && value.snapshotAt >= before && value.snapshotAt <= Date.now());
    assert.equal(value.expiresAt, value.snapshotAt + 60_000);
    assert.equal(value.revision, createHash('sha256').update(JSON.stringify(value.data)).digest('hex'));
    return value;
  }
  const first = await readLegacy();
  assert.deepEqual(first.data, { _id: 'home', servedTrips: 123, coverageText: '纽约 / 新泽西' });
  // A new database fact is reflected by the next read, not a re-stamped cached
  // CloudBase generation or a second timer-maintained aggregate.
  await db.pool.query('UPDATE public_statistics SET served_count=124,coverage_text=NULL WHERE app_id=$1', [appId]);
  const second = await readLegacy();
  assert.equal(second.data.servedTrips, 124);
  assert.equal(second.data.coverageText, 'N/A');
  assert.notEqual(first.revision, second.revision);
  await db.pool.query('UPDATE public_statistics SET coverage_text=$2 WHERE app_id=$1', [appId, '']);
  assert.equal((await readLegacy()).data.coverageText, 'N/A');
  for (const suffix of ['?appId=another-app', '?openid=synthetic-user']) {
    assert.equal((await app.inject(`/api/v1/statistics/legacy${suffix}`)).statusCode, 400);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/statistics/legacy' })).statusCode, 404);
  for (const table of ['users', 'sessions', 'idempotency_requests', 'business_events']) {
    assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
  }
});

test('legacy statistics stay unavailable before activation or without a migrated baseline', async t => {
  const db = await createTestDatabase();
  const staged = await createApp({ pool: db.pool, config });
  const active = await createApp({ pool: db.pool, config: { ...config, businessMode: 'active' } });
  t.after(async () => { await staged.close(); await active.close(); await db.close(); });
  const disabled = await staged.inject('/api/v1/statistics/legacy');
  assert.equal(disabled.statusCode, 503); assert.equal(disabled.json().error.code, 'BACKEND_STAGED');
  const missing = await active.inject('/api/v1/statistics/legacy');
  assert.equal(missing.statusCode, 503); assert.equal(missing.json().error.code, 'STATISTICS_NOT_INITIALIZED');
});

test('the shipped 5.1 statistics.publicStats action reaches the same PG authority and never revives a CloudBase read on failure', async t => {
  const db = await createTestDatabase();
  const serverConfig: Config = { ...config, businessMode: 'active' };
  const app = await createApp({ pool: db.pool, config: serverConfig });
  t.after(async () => { try { await app.close(); } finally { await db.close(); } });
  const loopback = await app.listen({ host: '127.0.0.1', port: 0 });
  assert.equal(new URL(loopback).hostname, '127.0.0.1');
  await db.pool.query('INSERT INTO public_statistics(app_id,served_count,coverage_text) VALUES($1,321,$2),($3,999,$4)',
    [appId, '纽约 / 新泽西', 'another-app', 'private-other-app']);

  const { readServerStats, ENDPOINT } = require('../../../cloudfunctions/statistics/provider.js');
  const { createStatisticsHandler } = require('../../../cloudfunctions/statistics/handler.js');
  const serverStatuses: number[] = [];
  const handler = createStatisticsHandler({ authority: 'server',
    // Only the native HTTPS transport is replaced: the provider still checks
    // real response bytes/headers from the composed app and its actual PG query.
    readPublicStats: () => readServerStats((url: string, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
        assert.equal(url, ENDPOINT);
        assert.equal(url, 'https://collect.linkx.ink/api/v1/statistics/public');
        assert.equal(options.method, 'GET');
        return httpRequest(loopback + new URL(url).pathname, options, response => {
          serverStatuses.push(response.statusCode!); callback(response);
        });
      }),
    account() { throw Error('public reads must not use account state'); },
  });

  async function readThroughCompatibility() {
    // This is the immutable native invocation issued by 5.1. The real handler
    // and provider run through loopback HTTP to PG, without current-client code.
    const request = { name: 'statistics', data: { action: 'publicStats' } };
    assert.equal(request.name, 'statistics');
    return handler(request.data, {});
  }

  assert.deepEqual(await readThroughCompatibility(), {
    success: true, data: { _id: 'home', servedTrips: 321, coverageText: '纽约 / 新泽西' },
  });
  await db.pool.query('UPDATE public_statistics SET served_count=322,coverage_text=$2 WHERE app_id=$1', [appId, '']);
  assert.deepEqual(await readThroughCompatibility(), {
    success: true, data: { _id: 'home', servedTrips: 322, coverageText: 'N/A' },
  });
  const unavailable = { success: false, data: { _id: 'home', servedTrips: null, coverageText: 'N/A' },
    errorMsg: 'PUBLIC_STATS_UNAVAILABLE' };
  serverConfig.businessMode = 'staged';
  assert.deepEqual(await readThroughCompatibility(), unavailable, 'an actual HTTP 503 cannot resurrect old statistics');
  serverConfig.businessMode = 'active';
  // Break only this generated test schema. The real query now fails in PG; no
  // mocked service/repository response can make this failure look successful.
  await db.pool.query('ALTER TABLE public_statistics RENAME TO unavailable_public_statistics');
  try { assert.deepEqual(await readThroughCompatibility(), unavailable, 'a real PG failure must stay unavailable'); }
  finally { await db.pool.query('ALTER TABLE unavailable_public_statistics RENAME TO public_statistics'); }
  assert.equal((await readThroughCompatibility()).data.servedTrips, 322);
  assert.deepEqual(serverStatuses, [200, 200, 503, 500, 200]);
  for (const table of ['users', 'sessions', 'idempotency_requests', 'business_events']) {
    assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
  }
});


test('the current home page reads canonical public statistics over real HTTP/PG with no login or cloud statistics call', async t => {
  const db = await createTestDatabase();
  const serverConfig: Config = { ...config, businessMode: 'active' };
  const app = await createApp({ pool: db.pool, config: serverConfig });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const device = miniProgram({ url, appId, bridgeKey: Buffer.alloc(32, 1) });
  t.after(async () => { device.close(); try { await app.close(); } finally { await db.close(); } });
  await db.pool.query('INSERT INTO public_statistics(app_id,served_count,coverage_text) VALUES($1,123,$2),($3,999,$4)',
    [appId, '纽约 / 新泽西', 'another-app', 'private-other-app']);
  const page = device.page('pages/home/home.js');
  page.syncLoginState();
  await page.loadPublicStats();
  assert.equal(page.data.publicStats.servedTrips, 123);
  assert.equal(device.requests.length, 1);
  assert.equal(device.requests[0]!.path, '/api/v1/statistics/public');
  assert.equal(device.requests[0]!.method, 'GET');
  assert.equal(device.requests[0]!.body, undefined);
  const cached = device.storage.get('homePublicStatsCacheV1');
  assert.deepEqual(cached.data, { servedTrips: 123, coverageText: '纽约 / 新泽西' });
  await db.pool.query('UPDATE public_statistics SET served_count=124,coverage_text=NULL WHERE app_id=$1', [appId]);
  // Persisted 5.1 cache shape is unchanged; ordinary returns do not re-stamp it.
  await page.loadPublicStats();
  assert.equal(device.requests.length, 1);
  assert.deepEqual(device.storage.get('homePublicStatsCacheV1'), cached);
  await page.loadPublicStats({ force: true });
  assert.equal(page.data.publicStats.servedTrips, 124);
  assert.equal(page.data.publicStats.coverageText, 'N/A');
  const current = device.storage.get('homePublicStatsCacheV1');
  serverConfig.businessMode = 'staged';
  await page.loadPublicStats({ force: true });
  assert.equal(device.requests.at(-1)!.status, 503);
  assert.deepEqual(device.storage.get('homePublicStatsCacheV1'), current);
  assert.equal(page.data.publicStats.servedTrips, 124);
  serverConfig.businessMode = 'active';
  await db.pool.query('UPDATE public_statistics SET served_count=125 WHERE app_id=$1', [appId]);
  await page.loadPublicStats({ force: true });
  assert.equal(page.data.publicStats.servedTrips, 125);
  assert.equal(device.authorityCalls(), 1); assert.equal(device.bridgeCalls(), 0);
  assert.ok(device.requests.every(row => row.path === '/api/v1/statistics/public'));
  for (const table of ['users', 'sessions', 'idempotency_requests', 'business_events']) {
    assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
  }
});
