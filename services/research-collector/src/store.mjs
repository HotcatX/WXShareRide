import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { requireThat } from './errors.mjs';
import { validateBatch } from './validation.mjs';
import { DEFAULT_NOTICE_VERSION } from './bridge.mjs';
import { initializePlaces, createPlacesStore } from './places.mjs';

const DAY_MS = 86_400_000;
const MAX_VERSION = 2_147_483_647;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function sqliteIsPatched(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  return major > 3 || (major === 3 && (minor > 51 || (minor === 51 && patch >= 3)
    || (minor === 50 && patch >= 7) || (minor === 44 && patch >= 6)));
}

export function openStore(path, { realEnabled = false, purposeVersion = 'ride-research-v1', maxDatabaseMB = 1024, noticeVersion = DEFAULT_NOTICE_VERSION } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { timeout: 3000 });
  const sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get().version;
  if (!sqliteIsPatched(sqliteVersion)) { db.close(); throw new Error('SQLite must include the WAL-reset fix (3.51.3+ or documented backport)'); }
  if (db.pragma('user_version', { simple: true }) > 4) { db.close(); throw new Error('Unsupported database schema version'); }
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('secure_delete = ON');
  db.pragma('wal_autocheckpoint = 1000');
  db.pragma('journal_size_limit = 16777216');
  const pageSize = db.pragma('page_size', { simple: true });
  db.pragma(`max_page_count = ${Math.floor(maxDatabaseMB * 1024 * 1024 / pageSize)}`);
  chmodSync(path, 0o600);
  db.transaction(() => { db.exec(`
    CREATE TABLE IF NOT EXISTS collector_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    INSERT OR IGNORE INTO collector_settings VALUES ('restore_gate', 'open');
    CREATE TABLE IF NOT EXISTS research_participants (
      participant_key TEXT PRIMARY KEY, grant_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','revoked')),
      status_version INTEGER NOT NULL, purpose_version TEXT NOT NULL, synthetic INTEGER NOT NULL CHECK(synthetic IN (0,1)), updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS revoked_grants (
      participant_key TEXT NOT NULL, grant_id TEXT NOT NULL, status_version INTEGER NOT NULL, revoked_at INTEGER NOT NULL,
      PRIMARY KEY(participant_key, grant_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS batch_receipts (
      participant_key TEXT NOT NULL, batch_id TEXT NOT NULL, grant_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL, event_count INTEGER NOT NULL, received_at INTEGER NOT NULL,
      PRIMARY KEY(participant_key, batch_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS ingest_batches (
      participant_key TEXT NOT NULL, batch_id TEXT NOT NULL, grant_id TEXT NOT NULL,
      status_version INTEGER NOT NULL, purpose_version TEXT NOT NULL, received_at INTEGER NOT NULL,
      payload BLOB NOT NULL, PRIMARY KEY(participant_key, batch_id),
      FOREIGN KEY(participant_key, batch_id) REFERENCES batch_receipts(participant_key, batch_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS event_receipts (
      participant_key TEXT NOT NULL, event_id TEXT NOT NULL, grant_id TEXT NOT NULL,
      event_hash TEXT NOT NULL, first_batch_id TEXT NOT NULL, received_at INTEGER NOT NULL,
      PRIMARY KEY(participant_key, event_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS research_accounts (
      account_subject TEXT PRIMARY KEY, participant_key TEXT NOT NULL UNIQUE,
      notice_version TEXT NOT NULL, created_at INTEGER NOT NULL,
      FOREIGN KEY(participant_key) REFERENCES research_participants(participant_key)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS participation_operations (
      account_subject TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      action TEXT NOT NULL, status_version INTEGER NOT NULL, purpose_version TEXT NOT NULL,
      notice_version TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(account_subject, request_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS bridge_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS bridge_nonce_expiry ON bridge_nonces(expires_at);
    CREATE INDEX IF NOT EXISTS participation_operation_age ON participation_operations(created_at);
    CREATE INDEX IF NOT EXISTS ingest_batch_age ON ingest_batches(received_at);
    DROP VIEW IF EXISTS operational_events;
    DROP VIEW IF EXISTS eligible_real_events;
    DROP VIEW IF EXISTS eligible_real_batches;
    DROP VIEW IF EXISTS eligible_events;
    DROP VIEW IF EXISTS eligible_batches;
    CREATE VIEW eligible_batches AS
      SELECT b.* FROM ingest_batches b JOIN research_participants p ON p.participant_key=b.participant_key
      WHERE p.status='active' AND p.grant_id=b.grant_id AND p.purpose_version=b.purpose_version
        AND (SELECT value FROM collector_settings WHERE key='restore_gate')='open'
        AND b.received_at > (CAST(strftime('%s','now') AS INTEGER)*1000 - CASE p.synthetic WHEN 1 THEN 14 ELSE 180 END*86400000);
    CREATE VIEW eligible_events AS
      SELECT b.participant_key, b.grant_id, b.purpose_version, b.batch_id, b.received_at,
        json_extract(e.value,'$.eventId') AS event_id, e.value AS event_json
      FROM eligible_batches b, json_each(CAST(b.payload AS TEXT),'$.events') e
      JOIN event_receipts r ON r.participant_key=b.participant_key
        AND r.event_id=json_extract(e.value,'$.eventId') AND r.first_batch_id=b.batch_id;
    CREATE VIEW eligible_real_batches AS
      SELECT b.* FROM eligible_batches b JOIN research_participants p ON p.participant_key=b.participant_key WHERE p.synthetic=0;
    CREATE VIEW eligible_real_events AS
      SELECT e.* FROM eligible_events e JOIN research_participants p ON p.participant_key=e.participant_key WHERE p.synthetic=0;
  `);
    // Additive migration preserves all participant/grant/receipt IDs. Old rows
    // are linked on the next trusted status/activation, never by guessing an ID.
    if (!db.prepare('PRAGMA table_info(research_accounts)').all().some(column => column.name === 'openid')) {
      db.exec('ALTER TABLE research_accounts ADD COLUMN openid TEXT');
    }
    db.exec(`CREATE INDEX IF NOT EXISTS research_account_openid ON research_accounts(openid);
      CREATE VIEW operational_events AS
        SELECT a.openid,p.synthetic,json_extract(e.event_json,'$.data.tripKey') AS tripKey,e.*
        FROM eligible_events e JOIN research_accounts a ON a.participant_key=e.participant_key
        JOIN research_participants p ON p.participant_key=e.participant_key;
      PRAGMA user_version = 4;`);
    initializePlaces(db);
  }).immediate();
  const places = createPlacesStore(db, { realEnabled });
  const getParticipant = key => db.prepare('SELECT * FROM research_participants WHERE participant_key=?').get(key);
  const normalize = p => ({ participantKey: p.participant_key, grantId: p.grant_id, status: p.status,
    statusVersion: p.status_version, purposeVersion: p.purpose_version, synthetic: Boolean(p.synthetic) });
  const assertActive = (p, claims) => {
    requireThat(db.prepare("SELECT value FROM collector_settings WHERE key='restore_gate'").get().value === 'open', 503, 'RESTORE_QUARANTINE');
    requireThat(p && p.status === 'active', 403, 'PARTICIPATION_INACTIVE');
    requireThat(realEnabled || p.synthetic === 1, 503, 'COLLECTION_DISABLED');
    requireThat(p.purpose_version === purposeVersion, 403, 'STALE_GRANT');
    if (!p.synthetic) requireThat(db.prepare("SELECT value FROM collector_settings WHERE key='recovery_blocked_notice'").get()?.value !== noticeVersion, 503, 'RECOVERY_RECONSENT_NOTICE_REQUIRED');
    if (!p.synthetic) requireThat(db.prepare('SELECT 1 FROM research_accounts WHERE participant_key=? AND notice_version=?')
      .get(p.participant_key, noticeVersion), 403, 'CONSENT_REQUIRED');
    if (claims) requireThat(p.grant_id === claims.grantId && p.status_version === claims.statusVersion
      && p.purpose_version === claims.purposeVersion, 403, 'STALE_GRANT');
  };
  const stateTransaction = db.transaction((state, now) => {
    const current = getParticipant(state.participantKey);
    if (current) {
      requireThat(state.statusVersion >= current.status_version, 409, 'STALE_STATE');
      if (state.statusVersion === current.status_version) {
        requireThat(Object.entries(normalize(current)).every(([key, value]) => state[key] === value), 409, 'STATE_CONFLICT');
        return { ...normalize(current), duplicate: true };
      }
      requireThat(state.synthetic === Boolean(current.synthetic), 409, 'PARTICIPANT_KIND_IMMUTABLE');
      if (state.status === 'revoked') requireThat(state.grantId === current.grant_id, 409, 'GRANT_MISMATCH');
      if (state.status === 'active' && current.status === 'active') {
        requireThat(state.grantId === current.grant_id && state.purposeVersion === current.purpose_version, 409, 'REVOKE_BEFORE_NEW_GRANT');
      }
    }
    if (state.status === 'active') {
      requireThat(!db.prepare('SELECT 1 FROM revoked_grants WHERE participant_key=? AND grant_id=?').get(state.participantKey, state.grantId), 409, 'GRANT_REVOKED');
      requireThat(state.purposeVersion === purposeVersion, 409, 'PURPOSE_MISMATCH');
      requireThat(realEnabled || state.synthetic, 503, 'COLLECTION_DISABLED');
    } else {
      db.prepare(`INSERT INTO revoked_grants VALUES (?,?,?,?) ON CONFLICT(participant_key,grant_id) DO UPDATE SET
        status_version=MAX(status_version,excluded.status_version)`).run(state.participantKey, state.grantId, state.statusVersion, now);
      // Delete all payloads for this participant, keeping only minimal retry/security metadata.
      db.prepare('DELETE FROM ingest_batches WHERE participant_key=?').run(state.participantKey);
      const account = db.prepare('SELECT openid FROM research_accounts WHERE participant_key=?').get(state.participantKey)?.openid;
      if (account) {
        db.prepare('DELETE FROM place_selection_votes WHERE synthetic=? AND openid=?').run(Number(state.synthetic), account);
        db.prepare('DELETE FROM place_outcomes WHERE synthetic=? AND openid=?').run(Number(state.synthetic), account);
      }
      db.prepare('DELETE FROM place_rank_snapshots WHERE participant_key=?').run(state.participantKey);
    }
    db.prepare(`INSERT INTO research_participants VALUES (?,?,?,?,?,?,?) ON CONFLICT(participant_key) DO UPDATE SET
      grant_id=excluded.grant_id,status=excluded.status,status_version=excluded.status_version,
      purpose_version=excluded.purpose_version,updated_at=excluded.updated_at`).run(
      state.participantKey, state.grantId, state.status, state.statusVersion, state.purposeVersion, Number(state.synthetic), now);
    return { ...state, duplicate: false };
  });
  const getAccount = subject => db.prepare(`SELECT p.*, a.notice_version, a.openid FROM research_accounts a
    JOIN research_participants p ON p.participant_key=a.participant_key WHERE a.account_subject=?`).get(subject);
  const gateOpen = () => db.prepare("SELECT value FROM collector_settings WHERE key='restore_gate'").get().value === 'open';
  const participationStatus = (subject, synthetic = false) => {
    const p = getAccount(subject);
    const kind = synthetic ? { synthetic: true } : {};
    if (!p) return { ok: true, status: 'none', statusVersion: 0, purposeVersion, noticeVersion, ...kind };
    requireThat(Boolean(p.synthetic) === synthetic, 409, 'PARTICIPANT_KIND_IMMUTABLE');
    const response = { ok: true, participantKey: p.participant_key, status: p.status, statusVersion: p.status_version,
      purposeVersion, noticeVersion, ...kind };
    if (p.status === 'active' && p.notice_version === noticeVersion && gateOpen() && (realEnabled || synthetic)
      && (synthetic || db.prepare("SELECT value FROM collector_settings WHERE key='recovery_blocked_notice'").get()?.value !== noticeVersion)) {
      assertActive(p); response.participant = normalize(p);
    }
    return response;
  };
  const participationTransaction = db.transaction((request, now) => {
    const { accountSubject, action, requestId, expectedStatusVersion } = request;
    const synthetic = request.synthetic === true;
    const current = getAccount(accountSubject);
    requireThat(!current || Boolean(current.synthetic) === synthetic, 409, 'PARTICIPANT_KIND_IMMUTABLE');
    if (request.openid !== undefined) {
      requireThat(!current?.openid || current.openid === request.openid, 409, 'ACCOUNT_IDENTITY_CONFLICT');
      requireThat(!db.prepare(`SELECT 1 FROM research_accounts a JOIN research_participants p ON p.participant_key=a.participant_key
        WHERE a.openid=? AND p.synthetic=? AND a.account_subject<>?`).get(request.openid, Number(synthetic), accountSubject), 409, 'ACCOUNT_IDENTITY_CONFLICT');
      if (current && !current.openid) db.prepare('UPDATE research_accounts SET openid=? WHERE account_subject=?').run(request.openid, accountSubject);
    }
    if (action === 'status') return participationStatus(accountSubject, synthetic);
    // Identity is separately checked/bound above, not an operation argument.
    // Omitting it from the hash keeps pre-migration operation retries compatible.
    const { openid: _openid, ...operation } = request;
    const hash = createHash('sha256').update(canonical(operation)).digest('hex');
    const prior = db.prepare('SELECT * FROM participation_operations WHERE account_subject=? AND request_id=?').get(accountSubject, requestId);
    if (prior) {
      requireThat(prior.request_hash === hash, 409, 'OPERATION_CONFLICT');
      requireThat(current && prior.status_version === current.status_version, 409, 'OPERATION_SUPERSEDED');
      return participationStatus(accountSubject, synthetic);
    }
    requireThat(expectedStatusVersion === (current?.status_version || 0), 409, 'STATE_CONFLICT');
    if (action === 'activate') {
      requireThat(realEnabled || synthetic, 503, 'COLLECTION_DISABLED');
      requireThat(gateOpen(), 503, 'RESTORE_QUARANTINE');
      requireThat(synthetic || db.prepare("SELECT value FROM collector_settings WHERE key='recovery_blocked_notice'").get()?.value !== noticeVersion,
        503, 'RECOVERY_RECONSENT_NOTICE_REQUIRED');
    }
    let participant = current ? normalize(current) : { participantKey: randomUUID(), grantId: randomUUID(),
      status: 'revoked', statusVersion: 0, purposeVersion, synthetic };
    if (action === 'activate' && (!current || current.status !== 'active' || current.notice_version !== noticeVersion)) {
      if (current?.status === 'active') {
        requireThat(participant.statusVersion < MAX_VERSION - 1, 409, 'VERSION_EXHAUSTED');
        participant = { ...participant, status: 'revoked', statusVersion: participant.statusVersion + 1 };
        stateTransaction(participant, now);
      }
      requireThat(participant.statusVersion < MAX_VERSION, 409, 'VERSION_EXHAUSTED');
      participant = { ...participant, grantId: randomUUID(), status: 'active', statusVersion: participant.statusVersion + 1, purposeVersion };
      stateTransaction(participant, now);
    } else if (action === 'withdraw' && (!current || current.status === 'active')) {
      requireThat(participant.statusVersion < MAX_VERSION, 409, 'VERSION_EXHAUSTED');
      participant = { ...participant, status: 'revoked', statusVersion: participant.statusVersion + 1 };
      stateTransaction(participant, now);
    }
    // Keep a revoked tombstone even for an account that had not previously enrolled.
    // It invalidates any racing activation prepared against version zero.
    db.prepare(`INSERT INTO research_accounts (account_subject,participant_key,notice_version,created_at,openid) VALUES (?,?,?,?,?)
      ON CONFLICT(account_subject) DO UPDATE SET
      notice_version=CASE WHEN ?='activate' THEN excluded.notice_version ELSE notice_version END,
      openid=COALESCE(research_accounts.openid,excluded.openid)`).run(
      accountSubject, participant.participantKey, noticeVersion, now, request.openid ?? null, action);
    db.prepare('INSERT INTO participation_operations VALUES (?,?,?,?,?,?,?,?)').run(
      accountSubject, requestId, hash, action, participant.statusVersion, purposeVersion, noticeVersion, now);
    return participationStatus(accountSubject, synthetic);
  });
  const receiveTransaction = db.transaction((claims, raw, body, now) => {
    // BEGIN IMMEDIATE covers authorization, receipt and payload; no awaits inside.
    const participant = getParticipant(claims.sub);
    assertActive(participant, claims);
    const hash = createHash('sha256').update(raw).digest('hex');
    const previous = db.prepare('SELECT * FROM batch_receipts WHERE participant_key=? AND batch_id=?').get(claims.sub, body.batchId);
    if (previous) {
      requireThat(previous.grant_id === claims.grantId && previous.payload_hash === hash, 409, 'BATCH_CONFLICT');
      return { ok: true, batchId: body.batchId, payloadHash: hash, eventCount: previous.event_count, receivedAt: previous.received_at, duplicate: true };
    }
    // Recheck age at commit; expired-but-previously-accepted retries remain idempotent.
    validateBatch(body, now);
    for (const event of body.events) {
      const eventHash = createHash('sha256').update(canonical(event)).digest('hex');
      const old = db.prepare('SELECT grant_id,event_hash FROM event_receipts WHERE participant_key=? AND event_id=?').get(claims.sub, event.eventId);
      if (old) requireThat(old.grant_id === claims.grantId && old.event_hash === eventHash, 409, 'EVENT_CONFLICT');
      else {
        db.prepare('INSERT INTO event_receipts VALUES (?,?,?,?,?,?)').run(claims.sub, event.eventId, claims.grantId, eventHash, body.batchId, now);
        places.recordEvent(participant, event);
      }
    }
    db.prepare('INSERT INTO batch_receipts VALUES (?,?,?,?,?,?)').run(claims.sub, body.batchId, claims.grantId, hash, body.events.length, now);
    db.prepare('INSERT INTO ingest_batches VALUES (?,?,?,?,?,?,?)').run(claims.sub, body.batchId, claims.grantId,
      claims.statusVersion, claims.purposeVersion, now, raw);
    return { ok: true, batchId: body.batchId, payloadHash: hash, eventCount: body.events.length, receivedAt: now, duplicate: false };
  });
  return {
    db, sqliteVersion, places,
    placeSuggestions(claims, body, now = Date.now()) {
      const p = getParticipant(claims.sub); assertActive(p, claims);
      requireThat(claims.scopes?.includes('places:read'), 403, 'PLACE_SCOPE_REQUIRED');
      return places.suggestions(p, body, now);
    },
    consumeBridgeNonce(nonce, expiresAt, now = Date.now()) {
      return db.transaction(() => {
        db.prepare('DELETE FROM bridge_nonces WHERE expires_at < ?').run(now);
        requireThat(!db.prepare('SELECT 1 FROM bridge_nonces WHERE nonce=?').get(nonce), 409, 'BRIDGE_REPLAY');
        requireThat(db.prepare('SELECT COUNT(*) AS n FROM bridge_nonces').get().n < 5000, 429, 'BRIDGE_CAPACITY');
        db.prepare('INSERT INTO bridge_nonces VALUES (?,?)').run(nonce, expiresAt);
      }).immediate();
    },
    participate(request, now = Date.now()) { return participationTransaction.immediate(request, now); },
    applyState(state, now = Date.now()) { return stateTransaction.immediate(state, now); },
    activeParticipant(key) { const p = getParticipant(key); assertActive(p); return normalize(p); },
    receive(claims, raw, body, now = Date.now()) { return receiveTransaction.immediate(claims, raw, body, now); },
    close() { db.close(); },
    async backup(path) { return db.backup(path); },
    prune(now = Date.now()) {
      return db.transaction(() => {
        const payloads = db.prepare(`DELETE FROM ingest_batches WHERE
          (participant_key IN (SELECT participant_key FROM research_participants WHERE synthetic=1) AND received_at <= ?)
          OR (participant_key IN (SELECT participant_key FROM research_participants WHERE synthetic=0) AND received_at <= ?)`)
          .run(now - 14 * DAY_MS, now - 180 * DAY_MS).changes;
        // Keep deduplication metadata while a payload still exists, then at least
        // the seven-day upload retry window. No receipt becomes a research observation.
        const expiredReceipt = `((participant_key IN (SELECT participant_key FROM research_participants WHERE synthetic=1) AND received_at <= ?)
          OR (participant_key IN (SELECT participant_key FROM research_participants WHERE synthetic=0) AND received_at <= ?))`;
        const events = db.prepare(`DELETE FROM event_receipts WHERE ${expiredReceipt}
          AND NOT EXISTS (SELECT 1 FROM ingest_batches b WHERE b.participant_key=event_receipts.participant_key AND b.batch_id=event_receipts.first_batch_id)`)
          .run(now - 30 * DAY_MS, now - 187 * DAY_MS).changes;
        const receipts = db.prepare(`DELETE FROM batch_receipts WHERE ${expiredReceipt}
          AND NOT EXISTS (SELECT 1 FROM ingest_batches b WHERE b.participant_key=batch_receipts.participant_key AND b.batch_id=batch_receipts.batch_id)`)
          .run(now - 30 * DAY_MS, now - 187 * DAY_MS).changes;
        const nonces = db.prepare('DELETE FROM bridge_nonces WHERE expires_at < ?').run(now).changes;
        const operations = db.prepare('DELETE FROM participation_operations WHERE created_at <= ?').run(now - 187 * DAY_MS).changes;
        return { payloads, events, receipts, nonces, operations, places: places.prune(now) };
      }).immediate();
    },
    recoveryComplete() {
      return db.transaction(() => {
        requireThat(!gateOpen(), 409, 'RECOVERY_NOT_QUARANTINED');
        const now = Date.now();
        const real = db.prepare('SELECT * FROM research_participants WHERE synthetic=0').all();
        db.prepare('DELETE FROM ingest_batches WHERE participant_key IN (SELECT participant_key FROM research_participants WHERE synthetic=0)').run();
        for (const table of ['place_selection_votes', 'place_outcomes', 'place_rank_snapshots']) {
          db.prepare(`DELETE FROM ${table} WHERE synthetic=0`).run();
        }
        for (const p of real) {
          // Saturation intentionally prevents future enrollment rather than wraparound.
          const nextVersion = Math.min(MAX_VERSION, p.status_version + 1);
          db.prepare(`INSERT INTO revoked_grants VALUES (?,?,?,?) ON CONFLICT(participant_key,grant_id) DO UPDATE SET
            status_version=MAX(status_version,excluded.status_version)`).run(p.participant_key, p.grant_id, nextVersion, now);
          db.prepare("UPDATE research_participants SET status='revoked',status_version=?,updated_at=? WHERE participant_key=?")
            .run(nextVersion, now, p.participant_key);
        }
        // Empty/pre-activation backups can also predate a later withdrawal.
        db.prepare("INSERT INTO collector_settings VALUES ('recovery_blocked_notice',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(noticeVersion);
        db.prepare("UPDATE collector_settings SET value='open' WHERE key='restore_gate'").run();
        db.prepare("INSERT INTO collector_settings VALUES ('last_reconciled_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(now));
        return { realGrantsRevoked: real.length, freshNoticeRequired: true };
      }).immediate();
    },
  };
}
