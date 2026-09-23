import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, randomBytes, generateKeyPairSync, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createCollector } from '../src/server.mjs';
import { openStore } from '../src/store.mjs';
import { createTokenService } from '../src/auth.mjs';

function state(extra = {}) { return { participantKey: randomUUID(), grantId: randomUUID(), status: 'active', statusVersion: 1, purposeVersion: 'ride-research-v1', synthetic: true, ...extra }; }
function batch(extra = {}) { return { schemaVersion: 1, batchId: randomUUID(), events: [{ eventId: randomUUID(), eventName: 'page_view', schemaVersion: 1, occurredAt: Date.now(), data: { page: 'home' } }], ...extra }; }

async function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rc-'));
  const config = { dbPath: join(dir, 'store.sqlite'), host: '127.0.0.1', port: 0,
    adminSocket: join(dir, 'run', 'admin.sock'), adminToken: randomBytes(32).toString('base64url'),
    privatePem: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
    minFreeBytes: 0, realEnabled: false, purposeVersion: 'ride-research-v1', ...overrides };
  let app = createCollector(config); let address = await app.start();
  const admin = (path, body, secret = config.adminToken) => new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({ socketPath: config.adminSocket, path, method: 'POST', headers: {
      Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw),
    } }, res => { let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) })); });
    req.on('error', reject); req.end(raw);
  });
  const send = async (body, token, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/batches`, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers,
    }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const enroll = async (p = state()) => {
    assert.equal((await admin('/v1/participants/state', p)).status, 200);
    const token = await admin('/v1/tokens', { participantKey: p.participantKey });
    assert.equal(token.status, 200); return { state: p, token: token.body.token };
  };
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  return { config, dir, admin, send, enroll, get app() { return app; }, get base() { return `http://127.0.0.1:${address.port}`; },
    async restart() { await app.close(); app = createCollector(config); address = await app.start(); } };
}

test('public surface, unknown identities, default-off and strict admin authentication', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.base}/healthz`)).status, 200);
  assert.equal((await fetch(`${f.base}/v1/status`)).status, 404);
  assert.equal((await fetch(`${f.base}/v1/tokens`, { method: 'POST' })).status, 404);
  assert.equal((await f.admin('/v1/tokens', { participantKey: randomUUID() })).status, 403);
  assert.equal((await f.admin('/v1/participants/state', state(), 'wrong')).status, 401);
  assert.equal((await f.admin('/v1/participants/state', state({ synthetic: false }))).status, 503);
  assert.equal((await f.send(batch(), 'unsigned')).status, 401);
  assert.equal(statSync(f.config.adminSocket).mode & 0o777, 0o600);
});

test('stable byte hash ACK, conflicting retry and cross-batch event deduplication', async t => {
  const f = await fixture(t); const enrolled = await f.enroll(); const b = batch(); const raw = JSON.stringify(b);
  const first = await f.send(raw, enrolled.token);
  assert.equal(first.status, 200); assert.equal(first.body.duplicate, false);
  assert.equal(first.body.payloadHash, createHash('sha256').update(raw).digest('hex'));
  const retry = await f.send(raw, enrolled.token);
  assert.deepEqual(retry.body, { ...first.body, duplicate: true });
  const conflict = structuredClone(b); conflict.events[0].data.page = 'profile';
  assert.equal((await f.send(conflict, enrolled.token)).body.error, 'BATCH_CONFLICT');
  const duplicateEvent = { ...b, batchId: randomUUID() };
  assert.equal((await f.send(duplicateEvent, enrolled.token)).status, 200);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM eligible_events').get().n, 1);
  const badEvent = { ...conflict, batchId: randomUUID(), events: [batch().events[0], conflict.events[0]] };
  assert.equal((await f.send(badEvent, enrolled.token)).body.error, 'EVENT_CONFLICT');
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM event_receipts').get().n, 1, 'failed whole batch rolls back preliminary event receipts');
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM batch_receipts').get().n, 2);
});

test('signature, issuer, audience, expiry, purpose and state version are enforced', async t => {
  const f = await fixture(t); const { state: p } = await f.enroll();
  const invalid = [
    createTokenService(f.config.privatePem, { issuer: 'other-service' }).issue(p).token,
    createTokenService(f.config.privatePem, { audience: 'other-audience' }).issue(p).token,
    createTokenService(f.config.privatePem, { keyId: 'other-key' }).issue(p).token,
    createTokenService(f.config.privatePem).issue(p, Date.now() - 901_000).token,
    createTokenService(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })).issue(p).token,
  ];
  for (const token of invalid) assert.equal((await f.send(batch(), token)).status, 401);
  assert.equal((await f.send(batch(), f.app.tokens.issue({ ...p, purposeVersion: 'ride-research-v2' }).token)).body.error, 'STALE_GRANT');
  assert.equal((await f.send(batch(), f.app.tokens.issue({ ...p, statusVersion: 2 }).token)).body.error, 'STALE_GRANT');
});

test('database full returns no successful ACK or partial receipt/event state', async t => {
  const f = await fixture(t); const { token } = await f.enroll();
  const pageCount = f.app.store.db.pragma('page_count', { simple: true });
  f.app.store.db.pragma(`max_page_count = ${pageCount}`);
  const b = batch({ events: Array.from({ length: 50 }, () => batch().events[0]) });
  const reply = await f.send(b, token);
  assert.equal(reply.status, 503);
  assert.equal(reply.body.error, 'STORAGE_UNAVAILABLE');
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM batch_receipts').get().n, 0);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM event_receipts').get().n, 0);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM ingest_batches').get().n, 0);
});

test('monotone participation state, withdrawal, old token and new grant isolation', async t => {
  const f = await fixture(t); const { state: p, token } = await f.enroll(); const b = batch();
  assert.equal((await f.send(b, token)).status, 200);
  const reordered = { synthetic: true, purposeVersion: p.purposeVersion, statusVersion: 1, status: 'active', grantId: p.grantId, participantKey: p.participantKey };
  assert.equal((await f.admin('/v1/participants/state', reordered)).body.duplicate, true);
  assert.equal((await f.admin('/v1/participants/state', { ...p, status: 'revoked', statusVersion: 2 })).status, 200);
  assert.equal((await f.send(b, token)).body.error, 'PARTICIPATION_INACTIVE');
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM ingest_batches').get().n, 0);
  assert.equal((await f.admin('/v1/participants/state', p)).body.error, 'STALE_STATE');
  assert.equal((await f.admin('/v1/participants/state', { ...p, statusVersion: 3 })).body.error, 'GRANT_REVOKED');
  const newP = { ...p, grantId: randomUUID(), statusVersion: 3 };
  assert.equal((await f.admin('/v1/participants/state', newP)).status, 200);
  assert.equal((await f.send(batch(), token)).body.error, 'STALE_GRANT');
  const fresh = (await f.admin('/v1/tokens', { participantKey: p.participantKey })).body.token;
  assert.equal((await f.send(b, fresh)).body.error, 'BATCH_CONFLICT');
  assert.equal((await f.send({ ...b, batchId: randomUUID() }, fresh)).body.error, 'EVENT_CONFLICT');
});

test('restart preserves ACK and withdrawal state on disk', async t => {
  const f = await fixture(t); const { state: p, token } = await f.enroll(); const b = batch();
  const first = await f.send(b, token); await f.restart();
  assert.deepEqual((await f.send(b, token)).body, { ...first.body, duplicate: true });
  await f.admin('/v1/participants/state', { ...p, status: 'revoked', statusVersion: 2 });
  await f.restart();
  assert.equal((await f.send(b, token)).status, 403);
  assert.equal(f.app.store.db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(f.app.store.db.pragma('synchronous', { simple: true }), 2);
});

test('JSON/schema allowlist rejects sensitive, unknown, huge and ambiguous inputs', async t => {
  const f = await fixture(t); const { token } = await f.enroll();
  const cases = [
    b => { b.events[0].data.phone = '5551234567'; },
    b => { b.events[0].data.latitude = 40.5; },
    b => { b.events[0].eventName = 'booking_succeeded'; },
    b => { b.schemaVersion = 2; },
    b => { b.actorKey = randomUUID(); },
    b => { b.events[0].occurredAt = Date.now() - 8 * 86_400_000; },
    b => { b.events[0].occurredAt = Date.now() + 6 * 60_000; },
    b => { b.events = Array.from({ length: 51 }, () => batch().events[0]); },
  ];
  for (const mutate of cases) { const b = batch(); mutate(b); assert.equal((await f.send(b, token)).status, 422); }
  assert.equal((await f.send(JSON.stringify(batch()) + ' ', token)).body.error, 'NON_CANONICAL_JSON');
  const duplicateKeys = JSON.stringify(batch()).replace('"data":{"page":"home"}', '"data":{"phone":"secret"},"data":{"page":"home"}');
  assert.equal((await f.send(duplicateKeys, token)).body.error, 'NON_CANONICAL_JSON');
  assert.equal((await f.send('x'.repeat(65_537), token)).status, 413);
  assert.equal((await f.send(batch(), token, { 'Content-Encoding': 'gzip' })).status, 415);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM ingest_batches').get().n, 0);
});

test('candidate completeness is explicit and enforced', async t => {
  const f = await fixture(t); const { token } = await f.enroll(); const b = batch();
  b.events[0].eventName = 'result_set_rendered';
  b.events[0].data = { searchId: randomUUID(), selectionSetId: randomUUID(), source: 'cache', renderedCount: 2,
    loadedDateCount: 1, hasMore: true, candidatesComplete: true, candidates: [] };
  assert.equal((await f.send(b, token)).status, 422);
  b.events[0].data.candidatesComplete = false;
  assert.equal((await f.send(b, token)).status, 200);
});

test('concurrent withdrawal leaves no eligible payload and blocks later writes', async t => {
  const f = await fixture(t); const { state: p, token } = await f.enroll();
  const results = await Promise.all([
    ...Array.from({ length: 12 }, () => f.send(batch(), token)),
    f.admin('/v1/participants/state', { ...p, status: 'revoked', statusVersion: 2 }),
  ]);
  assert.ok(results.every(r => [200, 403].includes(r.status)));
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM eligible_events').get().n, 0);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM ingest_batches').get().n, 0);
  assert.equal((await f.send(batch(), token)).status, 403);
});

test('online backup and published restore candidate are consistent and quarantined', async t => {
  const f = await fixture(t); const { state: p, token } = await f.enroll(); const b = batch();
  await f.send(b, token);
  const backup = join(f.dir, 'backup.sqlite'); const candidate = join(f.dir, 'candidate.sqlite');
  const backupRun = spawnSync(process.execPath, ['scripts/backup.mjs', backup], { cwd: resolve('.'), env: { ...process.env, DB_PATH: f.config.dbPath }, encoding: 'utf8' });
  assert.equal(backupRun.status, 0, backupRun.stderr);
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  const restoredRun = spawnSync(process.execPath, ['scripts/restore-check.mjs', backup, candidate], { cwd: resolve('.'), encoding: 'utf8' });
  assert.equal(restoredRun.status, 0, restoredRun.stderr);
  const restored = openStore(candidate);
  try {
    assert.throws(() => restored.activeParticipant(p.participantKey), /RESTORE_QUARANTINE/);
    assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM eligible_events').get().n, 0);
    restored.applyState({ ...p, status: 'revoked', statusVersion: 2 });
    restored.recoveryComplete();
    assert.throws(() => restored.activeParticipant(p.participantKey), /PARTICIPATION_INACTIVE/);
    assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM ingest_batches').get().n, 0);
  } finally { restored.close(); }
});

test('committed batch survives process SIGKILL and WAL recovery', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-crash-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'crash.sqlite'); const p = state(); const b = batch();
  const input = join(dir, 'fixture.json'); writeFileSync(input, JSON.stringify({ dbPath, p, b }));
  const program = `import {readFileSync} from 'node:fs';import {openStore} from './src/store.mjs';const {dbPath,p,b}=JSON.parse(readFileSync(process.argv[1]));const s=openStore(dbPath);s.applyState(p);s.receive({sub:p.participantKey,...p},Buffer.from(JSON.stringify(b)),b);process.kill(process.pid,'SIGKILL');`;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', program, input], { cwd: resolve('.'), encoding: 'utf8' });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const reopened = openStore(dbPath);
  try {
    assert.equal(reopened.db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(reopened.receive({ sub: p.participantKey, ...p }, Buffer.from(JSON.stringify(b)), b).duplicate, true);
  } finally { reopened.close(); }
});

test('prune keeps distinct synthetic14/30-day and real180/187-day retention', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-retain-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = openStore(join(dir, 'retain.sqlite'), { realEnabled: true });
  try {
    for (const synthetic of [true, false]) {
      let p = state({ synthetic }); const b = batch();
      if (synthetic) s.applyState(p);
      else p = s.participate({ accountSubject: randomBytes(32).toString('hex'), action: 'activate', requestId: randomUUID(), expectedStatusVersion: 0, purposeVersion: 'ride-research-v1', noticeVersion: 'ride-research-notice-2026-09-23' }).participant;
      s.receive({ sub: p.participantKey, ...p }, Buffer.from(JSON.stringify(b)), b);
    }
    assert.equal(s.prune(Date.now() + 15 * 86_400_000).payloads, 1);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM ingest_batches').get().n, 1);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM batch_receipts').get().n, 2);
    s.prune(Date.now() + 31 * 86_400_000);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM batch_receipts').get().n, 1);
    s.prune(Date.now() + 181 * 86_400_000);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM ingest_batches').get().n, 0);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM batch_receipts').get().n, 1);
    s.prune(Date.now() + 188 * 86_400_000);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM batch_receipts').get().n, 0);
  } finally { s.close(); }
});
