import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes, generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openStore } from '../src/store.mjs';
import { createCollector } from '../src/server.mjs';
import { createConsole, initializeConsole, CONSOLE_STATISTICS_ROUTE } from '../src/console.mjs';

const DAY = 86400000, now = Date.now();
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'collector-statistics-')), path = join(dir, 'db.sqlite');
  let store = openStore(path, { realEnabled: true });
  const reader = () => { initializeConsole(store.db); return createConsole(store, { realEnabled: true }, { clock: () => now }); };
  let console = reader();
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, stats: input => console.statistics({ to: now, ...input }),
    reopen() { store.close(); store = openStore(path, { realEnabled: true }); console = reader(); } };
}
function enroll(store, synthetic = false) {
  const request = { accountSubject: randomBytes(32).toString('hex'), openid: `synthetic_${randomUUID()}`,
    action: 'activate', requestId: randomUUID(), expectedStatusVersion: 0, purposeVersion: 'ride-analytics-v1',
    noticeVersion: 'ride-analytics-notice-2026-09-23', synthetic };
  const p = store.updateAccount(request).participant;
  return { request, p, claims: { sub: p.participantKey, ...p } };
}
const followup = (extra = {}) => ({ followupId: randomUUID(), tripKey: randomUUID(), tripType: 'carpool', role: 'passenger', ...extra });
function put(store, account, data = followup(), { name = 'followup_answer', occurredAt = now, receivedAt = now,
  buildMode = 'release', eventId = randomUUID(), batchId = randomUUID() } = {}) {
  const scope = data.role === 'driver' ? 'driver_any_passenger' : 'respondent_booking';
  const body = { schemaVersion: 1, batchId, events: [{ eventId, eventName: name, schemaVersion: 1, occurredAt,
    data: name === 'followup_answer' ? { ...data, outcomeScope: scope, outcome: data.outcome ?? 'yes' }
      : name === 'followup_dismissed' ? { ...data, dismissalReason: 'close', assumedOutcome: 'yes', outcomeScope: scope } : data,
    ...(buildMode === null ? {} : { context: { buildMode } }) }] };
  store.receive(account.claims, Buffer.from(JSON.stringify(body)), body, receivedAt);
  return body;
}
const empty = { responses: 0, users: 0, rides: 0, passenger: 0, driver: 0, yes: 0, no: 0, defaults: 0 };

test('statistics deduplicate deliveries, respect late corrections and keep default outcomes separate', t => {
  const f = fixture(t), a = enroll(f.store), trip = followup();
  const body = put(f.store, a, trip, { occurredAt: now - 3000 });
  f.store.receive(a.claims, Buffer.from(JSON.stringify(body)), body, now);
  const retry = { ...body, batchId: randomUUID() };
  f.store.receive(a.claims, Buffer.from(JSON.stringify(retry)), retry, now);
  put(f.store, a, trip, { name: 'followup_dismissed' });
  put(f.store, a, { ...trip, outcome: 'no' }, { occurredAt: now - 1000 });
  put(f.store, a, { ...trip, outcome: 'yes' }, { occurredAt: now - 2000 });
  put(f.store, a, followup(), { name: 'followup_dismissed' });
  put(f.store, a, { ...trip, role: 'driver' });
  put(f.store, a, { ...trip, tripType: 'request' });
  put(f.store, a, followup(), { name: 'followup_presented' });
  f.store.db.function('payload_json', () => { throw new Error('Statistics must not decode payloads'); });
  const result = f.stats();
  assert.deepEqual(result.collection.followups, { responses: 3, users: 1, rides: 2, passenger: 2, driver: 1, yes: 2, no: 1, defaults: 1 });
  assert.equal(result.collection.events, 8);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM followup_events').get().n, 7);
  assert.ok(!JSON.stringify(result).includes(a.request.openid));
  assert.ok(!JSON.stringify(result).includes(trip.tripKey));
});

test('only real release outcomes count; nonrelease events and synthetic participants cannot override them', t => {
  const f = fixture(t), a = enroll(f.store), synthetic = enroll(f.store, true), trip = followup();
  put(f.store, a, trip, { occurredAt: now - 1000 });
  for (const buildMode of ['develop', 'trial', 'unknown', null]) put(f.store, a, { ...trip, outcome: 'no' }, { buildMode });
  put(f.store, synthetic, trip);
  assert.deepEqual(f.stats().collection.followups, { ...empty, responses: 1, users: 1, rides: 1, passenger: 1, yes: 1 });
  assert.equal(f.stats().collection.events, 5);
});

test('unbound identities remain counted and account binding deduplicates by openid, trip type and role', t => {
  const f = fixture(t), a = enroll(f.store), b = enroll(f.store), trip = followup();
  put(f.store, a, trip); put(f.store, b, trip);
  f.store.db.prepare('UPDATE analytics_accounts SET openid=NULL').run();
  assert.equal(f.stats().collection.followups.responses, 2);
  assert.equal(f.stats().collection.followups.users, 2);
  f.store.db.prepare('UPDATE analytics_accounts SET openid=?').run(a.request.openid);
  assert.equal(f.stats().collection.followups.responses, 1);
  assert.equal(f.stats().collection.followups.users, 1);
});

test('occurrence windows apply after full-history ranking while event counts use receipt time', t => {
  const f = fixture(t), a = enroll(f.store), trip = followup();
  put(f.store, a, trip, { occurredAt: now - DAY, receivedAt: now - 1000 });
  put(f.store, a, trip, { name: 'followup_dismissed' });
  assert.deepEqual(f.stats({ from: now - 1000 }).collection.followups, empty, 'old explicit answers outrank current defaults before filtering');
  assert.equal(f.stats({ from: now - 1000 }).collection.events, 2);
  put(f.store, a, { ...trip, outcome: 'no' }, { occurredAt: now - 500 });
  assert.deepEqual(f.stats({ from: now - 1000 }).collection.followups, { ...empty, responses: 1, users: 1, rides: 1, passenger: 1, no: 1 });
  for (const input of [{}, { to: 'wrong' }, { from: now + 1, to: now }, { to: now + 300001 }, { to: now, extra: true }]) {
    assert.throws(() => createConsole(f.store, {}).statistics(input, now), { status: 422 });
  }
});

test('withdrawal, grant, purpose, retention and recovery gates remain live on every statistics read', t => {
  const f = fixture(t), accounts = Array.from({ length: 5 }, () => enroll(f.store));
  for (let i = 0; i < 4; i++) put(f.store, accounts[i]);
  put(f.store, accounts[4], followup(), { occurredAt: now - 180 * DAY, receivedAt: now - 180 * DAY });
  f.store.db.prepare('UPDATE ingest_batches SET purpose_version=? WHERE participant_key=?').run('ride-analytics-v2', accounts[1].p.participantKey);
  f.store.db.prepare('UPDATE ingest_batches SET grant_id=? WHERE participant_key=?').run(randomUUID(), accounts[2].p.participantKey);
  f.store.updateAccount({ ...accounts[3].request, action: 'withdraw', requestId: randomUUID(), expectedStatusVersion: 1 });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM followup_events WHERE participant_key=?').get(accounts[3].p.participantKey).n, 0);
  assert.equal(f.stats().collection.followups.responses, 1);
  assert.equal(f.stats().collection.events, 1);
  f.store.prune(now);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM followup_events WHERE participant_key=?').get(accounts[4].p.participantKey).n, 0);
  f.store.db.prepare("UPDATE collector_settings SET value='closed' WHERE key='restore_gate'").run();
  assert.deepEqual(f.stats().collection, { status: 'unavailable', events: null, followups: null });
  f.store.recoveryComplete();
  assert.deepEqual(f.stats().collection.followups, empty);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM followup_events').get().n, 0);
});

test('historical backfill is bounded, resumes from committed progress and never exposes partial counts', async t => {
  const f = fixture(t), a = enroll(f.store);
  for (let i = 0; i < 17; i++) {
    const body = put(f.store, a);
    if (i === 0) {
      const retry = { ...body, batchId: randomUUID() };
      f.store.receive(a.claims, Buffer.from(JSON.stringify(retry)), retry, now);
    }
  }
  // Simulate an existing pre-projection database, preserving original receipts.
  f.store.db.exec("DROP TABLE followup_events; DELETE FROM collector_settings WHERE key='followup_index_cursor'; PRAGMA user_version=7;");
  f.reopen();
  assert.equal(f.stats().collection.status, 'building');
  assert.equal(f.stats().collection.events, 17); assert.equal(f.stats().collection.followups, null);
  assert.ok(f.stats().storage.payloadBytes > 0, 'storage is known while the response projection is still building');
  assert.equal(f.store.followups.backfillStep(), false);
  const partial = f.store.db.prepare('SELECT COUNT(*) AS n FROM followup_events').get().n;
  assert.ok(partial >= 7 && partial <= 8, 'only first receipts among the first eight batches are indexed');
  const progress = f.store.db.prepare("SELECT value FROM collector_settings WHERE key='followup_index_cursor'").get().value;
  f.reopen();
  assert.equal(f.store.db.prepare("SELECT value FROM collector_settings WHERE key='followup_index_cursor'").get().value, progress);
  assert.equal(f.stats().collection.followups, null);
  put(f.store, a);
  f.store.followups.start();
  for (let attempts = 0; f.store.followups.status() === 'building' && attempts < 20; attempts++) await new Promise(setImmediate);
  assert.equal(f.stats().collection.status, 'ready');
  assert.equal(f.stats().collection.followups.responses, 18);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM followup_events').get().n, 18);
  f.reopen();
  assert.equal(f.store.followups.status(), 'ready');
  assert.equal(f.store.followups.backfillStep(), true);
});

test('historical backfill finishes autonomously while both servers receive no requests', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-statistics-idle-')), path = join(dir, 'db.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = openStore(path, { realEnabled: true }), account = enroll(store);
  try {
    for (let index = 0; index < 65; index++) put(store, account);
    store.db.exec("DROP TABLE followup_events; DELETE FROM collector_settings WHERE key='followup_index_cursor'; PRAGMA user_version=7;");
  } finally { store.close(); }
  // A child process has no test runner or HTTP traffic to keep waking its loop.
  // Only one deadline timer observes the result; it never polls the backfill.
  const script = `
    import { createCollector } from ${JSON.stringify(new URL('../src/server.mjs', import.meta.url).href)};
    import { generateKeyPairSync, randomBytes } from 'node:crypto';
    const keys = generateKeyPairSync('ed25519');
    const app = createCollector({ dbPath: ${JSON.stringify(path)}, adminSocket: ${JSON.stringify(join(dir, 'admin.sock'))},
      adminToken: randomBytes(32).toString('base64url'), privatePem: keys.privateKey.export({format:'pem',type:'pkcs8'}),
      realEnabled:false, host:'127.0.0.1', port:0, minFreeBytes:0,
      token:{issuer:'idle-test',audience:'idle-test',kid:'idle-test',ttlSeconds:60,scopes:['batches:write']} });
    await app.start();
    await new Promise(resolve => setTimeout(resolve, 500));
    const result = { status: app.store.followups.status(),
      events: app.store.db.prepare('SELECT COUNT(*) AS n FROM followup_events').get().n };
    await app.close();
    process.stdout.write(JSON.stringify(result));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 });
  assert.deepEqual(JSON.parse(stdout), { status: 'ready', events: 65 });
});

test('storage counts retained compressed payloads including retries and test data over nonoverlapping DST days', t => {
  const f = fixture(t), a = enroll(f.store), synthetic = enroll(f.store, true);
  const starts = ['2026-03-04T05:00:00Z', '2026-03-05T05:00:00Z', '2026-03-06T05:00:00Z', '2026-03-07T05:00:00Z',
    '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z', '2026-03-10T04:00:00Z', '2026-03-11T04:00:00Z'].map(Date.parse);
  const to = Date.parse('2026-03-10T16:00:00Z');
  const days = starts.slice(0, 7).map((from, index) => ({ date: `2026-03-${String(index + 4).padStart(2, '0')}`, from,
    to: index === 6 ? to : starts[index + 1] - 1 }));
  assert.equal(days[4].to - days[4].from + 1, 23 * 3600000);
  const bodies = [];
  for (const [account, receivedAt] of [[a, starts[4] - 1], [synthetic, starts[4]], [a, starts[5] - 1], [a, starts[5]]]) {
    bodies.push(put(f.store, account, followup(), { receivedAt, occurredAt: receivedAt, buildMode: 'develop' }));
  }
  const retry = { ...bodies[0], batchId: randomUUID() };
  f.store.receive(a.claims, Buffer.from(JSON.stringify(retry)), retry, starts[4] - 1);
  f.store.db.function('payload_json', () => { throw new Error('Storage must never decode payloads'); });
  const all = f.store.db.prepare('SELECT received_at,length(payload) AS bytes FROM ingest_batches').all();
  const seenPaths = [];
  const console = createConsole(f.store, {}, { clock: () => now,
    fileStat: path => { seenPaths.push(path); return { size: path.endsWith('-wal') ? 200 : 1000 }; },
    volumeStat: path => { seenPaths.push(path); return { blocks: 100, bsize: 1024, bavail: 25, bfree: 30 }; } });
  const result = console.statistics({ from: starts[4], to, days });
  assert.equal(result.storage.collectorBytes, 1200);
  assert.equal(result.storage.totalBytes, 102400); assert.equal(result.storage.freeBytes, 25600, 'available bytes exclude reserved free blocks');
  assert.equal(result.storage.payloadBytes, all.reduce((sum, row) => sum + row.bytes, 0));
  assert.equal(result.storage.addedBytes, all.filter(row => row.received_at >= starts[4]).reduce((sum, row) => sum + row.bytes, 0));
  assert.deepEqual(result.storage.daily, days.map(day => ({ date: day.date,
    bytes: all.filter(row => row.received_at >= day.from && row.received_at <= day.to).reduce((sum, row) => sum + row.bytes, 0) })));
  assert.ok(seenPaths.every(path => path === f.store.db.name || path === f.store.db.name + '-wal'));
  assert.equal(result.collection.events, 0, 'expired research eligibility does not hide bytes still physically retained');
  assert.ok(result.storage.daily.some(day => day.bytes === 0));
  for (const invalid of [days.slice(0, 6), days.map((day, index) => index === 1 ? { ...day, from: day.from - 1 } : day),
    days.map((day, index) => index === 6 ? { ...day, to: day.to + 1 } : day)]) {
    assert.throws(() => console.statistics({ to, days: invalid }), { status: 422 });
  }
});

test('file and volume failures remain unknown independently without losing known payload or response totals', t => {
  const f = fixture(t), a = enroll(f.store); put(f.store, a);
  const denied = () => { const error = new Error('Private path'); error.code = 'EACCES'; throw error; };
  const missing = () => { const error = new Error('Missing WAL'); error.code = 'ENOENT'; throw error; };
  const read = (fileStat, volumeStat) => createConsole(f.store, {}, { clock: () => now, fileStat, volumeStat }).statistics({ to: now });
  const unavailable = read(denied, denied);
  assert.equal(unavailable.storage.collectorBytes, null); assert.equal(unavailable.storage.totalBytes, null);
  assert.ok(unavailable.storage.payloadBytes > 0); assert.equal(unavailable.collection.followups.responses, 1);
  const noWal = read(path => path.endsWith('-wal') ? missing() : { size: 5000 }, denied);
  assert.equal(noWal.storage.collectorBytes, 5000); assert.equal(noWal.storage.freeBytes, null);
  const unsafe = read(() => ({ size: Number.MAX_SAFE_INTEGER }), () => ({ blocks: Infinity, bsize: 1024, bavail: -1 }));
  assert.equal(unsafe.storage.collectorBytes, null); assert.equal(unsafe.storage.totalBytes, null); assert.equal(unsafe.storage.freeBytes, null);
  f.store.db.prepare("UPDATE collector_settings SET value='closed' WHERE key='restore_gate'").run();
  assert.equal(read(denied, denied).storage, null);
});

test('corrupt historical payloads or receipts leave statistics unavailable without false partial totals', async t => {
  for (const damage of ['payload', 'receipt']) {
    const f = fixture(t), a = enroll(f.store), body = put(f.store, a);
    if (damage === 'payload') {
      const changed = { ...body, events: [{ ...body.events[0], data: { ...body.events[0].data, outcome: 'no' } }] };
      const raw = Buffer.from(JSON.stringify(changed));
      f.store.db.prepare("UPDATE ingest_batches SET payload=?,codec='json',raw_bytes=?").run(raw, raw.length);
    } else f.store.db.prepare('UPDATE event_receipts SET event_hash=?').run('0'.repeat(64));
    f.store.db.exec("DROP TABLE followup_events; DELETE FROM collector_settings WHERE key='followup_index_cursor'; PRAGMA user_version=7;");
    f.reopen(); f.store.followups.start();
    await new Promise(setImmediate);
    assert.deepEqual(f.stats().collection, { status: 'unavailable', events: null, followups: null });
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM followup_events').get().n, 0);
    assert.equal(f.store.db.prepare("SELECT value FROM collector_settings WHERE key='followup_index_cursor'").get().value, '[]');
    assert.equal(f.store.db.prepare('SELECT 1 AS healthy').get().healthy, 1);
  }
});

test('statistics use only authenticated private routes and reject invalid bodies', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-statistics-http-'));
  const keys = generateKeyPairSync('ed25519');
  const config = { dbPath: join(dir, 'db.sqlite'), adminSocket: join(dir, 'admin.sock'), adminToken: randomBytes(32).toString('base64url'),
    privatePem: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), realEnabled: true,
    host: '127.0.0.1', port: 0, minFreeBytes: 0, token: { issuer: 'test', audience: 'test', kid: 'test', ttlSeconds: 60, scopes: ['batches:write'] } };
  const app = createCollector(config); await app.start();
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const call = (token, body, socketPath = config.adminSocket) => new Promise(resolve => {
    const req = http.request({ socketPath, path: CONSOLE_STATISTICS_ROUTE, method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, res => {
      let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    }); req.end(JSON.stringify(body));
  });
  assert.equal((await call('wrong', { to: now })).status, 401);
  assert.equal((await call(config.adminToken, { to: now, synthetic: true })).status, 422);
  assert.equal((await call(config.adminToken, { to: now })).body.collection.status, 'ready');
  const response = await fetch(`http://127.0.0.1:${app.publicServer.address().port}${CONSOLE_STATISTICS_ROUTE}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.adminToken}` }, body: JSON.stringify({ to: now }) });
  assert.equal(response.status, 404);
});
