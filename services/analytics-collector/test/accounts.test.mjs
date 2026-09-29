import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, generateKeyPairSync, createHmac, sign } from 'node:crypto';
import { createCollector } from '../src/server.mjs';
import { loadBridgeKey } from '../src/bridge.mjs';
import { BRIDGE_ROUTE, DEFAULT_PURPOSE_VERSION, DEFAULT_NOTICE_VERSION, TOKEN_ISSUER, TOKEN_AUDIENCE } from '../src/protocol.mjs';
import { LEGACY_BRIDGE_ROUTE, LEGACY_PURPOSE_VERSION, LEGACY_NOTICE_VERSION, LEGACY_TOKEN_ISSUER, LEGACY_TOKEN_AUDIENCE } from '../src/compat/legacy.mjs';
import { openStore } from '../src/store.mjs';
import { rotateBackups } from '../src/backup-retention.mjs';
import { readSafeMetrics } from '../src/metrics.mjs';

const subject = () => randomBytes(32).toString('hex');
const request = (accountSubject, action = 'status', expectedStatusVersion = 0, extra = {}) => ({ accountSubject,
  action, requestId: randomUUID(), expectedStatusVersion, purposeVersion: 'ride-analytics-v1', noticeVersion: DEFAULT_NOTICE_VERSION, ...extra });
async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'analytics-bridge-'));
  const config = { dbPath: join(dir, 'store.sqlite'), host: '127.0.0.1', port: 0, minFreeBytes: 0,
    adminSocket: join(dir, 'run/admin.sock'), adminToken: randomBytes(32).toString('base64url'),
    privatePem: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
    bridgeKey: randomBytes(32), purposeVersion: 'ride-analytics-v1', noticeVersion: DEFAULT_NOTICE_VERSION,
    realEnabled: true, ...options };
  let app = createCollector(config); let address = await app.start();
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, config, get app() { return app; }, async restart(changes = {}) {
    await app.close(); Object.assign(config, changes); app = createCollector(config); address = await app.start();
  }, async send(body, options = {}) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const timestamp = String(options.timestamp ?? Date.now()); const nonce = options.nonce || randomBytes(16).toString('hex');
    const signature = createHmac('sha256', options.signingKey || config.bridgeKey || randomBytes(32)).update(`${timestamp}\n${nonce}\n`).update(raw).digest('hex');
    const res = await fetch(`http://127.0.0.1:${address.port}${options.route || BRIDGE_ROUTE}`, { method: options.method || 'POST', body: raw,
      headers: { 'Content-Type': 'application/json', 'x-linkx-timestamp': timestamp, 'x-linkx-nonce': nonce,
        'x-linkx-signature': signature, ...options.headers } });
    return { status: res.status, body: await res.json() };
  }, async batch(token, b = { schemaVersion: 1, batchId: randomUUID(), events: [{ eventId: randomUUID(), eventName: 'page_view',
    schemaVersion: 1, occurredAt: Date.now(), data: { page: 'home' } }] }) {
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/batches`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(b) });
    return { status: res.status, body: await res.json() };
  } };
}

test('legacy requests and JWTs share one canonical account, grant, queue and operation history', async t => {
  const f = await fixture(t); const account = subject();
  const oldRequest = request(account, 'activate', 0, { purposeVersion: LEGACY_PURPOSE_VERSION, noticeVersion: LEGACY_NOTICE_VERSION });
  const originalBytes = JSON.stringify(oldRequest);
  const active = await f.send(oldRequest, { route: LEGACY_BRIDGE_ROUTE });
  assert.equal(active.status, 200); assert.equal(active.body.purposeVersion, LEGACY_PURPOSE_VERSION);
  assert.equal(active.body.noticeVersion, LEGACY_NOTICE_VERSION);
  assert.equal(active.body.session.acceptedPurposeVersion, LEGACY_PURPOSE_VERSION);
  const newClaims = JSON.parse(Buffer.from(active.body.session.token.split('.')[1], 'base64url'));
  assert.equal(newClaims.iss, TOKEN_ISSUER); assert.equal(newClaims.aud, TOKEN_AUDIENCE);
  assert.equal(newClaims.purposeVersion, DEFAULT_PURPOSE_VERSION);
  const resign = changes => {
    const input = `${active.body.session.token.split('.')[0]}.${Buffer.from(JSON.stringify({ ...newClaims, ...changes })).toString('base64url')}`;
    return `${input}.${sign(null, Buffer.from(input), f.config.privatePem).toString('base64url')}`;
  };
  const oldToken = resign({ iss: LEGACY_TOKEN_ISSUER, aud: LEGACY_TOKEN_AUDIENCE, purposeVersion: LEGACY_PURPOSE_VERSION });
  const queued = { schemaVersion: 1, batchId: randomUUID(), events: [{ eventId: randomUUID(), eventName: 'page_view',
    schemaVersion: 1, occurredAt: Date.now(), data: { page: 'home' } }] };
  const first = await f.batch(oldToken, queued); assert.equal(first.status, 200); assert.equal(first.body.duplicate, false);
  const operation = f.app.store.db.prepare('SELECT * FROM analytics_operations WHERE request_id=?').get(oldRequest.requestId);
  await f.restart();
  const retried = await f.send(JSON.parse(originalBytes), { route: BRIDGE_ROUTE });
  assert.equal(retried.status, 200); assert.equal(retried.body.session.grantId, active.body.session.grantId);
  assert.equal(retried.body.purposeVersion, LEGACY_PURPOSE_VERSION, 'metadata follows request, not URL');
  assert.deepEqual(f.app.store.db.prepare('SELECT * FROM analytics_operations WHERE request_id=?').get(oldRequest.requestId), operation);
  assert.deepEqual((await f.batch(retried.body.session.token, queued)).body, { ...first.body, duplicate: true });
  assert.equal((await f.batch(resign({ aud: LEGACY_TOKEN_AUDIENCE }), queued)).status, 401, 'mixed issuer and audience are not valid aliases');
  const current = (await f.send(request(account, 'status', 1))).body;
  assert.equal(current.purposeVersion, DEFAULT_PURPOSE_VERSION); assert.equal(current.noticeVersion, DEFAULT_NOTICE_VERSION);
  assert.equal(current.participantKey, active.body.participantKey); assert.equal(current.session.grantId, active.body.session.grantId);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM analytics_accounts').get().n, 1);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM analytics_participants').get().n, 1);
  assert.equal((await f.send(request(account, 'withdraw', 1))).body.status, 'revoked');
  assert.equal((await f.batch(oldToken, queued)).status, 403);
  assert.equal((await f.batch(current.session.token, queued)).status, 403);
  assert.equal((await f.send(JSON.parse(originalBytes), { route: LEGACY_BRIDGE_ROUTE })).body.error, 'OPERATION_SUPERSEDED');
});

test('renaming the notice never clears the recovery authorization block', async t => {
  const f = await fixture(t);
  f.app.store.db.prepare("UPDATE collector_settings SET value='closed' WHERE key='restore_gate'").run();
  f.app.store.recoveryComplete();
  f.app.store.db.prepare("UPDATE collector_settings SET value=? WHERE key='recovery_blocked_notice'").run(LEGACY_NOTICE_VERSION);
  const account = subject();
  assert.equal((await f.send(request(account, 'activate'))).body.error, 'RECOVERY_RECONSENT_NOTICE_REQUIRED');
  assert.equal((await f.send(request(account, 'activate', 0, { purposeVersion: LEGACY_PURPOSE_VERSION,
    noticeVersion: LEGACY_NOTICE_VERSION }), { route: LEGACY_BRIDGE_ROUTE })).body.error, 'RECOVERY_RECONSENT_NOTICE_REQUIRED');
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM analytics_accounts').get().n, 0);
});

test('bridge key file is opt-in and hex-decoded without accepting malformed files', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-key-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'bridge.key'); const key = randomBytes(32);
  assert.equal(loadBridgeKey(), null); writeFileSync(path, key.toString('hex') + '\n'); assert.deepEqual(loadBridgeKey(path), key);
  writeFileSync(path, 'g'.repeat(64)); assert.throws(() => loadBridgeKey(path), /Invalid analytics bridge key file/);
  writeFileSync(path, key.toString('hex')); symlinkSync(path, join(dir, 'link'));
  assert.throws(() => loadBridgeKey(join(dir, 'link')), /Invalid analytics bridge key file/);
});

test('unknown status is read-only; trusted activation produces a random real participant and valid session', async t => {
  const f = await fixture(t); const account = subject(); const status = await f.send(request(account));
  assert.deepEqual(status.body, { ok: true, status: 'none', statusVersion: 0, purposeVersion: 'ride-analytics-v1', noticeVersion: DEFAULT_NOTICE_VERSION });
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM analytics_participants').get().n, 0);
  const activation = await f.send(request(account, 'activate'));
  assert.equal(activation.status, 200); assert.equal(activation.body.statusVersion, 1);
  assert.equal(activation.body.participantKey, activation.body.session.participantKey);
  assert.notEqual(activation.body.participantKey, account);
  assert.equal(f.app.store.db.prepare('SELECT synthetic FROM analytics_participants').get().synthetic, 0);
  assert.equal((await f.batch(activation.body.session.token)).status, 200);
  assert.deepEqual(Object.keys(readSafeMetrics(f.app.store.db)).sort(), ['realActiveParticipants','realEligibleBatches','realEligibleEvents','realEventsByName','realLatestReceivedAt','realRevokedParticipants','syntheticParticipants',
    'syntheticActiveParticipants','syntheticRevokedParticipants','syntheticEligibleBatches','syntheticEligibleEvents','syntheticEventsByName','syntheticLatestReceivedAt'].sort());
  assert.deepEqual(readSafeMetrics(f.app.store.db).realEventsByName, [{ eventName: 'page_view', count: 1 }]);
});

test('signed test namespace is isolated from real activation, metrics, analysis and withdrawal', async t => {
  const f = await fixture(t); const realAccount = subject(); const testAccount = subject();
  const real = (await f.send(request(realAccount, 'activate'))).body;
  const unknown = await f.send(request(testAccount, 'status', 0, { synthetic: true }));
  assert.equal(unknown.body.synthetic, true); assert.equal(unknown.body.status, 'none');
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM analytics_accounts').get().n, 1);
  const activation = request(testAccount, 'activate', 0, { synthetic: true });
  const testState = (await f.send(activation)).body;
  assert.equal(testState.synthetic, true); assert.notEqual(testState.participantKey, real.participantKey);
  assert.equal((await f.send(activation)).body.session.grantId, testState.session.grantId);
  assert.equal((await f.batch(real.session.token)).status, 200);
  assert.equal((await f.batch(testState.session.token)).status, 200);
  const counts = readSafeMetrics(f.app.store.db);
  assert.equal(counts.realEligibleEvents, 1); assert.equal(counts.syntheticEligibleEvents, 1);
  assert.equal(counts.realEligibleBatches, 1); assert.equal(counts.syntheticEligibleBatches, 1);
  assert.deepEqual(counts.syntheticEventsByName, [{ eventName: 'page_view', count: 1 }]);
  assert.equal(typeof counts.syntheticLatestReceivedAt, 'number');
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM eligible_events').get().n, 2);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM eligible_real_events').get().n, 1);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM eligible_real_batches').get().n, 1);
  for (const action of ['status', 'activate', 'withdraw']) {
    assert.equal((await f.send(request(testAccount, action, 1))).body.error, 'PARTICIPANT_KIND_IMMUTABLE');
    assert.equal((await f.send(request(realAccount, action, 1, { synthetic: true }))).body.error, 'PARTICIPANT_KIND_IMMUTABLE');
  }
  assert.equal((await f.send(request(testAccount, 'withdraw', 1, { synthetic: true }))).body.status, 'revoked');
  assert.equal((await f.batch(testState.session.token)).status, 403);
  assert.equal((await f.batch(real.session.token)).status, 200);
  assert.equal(readSafeMetrics(f.app.store.db).syntheticEligibleEvents, 0);
  assert.equal(readSafeMetrics(f.app.store.db).syntheticRevokedParticipants, 1);
  // A historical real helper still uses the original body and can withdraw real state.
  assert.equal((await f.send(request(realAccount, 'withdraw', 1))).body.status, 'revoked');
});

test('test activation can run while real collection is disabled but never bypasses restore quarantine', async t => {
  const f = await fixture(t, { realEnabled: false }); const account = subject();
  assert.equal((await f.send(request(subject(), 'activate'))).body.error, 'COLLECTION_DISABLED');
  const active = (await f.send(request(account, 'activate', 0, { synthetic: true }))).body;
  assert.equal(active.synthetic, true); assert.equal((await f.batch(active.session.token)).status, 200);
  await f.restart();
  assert.equal((await f.send(request(account, 'status', 0, { synthetic: true }))).body.participantKey, active.participantKey);
  f.app.store.db.prepare("UPDATE collector_settings SET value='closed' WHERE key='restore_gate'").run();
  assert.equal((await f.send(request(account, 'status', 0, { synthetic: true }))).body.session, undefined);
  assert.equal((await f.send(request(subject(), 'activate', 0, { synthetic: true }))).body.error, 'RESTORE_QUARANTINE');
  assert.equal((await f.batch(active.session.token)).body.error, 'RESTORE_QUARANTINE');
  assert.equal(readSafeMetrics(f.app.store.db).syntheticEligibleEvents, 0);
  assert.equal(f.app.store.recoveryComplete().freshNoticeRequired, true);
  // The recovery notice block protects real grants; a test namespace has no real analytics eligibility.
  assert.equal((await f.send(request(subject(), 'activate', 0, { synthetic: true }))).status, 200);
  assert.equal((await f.send(request(account, 'withdraw', 1, { synthetic: true }))).body.status, 'revoked');
});

test('only signed boolean true selects synthetic; ambiguous flags and body tampering fail closed', async t => {
  const f = await fixture(t); const r = request(subject());
  for (const synthetic of [false, 1, 'true', null]) assert.equal((await f.send({ ...r, synthetic })).status, 422);
  assert.equal((await f.send({ ...r, collectionMode: 'test' })).status, 422);
  const timestamp = String(Date.now()); const nonce = randomBytes(16).toString('hex');
  const originalSignature = createHmac('sha256', f.config.bridgeKey).update(`${timestamp}\n${nonce}\n${JSON.stringify(r)}`).digest('hex');
  assert.equal((await f.send({ ...r, synthetic: true }, { timestamp, nonce, headers: { 'x-linkx-signature': originalSignature } })).status, 401);
});

test('HMAC exact bytes/time/nonce and strict schema fail closed; replay survives restart', async t => {
  const f = await fixture(t); const r = request(subject());
  for (const options of [ { signingKey: randomBytes(32) }, { timestamp: Date.now() - 301000 },
    { timestamp: Date.now() + 301000 }, { headers: { 'x-linkx-nonce': 'invalid' } },
    { headers: { 'x-linkx-signature': 'a'.repeat(64) } } ]) assert.equal((await f.send(r, options)).status, 401);
  assert.equal((await f.send({ ...r, openid: 'private' })).status, 422);
  assert.equal((await f.send({ ...r, action: 'consent' })).status, 422);
  assert.equal((await f.send({ ...r, noticeVersion: 'ride-analytics-notice-2026-09-24' })).body.error, 'NOTICE_VERSION_MISMATCH');
  assert.equal((await f.send(JSON.stringify(r) + ' ')).status, 400);
  assert.equal((await f.send('x'.repeat(8193))).status, 413);
  assert.equal((await f.send(r, { route: BRIDGE_ROUTE + '?x=1' })).status, 404);
  const nonce = randomBytes(16).toString('hex');
  assert.equal((await f.send(r, { nonce })).status, 200);
  await f.restart(); assert.equal((await f.send(r, { nonce })).body.error, 'BRIDGE_REPLAY');
  f.app.store.consumeBridgeNonce('a'.repeat(32), 100, 50);
  f.app.store.consumeBridgeNonce('b'.repeat(32), 200, 101);
  assert.equal(f.app.store.db.prepare('SELECT 1 FROM bridge_nonces WHERE nonce=?').get('a'.repeat(32)), undefined);
});

test('trusted signed OpenID is bound once without adding it to tokens or accepting an identity rebind', async t => {
  const f = await fixture(t); const account = subject(); const openid = 'signed_operational_openid_123';
  const original = request(account, 'activate');
  const active = await f.send({ ...original, openid });
  assert.equal(active.status, 200);
  assert.equal(f.app.store.db.prepare('SELECT openid FROM analytics_accounts WHERE account_subject=?').get(account).openid, openid);
  assert.equal(JSON.stringify(active.body).includes(openid), false);
  assert.equal(Buffer.from(active.body.session.token.split('.')[1], 'base64url').toString().includes(openid), false);
  assert.equal((await f.send(original)).body.session.grantId, active.body.session.grantId);
  const conflict = await f.send(request(account, 'status', 0, { openid: 'different_operational_openid_456' }));
  assert.equal(conflict.status, 409); assert.equal(conflict.body.error, 'ACCOUNT_IDENTITY_CONFLICT');
  assert.equal((await f.send(request(account, 'withdraw', 1))).body.status, 'revoked');
});

test('operation retries are idempotent but neither old activation nor old withdrawal can affect a later grant', async t => {
  const f = await fixture(t); const account = subject(); const activation = request(account, 'activate');
  const first = (await f.send(activation)).body; const retry = (await f.send(activation)).body;
  assert.equal(retry.session.grantId, first.session.grantId);
  assert.equal((await f.send({ ...activation, expectedStatusVersion: 1 })).body.error, 'OPERATION_CONFLICT');
  const withdrawal = request(account, 'withdraw', 1);
  const withdrawn = await f.send(withdrawal); assert.equal(withdrawn.body.status, 'revoked'); assert.equal(withdrawn.body.statusVersion, 2);
  assert.equal(withdrawn.body.participantKey, first.participantKey);
  assert.equal((await f.send(activation)).body.error, 'OPERATION_SUPERSEDED');
  assert.equal((await f.batch(first.session.token)).status, 403);
  assert.equal(readSafeMetrics(f.app.store.db).realEligibleEvents, 0);
  const next = (await f.send(request(account, 'activate', 2))).body;
  assert.equal(next.statusVersion, 3); assert.notEqual(next.session.grantId, first.session.grantId);
  assert.equal((await f.send(withdrawal)).body.error, 'OPERATION_SUPERSEDED');
  assert.equal((await f.send(request(account, 'withdraw', 1))).body.error, 'STATE_CONFLICT');
  assert.equal((await f.batch(next.session.token)).status, 200);
});

test('racing activation CAS changes state once; withdrawal before any activation records a tombstone', async t => {
  const f = await fixture(t); const account = subject();
  const replies = await Promise.all([f.send(request(account, 'activate')), f.send(request(account, 'activate'))]);
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 409]);
  const other = subject(); const withdrawn = await f.send(request(other, 'withdraw'));
  assert.equal(withdrawn.body.status, 'revoked'); assert.equal(withdrawn.body.statusVersion, 1);
  assert.equal((await f.send(request(other, 'activate'))).body.error, 'STATE_CONFLICT');
  assert.equal((await f.send(request(other, 'activate', 1))).status, 200);
});

test('paused collection returns active identity/version without token and still permits withdrawal', async t => {
  const f = await fixture(t); const account = subject(); const active = (await f.send(request(account, 'activate'))).body;
  await f.restart({ realEnabled: false });
  const status = (await f.send(request(account))).body;
  assert.equal(status.status, 'active'); assert.equal(status.participantKey, active.participantKey); assert.equal(status.session, undefined);
  assert.equal((await f.send(request(subject(), 'activate'))).body.error, 'COLLECTION_DISABLED');
  assert.equal((await f.send(request(account, 'withdraw', 1))).body.status, 'revoked');
  await f.restart({ bridgeKey: null });
  assert.equal((await f.send(request(account))).body.error, 'BRIDGE_DISABLED');
});

test('real recovery deletes payload, revokes every prior real grant, and requires a newly deployed notice', async t => {
  const f = await fixture(t); const account = subject(); const active = (await f.send(request(account, 'activate'))).body;
  await f.batch(active.session.token);
  f.app.store.db.prepare("UPDATE collector_settings SET value='closed' WHERE key='restore_gate'").run();
  assert.equal((await f.send(request(account))).body.session, undefined);
  const result = f.app.store.recoveryComplete(); assert.equal(result.realGrantsRevoked, 1); assert.equal(result.freshNoticeRequired, true);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM ingest_batches').get().n, 0);
  assert.equal((await f.batch(active.session.token)).status, 403);
  assert.equal((await f.send(request(account, 'activate', 2))).body.error, 'RECOVERY_RECONSENT_NOTICE_REQUIRED');
  const noticeVersion = 'ride-analytics-notice-2026-09-24'; await f.restart({ noticeVersion });
  const fresh = await f.send(request(account, 'activate', 2, { noticeVersion })); assert.equal(fresh.status, 200);
  assert.equal(fresh.body.statusVersion, 3); assert.notEqual(fresh.body.session.grantId, active.session.grantId);
});

test('restoring an empty pre-activation backup also blocks an old expected-zero activation absent from its history', async t => {
  const f = await fixture(t); const old = request(subject(), 'activate');
  // This empty database represents a backup predating enrollment and withdrawal.
  // Thus no account, operation receipt or nonce exists to detect their later replay.
  f.app.store.db.prepare("UPDATE collector_settings SET value='closed' WHERE key='restore_gate'").run();
  assert.equal(f.app.store.recoveryComplete().freshNoticeRequired, true);
  assert.equal((await f.send(old)).body.error, 'RECOVERY_RECONSENT_NOTICE_REQUIRED');
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM analytics_participants').get().n, 0);
  await f.restart({ noticeVersion: 'ride-analytics-notice-2026-09-24' });
  assert.equal((await f.send(old)).body.error, 'NOTICE_VERSION_MISMATCH');
});

test('expired real payloads are excluded before scheduled prune and physically removed by maintenance', t => {
  const dir = mkdtempSync(join(tmpdir(), 'real-retention-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = openStore(join(dir, 'db.sqlite'), { realEnabled: true });
  try {
    const p = store.updateAccount(request(subject(), 'activate')).participant;
    const b = { schemaVersion: 1, batchId: randomUUID(), events: [{ eventId: randomUUID(), eventName: 'page_view', schemaVersion: 1, occurredAt: Date.now(), data: { page: 'home' } }] };
    store.receive({ sub: p.participantKey, ...p }, Buffer.from(JSON.stringify(b)), b);
    store.db.prepare('UPDATE ingest_batches SET received_at=?').run(Date.now() - 181 * 86400000);
    assert.equal(readSafeMetrics(store.db).realEligibleEvents, 0);
    assert.equal(store.prune().payloads, 1);
  } finally { store.close(); }
});

test('backup rotation removes only managed regular snapshots aged seven days and leaves fresh/unmanaged files', t => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-rotation-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = Date.now(); const name = at => `collector-${new Date(at).toISOString().replaceAll(':','-')}.sqlite`;
  writeFileSync(join(dir, name(now - 7 * 86400000)), 'old'); writeFileSync(join(dir, name(now - 6 * 86400000)), 'fresh');
  writeFileSync(join(dir, 'operator-evidence.sqlite'), 'unmanaged');
  symlinkSync(join(dir, 'operator-evidence.sqlite'), join(dir, name(now - 8 * 86400000)));
  assert.equal(rotateBackups(dir, now).removed, 1); assert.equal(readdirSync(dir).length, 3);
});
