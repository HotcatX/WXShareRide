import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage, RequestOptions } from 'node:http';
import test from 'node:test';
import { createApp } from '../src/app.ts';
import { createTestDatabase } from './helpers/database.ts';
import { createDevtoolsHarness } from './helpers/devtools-harness.ts';
import type { RuntimeRequest } from './helpers/devtools-harness.ts';
const require = createRequire(import.meta.url);
const { createBackendHandler } = require('../../../cloudfunctions/backend/handler.js');

/** Explicitly opt in: this opens ONLY an ephemeral project after first installing
 * a synchronous deny-by-default wx boundary. Never upload or preview this copy. */
test('compiled DevTools pages use isolated real HTTP/PG after the fail-closed boundary probe',
  { skip: process.env.LINKX_DEVTOOLS_E2E !== '1', timeout: 240000 }, async t => {
    const db = await createTestDatabase(), ide = await createDevtoolsHarness();
    const appId = 'wx8a8a389199aa2a0e', openid = 'synthetic-devtools-user', bridgeKey = randomBytes(32);
    const app = await createApp({ pool: db.pool, config: { databaseUrl: '', host: '127.0.0.1', port: 0,
      appId, sessionTtlSeconds: 3600, businessMode: 'active', authBridgeKey: bridgeKey } });
    t.after(async () => { try { await ide.close(); } finally { try { await app.close(); } finally { await db.close(); } } });
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    assert.equal(new URL(url).hostname, '127.0.0.1');
    const requests: Array<{ kind: string; path: string; status: number }> = [];
    const authority = createBackendHandler({ authority: 'server',
      getKey() { throw Error('authority must not load a key'); }, getDb() { throw Error('authority must not read CloudBase'); } });
    const { readServerStats, createPublicStatsReader, ENDPOINT } = require('../../../cloudfunctions/statistics/provider.js');
    const { createStatisticsHandler } = require('../../../cloudfunctions/statistics/handler.js');
    const statistics = createStatisticsHandler({ authority: 'server',
      readPublicStats: createPublicStatsReader({ authority: 'server',
        readCloudStats() { throw Error('statistics must never read old CloudBase'); },
        readServer: () => readServerStats((target: string, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
          assert.equal(target, ENDPOINT);
          assert.equal(target, 'https://collect.linkx.ink/api/v1/statistics/public');
          assert.equal(options.method, 'GET');
          return httpRequest(url + new URL(target).pathname, options, response => {
            requests.push({ kind: 'publicStats', path: '/api/v1/statistics/public', status: response.statusCode! });
            callback(response);
          });
        }),
      }),
      participation() { throw Error('public read must not access participation'); },
      getSyncKey() { throw Error('public read must not load a key'); },
    });
    let session: any;
    async function dispatch(entry: RuntimeRequest) {
      if (entry.kind === 'authority') {
        assert.deepEqual(entry.input, { name: 'backend', data: { action: 'authority' } });
        return { id: entry.id, ok: true, value: { result: await authority(entry.input.data, {}) } };
      }
      if (entry.kind === 'publicStats') {
        assert.deepEqual(entry.input, { name: 'statistics', data: { action: 'publicStats' } });
        return { id: entry.id, ok: true, value: { result: await statistics(entry.input.data, {}) } };
      }
      if (entry.kind === 'http' && entry.input.header?.['x-linkx-probe-failure'] === '1') {
        return { id: entry.id, ok: false, value: { errMsg: 'request:fail synthetic transport failure' } };
      }
      let path: string, init: RequestInit;
      if (entry.kind === 'login') {
        assert.deepEqual(entry.input, { name: 'backend', data: { action: 'login' } });
        path = '/internal/v1/auth/cloudbase';
        const body = JSON.stringify({ purpose: 'login', appId, openid, source: 'wx_client' });
        const at = String(Date.now()), nonce = randomBytes(16).toString('hex');
        const signature = createHmac('sha256', bridgeKey)
          .update(['linkx-auth-bridge-v1', 'POST', path, appId, at, nonce, ''].join('\n')).update(body).digest('hex');
        init = { method: 'POST', body, headers: { 'content-type': 'application/json',
          'x-linkx-auth-timestamp': at, 'x-linkx-auth-nonce': nonce, 'x-linkx-auth-signature': signature } };
      } else {
        assert.equal(entry.kind, 'http');
        const target = new URL(entry.input.url);
        assert.equal(target.origin, 'https://collect.linkx.ink');
        path = target.pathname === '/v1/public-stats' ? '/api/v1/statistics/legacy' : target.pathname;
        assert.ok(path.startsWith('/api/v1/'));
        path += target.search;
        init = { method: entry.input.method, headers: entry.input.header,
          ...(entry.input.data === undefined ? {} : { body: JSON.stringify(entry.input.data) }) };
      }
      const response = await fetch(url + path, init), data = await response.json();
      if (entry.kind === 'login') session = data.data;
      requests.push({ kind: entry.kind, path, status: response.status });
      return { id: entry.id, ok: true, value: entry.kind === 'login' ? { result: data } :
        { statusCode: response.status, data, header: Object.fromEntries(response.headers) } };
    }
    t.diagnostic(`ephemeral test project: ${ide.project}`);
    await ide.open();
    const initial = await ide.evaluate('function(){ const app = getApp(); return app && app.__linkxHarness ? app.__linkxHarness.snapshot() : { ready: false }; }');
    t.diagnostic(`probe runtime: ${JSON.stringify(initial)}`);
    if (initial?.runId !== ide.runId) {
      t.diagnostic(`probe console: ${JSON.stringify(await ide.cli('get_simulator_console', ['--command', 'grep -n .']))}`);
    }
    assert.equal(initial.runId, ide.runId, 'the isolated compiled runtime must expose its unique marker');
    let replies: any[] = [];
    async function pump() {
      for (let i = 0; i < 8; i++) {
        const value = await ide.evaluate('function(id,replies){ const app=getApp(); if(!app) return {runId:id,loading:true,requests:[]}; return app.__linkxHarness.exchange(id,replies); }', [ide.runId, replies]);
        assert.equal(value.runId, ide.runId);
        if (value.loading) return value;
        replies = await Promise.all(value.requests.map(dispatch));
        // Acknowledge promptly before another separate page inspection; native
        // client deadlines remain unchanged by this transport test fixture.
        if (!replies.length) return value;
      }
    }
    async function until(expression: string, label: string) {
      for (let i = 0; i < 15; i++) {
        await pump();
        const value = await ide.evaluate(`function(){ return (${expression}); }`);
        if (value) return value;
      }
      t.diagnostic(`requests at ${label}: ${JSON.stringify(requests)}`);
      t.diagnostic(`state at ${label}: ${JSON.stringify(await ide.evaluate('function(){const app=getApp(),pages=getCurrentPages(),page=pages[pages.length-1];return {boundary:app&&app.__linkxHarness&&app.__linkxHarness.snapshot(),route:page&&page.route,ready:page&&page.data.timelinePageReady,stats:page&&page.data.publicStats};}'))}`);
      t.diagnostic(`failed stage ${label}: ${JSON.stringify(await ide.cli('get_simulator_console', ['--command', 'grep -n .']))}`);
      assert.fail(label);
    }
    await ide.evaluate('function(){ getApp().__linkxHarness.beginProbe(); return true; }');
    await until('getApp().__linkxHarness.snapshot().probe.login', 'the isolated login Promise resolves');
    const probe = (await ide.evaluate('function(){ return getApp().__linkxHarness.snapshot(); }')).probe;
    assert.deepEqual(probe, { success: 1, failed: 1, aborted: 1, complete: 3, login: true, denied: 11, ok: true });
    assert.equal(requests.filter(value => value.kind === 'http').length, 1, 'aborted/failed requests never reach HTTP');
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM users')).rows[0].n, 1);
    assert.equal(session.user.openid, openid);
    // Fixture preparation uses the actual API. It avoids redirecting into an
    // avatar-upload page with native component image URLs outside this probe.
    const prepared = await fetch(url + '/api/v1/me', { method: 'PATCH', headers: {
      authorization: `Bearer ${session.token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ name: 'Synthetic DevTools user', profile: { wechatId: 'synthetic_devtools', profileCompleted: true,
        vehicle: { plate: 'TEST-DEV', brand: 'Test', model: 'Car' } } }) });
    assert.equal(prepared.status, 200);
    t.diagnostic('actual DevTools boundary probe passed: request success/failure/abort, denied cloud/network methods, signed local login');
    await db.pool.query('INSERT INTO public_statistics(app_id,served_count,coverage_text) VALUES($1,321,$2)', [appId, 'Synthetic fixture coverage']);
    replies = [];
    await ide.loadApplication();
    const current = 'getCurrentPages()[getCurrentPages().length-1]';
    await until(`${current} && ${current}.route === 'pages/home/home' && ${current}.data.publicStats.servedTrips === 321`,
      'the actual compiled home page renders PG public statistics');
    assert.ok(requests.some(value => value.path === '/api/v1/locations' && value.status === 200));
    await ide.cli('automation_element_action', ['--action', 'text', '--selector', '.ride-title']);
    await ide.cli('automation_navigate', ['--action', 'navigateTo', '--url', '/pages/other/login/login']);
    await until(`${current} && ${current}.route === 'pages/other/login/login' && ${current}.data.timelinePageReady`, 'the compiled login page is ready');
    await ide.cli('automation_element_action', ['--action', 'tap', '--selector', '.privacy-checkbox']);
    await ide.cli('automation_element_action', ['--action', 'tap', '--selector', '.ride-primary']);
    await until(`${current} && ${current}.route === 'pages/home/home' && ${current}.data.isLoggedIn === true`,
      'the actual login button completes a signed synthetic login and returns to home');
    assert.ok(requests.some(value => value.path === '/api/v1/me' && value.status === 200));
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM users')).rows[0].n, 1);

    await ide.mockResult('showModal', { confirm: true, cancel: false });
    await ide.cli('automation_navigate', ['--action', 'navigateTo', '--url', '/pages/home/driverCarpoolTemplate/driverCarpoolTemplate']);
    await until(`${current} && ${current}.data.userInfo && !${current}.data.loadingDepartureAddrs`, 'compiled template editor profile and locations');
    const time = require('../../../utils/rideTime.js');
    const targetDate = time.getRideDateTime(Date.now() + 2 * 86400000).date;
    const weekday = time.getRideWeekday(targetDate), weekdayIndex = (weekday + 6) % 7;
    await ide.evaluate('function(patch){ const page=getCurrentPages()[getCurrentPages().length-1]; page.setData(patch); page.confirmTemplate(); return true; }', [{
      departureAddress: 'Fort Lee', destinationAddress: '哥大', weekdayIndex,
      weekdayText: ['周一','周二','周三','周四','周五','周六','周日'][weekdayIndex],
      departureTime: '15:00', passengerCount: '3', referencePrice: '11-13$', comment: 'Synthetic DevTools fixture',
    }]);
    await until(`${current}.route === 'pages/home/home'`, 'compiled template save acknowledges and returns to home');
    const templates = await db.pool.query('SELECT id,weekday,local_time,definition FROM ride_templates');
    assert.equal(templates.rowCount, 1);
    const template = templates.rows[0], templateId = template.id;
    assert.equal(template.weekday, weekday); assert.equal(template.local_time, '15:00');
    assert.equal(template.definition.listedPriceCents, null); assert.equal(template.definition.listedPriceLabel, '11-13$');
    await ide.cli('automation_navigate', ['--action', 'navigateTo', '--url', '/pages/home/newTrip/newTrip?mode=driver']);
    await until(`${current}.data.userInfo && ${current}.data.templates && ${current}.data.templates.length === 1 && !${current}.data.loadingUserInfo`,
      'compiled publishing page loads the stored weekly template');
    await ide.evaluate('function(id){ const page=getCurrentPages()[getCurrentPages().length-1]; page.onTemplateTap({currentTarget:{dataset:{id}}}); void page.confirmTrip(); return true; }', [templateId]);
    const published = await until(`${current}.data.publishedRide && !${current}.data.submitting && ${current}.data.publishedRide`, 'compiled page publishes one actual ride');
    assert.equal(published.departureDate, targetDate); assert.equal(published.departureTime, '15:00');
    const stored = (await db.pool.query('SELECT listed_price_cents,listed_price_label,time_zone FROM rides WHERE id=$1', [published.id])).rows[0];
    assert.equal(stored.listed_price_cents, null); assert.equal(stored.listed_price_label, '11-13$');
    assert.equal(stored.time_zone, 'America/New_York');
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM rides')).rows[0].n, 1);
    const final = await ide.evaluate('function(){ return getApp().__linkxHarness.snapshot(); }');
    assert.deepEqual(final.blocked, [], 'actual business pages used no forbidden native/legacy fallback');
    t.diagnostic(`${requests.length} real isolated HTTP requests; actual compiled home/login/template/publish pages; native domain/TLS/WeChat identity not tested`);
  });
