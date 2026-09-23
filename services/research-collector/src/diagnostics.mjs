import { requireThat } from './errors.mjs';
import { shape, id, validateBatch } from './validation.mjs';

export const DIAGNOSTIC_ROUTE = '/v1/diagnostics/account';
export const MAX_DIAGNOSTIC_BYTES = 262_144;
const DAY = 86_400_000;
const epoch = value => Number.isSafeInteger(value) && value >= 0;
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function validateDiagnosticRequest(body, now = Date.now()) {
  requireThat(shape(body, {
    openid: value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value),
    synthetic: value => typeof value === 'boolean', from: epoch, to: epoch,
    limit: value => integer(value, 1, 100),
  }) && body.from <= body.to && body.to - body.from <= 180 * DAY && body.to <= now + 300_000,
  422, 'INVALID_DIAGNOSTIC_REQUEST');
  return body;
}

// Validate the currently supported schema before exposing stored data. A future
// schema can extend validation.mjs without turning this into a free-text dump.
function eventProjection(row) {
  const event = JSON.parse(row.event_json);
  validateBatch({ schemaVersion: 1, batchId: row.batch_id, events: [event] }, Date.now(), false);
  const result = { batchId: row.batch_id, receivedAt: row.received_at,
    eventId: event.eventId, eventName: event.eventName, schemaVersion: event.schemaVersion,
    occurredAt: event.occurredAt, data: event.data };
  if (event.sessionId !== undefined) result.sessionId = event.sessionId;
  if (event.context !== undefined) result.context = event.context;
  return result;
}

export function readAccountDiagnostics(db, input, now = Date.now()) {
  const request = validateDiagnosticRequest(input, now);
  // One short read snapshot; no network, async work, state writes or token issuance.
  return db.transaction(() => {
    const { openid, synthetic, from, to, limit } = request;
    const p = db.prepare(`SELECT p.participant_key,p.status,p.status_version,p.purpose_version,p.synthetic,p.updated_at,a.notice_version,a.openid
      FROM research_accounts a JOIN research_participants p ON p.participant_key=a.participant_key WHERE a.openid=? AND p.synthetic=?`).get(openid, Number(synthetic));
    const eventRetentionDays = synthetic ? 14 : 180;
    const result = { ok: true, synthetic, status: p?.status || 'none',
      account: p ? { openid: p.openid, participantKey: p.participant_key, statusVersion: p.status_version,
        purposeVersion: p.purpose_version, noticeVersion: p.notice_version, updatedAt: p.updated_at } : null,
      coverage: { timeBasis: 'receivedAt', from, to, limit, sampledAt: now,
        eventRetentionDays, receiptRetentionDays: synthetic ? 30 : 187,
        retentionCutoff: now - eventRetentionDays * DAY, windowStartsBeforeRetention: from < now - eventRetentionDays * DAY,
        restoreGate: db.prepare("SELECT value FROM collector_settings WHERE key='restore_gate'").get().value,
        scope: 'retained_authorized_events', missingHistoryPossible: true },
      events: [], batches: [], hasMoreEvents: false, hasMoreBatches: false };
    if (!p) return result;
    const batches = db.prepare(`SELECT r.batch_id AS batchId,r.received_at AS receivedAt,r.event_count AS eventCount,
      b.batch_id IS NOT NULL AS payloadPresent,
      EXISTS(SELECT 1 FROM eligible_batches e WHERE e.participant_key=r.participant_key AND e.batch_id=r.batch_id) AS eligible
      FROM batch_receipts r LEFT JOIN ingest_batches b ON b.participant_key=r.participant_key AND b.batch_id=r.batch_id
      WHERE r.participant_key=? AND r.received_at>=? AND r.received_at<=?
      ORDER BY r.received_at DESC,r.batch_id DESC LIMIT ?`).all(p.participant_key, from, to, limit + 1);
    result.hasMoreBatches = batches.length > limit;
    result.batches = batches.slice(0, limit).map(row => ({ ...row, payloadPresent: Boolean(row.payloadPresent), eligible: Boolean(row.eligible) }));
    // Materialize at most 101 event receipts before JSON expansion. The join to
    // eligible_batches excludes revoked/expired/restored-quarantined payloads.
    const rows = db.prepare(`WITH chosen AS MATERIALIZED (
      SELECT r.event_id,r.first_batch_id AS batch_id,b.received_at FROM event_receipts r
      JOIN eligible_batches b ON b.participant_key=r.participant_key AND b.batch_id=r.first_batch_id
      WHERE r.participant_key=? AND b.received_at>=? AND b.received_at<=?
      ORDER BY b.received_at DESC,r.event_id DESC LIMIT ?)
      SELECT c.batch_id,c.received_at,e.value AS event_json FROM chosen c
      JOIN eligible_batches b ON b.participant_key=? AND b.batch_id=c.batch_id,
        json_each(CAST(b.payload AS TEXT),'$.events') e
      WHERE json_extract(e.value,'$.eventId')=c.event_id
      ORDER BY c.received_at DESC,c.event_id DESC`).all(p.participant_key, from, to, limit + 1, p.participant_key);
    result.hasMoreEvents = rows.length > limit;
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      let event;
      try { event = eventProjection(row); }
      catch { requireThat(false, 503, 'DIAGNOSTIC_SCHEMA_UNAVAILABLE'); }
      const size = Buffer.byteLength(JSON.stringify(event));
      if (bytes + size > 196_608) { result.hasMoreEvents = true; break; }
      bytes += size; result.events.push(event);
    }
    return result;
  }).deferred();
}

// The root CLI also projects the response; no token/grant/subject or unexpected
// server diagnostics can accidentally be printed by forwarding the entire body.
export function projectDiagnosticResponse(value, expectedSynthetic) {
  const bad = () => requireThat(false, 502, 'INVALID_DIAGNOSTIC_RESPONSE');
  if (!object(value) || value.ok !== true || value.synthetic !== expectedSynthetic ||
    !['none', 'active', 'revoked'].includes(value.status) || !object(value.coverage) ||
    !Array.isArray(value.events) || value.events.length > 100 || !Array.isArray(value.batches) || value.batches.length > 100 ||
    typeof value.hasMoreEvents !== 'boolean' || typeof value.hasMoreBatches !== 'boolean') bad();
  const c = value.coverage;
  if (c.timeBasis !== 'receivedAt' || !epoch(c.from) || !epoch(c.to) || !epoch(c.sampledAt) ||
    !integer(c.limit, 1, 100) || c.eventRetentionDays !== (expectedSynthetic ? 14 : 180) ||
    c.receiptRetentionDays !== (expectedSynthetic ? 30 : 187) || !Number.isSafeInteger(c.retentionCutoff) ||
    typeof c.windowStartsBeforeRetention !== 'boolean' || !['open', 'closed'].includes(c.restoreGate) ||
    c.scope !== 'retained_authorized_events' || c.missingHistoryPossible !== true) bad();
  let account = null;
  if (value.status === 'none') { if (value.account !== null || value.events.length || value.batches.length) bad(); }
  else {
    const a = value.account;
    if (!object(a) || typeof a.openid !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(a.openid) || !id(a.participantKey) || !integer(a.statusVersion, 1, 2_147_483_647) ||
      typeof a.purposeVersion !== 'string' || !/^ride-research-v[1-9][0-9]{0,3}$/.test(a.purposeVersion) ||
      typeof a.noticeVersion !== 'string' || !/^ride-research-notice-20\d\d-\d\d-\d\d(?:-[1-9]\d{0,3})?$/.test(a.noticeVersion) || !epoch(a.updatedAt)) bad();
    account = { openid: a.openid, participantKey: a.participantKey, statusVersion: a.statusVersion,
      purposeVersion: a.purposeVersion, noticeVersion: a.noticeVersion, updatedAt: a.updatedAt };
  }
  const events = value.events.map(row => {
    if (!object(row) || !id(row.batchId) || !epoch(row.receivedAt)) bad();
    const event = { eventId: row.eventId, eventName: row.eventName, schemaVersion: row.schemaVersion,
      occurredAt: row.occurredAt, data: row.data };
    if (row.sessionId !== undefined) event.sessionId = row.sessionId;
    if (row.context !== undefined) event.context = row.context;
    try { return eventProjection({ batch_id: row.batchId, received_at: row.receivedAt, event_json: JSON.stringify(event) }); }
    catch { return bad(); }
  });
  const batches = value.batches.map(b => {
    if (!object(b) || !id(b.batchId) || !epoch(b.receivedAt) || !integer(b.eventCount, 1, 50) ||
      typeof b.payloadPresent !== 'boolean' || typeof b.eligible !== 'boolean') bad();
    return { batchId: b.batchId, receivedAt: b.receivedAt, eventCount: b.eventCount, payloadPresent: b.payloadPresent, eligible: b.eligible };
  });
  return { ok: true, synthetic: expectedSynthetic, status: value.status, account,
    coverage: { timeBasis: c.timeBasis, from: c.from, to: c.to, limit: c.limit, sampledAt: c.sampledAt,
      eventRetentionDays: c.eventRetentionDays, receiptRetentionDays: c.receiptRetentionDays, retentionCutoff: c.retentionCutoff,
      windowStartsBeforeRetention: c.windowStartsBeforeRetention, restoreGate: c.restoreGate,
      scope: c.scope, missingHistoryPossible: true }, events, batches,
    hasMoreEvents: value.hasMoreEvents, hasMoreBatches: value.hasMoreBatches };
}
