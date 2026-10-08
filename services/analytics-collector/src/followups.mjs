import { decodePayload } from './payload.mjs';
import { validateBatch } from './validation.mjs';
import { createHash } from 'node:crypto';

const CURSOR = 'followup_index_cursor';
const utf8 = new TextDecoder('utf-8', { fatal: true });
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const hash = value => createHash('sha256').update(value).digest('hex');

// This narrow projection belongs to the original batch. Deleting a payload for
// withdrawal, retention or recovery also deletes its derived follow-up data.
export function initializeFollowups(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS followup_events (
    participant_key TEXT NOT NULL, event_id TEXT NOT NULL, batch_id TEXT NOT NULL,
    occurred_at INTEGER NOT NULL, trip_id TEXT NOT NULL, trip_type TEXT NOT NULL,
    role TEXT NOT NULL, source TEXT NOT NULL, outcome TEXT NOT NULL, release INTEGER NOT NULL,
    PRIMARY KEY(participant_key,event_id),
    FOREIGN KEY(participant_key,batch_id) REFERENCES ingest_batches(participant_key,batch_id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX IF NOT EXISTS followup_batch ON followup_events(participant_key,batch_id);`);
  db.prepare('INSERT OR IGNORE INTO collector_settings VALUES (?,?)').run(CURSOR,
    db.prepare('SELECT 1 FROM ingest_batches LIMIT 1').get() ? '[]' : 'ready');
}

export function createFollowupIndex(db) {
  let scheduled, closed = false, failed = false;
  const cursor = db.prepare('SELECT value FROM collector_settings WHERE key=?');
  const saveCursor = db.prepare('UPDATE collector_settings SET value=? WHERE key=?');
  const insert = db.prepare('INSERT OR IGNORE INTO followup_events VALUES (?,?,?,?,?,?,?,?,?,?)');
  const receipt = db.prepare('SELECT first_batch_id,event_hash FROM event_receipts WHERE participant_key=? AND event_id=?');
  const record = (participantKey, batchId, event) => {
    const d = event.data;
    const source = event.eventName === 'followup_answer' ? 'self_report'
      : event.eventName === 'followup_dismissed' && d.dismissalReason === 'close' && d.assumedOutcome === 'yes'
        && d.outcomeScope === (d.role === 'driver' ? 'driver_any_passenger' : 'respondent_booking') ? 'dismissed_default' : null;
    if (source) insert.run(participantKey, event.eventId, batchId, event.occurredAt,
      d.tripKey, d.tripType, d.role, source, source === 'self_report' ? d.outcome : 'yes', Number(event.context?.buildMode === 'release'));
  };
  const status = () => failed ? 'unavailable' : cursor.get(CURSOR).value === 'ready' ? 'ready' : 'building';
  // At most eight bounded upload payloads are decoded per event-loop turn.
  // The committed cursor survives restarts; live writes project their own first
  // events even when a newly received batch sorts before the backfill cursor.
  const backfillStep = db.transaction(() => {
    const current = cursor.get(CURSOR).value;
    if (current === 'ready') return true;
    const after = JSON.parse(current);
    const rows = db.prepare(`SELECT b.participant_key,b.batch_id,b.payload,b.codec,b.raw_bytes,r.payload_hash FROM ingest_batches b
      JOIN batch_receipts r ON r.participant_key=b.participant_key AND r.batch_id=b.batch_id
      WHERE (b.participant_key,b.batch_id)>(?,?) ORDER BY b.participant_key,b.batch_id LIMIT 8`).all(after[0] ?? '', after[1] ?? '');
    for (const row of rows) {
      const raw = decodePayload(row.payload, row.codec, row.raw_bytes);
      if (hash(raw) !== row.payload_hash) throw new Error('Invalid follow-up source receipt');
      const body = JSON.parse(utf8.decode(raw));
      validateBatch(body, Date.now(), false);
      if (body.batchId !== row.batch_id) throw new Error('Invalid follow-up source batch');
      for (const event of body.events) {
        const saved = receipt.get(row.participant_key, event.eventId);
        if (saved?.first_batch_id === row.batch_id) {
          if (hash(canonical(event)) !== saved.event_hash) throw new Error('Invalid follow-up event receipt');
          record(row.participant_key, row.batch_id, event);
        }
      }
    }
    saveCursor.run(rows.length < 8 ? 'ready' : JSON.stringify([rows.at(-1).participant_key, rows.at(-1).batch_id]), CURSOR);
    return rows.length < 8;
  });
  const start = () => {
    if (scheduled || closed || status() !== 'building') return;
    scheduled = setImmediate(() => {
      scheduled = undefined;
      if (closed) return;
      try { if (!backfillStep.immediate()) start(); }
      catch { failed = true; }
    });
  };
  return { record, status, start, backfillStep: () => backfillStep.immediate(),
    close() { closed = true; if (scheduled) clearImmediate(scheduled); } };
}
