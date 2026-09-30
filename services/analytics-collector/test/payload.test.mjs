import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePayload, decodePayload, MAX_PAYLOAD_BYTES } from '../src/payload.mjs';
import { openDatabase } from '../src/database.mjs';
import { openStore } from '../src/store.mjs';
import { readSafeMetrics } from '../src/metrics.mjs';
import { readAccountDiagnostics } from '../src/diagnostics.mjs';
import { compressPayloads } from '../scripts/compress-payloads.mjs';
import { SCHEMA_VERSION } from '../src/schema.mjs';
import { MAX_BYTES } from '../src/validation.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const now = Date.now(), openid = 'payload_fixture_account_01';
const purposeVersion = 'ride-analytics-v1', noticeVersion = 'ride-analytics-notice-2026-09-23';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'payload-store-')), path = join(dir, 'db.sqlite');
  let store = openStore(path, { realEnabled: true });
  t.after(() => { if (store.db.open) store.close(); rmSync(dir, { recursive: true, force: true }); });
  const account = store.updateAccount({ accountSubject: randomBytes(32).toString('hex'), action: 'activate',
    requestId: randomUUID(), expectedStatusVersion: 0, purposeVersion, noticeVersion, synthetic: false, openid });
  const claims = { ...account.participant, sub: account.participantKey };
  const body = (events = 12) => ({ schemaVersion: 1, batchId: randomUUID(), events: Array.from({ length: events }, () => ({
    eventId: randomUUID(), eventName: 'page_view', schemaVersion: 1, occurredAt: now, data: { page: 'home' },
  })) });
  return { store, path, claims, body, reopen() { store.close(); store = openStore(path, { realEnabled: true }); return store; } };
}
function countDecodes(db) {
  let count = 0;
  db.function('payload_json', { deterministic: true }, (payload, codec, rawBytes) => {
    count++; return decodePayload(payload, codec, rawBytes).toString('utf8');
  });
  return { get count() { return count; }, reset() { count = 0; } };
}

test('payload codec is byte-lossless, bounded, and only compresses when smaller', () => {
  assert.equal(MAX_PAYLOAD_BYTES, MAX_BYTES);
  for (const raw of [Buffer.from('{ "中文": "same bytes", "x": [1,2] }\n'), randomBytes(256), Buffer.alloc(MAX_PAYLOAD_BYTES, 120)]) {
    const encoded = encodePayload(raw);
    assert.deepEqual(decodePayload(encoded.payload, encoded.codec, encoded.rawBytes), raw);
    assert.equal(encoded.rawBytes, raw.length); assert.ok(encoded.payload.length <= raw.length);
    if (encoded.codec === 'gzip') assert.ok(encoded.payload.length < raw.length);
  }
  const tiny = Buffer.from('{}'); assert.equal(encodePayload(tiny).codec, 'json');
  assert.deepEqual(decodePayload(tiny, 'json', null), tiny, 'unannotated historical JSON is readable');
  for (const invalid of [Buffer.alloc(0), Buffer.alloc(MAX_PAYLOAD_BYTES + 1), '{}', null]) assert.throws(() => encodePayload(invalid), /Invalid stored payload/);
});

test('decoder rejects corruption, truncation, oversized inflation and inconsistent size before returning bytes', () => {
  const raw = Buffer.alloc(1000, 97), zipped = gzipSync(raw), badCrc = Buffer.from(zipped); badCrc[badCrc.length - 8] ^= 255;
  for (const [payload, codec, rawBytes] of [
    [Buffer.from('not gzip'), 'gzip', 1000], [zipped.subarray(0, -1), 'gzip', 1000], [badCrc, 'gzip', 1000],
    [gzipSync(Buffer.alloc(MAX_PAYLOAD_BYTES + 1)), 'gzip', MAX_PAYLOAD_BYTES],
    [gzipSync(Buffer.alloc(2 * 1024 * 1024)), 'gzip', 10], [zipped, 'gzip', 999],
    [zipped, 'gzip', null], [zipped, 'brotli', 1000], [raw, 'json', 999], [raw, 'json', 0],
    [raw, 'json', MAX_PAYLOAD_BYTES + 1], [Buffer.alloc(MAX_PAYLOAD_BYTES + 1), 'json', null],
  ]) assert.throws(() => decodePayload(payload, codec, rawBytes), /Invalid stored payload/);
  const db = openDatabase(':memory:');
  try { assert.throws(() => db.prepare("SELECT payload_json(?,'json',?)").get(Buffer.from([255]), 1), /Invalid stored payload/); }
  finally { db.close(); }
});

test('new compressed writes preserve raw batch ACK, event identity, duplicate delivery, views and restart', t => {
  const f = fixture(t), body = f.body(), raw = Buffer.from(JSON.stringify(body, null, 2) + '\n');
  const first = f.store.receive(f.claims, raw, body, now);
  assert.equal(first.payloadHash, hash(raw));
  const row = f.store.db.prepare('SELECT payload,codec,raw_bytes FROM ingest_batches').get();
  assert.equal(row.codec, 'gzip'); assert.equal(row.raw_bytes, raw.length); assert.ok(row.payload.length < raw.length);
  assert.deepEqual(decodePayload(row.payload, row.codec, row.raw_bytes), raw);
  assert.equal(f.store.db.prepare('SELECT payload FROM eligible_batches').get().payload, raw.toString());
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM eligible_real_events').get().n, body.events.length);
  const receipts = f.store.db.prepare('SELECT * FROM event_receipts ORDER BY event_id').all();
  assert.deepEqual(f.store.receive(f.claims, raw, body, now + 1), { ...first, duplicate: true });
  const retryBody = { ...body, batchId: randomUUID() }, retryRaw = Buffer.from(JSON.stringify(retryBody));
  f.store.receive(f.claims, retryRaw, retryBody, now + 2);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM event_receipts ORDER BY event_id').all(), receipts);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM eligible_real_events').get().n, body.events.length);
  const reopened = f.reopen();
  assert.equal(reopened.db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.deepEqual(reopened.receive(f.claims, raw, body, now + 3), { ...first, duplicate: true });
});

test('metrics inflate each eligible batch once; diagnostics inflate each chosen batch once', t => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) { const body = f.body(20); f.store.receive(f.claims, Buffer.from(JSON.stringify(body)), body, now + i); }
  const decoder = countDecodes(f.store.db), metrics = readSafeMetrics(f.store.db);
  assert.equal(metrics.realEligibleEvents, 60); assert.equal(metrics.realEligibleBatches, 3);
  assert.deepEqual(metrics.realEventsByName, [{ eventName: 'page_view', count: 60 }]);
  assert.equal(decoder.count, 3, 'metric totals and groups share one JSON expansion per batch');
  decoder.reset();
  const diagnostics = readAccountDiagnostics(f.store.db, { openid, synthetic: false, from: now - 1, to: now + 10, limit: 100 }, now + 10);
  assert.equal(diagnostics.events.length, 60); assert.equal(decoder.count, 3);
  decoder.reset();
  f.store.db.prepare("UPDATE collector_settings SET value='closed' WHERE key='restore_gate'").run();
  assert.equal(readSafeMetrics(f.store.db).realEligibleEvents, 0); assert.equal(decoder.count, 0, 'quarantined bytes are not decoded');
});

test('compressed followups retain explicit priority and withdrawals remove payload access', t => {
  const f = fixture(t), body = f.body(1), record = { followupId: randomUUID(), tripKey: randomUUID(), tripType: 'carpool', role: 'passenger' };
  body.events = [
    { ...body.events[0], eventName: 'followup_answer', data: { ...record, outcome: 'no', outcomeScope: 'respondent_booking' } },
    { ...body.events[0], eventId: randomUUID(), eventName: 'followup_dismissed', occurredAt: now + 1,
      data: { ...record, dismissalReason: 'close', assumedOutcome: 'yes', outcomeScope: 'respondent_booking' } },
  ];
  f.store.receive(f.claims, Buffer.from(JSON.stringify(body)), body, now + 1);
  assert.deepEqual(f.store.db.prepare('SELECT source,outcome FROM operational_followup_outcomes').all(), [{ source: 'self_report', outcome: 'no' }]);
  f.store.applyState({ participantKey: f.claims.sub, grantId: f.claims.grantId, status: 'revoked',
    statusVersion: 2, purposeVersion, synthetic: false }, now + 2);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM ingest_batches').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM operational_followup_outcomes').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM batch_receipts').get().n, 1);
});

test('offline compression verifies raw receipt hashes, resumes safely and leaves receipts untouched', t => {
  const f = fixture(t), originals = [];
  for (let i = 0; i < 3; i++) {
    const body = f.body(), raw = Buffer.from(JSON.stringify(body, null, 2)); f.store.receive(f.claims, raw, body, now + i);
    f.store.db.prepare("UPDATE ingest_batches SET payload=?,codec='json',raw_bytes=NULL WHERE batch_id=?").run(raw, body.batchId);
    originals.push({ body, raw });
  }
  const receipts = f.store.db.prepare('SELECT * FROM batch_receipts ORDER BY batch_id').all();
  const events = f.store.db.prepare('SELECT * FROM event_receipts ORDER BY event_id').all();
  const dry = compressPayloads(f.store.db); assert.equal(dry.applied, false); assert.equal(dry.rewritten, 3);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM ingest_batches WHERE codec='json' AND raw_bytes IS NULL").get().n, 3);
  const result = compressPayloads(f.store.db, { apply: true, batchSize: 1 });
  assert.equal(result.batches, 3); assert.equal(result.rewritten, 3); assert.ok(result.storedBytesAfter < result.storedBytesBefore);
  assert.equal(compressPayloads(f.store.db, { apply: true }).rewritten, 0);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM batch_receipts ORDER BY batch_id').all(), receipts);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM event_receipts ORDER BY event_id').all(), events);
  for (const { body, raw } of originals) assert.equal(f.store.receive(f.claims, raw, body, now + 10).duplicate, true);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM eligible_real_events').get().n, 36);
});

test('a corrupt compression chunk rolls back all writes in that chunk and refuses forged metadata', t => {
  const f = fixture(t);
  for (let i = 0; i < 2; i++) {
    const body = f.body(), raw = Buffer.from(JSON.stringify(body)); f.store.receive(f.claims, raw, body, now + i);
    f.store.db.prepare("UPDATE ingest_batches SET payload=?,codec='json',raw_bytes=NULL WHERE batch_id=?").run(raw, body.batchId);
  }
  f.store.db.prepare("UPDATE batch_receipts SET payload_hash=? WHERE rowid=(SELECT MAX(rowid) FROM batch_receipts)").run('0'.repeat(64));
  const before = f.store.db.prepare('SELECT rowid,* FROM ingest_batches ORDER BY rowid').all();
  assert.throws(() => compressPayloads(f.store.db, { apply: true, batchSize: 2 }), /Payload receipt hash mismatch/);
  assert.deepEqual(f.store.db.prepare('SELECT rowid,* FROM ingest_batches ORDER BY rowid').all(), before);
  assert.throws(() => f.store.db.prepare("UPDATE ingest_batches SET codec='gzip',raw_bytes=NULL").run(), /CHECK constraint/);
});

test('completed compression chunks remain valid when a later chunk fails; restart verifies and resumes', t => {
  const f = fixture(t), originals = [];
  for (let i = 0; i < 3; i++) {
    const body = f.body(), raw = Buffer.from(JSON.stringify(body)); f.store.receive(f.claims, raw, body, now + i);
    f.store.db.prepare("UPDATE ingest_batches SET payload=?,codec='json',raw_bytes=NULL WHERE batch_id=?").run(raw, body.batchId);
    originals.push({ body, raw });
  }
  f.store.db.prepare('UPDATE batch_receipts SET payload_hash=? WHERE batch_id=?').run('0'.repeat(64), originals[1].body.batchId);
  assert.throws(() => compressPayloads(f.store.db, { apply: true, batchSize: 1 }), /Payload receipt hash mismatch/);
  assert.deepEqual(f.store.db.prepare('SELECT codec FROM ingest_batches ORDER BY rowid').all().map(row => row.codec), ['gzip', 'json', 'json']);
  f.store.db.prepare('UPDATE batch_receipts SET payload_hash=? WHERE batch_id=?').run(hash(originals[1].raw), originals[1].body.batchId);
  assert.equal(compressPayloads(f.store.db, { apply: true, batchSize: 1 }).rewritten, 2);
  for (const { body, raw } of originals) assert.equal(f.store.receive(f.claims, raw, body).duplicate, true);
});

test('corrupt stored gzip fails view reads closed and oversize encoding leaves no partial receipt', t => {
  const f = fixture(t), body = f.body();
  assert.throws(() => f.store.receive(f.claims, Buffer.alloc(MAX_PAYLOAD_BYTES + 1), body), /Invalid stored payload/);
  for (const table of ['batch_receipts', 'event_receipts', 'ingest_batches']) assert.equal(f.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  f.store.receive(f.claims, Buffer.from(JSON.stringify(body)), body);
  f.store.db.prepare('UPDATE ingest_batches SET payload=?').run(Buffer.from('not gzip'));
  assert.throws(() => f.store.db.prepare('SELECT * FROM eligible_real_events').all(), /Invalid stored payload/);
  assert.throws(() => readSafeMetrics(f.store.db), /Invalid stored payload/);
});

test('schema5 upgrade is additive and fail-closed for mixed codec metadata or future versions', t => {
  const dir = mkdtempSync(join(tmpdir(), 'payload-schema5-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = readFileSync(new URL('./fixtures/schema-v4.sql', import.meta.url), 'utf8')
    .replaceAll('research_participants', 'analytics_participants').replaceAll('research_accounts', 'analytics_accounts')
    .replaceAll('participation_operations', 'analytics_operations').replaceAll('place_participation_history', 'place_membership_history')
    .replaceAll('research_account_openid', 'analytics_account_openid').replaceAll('participation_operation_age', 'analytics_operation_age')
    .replaceAll('place_participation_account', 'place_membership_account').replaceAll('place_participation_trip_version', 'place_membership_trip_version')
    .replace('user_version = 4', 'user_version = 5');
  for (const [name, mutation, fails] of [
    ['valid', '', false], ['mixed', "ALTER TABLE ingest_batches ADD COLUMN codec TEXT NOT NULL DEFAULT 'json'", true],
    ['future', `PRAGMA user_version=${SCHEMA_VERSION + 1}`, true], ['mislabelled', `PRAGMA user_version=${SCHEMA_VERSION}`, true],
  ]) {
    const path = join(dir, name + '.sqlite'), db = openDatabase(path); db.exec(legacy); if (mutation) db.exec(mutation);
    const before = db.prepare('SELECT * FROM sqlite_schema ORDER BY rowid').all(); db.close();
    if (fails) {
      assert.throws(() => openStore(path), /Unsupported/);
      const check = openDatabase(path); assert.deepEqual(check.prepare('SELECT * FROM sqlite_schema ORDER BY rowid').all(), before); check.close();
    } else {
      const s = openStore(path); assert.equal(s.db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
      assert.deepEqual(s.db.prepare('PRAGMA table_info(ingest_batches)').all().slice(-2).map(x => x.name), ['codec', 'raw_bytes']); s.close();
    }
  }
});
