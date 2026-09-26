import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes, generateKeyPairSync } from 'node:crypto';
import { openStore } from '../src/store.mjs';
import { createCollector } from '../src/server.mjs';
import { DIAGNOSTIC_ROUTE, readAccountDiagnostics, projectDiagnosticResponse, validateDiagnosticRequest } from '../src/diagnostics.mjs';

const OPENID = 'synthetic_operator_account_123';
const subject = () => randomBytes(32).toString('hex');
const request = (accountSubject, extra = {}) => ({ accountSubject, action: 'activate', requestId: randomUUID(),
  expectedStatusVersion: 0, purposeVersion: 'ride-research-v1', noticeVersion: 'ride-research-notice-2026-09-23', ...extra });
const query = (extra = {}) => ({ openid: OPENID, synthetic: false, from: Date.now() - 60_000, to: Date.now() + 1000, limit: 50, ...extra });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'account-diagnostics-')); const path = join(dir, 'db.sqlite');
  let store = openStore(path, { realEnabled: true });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, restart() { store.close(); store = openStore(path, { realEnabled: true }); } };
}
function put(store, p, extra = {}, now = Date.now()) {
  const event = { eventId: randomUUID(), eventName: 'page_view', schemaVersion: 1, occurredAt: now, data: { page: 'home' }, ...extra };
  const body = { schemaVersion: 1, batchId: randomUUID(), events: [event] };
  store.receive({ sub: p.participantKey, ...p }, Buffer.from(JSON.stringify(body)), body, now);
  return body;
}

test('v2 migration adds nullable OpenID and binds trusted status without changing prior grants/operation retries', t => {
  const f = fixture(t); const initial = request(subject()); const p = f.store.participate(initial).participant;
  put(f.store, p);
  f.store.db.exec('DROP VIEW operational_events; DROP INDEX research_account_openid; ALTER TABLE research_accounts DROP COLUMN openid; PRAGMA user_version=2;');
  f.restart(); assert.equal(f.store.db.pragma('user_version', { simple: true }), 4);
  assert.equal(f.store.db.prepare('SELECT openid FROM research_accounts').get().openid, null);
  assert.equal(readAccountDiagnostics(f.store.db, query()).status, 'none');
  const bound = f.store.participate({ ...initial, action: 'status', openid: OPENID });
  assert.equal(bound.participant.grantId, p.grantId); assert.equal(bound.statusVersion, 1);
  assert.equal(f.store.participate({ ...initial, openid: OPENID }).participant.grantId, p.grantId);
  assert.equal(f.store.participate(initial).participant.grantId, p.grantId, 'old private helper/operation remains compatible');
  assert.equal(readAccountDiagnostics(f.store.db, query()).events.length, 1);
});

test('OpenID is immutable within an account and unique per real/test namespace; unknown status stays read-only', t => {
  const f = fixture(t); const account = subject();
  f.store.participate(request(account, { action: 'status', openid: OPENID }));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM research_accounts').get().n, 0);
  const p = f.store.participate(request(account, { openid: OPENID })).participant;
  const testParticipant = f.store.participate(request(subject(), { openid: OPENID, synthetic: true })).participant;
  assert.notEqual(testParticipant.participantKey, p.participantKey);
  for (const action of ['status', 'activate', 'withdraw']) assert.throws(() => f.store.participate(request(account,
    { action, expectedStatusVersion: 1, openid: 'different_operator_account_456' })), { code: 'ACCOUNT_IDENTITY_CONFLICT' });
  assert.throws(() => f.store.participate(request(subject(), { openid: OPENID })), { code: 'ACCOUNT_IDENTITY_CONFLICT' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM research_accounts').get().n, 2);
});

test('OpenID diagnostics isolates real/test, bounds timeline and exposes no grant/token/subject; research view excludes OpenID', t => {
  const f = fixture(t); const real = f.store.participate(request(subject(), { openid: OPENID })).participant;
  const synthetic = f.store.participate(request(subject(), { openid: OPENID, synthetic: true })).participant;
  const tripKey = randomUUID(); const now = Date.now();
  put(f.store, real, {}, now - 2000);
  const latest = put(f.store, real, { eventName: 'trip_detail_opened', data: { tripKey, tripType: 'carpool', source: 'list' } }, now - 1000);
  put(f.store, synthetic, {}, now);
  const found = readAccountDiagnostics(f.store.db, query({ limit: 1 }));
  assert.equal(found.account.openid, OPENID); assert.equal(found.events[0].eventId, latest.events[0].eventId);
  assert.equal(found.events[0].data.tripKey, tripKey); assert.equal(found.hasMoreEvents, true); assert.equal(found.hasMoreBatches, true);
  assert.equal(readAccountDiagnostics(f.store.db, query({ synthetic: true })).account.participantKey, synthetic.participantKey);
  const encoded = JSON.stringify(found);
  for (const forbidden of ['grantId', 'grant_id', 'token', 'accountSubject', 'account_subject']) assert.equal(encoded.includes(forbidden), false);
  const operational = f.store.db.prepare('SELECT openid,synthetic,tripKey FROM operational_events WHERE event_id=?').get(latest.events[0].eventId);
  assert.deepEqual(operational, { openid: OPENID, synthetic: 0, tripKey });
  assert.equal(f.store.db.prepare('PRAGMA table_info(eligible_real_events)').all().some(c => c.name === 'openid'), false);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM eligible_real_events').get().n, 2);
  const projected = projectDiagnosticResponse({ ...found, token: 'do-not-print', account: { ...found.account, grantId: 'do-not-print' } }, false);
  assert.equal(JSON.stringify(projected).includes('do-not-print'), false);
});

test('withdrawn/quarantined/expired payloads cannot be returned, but minimal batch receipts explain missing history', t => {
  const f = fixture(t); const account = subject(); const p = f.store.participate(request(account, { openid: OPENID })).participant;
  put(f.store, p);
  f.store.db.prepare("UPDATE collector_settings SET value='closed' WHERE key='restore_gate'").run();
  const quarantined = readAccountDiagnostics(f.store.db, query());
  assert.equal(quarantined.events.length, 0); assert.equal(quarantined.coverage.restoreGate, 'closed');
  f.store.db.prepare("UPDATE collector_settings SET value='open' WHERE key='restore_gate'").run();
  f.store.participate(request(account, { action: 'withdraw', expectedStatusVersion: 1 }));
  const revoked = readAccountDiagnostics(f.store.db, query());
  assert.equal(revoked.status, 'revoked'); assert.equal(revoked.events.length, 0);
  assert.equal(revoked.batches[0].payloadPresent, false); assert.equal(revoked.batches[0].eligible, false);
  assert.equal(revoked.coverage.eventRetentionDays, 180); assert.equal(revoked.coverage.missingHistoryPossible, true);
});

test('diagnostics rejects unbounded ranges/limits/extras and is reachable only on authenticated UNIX admin', async t => {
  for (const bad of [query({ limit: 101 }), query({ from: 0 }), query({ to: Date.now() + 400_000 }), query({ openid: 'short' }),
    { ...query(), token: 'extra' }, query({ synthetic: 'true' })]) assert.throws(() => validateDiagnosticRequest(bad));
  const dir = mkdtempSync(join(tmpdir(), 'diagnostic-admin-'));
  const config = { dbPath: join(dir, 'db.sqlite'), adminSocket: join(dir, 'run/admin.sock'), host: '127.0.0.1', port: 0,
    minFreeBytes: 0, adminToken: randomBytes(32).toString('base64url'), purposeVersion: 'ride-research-v1',
    privatePem: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const app = createCollector(config); const address = await app.start();
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const raw = JSON.stringify(query());
  const publicReply = await fetch(`http://127.0.0.1:${address.port}${DIAGNOSTIC_ROUTE}`, { method: 'POST', body: raw,
    headers: { Authorization: `Bearer ${config.adminToken}`, 'Content-Type': 'application/json' } });
  assert.equal(publicReply.status, 404);
  const admin = token => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: config.adminSocket, path: DIAGNOSTIC_ROUTE, method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } }, res => {
      let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }); req.on('error', reject); req.end(raw);
  });
  assert.equal((await admin('bad')).status, 401);
  const before = app.store.db.prepare('SELECT total_changes() n').get().n;
  const result = await admin(config.adminToken); assert.equal(result.status, 200); assert.equal(result.body.status, 'none');
  assert.equal(app.store.db.prepare('SELECT total_changes() n').get().n, before, 'diagnostic request makes no database mutation');
});
