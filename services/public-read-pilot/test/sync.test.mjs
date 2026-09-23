import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSnapshot, readSnapshot, revisionOf } from '../src/snapshot.mjs';
import { loadSyncKey } from '../src/sync.mjs';
import { createPublicReadPilot, ROUTE, SYNC_ROUTE } from '../src/server.mjs';

const NOW = 1_790_000_000_000;
const DATA = { _id: 'home', servedTrips: 123, coverageText: 'NY / NJ' };
const make = (at = NOW, data = DATA) => makeSnapshot(data, { now: at, ttlMs: 7_200_000 });
const sign = (key, timestamp, body) => createHmac('sha256', key).update(`${timestamp}\n`).update(body).digest('hex');
async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'public-sync-'));
  const path = join(dir, 'snapshot.json'); const key = randomBytes(32); const logs = [];
  if (options.initial) writeFileSync(path, typeof options.initial === 'string' ? options.initial : JSON.stringify(options.initial));
  const server = createPublicReadPilot({ snapshotPath: path, syncKey: options.disabled ? null : key,
    readEnabled: !options.readDisabled, now: () => NOW, log: item => logs.push(item) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { dir, path, key, logs, base, async sync(value = make(), options = {}) {
    const body = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value);
    const timestamp = String(options.timestamp ?? NOW);
    return fetch(base + (options.route || SYNC_ROUTE), { method: options.method || 'POST', body,
      headers: { 'Content-Type': 'application/json', 'x-linkx-timestamp': timestamp,
        'x-linkx-signature': sign(key, timestamp, body), ...options.headers } });
  } };
}

test('HMAC uses the decoded 32-byte secret; absent or invalid configured key fails closed', t => {
  const dir = mkdtempSync(join(tmpdir(), 'public-key-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'key'); const key = randomBytes(32);
  assert.equal(loadSyncKey(), null);
  writeFileSync(path, key.toString('hex') + '\n'); assert.deepEqual(loadSyncKey(path), key);
  for (const value of ['', 'z'.repeat(64), key.toString('hex').repeat(3), Buffer.from([0xff])]) {
    writeFileSync(path, value); assert.throws(() => loadSyncKey(path), /PUBLIC_STATS_SYNC_KEY_INVALID/);
  }
  writeFileSync(path, key.toString('hex')); symlinkSync(path, join(dir, 'link'));
  assert.throws(() => loadSyncKey(join(dir, 'link')), /PUBLIC_STATS_SYNC_KEY_INVALID/);
});

test('authenticated sync installs mode600 atomically, serves it, and accepts exact retry', async t => {
  const f = await fixture(t);
  const result = await f.sync(); assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { ok: true, duplicate: false, snapshotAt: NOW, revision: make().revision });
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.deepEqual(readSnapshot(f.path, NOW), make());
  assert.deepEqual(readdirSync(f.dir), ['snapshot.json']);
  const retry = await f.sync(); assert.equal(retry.status, 200); assert.equal((await retry.json()).duplicate, true);
  assert.equal((await fetch(f.base + ROUTE)).status, 200);
  assert.equal((await fetch(f.base + '/trial/v1/public-stats')).status, 404);
  assert.ok(f.logs.every(value => Object.keys(value).join(',') === 'event,status,at'));
});

test('signature, exact body bytes and signing timestamp must match, with five-minute boundary', async t => {
  const f = await fixture(t);
  for (const options of [
    { headers: { 'x-linkx-signature': 'a'.repeat(64) } },
    { headers: { 'x-linkx-signature': sign(Buffer.from(f.key.toString('hex')), String(NOW), JSON.stringify(make())) } },
    { headers: { 'x-linkx-signature': sign(f.key, String(NOW), JSON.stringify(make()) + ' ') } },
    { timestamp: NOW - 300_001 }, { timestamp: NOW + 300_001 },
    { headers: { 'x-linkx-timestamp': '01' + NOW } },
  ]) assert.equal((await f.sync(make(), options)).status, 401);
  assert.equal(readdirSync(f.dir).length, 0);
  for (const timestamp of [NOW - 300_000, NOW + 300_000]) assert.equal((await f.sync(make(), { timestamp })).status, 200);
});

test('older snapshots and same-time changed data or expiry cannot replace current state', async t => {
  const f = await fixture(t, { initial: make() }); const original = readFileSync(f.path);
  for (const snapshot of [make(NOW - 1), make(NOW, { ...DATA, servedTrips: 999 }), { ...make(), expiresAt: NOW + 3_600_000 }]) {
    assert.equal((await f.sync(snapshot)).status, 409);
    assert.deepEqual(readFileSync(f.path), original);
  }
  assert.equal((await f.sync(make(NOW + 1))).status, 200);
  assert.equal(readSnapshot(f.path, NOW).snapshotAt, NOW + 1);
});

test('concurrent arrivals remain monotonic and all stored generations stay complete', async t => {
  const f = await fixture(t);
  const times = [NOW + 4, NOW + 2, NOW + 9, NOW + 1, NOW + 10, NOW + 5];
  const responses = await Promise.all(times.map(at => f.sync(make(at))));
  assert.ok(responses.every(response => [200, 409].includes(response.status)));
  assert.equal(readSnapshot(f.path, NOW).snapshotAt, Math.max(...times));
  assert.deepEqual(readdirSync(f.dir), ['snapshot.json']);
});

test('strict public schema, revision, UTF8, size and sync freshness are checked before writing', async t => {
  const f = await fixture(t, { initial: make() }); const original = readFileSync(f.path);
  const personal = { ...make(), data: { ...DATA, openid: 'synthetic-private' } }; personal.revision = revisionOf(personal.data);
  for (const value of [personal, { ...make(), debug: 'private' }, { ...make(), revision: '0'.repeat(64) },
    make(NOW - 300_001), make(NOW + 60_001), '{bad', Buffer.from([0xff])]) {
    assert.equal((await f.sync(value)).status, 400);
    assert.deepEqual(readFileSync(f.path), original);
  }
  assert.equal((await f.sync(' '.repeat(8193))).status, 413);
  assert.equal((await f.sync(make(), { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.sync(make(), { headers: { 'Content-Encoding': 'gzip' } })).status, 415);
  const raw = JSON.stringify(make());
  assert.equal((await f.sync(raw + ' '.repeat(8192 - Buffer.byteLength(raw)))).status, 200);
});

test('sync defaults disabled while public read pause does not stop authenticated updates', async t => {
  const disabled = await fixture(t, { disabled: true, initial: make() });
  assert.equal((await disabled.sync()).status, 503);
  assert.equal((await fetch(disabled.base + ROUTE)).status, 200);
  const paused = await fixture(t, { readDisabled: true });
  assert.equal((await paused.sync()).status, 200);
  const res = await fetch(paused.base + ROUTE); assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'PUBLIC_READ_DISABLED');
  for (const path of [SYNC_ROUTE + '?x=1', SYNC_ROUTE + '/', '/internal/v1/%70ublic-stats/sync']) {
    assert.equal((await paused.sync(make(), { route: path })).status, 404);
  }
  assert.equal((await fetch(paused.base + SYNC_ROUTE)).status, 405);
});

test('expired generations permit fresh update but corrupt existing state fails closed', async t => {
  const expired = await fixture(t, { initial: make(NOW - 10_000_000) });
  assert.equal((await expired.sync()).status, 200);
  const corrupt = await fixture(t, { initial: '{bad' });
  assert.equal((await corrupt.sync()).status, 503);
  assert.equal(readFileSync(corrupt.path, 'utf8'), '{bad');
});
