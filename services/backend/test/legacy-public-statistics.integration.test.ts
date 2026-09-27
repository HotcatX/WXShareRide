import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage, RequestOptions } from 'node:http';
import vm from 'node:vm';
import test from 'node:test';
import { createApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { createTestDatabase } from './helpers/database.ts';

const require = createRequire(import.meta.url);
const appId = 'wx8a8a389199aa2a0e';
const config = { databaseUrl: '', host: '127.0.0.1', port: 3100, appId, sessionTtlSeconds: 3600 };

test('the existing public-statistics client accepts live PG facts through the old wire contract without cloud fallback', async t => {
  const db = await createTestDatabase();
  const app = await createApp({ pool: db.pool, config: { ...config, businessMode: 'active' } });
  t.after(async () => { await app.close(); await db.close(); });
  await db.pool.query('INSERT INTO public_statistics(app_id,served_count,coverage_text) VALUES($1,123,$2),($3,999,$4)',
    [appId, '纽约 / 新泽西', 'another-app', 'private-other-app']);
  let cloudCalls = 0, httpCalls = 0;
  const wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } }),
    getStorageSync: () => '', removeStorageSync() {},
    request(options: any) {
      assert.equal(options.url, 'https://collect.linkx.ink/v1/public-stats');
      assert.equal(options.method, 'GET'); httpCalls++;
      // Only the deployment proxy rewrites the old exact public path. The
      // actual legacy client and its schema/hash validation run unchanged.
      void app.inject('/api/v1/statistics/legacy').then(response => {
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.equal(response.headers['x-content-type-options'], 'nosniff');
        options.success({ statusCode: response.statusCode, data: response.json() });
      }).catch(error => options.fail(error));
      return { abort() {} };
    },
    cloud: { callFunction() { cloudCalls++; throw Error('unexpected legacy CloudBase read'); } },
  };
  const module: { exports: any } = { exports: {} };
  vm.runInNewContext(readFileSync(new URL('../../../utils/publicStatsClient.js', import.meta.url), 'utf8'), {
    module, wx, Date, setTimeout, clearTimeout,
    require(name: string) {
      if (name === '../config/publicStats') return require('../../../config/publicStats.js');
      return require(`../../../utils/${name}`);
    },
  });
  const client = module.exports;
  const first = await client.loadPublicStats();
  assert.deepEqual(JSON.parse(JSON.stringify(first.response.result.data)), { _id: 'home', servedTrips: 123, coverageText: '纽约 / 新泽西' });
  // A new database fact is reflected by the next read, not a re-stamped cached
  // CloudBase generation or a second timer-maintained aggregate.
  await db.pool.query('UPDATE public_statistics SET served_count=124,coverage_text=NULL WHERE app_id=$1', [appId]);
  const second = await client.loadPublicStats();
  assert.equal(second.response.result.data.servedTrips, 124);
  assert.equal(second.response.result.data.coverageText, 'N/A');
  assert.notEqual(first.diagnostic.revision, second.diagnostic.revision);
  assert.equal(httpCalls, 2); assert.equal(cloudCalls, 0);
  await db.pool.query('UPDATE public_statistics SET coverage_text=$2 WHERE app_id=$1', [appId, '']);
  assert.equal((await client.loadPublicStats()).response.result.data.coverageText, 'N/A');
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

test('the existing client cloud fallback reaches the same PG authority and never revives a CloudBase read on failure', async t => {
  const db = await createTestDatabase();
  const serverConfig: Config = { ...config, businessMode: 'active' };
  const app = await createApp({ pool: db.pool, config: serverConfig });
  t.after(async () => { try { await app.close(); } finally { await db.close(); } });
  const loopback = await app.listen({ host: '127.0.0.1', port: 0 });
  assert.equal(new URL(loopback).hostname, '127.0.0.1');
  await db.pool.query('INSERT INTO public_statistics(app_id,served_count,coverage_text) VALUES($1,321,$2),($3,999,$4)',
    [appId, '纽约 / 新泽西', 'another-app', 'private-other-app']);

  const { readServerStats, createPublicStatsReader, ENDPOINT } = require('../../../cloudfunctions/statistics/provider.js');
  const { createStatisticsHandler } = require('../../../cloudfunctions/statistics/handler.js');
  let oldDatabaseReads = 0, primaryHttpCalls = 0, cloudCalls = 0;
  const serverStatuses: number[] = [];
  const handler = createStatisticsHandler({ authority: 'server',
    readPublicStats: createPublicStatsReader({ authority: 'server',
      readCloudStats: async () => { oldDatabaseReads++; throw Error('unexpected old CloudBase database read'); },
      // Only the native HTTPS transport is replaced: the provider still checks
      // real response bytes/headers from the composed app and its actual PG query.
      readServer: () => readServerStats((url: string, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
        assert.equal(url, ENDPOINT);
        assert.equal(url, 'https://collect.linkx.ink/api/v1/statistics/public');
        assert.equal(options.method, 'GET');
        return httpRequest(loopback + new URL(url).pathname, options, response => {
          serverStatuses.push(response.statusCode!); callback(response);
        });
      }),
    }),
    participation() { throw Error('public reads must not use participation'); },
    getSyncKey() { throw Error('public reads must not use timer credentials'); },
  });

  async function readThroughFallback() {
    const wx = {
      getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } }),
      getStorageSync: () => '', removeStorageSync() {},
      request(options: any) {
        assert.equal(options.url, 'https://collect.linkx.ink/v1/public-stats');
        assert.equal(options.method, 'GET'); primaryHttpCalls++;
        queueMicrotask(() => options.success({ statusCode: 503, data: { ok: false } }));
        return { abort() {} };
      },
      cloud: {
        async callFunction(input: any) {
          assert.deepEqual(JSON.parse(JSON.stringify(input)), { name: 'statistics', data: { action: 'publicStats' } });
          cloudCalls++;
          return { result: await handler(input.data, {}) };
        },
        database() { oldDatabaseReads++; throw Error('unexpected direct CloudBase database access'); },
      },
    };
    // A fresh client for each case ensures every read traverses the primary HTTP
    // failure, rather than being skipped by its existing two-failure circuit.
    const module: { exports: any } = { exports: {} };
    vm.runInNewContext(readFileSync(new URL('../../../utils/publicStatsClient.js', import.meta.url), 'utf8'), {
      module, wx, Date, setTimeout, clearTimeout,
      require(name: string) {
        if (name === '../config/publicStats') return require('../../../config/publicStats.js');
        // In particular, compat/cloudReads is the real shipped helper; neither
        // its fixed statistics action nor the handler/provider is mocked.
        return require(`../../../utils/${name}`);
      },
    });
    const result = await module.exports.loadPublicStats();
    assert.deepEqual(JSON.parse(JSON.stringify(result.diagnostic)), { source: 'cloudbase', reason: 'http_error' });
    assert.equal(oldDatabaseReads, 0);
    return JSON.parse(JSON.stringify(result.response.result));
  }

  assert.deepEqual(await readThroughFallback(), {
    success: true, data: { _id: 'home', servedTrips: 321, coverageText: '纽约 / 新泽西' },
  });
  await db.pool.query('UPDATE public_statistics SET served_count=322,coverage_text=$2 WHERE app_id=$1', [appId, '']);
  assert.deepEqual(await readThroughFallback(), {
    success: true, data: { _id: 'home', servedTrips: 322, coverageText: 'N/A' },
  });
  const unavailable = { success: false, data: { _id: 'home', servedTrips: null, coverageText: 'N/A' },
    errorMsg: 'PUBLIC_STATS_UNAVAILABLE' };
  serverConfig.businessMode = 'staged';
  assert.deepEqual(await readThroughFallback(), unavailable, 'an actual HTTP 503 cannot resurrect old statistics');
  serverConfig.businessMode = 'active';
  // Break only this generated test schema. The real query now fails in PG; no
  // mocked service/repository response can make this failure look successful.
  await db.pool.query('ALTER TABLE public_statistics RENAME TO unavailable_public_statistics');
  try { assert.deepEqual(await readThroughFallback(), unavailable, 'a real PG failure must stay unavailable'); }
  finally { await db.pool.query('ALTER TABLE unavailable_public_statistics RENAME TO public_statistics'); }
  assert.equal((await readThroughFallback()).data.servedTrips, 322);
  assert.deepEqual(serverStatuses, [200, 200, 503, 500, 200]);
  assert.equal(primaryHttpCalls, 5); assert.equal(cloudCalls, 5); assert.equal(oldDatabaseReads, 0);
  for (const table of ['users', 'sessions', 'idempotency_requests', 'business_events']) {
    assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
  }
});
