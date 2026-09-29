import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openStore } from '../src/store.mjs';
import { STANDARD_PLACES } from '../src/places.mjs';
import { DEFAULT_PURPOSE_VERSION, DEFAULT_NOTICE_VERSION } from '../src/protocol.mjs';

const legacyPurpose = 'ride-research-v1', legacyNotice = 'ride-research-notice-2026-09-23';
const names = { research_participants: 'analytics_participants', research_accounts: 'analytics_accounts',
  participation_operations: 'analytics_operations', place_participation_history: 'place_membership_history' };
const schema = readFileSync(new URL('./fixtures/schema-v4.sql', import.meta.url), 'utf8');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const readTables = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all().map(({ name }) => [names[name] || name, db.prepare(`SELECT rowid,* FROM ${name} ORDER BY rowid`).all()]));

function legacyFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'collector-schema-')); const path = join(dir, 'db.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(path); db.pragma('foreign_keys=ON'); db.exec(schema);
  const now = Date.now(), participantKey = randomUUID(), grantId = randomUUID(), accountSubject = 'a'.repeat(64), openid = 'fixture_account_openid_0001';
  const initial = { accountSubject, action: 'activate', requestId: randomUUID(), expectedStatusVersion: 0, purposeVersion: legacyPurpose, noticeVersion: legacyNotice };
  const event = { eventId: randomUUID(), eventName: 'page_view', schemaVersion: 1, occurredAt: now, data: { page: 'home' } };
  const body = { schemaVersion: 1, batchId: randomUUID(), events: [event] }, raw = Buffer.from(JSON.stringify(body));
  db.prepare('INSERT INTO collector_settings VALUES (?,?)').run('restore_gate', 'open');
  db.prepare('INSERT INTO collector_settings VALUES (?,?)').run('recovery_blocked_notice', 'ride-research-notice-2026-09-22');
  db.prepare('INSERT INTO research_participants VALUES (?,?,?,?,?,?,?)').run(participantKey, grantId, 'active', 1, legacyPurpose, 0, now);
  db.prepare('INSERT INTO research_accounts VALUES (?,?,?,?,?)').run(accountSubject, participantKey, legacyNotice, now, openid);
  db.prepare('INSERT INTO participation_operations VALUES (?,?,?,?,?,?,?,?)').run(accountSubject, initial.requestId, hash(canonical(initial)), 'activate', 1, legacyPurpose, legacyNotice, now);
  db.prepare('INSERT INTO revoked_grants VALUES (?,?,?,?)').run(participantKey, 'prior-revoked-grant', 0, now - 1000);
  db.prepare('INSERT INTO batch_receipts VALUES (?,?,?,?,?,?)').run(participantKey, body.batchId, grantId, hash(raw), 1, now);
  db.prepare('INSERT INTO event_receipts VALUES (?,?,?,?,?,?)').run(participantKey, event.eventId, grantId, hash(canonical(event)), body.batchId, now);
  db.prepare('INSERT INTO ingest_batches VALUES (?,?,?,?,?,?,?)').run(participantKey, body.batchId, grantId, 1, legacyPurpose, now, raw);
  db.prepare('INSERT INTO bridge_nonces VALUES (?,?)').run('existing-bridge-nonce', now + 300000);
  for (const p of STANDARD_PLACES) {
    db.prepare('INSERT INTO place_catalog VALUES (?,?,?,?,?,?,?,?)').run(p.placeId, p.label, 'ny_nj', p.placeId, Number(p.airport), 1, 0, 'curated_standard');
    for (const alias of [...p.aliases, p.label, p.value, p.placeId]) db.prepare('INSERT OR IGNORE INTO place_aliases VALUES (?,?,?)').run(alias.trim().replace(/\s+/g, '').toLowerCase(), 'ny_nj', p.placeId);
  }
  db.prepare('INSERT INTO place_candidates VALUES (?,?,?,?,?,?)').run('candidate', 'ny_nj', 'Fixture museum', 'pending', now, now);
  db.prepare('INSERT INTO place_business_events VALUES (?,?,?,?,?,?,?,?,?)').run(0, 'business-event', 'existing-business-hash', 'trip', 'carpool', 1, now, now, '{"fixture":true}');
  db.prepare('INSERT INTO place_participation_history VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(0, openid, 'business-event', 'trip', 'carpool', 1, now, 'ny_nj', '2026-09-29', 'driver', 1, 'fort_lee', 'columbia', 'transaction');
  db.prepare('INSERT INTO place_public_usage VALUES (?,?,?,?,?,?,?,?,?,?)').run(0, 'business-event', 'fort_lee', 'ny_nj', 'departure', openid, now, '["columbia:fort_lee"]', 'transaction', now);
  db.prepare('INSERT INTO place_selection_votes VALUES (?,?,?,?,?,?,?,?,?)').run(0, openid, 'fort_lee', 'departure', '2026-09-29', 'ny_nj', now, '[]', event.eventId);
  db.prepare('INSERT INTO place_outcomes VALUES (?,?,?,?,?,?,?)').run(0, openid, 'trip', 'carpool', 'followup-event', now, 'yes');
  db.prepare('INSERT INTO place_rank_snapshots VALUES (?,?,?,?,?,?)').run('snapshot', participantKey, 0, 'cache-key', now, '{"fixture":true}');
  db.prepare('INSERT INTO place_followup_population VALUES (?,?,?,?,?,?,?,?,?,?)').run(0, 'trip', 'carpool', openid, 'driver', 1, now, now + 60000, 1, 'transaction');
  const rows = readTables(db), roots = db.prepare("SELECT name,rootpage FROM sqlite_schema WHERE type='table'").all();
  db.close();
  return { path, now, rows, roots, initial, body, raw, openid, claims: { sub: participantKey, participantKey, grantId, statusVersion: 1, purposeVersion: legacyPurpose } };
}

test('v4 rename preserves every stored value, rowid, data root, receipt, account and dependent view; restart is idempotent', t => {
  const f = legacyFixture(t); let store = openStore(f.path, { realEnabled: true });
  try {
    assert.deepEqual(readTables(store.db), f.rows);
    assert.equal(store.db.pragma('user_version', { simple: true }), 5);
    assert.deepEqual(store.db.pragma('foreign_key_check'), []);
    assert.equal(store.db.pragma('integrity_check', { simple: true }), 'ok');
    for (const { name, rootpage } of f.roots) assert.equal(store.db.prepare('SELECT rootpage FROM sqlite_schema WHERE name=?').get(names[name] || name).rootpage, rootpage, 'table pages are renamed, never copied');
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name LIKE 'research_%' OR name LIKE 'participation_%' OR name LIKE 'place_participation_%'").get().n, 0);
    assert.equal(store.db.prepare('SELECT openid FROM operational_events').get().openid, f.openid);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM eligible_real_events').get().n, 1);
    assert.equal(store.db.pragma('foreign_key_list(analytics_accounts)')[0].table, 'analytics_participants');
    const status = store.updateAccount({ ...f.initial, action: 'status' });
    assert.equal(status.participant.grantId, f.claims.grantId); assert.equal(status.purposeVersion, DEFAULT_PURPOSE_VERSION);
    assert.equal(status.noticeVersion, DEFAULT_NOTICE_VERSION);
    assert.equal(store.updateAccount(f.initial).participant.grantId, f.claims.grantId, 'old operation hash is still retryable');
    assert.equal(store.receive(f.claims, f.raw, f.body, f.now).duplicate, true, 'old tokens and byte-identical batch retries stay valid');
    assert.deepEqual(readTables(store.db), f.rows, 'read/status/retries do not mutate old metadata');
    store.close(); store = openStore(f.path, { realEnabled: true });
    assert.deepEqual(readTables(store.db), f.rows);
  } finally { store.close(); }
});

test('canonical tokens can append to a historical grant; views compare only equivalent versions', t => {
  const f = legacyFixture(t), store = openStore(f.path, { realEnabled: true });
  try {
    const event = { ...f.body.events[0], eventId: randomUUID() }, body = { ...f.body, batchId: randomUUID(), events: [event] };
    store.receive({ ...f.claims, purposeVersion: DEFAULT_PURPOSE_VERSION }, Buffer.from(JSON.stringify(body)), body, f.now);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM eligible_real_events').get().n, 2);
    assert.equal(store.db.prepare('SELECT purpose_version FROM analytics_participants').get().purpose_version, legacyPurpose);
    assert.equal(store.db.prepare('SELECT purpose_version FROM ingest_batches WHERE batch_id=?').get(body.batchId).purpose_version, DEFAULT_PURPOSE_VERSION);
    store.db.prepare('UPDATE ingest_batches SET purpose_version=? WHERE batch_id=?').run('ride-analytics-v2', body.batchId);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM eligible_real_events').get().n, 1, 'a genuinely different purpose is ineligible');
    assert.throws(() => store.receive({ ...f.claims, purposeVersion: 'ride-analytics-v2' }, f.raw, f.body, f.now), { code: 'STALE_GRANT' });
  } finally { store.close(); }
});

test('historical v2 nullable OpenID upgrade binds the original account without changing operation identity', t => {
  const f = legacyFixture(t), old = new Database(f.path);
  old.exec('DROP VIEW operational_events; DROP INDEX research_account_openid; ALTER TABLE research_accounts DROP COLUMN openid; PRAGMA user_version=2;'); old.close();
  const store = openStore(f.path, { realEnabled: true });
  try {
    assert.equal(store.db.prepare('SELECT openid FROM analytics_accounts').get().openid, null);
    assert.equal(store.updateAccount({ ...f.initial, action: 'status', openid: f.openid }).participant.grantId, f.claims.grantId);
    assert.equal(store.updateAccount({ ...f.initial, openid: f.openid }).participant.grantId, f.claims.grantId);
    assert.equal(store.db.prepare('SELECT openid FROM operational_events').get().openid, f.openid);
  } finally { store.close(); }
});

test('renaming preserves additional dependent views, foreign keys and trigger behavior', t => {
  const f = legacyFixture(t), old = new Database(f.path); old.pragma('foreign_keys=ON');
  old.exec(`CREATE VIEW account_memberships AS SELECT a.account_subject,h.trip_id FROM research_accounts a
    JOIN place_participation_history h ON h.openid=a.openid;
    CREATE TABLE audit_account_reference (participant_key TEXT PRIMARY KEY REFERENCES research_participants(participant_key)) STRICT;
    CREATE TRIGGER audit_new_participant AFTER INSERT ON research_participants BEGIN INSERT INTO audit_account_reference VALUES (new.participant_key); END;`);
  old.close(); const store = openStore(f.path, { realEnabled: true });
  try {
    assert.deepEqual(store.db.prepare('SELECT * FROM account_memberships').all(), [{ account_subject: f.initial.accountSubject, trip_id: 'trip' }]);
    const account = store.updateAccount({ ...f.initial, accountSubject: 'b'.repeat(64), requestId: randomUUID() });
    assert.equal(store.db.prepare('SELECT participant_key FROM audit_account_reference').get().participant_key, account.participantKey);
    assert.equal(store.db.pragma('foreign_key_list(audit_account_reference)')[0].table, 'analytics_participants');
    assert.deepEqual(store.db.pragma('foreign_key_check'), []);
    assert.equal(store.db.prepare('SELECT purpose_version FROM analytics_participants WHERE participant_key=?').get(account.participantKey).purpose_version, DEFAULT_PURPOSE_VERSION);
    assert.equal(store.db.prepare('SELECT notice_version FROM analytics_accounts WHERE participant_key=?').get(account.participantKey).notice_version, DEFAULT_NOTICE_VERSION);
  } finally { store.close(); }
});

test('a historical blocked-notice marker still blocks equivalent canonical authorization after upgrade', t => {
  const f = legacyFixture(t), old = new Database(f.path);
  old.prepare("UPDATE collector_settings SET value=? WHERE key='recovery_blocked_notice'").run(legacyNotice); old.close();
  const store = openStore(f.path, { realEnabled: true });
  try {
    assert.equal(store.updateAccount({ ...f.initial, action: 'status' }).participant, undefined);
    assert.throws(() => store.receive({ ...f.claims, purposeVersion: DEFAULT_PURPOSE_VERSION }, f.raw, f.body), { code: 'RECOVERY_RECONSENT_NOTICE_REQUIRED' });
    assert.throws(() => store.updateAccount({ ...f.initial, purposeVersion: DEFAULT_PURPOSE_VERSION, noticeVersion: DEFAULT_NOTICE_VERSION,
      requestId: randomUUID(), expectedStatusVersion: 1 }), { code: 'RECOVERY_RECONSENT_NOTICE_REQUIRED' });
    assert.equal(store.db.prepare("SELECT value FROM collector_settings WHERE key='recovery_blocked_notice'").get().value, legacyNotice);
  } finally { store.close(); }
});

test('withdrawal after upgrade revokes the original grant, removes payloads and retains retry receipts', t => {
  const f = legacyFixture(t), store = openStore(f.path, { realEnabled: true });
  try {
    const request = { ...f.initial, action: 'withdraw', expectedStatusVersion: 1, requestId: randomUUID() };
    const result = store.updateAccount(request);
    assert.equal(result.status, 'revoked'); assert.equal(result.participantKey, f.claims.participantKey);
    assert.equal(store.db.prepare('SELECT grant_id FROM analytics_participants').get().grant_id, f.claims.grantId);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM ingest_batches').get().n, 0);
    assert.equal(store.db.prepare('SELECT payload_hash FROM batch_receipts').get().payload_hash, hash(f.raw));
    assert.equal(store.updateAccount(request).statusVersion, 2);
    assert.throws(() => store.receive(f.claims, f.raw, f.body), { code: 'ACCOUNT_INACTIVE' });
  } finally { store.close(); }
});

test('a failure after table renames rolls back names, version and every row, and closes the failed connection', t => {
  const f = legacyFixture(t), old = new Database(f.path);
  old.exec("CREATE TRIGGER migration_failure BEFORE INSERT ON collector_settings BEGIN SELECT RAISE(ABORT,'fixture migration failure'); END;"); old.close();
  assert.throws(() => openStore(f.path, { realEnabled: true }), /fixture migration failure/);
  const check = new Database(f.path);
  try {
    assert.equal(check.pragma('user_version', { simple: true }), 4); assert.deepEqual(readTables(check), f.rows);
    assert.equal(check.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE type='table' AND name LIKE 'analytics_%'").get().n, 0);
    check.exec('BEGIN EXCLUSIVE; ROLLBACK;');
  } finally { check.close(); }
});

for (const [name, mutate] of [
  ['mixed names', 'ALTER TABLE research_accounts RENAME TO analytics_accounts'],
  ['incomplete v4', 'DROP TABLE place_participation_history'],
  ['missing receipt table', 'DROP TABLE event_receipts'],
  ['unexpected canonical index', 'CREATE INDEX analytics_operation_age ON participation_operations(created_at)'],
  ['future schema', 'PRAGMA user_version=6'],
  ['mislabelled schema', 'PRAGMA user_version=5'],
]) test(`${name} fails closed without changing data or schema`, t => {
  const f = legacyFixture(t), old = new Database(f.path); old.exec(mutate);
  const before = old.prepare('SELECT * FROM sqlite_schema ORDER BY rowid').all(), rows = readTables(old), version = old.pragma('user_version', { simple: true }); old.close();
  assert.throws(() => openStore(f.path, { realEnabled: true }), /Unsupported/);
  const check = new Database(f.path);
  try { assert.deepEqual(check.prepare('SELECT * FROM sqlite_schema ORDER BY rowid').all(), before); assert.deepEqual(readTables(check), rows); assert.equal(check.pragma('user_version', { simple: true }), version); }
  finally { check.close(); }
});

test('historical FK corruption fails closed before renaming tables', t => {
  const f = legacyFixture(t), old = new Database(f.path); old.pragma('foreign_keys=OFF');
  old.prepare('UPDATE research_accounts SET participant_key=?').run('missing'); old.close();
  assert.throws(() => openStore(f.path, { realEnabled: true }), /foreign key violations/);
  const check = new Database(f.path);
  try { assert.equal(check.pragma('user_version', { simple: true }), 4); assert.ok(check.prepare("SELECT 1 FROM sqlite_schema WHERE name='research_accounts'").get()); }
  finally { check.close(); }
});

test('restore-check upgrades a v4 backup only in a quarantined candidate and leaves the source bytes unchanged', t => {
  const f = legacyFixture(t), sourceHash = hash(readFileSync(f.path)), target = `${f.path}.candidate`;
  const summary = JSON.parse(execFileSync(process.execPath, [new URL('../scripts/restore-check.mjs', import.meta.url).pathname, f.path, target], { encoding: 'utf8' }));
  assert.equal(summary.ok, true); assert.equal(summary.restoreGate, 'closed'); assert.equal(summary.participants, 1); assert.equal(summary.batches, 1);
  assert.equal(hash(readFileSync(f.path)), sourceHash);
  const source = new Database(f.path, { readonly: true }), restored = new Database(target, { readonly: true });
  try {
    assert.equal(source.pragma('user_version', { simple: true }), 4); assert.equal(restored.pragma('user_version', { simple: true }), 5);
    assert.equal(restored.prepare("SELECT value FROM collector_settings WHERE key='restore_gate'").get().value, 'closed');
    assert.equal(restored.prepare('SELECT COUNT(*) n FROM eligible_real_events').get().n, 0);
    const expected = { ...f.rows, collector_settings: f.rows.collector_settings.map(row => row.key === 'restore_gate' ? { ...row, value: 'closed' } : row) };
    assert.deepEqual(readTables(restored), expected);
    assert.deepEqual(restored.pragma('foreign_key_check'), []);
  } finally { source.close(); restored.close(); }
});
