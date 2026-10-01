import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createAdminMonitor } from '../src/admin/monitor.ts';
import { AppError } from '../src/errors.ts';

const processMetrics = () => ({ scope: 'process', sampledAt: Date.now(), uptimeSeconds: 5,
  cpuPercent: null, cpuBasis: 'one_core' });
const snapshot = () => ({ ok: true, sampledAt: Date.now(), process: processMetrics(),
  traffic: {sampledAt:Date.now(),startedAt:Date.now(),minutes:[]}, collection: { enabled: true, restoreGate: 'open',
    latestReceivedAt: Date.now(), receivedLastMinute: 2, receivedLastMinuteCapped: false, activeLastMinute:1, activeLastMinuteCapped:false } });
const host = (sampledAt = Date.now()) => ({ schemaVersion: 1, sampledAt, uptimeSeconds: 50,
  cpu: { percent: 5, cores: 2 }, services: [{ name: 'backend', state: 'healthy',
    cpuPercent: 0, startedAt: '2026-09-30T00:00:00Z', restarts: 0 }] });
const page = () => ({ ok: true, sampledAt: Date.now(), timeBasis: 'receivedAt', from: 0, to: Date.now(),
  events: [{ openid: 'synthetic_operator_account_123', participantKey: randomUUID(), batchId: randomUUID(), receivedAt: Date.now(),
    eventId: randomUUID(), eventName: 'page_view', schemaVersion: 1, occurredAt: Date.now(), data: { page: 'home' } }],
  nextCursor: null, scanned: 1 });
async function fixture(t: TestContext, handler: http.RequestListener) {
  const dir = mkdtempSync(join(tmpdir(), 'admin-monitor-'));
  const config = { socketPath: join(dir, 'admin.sock'), token: randomBytes(32).toString('base64url'), hostSnapshotFile: join(dir, 'host.json') };
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(config.socketPath, resolve));
  t.after(async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(dir, { recursive: true, force: true });
  });
  return { config, dir, server };
}
function reply(res: http.ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
}

test('monitor uses a private socket, caches concurrent status reads, and distinguishes host/process measurements', async t => {
  let requests = 0;
  const f = await fixture(t, (req, res) => {
    requests++; assert.equal(req.method, 'GET'); assert.equal(req.url, '/v1/console/snapshot');
    assert.equal(req.headers.authorization, `Bearer ${f.config.token}`); reply(res, snapshot());
  });
  writeFileSync(f.config.hostSnapshotFile, JSON.stringify(host()));
  const monitor = createAdminMonitor(f.config);
  const results = await Promise.all(Array.from({ length: 12 }, () => monitor.status()));
  assert.equal(requests, 1); assert.ok(results.every(value => value === results[0]));
  assert.equal(results[0].host.status, 'ready'); assert.equal(results[0].backend.scope, 'process');
  assert.equal(results[0].backend.cpuBasis, 'one_core'); assert.equal(results[0].collector.status, 'ready');
  assert.equal(results[0].refreshAfterMs, 10000); assert.equal(JSON.stringify(results).includes(f.config.token), false);
});

test('monitor outages and missing optional configuration leave backend metrics available', async t => {
  const f = await fixture(t, (_req, res) => reply(res, { token: 'private', error: 'internal detail' }, 500));
  const value = await createAdminMonitor(f.config).status();
  assert.equal(value.host.status, 'unavailable'); assert.equal(value.collector.status, 'unavailable');
  assert.equal(value.backend.scope, 'process'); assert.equal(JSON.stringify(value).includes('internal detail'), false);
  const disabled = await createAdminMonitor().status();
  assert.equal(disabled.host.status, 'unavailable'); assert.equal(disabled.collector.status, 'unavailable');
});

test('host snapshots are bounded, reject symlinks/extra secrets, and label stale snapshots', async t => {
  const f = await fixture(t, (_req, res) => reply(res, snapshot()));
  writeFileSync(f.config.hostSnapshotFile, JSON.stringify(host(Date.now() - 70000)));
  assert.equal((await createAdminMonitor(f.config).status()).host.status, 'stale');
  writeFileSync(f.config.hostSnapshotFile, JSON.stringify({ ...host(), token: 'hidden' }));
  const extra = await createAdminMonitor(f.config).status(); assert.equal(extra.host.status, 'unavailable');
  assert.equal(JSON.stringify(extra).includes('hidden'), false);
  writeFileSync(f.config.hostSnapshotFile, ' '.repeat(16385));
  assert.equal((await createAdminMonitor(f.config).status()).host.status, 'unavailable');
  const target = join(f.dir, 'target.json'), link = join(f.dir, 'link.json');
  writeFileSync(target, JSON.stringify(host())); symlinkSync(target, link);
  assert.equal((await createAdminMonitor({ ...f.config, hostSnapshotFile: link }).status()).host.status, 'unavailable');
});

test('event pages validate requests, project known fields, and never echo private transport configuration', async t => {
  let requests = 0;
  const result = page();
  const f = await fixture(t, (req, res) => {
    requests++; assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/console/events');
    let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      assert.deepEqual(JSON.parse(raw), { limit: 25, subject: 'a'.repeat(64), type: 'page_view' }); reply(res, result);
    });
  });
  const monitor = createAdminMonitor(f.config);
  for (const input of [{ limit: 51 }, { limit: '25' }, { subject: 'invalid' }, { token: 'extra' }, { cursor: 'a'.repeat(769) }]) {
    await assert.rejects(monitor.events(input), (error: AppError) => error.status === 422);
  }
  assert.equal(requests, 0);
  const value = await monitor.events({ limit: 25, subject: 'a'.repeat(64), type: 'page_view' });
  assert.equal(value.events[0].eventId, result.events[0].eventId); assert.equal('ok' in value, false);
  assert.equal(JSON.stringify(value).includes(f.config.token), false); assert.equal(JSON.stringify(value).includes(f.config.socketPath), false);
});

test('bad/oversized collector replies fail only console endpoints and never expose their contents', async t => {
  let mode = 'extra';
  const f = await fixture(t, (_req, res) => {
    if (mode === 'extra') reply(res, { ...page(), token: 'secret-material' });
    else if (mode === 'large') reply(res, { padding: 'x'.repeat(300000) });
    else reply(res, { error: 'query details' }, 422);
  });
  const monitor = createAdminMonitor(f.config);
  await assert.rejects(monitor.events({}), (error: AppError) => error.status === 503 && !error.message.includes('secret-material'));
  mode = 'large'; await assert.rejects(monitor.events({}), (error: AppError) => error.status === 503);
  mode = 'query'; await assert.rejects(monitor.events({}), (error: AppError) => error.status === 422 && !error.message.includes('query details'));
});

test('stalled collector requests terminate within the fixed timeout without blocking host/process metrics', async t => {
  const f = await fixture(t, () => {});
  writeFileSync(f.config.hostSnapshotFile, JSON.stringify(host()));
  const started = Date.now(); const value = await createAdminMonitor(f.config).status();
  assert.ok(Date.now() - started < 2500); assert.equal(value.collector.status, 'unavailable'); assert.equal(value.host.status, 'ready');
});

test('history keeps sparse real points, shares reads and recovers after a missing export', async t => {
  const f = await fixture(t, (_req, res) => reply(res, snapshot()));
  const monitor = createAdminMonitor(f.config), now = Date.now();
  await assert.rejects(monitor.history('day'), (error: AppError) => error.status === 503);
  const value = { schemaVersion: 2, bucketMs:120000, range: 'day', sampledAt: now, from: now - 86400000, to: now,
    points: [{ at: now - 60000, cpu:null,requests:null,activeUsers:null,events:null }] };
  writeFileSync(join(f.dir, 'history-day.json'), JSON.stringify(value));
  const results = await Promise.all(Array.from({ length: 20 }, () => monitor.history('day')));
  assert.ok(results.every(result => result === results[0]));
  assert.equal(results[0].points.length, 1); assert.equal(results[0].points[0].cpu, null);
  assert.equal('schemaVersion' in results[0], false);
  writeFileSync(join(f.dir, 'history-day.json'), '{}');
  assert.strictEqual(await monitor.history('day'), results[0]);
  await assert.rejects(monitor.history('../private'), (error: AppError) => error.status === 422);
  await assert.rejects(createAdminMonitor().history('day'), (error: AppError) => error.status === 503);
});

test('history rejects unsafe files, oversized pages and invalid temporal/resource measurements', async t => {
  const f = await fixture(t, (_req, res) => reply(res, snapshot())), now = Date.now();
  const path = join(f.dir, 'history-week.json');
  const point = { at: now - 1000, cpu:{mean:5,min:2,max:10,peakAt:now-500,samples:2}, requests:null,activeUsers:null,events:null };
  const base = { schemaVersion: 2, bucketMs:900000, range: 'week', sampledAt: now, from: now - 604800000, to: now, points: [point] };
  for (const bad of [{ ...base, token: 'secret' }, { ...base, range: 'month' }, { ...base, sampledAt: now + 60000 },
    { ...base, points: [point, point] }, { ...base, points: [{ ...point, cpu:{...point.cpu,max:101} }] },
    { ...base, bucketMs:120000 }, { ...base,points:[{...point,cpu:{...point.cpu,min:7}}]},
    { ...base, points: Array.from({ length: 721 }, (_, index) => ({ ...point, at: now - 1000 + index })) }]) {
    writeFileSync(path, JSON.stringify(bad));
    await assert.rejects(createAdminMonitor(f.config).history('week'), (error: AppError) => error.status === 503 && !error.message.includes('secret'));
  }
  writeFileSync(path, ' '.repeat(524289));
  await assert.rejects(createAdminMonitor(f.config).history('week'), (error: AppError) => error.status === 503);
  rmSync(path); symlinkSync(f.config.hostSnapshotFile, path);
  writeFileSync(f.config.hostSnapshotFile, JSON.stringify(base));
  await assert.rejects(createAdminMonitor(f.config).history('week'), (error: AppError) => error.status === 503);
});
