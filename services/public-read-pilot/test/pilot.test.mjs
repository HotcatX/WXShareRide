import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeSnapshot, validateSnapshot, readSnapshot, revisionOf, MAX_TTL_MS } from '../src/snapshot.mjs';
import { createPublicReadPilot, ROUTE } from '../src/server.mjs';

const NOW = 1_790_000_000_000;
const DATA = { _id: 'home', servedTrips: 123, coverageText: 'NY / NJ' };
const make = () => makeSnapshot(DATA, { now: NOW });

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'public-pilot-'));
  const path = join(dir, 'snapshot.json');
  writeFileSync(path, JSON.stringify(make()));
  const server = createPublicReadPilot({ snapshotPath: path, now: () => NOW });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); rmSync(dir, { recursive: true, force: true }); });
  return { dir, path, base: `http://127.0.0.1:${server.address().port}`,
    set(value) { writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); } };
}

test('valid snapshot and null unknown preserve the exact public contract', async t => {
  const f = await fixture(t);
  const res = await fetch(f.base + ROUTE);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { ok: true, ...make() });
  const unknown = makeSnapshot({ ...DATA, servedTrips: null }, { now: NOW }); f.set(unknown);
  const unknownRes = await fetch(f.base + ROUTE);
  assert.equal((await unknownRes.json()).data.servedTrips, null);
});

test('only exact GET path is available, including no query, aliases or admin', async t => {
  const f = await fixture(t);
  for (const path of ['/', '/healthz', '/v1/batches', '/v1/participants/state', ROUTE + '?x=1', ROUTE + '?', ROUTE + '/', '/trial/v1/%70ublic-stats']) {
    // fetch normalizes a lone '?'; use its nonempty equivalent separately above.
    if (path.endsWith('?')) continue;
    assert.equal((await fetch(f.base + path)).status, 404, path);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
    const res = await fetch(f.base + ROUTE, { method });
    assert.equal(res.status, 405, method); assert.equal(res.headers.get('allow'), 'GET');
  }
});

test('missing, malformed, oversized and invalid UTF-8 files are unavailable without disclosure', async t => {
  const f = await fixture(t);
  const badInputs = ['{broken', 'x'.repeat(8193), Buffer.from([0xff, 0xfe])];
  for (const raw of badInputs) {
    writeFileSync(f.path, raw);
    const res = await fetch(f.base + ROUTE);
    assert.equal(res.status, 503); assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { ok: false, error: 'SNAPSHOT_UNAVAILABLE' });
  }
  rmSync(f.path);
  assert.equal((await fetch(f.base + ROUTE)).status, 503);
});

test('expired snapshots fail and exact six-hour and future-skew bounds are enforced', () => {
  const atLimit = makeSnapshot(DATA, { now: NOW, ttlMs: MAX_TTL_MS });
  assert.equal(validateSnapshot(atLimit, NOW).expiresAt, NOW + MAX_TTL_MS);
  assert.throws(() => validateSnapshot(atLimit, NOW + MAX_TTL_MS), /SNAPSHOT_UNAVAILABLE/);
  assert.throws(() => validateSnapshot({ ...atLimit, expiresAt: atLimit.expiresAt + 1 }, NOW), /SNAPSHOT_UNAVAILABLE/);
  assert.throws(() => validateSnapshot({ ...atLimit, expiresAt: NOW }, NOW), /SNAPSHOT_UNAVAILABLE/);
  assert.doesNotThrow(() => validateSnapshot(makeSnapshot(DATA, { now: NOW + 60_000 }), NOW));
  assert.throws(() => validateSnapshot(makeSnapshot(DATA, { now: NOW + 60_001 }), NOW), /SNAPSHOT_UNAVAILABLE/);
});

test('wrong revision and changed public value are rejected', async t => {
  const f = await fixture(t); const snapshot = make();
  snapshot.data.servedTrips++;
  f.set(snapshot); assert.equal((await fetch(f.base + ROUTE)).status, 503);
  f.set({ ...make(), revision: 'A'.repeat(64) });
  assert.equal((await fetch(f.base + ROUTE)).status, 503);
  assert.equal(revisionOf(DATA), make().revision);
});

test('strict whitelist rejects PII/internal fields at either level', async t => {
  const f = await fixture(t);
  const extra = [
    { ...make(), errorMsg: 'internal diagnostic' },
    { ...make(), _openid: 'private-user-id' },
    { ...make(), data: { ...DATA, phone: '5551234567' } },
    { ...make(), data: { ...DATA, servedTripsLastTripId: 'private-trip-id' } },
    { ...make(), data: { ...DATA, latitude: 40.8 } },
  ];
  for (const snapshot of extra) {
    if (snapshot.data) snapshot.revision = revisionOf(snapshot.data);
    f.set(snapshot); assert.equal((await fetch(f.base + ROUTE)).status, 503);
  }
});

test('schema, source, scalar types, missing fields and coverage limits are checked', () => {
  const variants = [
    { ...make(), schemaVersion: 2 }, { ...make(), source: 'live-cloudbase' },
    { ...make(), snapshotAt: '1790000000000' }, { ...make(), expiresAt: Infinity },
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '12'].map(servedTrips => ({ ...make(), data: { ...DATA, servedTrips } })),
    { ...make(), data: { ...DATA, coverageText: 'x'.repeat(121) } },
    { ...make(), data: { ...DATA, coverageText: 'NY\nNJ' } },
    { ...make(), data: { ...DATA, coverageText: null } },
    { ...make(), data: { ...DATA, _id: 'another-document' } },
    { ...make(), data: { _id: 'home', servedTrips: 1 } },
  ];
  for (const snapshot of variants) {
    if (snapshot.data) snapshot.revision = revisionOf(snapshot.data);
    assert.throws(() => validateSnapshot(snapshot, NOW), /SNAPSHOT_UNAVAILABLE/);
  }
  assert.doesNotThrow(() => makeSnapshot({ ...DATA, servedTrips: 0, coverageText: 'x'.repeat(120) }, { now: NOW }));
});

test('files at the exact 8192-byte bound work and symlinks fail closed', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pilot-file-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'snapshot.json'); const alias = join(dir, 'alias.json');
  const raw = JSON.stringify(make()); writeFileSync(path, raw + ' '.repeat(8192 - Buffer.byteLength(raw)));
  assert.equal(readSnapshot(path, NOW).revision, make().revision);
  writeFileSync(path, raw + ' '.repeat(8193 - Buffer.byteLength(raw)));
  assert.throws(() => readSnapshot(path, NOW), /SNAPSHOT_UNAVAILABLE/);
  writeFileSync(path, raw); symlinkSync(path, alias);
  assert.throws(() => readSnapshot(alias, NOW), /SNAPSHOT_UNAVAILABLE/);
});

test('generator accepts only public data, sets bounded expiry, and never echoes rejected secrets', () => {
  const cwd = resolve('.');
  const good = spawnSync(process.execPath, ['scripts/create-snapshot.mjs'], { cwd, input: JSON.stringify(DATA), encoding: 'utf8' });
  assert.equal(good.status, 0); const snapshot = JSON.parse(good.stdout);
  assert.deepEqual(snapshot.data, DATA); assert.equal(snapshot.expiresAt - snapshot.snapshotAt, 3_600_000);
  assert.doesNotThrow(() => validateSnapshot(snapshot));
  const secret = 'synthetic-sensitive-should-not-echo';
  const bad = spawnSync(process.execPath, ['scripts/create-snapshot.mjs'], { cwd, input: JSON.stringify({ ...DATA, phone: secret }), encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.equal(bad.stdout, ''); assert.ok(!bad.stderr.includes(secret));
  const long = spawnSync(process.execPath, ['scripts/create-snapshot.mjs'], { cwd, input: JSON.stringify(DATA), encoding: 'utf8', env: { ...process.env, SNAPSHOT_TTL_MS: String(MAX_TTL_MS + 1) } });
  assert.equal(long.status, 1); assert.equal(long.stdout, '');
});
