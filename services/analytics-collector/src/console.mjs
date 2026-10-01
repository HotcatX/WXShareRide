import { statSync } from 'node:fs';
import { TABLES } from './schema.mjs';
import { purposeVersionSql } from './compat/legacy.mjs';
import { decodePayload } from './payload.mjs';
import { requireThat } from './errors.mjs';
import { eventSchemas, id, shape, validateBatch } from './validation.mjs';

export const CONSOLE_STATUS_ROUTE = '/v1/console/snapshot';
export const CONSOLE_EVENTS_ROUTE = '/v1/console/events';
const DAY = 86_400_000;
const MAX_RESPONSE = 196_608;
const epoch = value => Number.isSafeInteger(value) && value >= 0;
const subject = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const cursorFields = { at: epoch, participant: id, event: id, from: epoch, to: epoch,
  synthetic: value => typeof value === 'boolean', subject: value => value === null || subject(value),
  type: value => value === null || Object.hasOwn(eventSchemas, value) };

export function initializeConsole(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS console_event_time ON event_receipts(received_at DESC,participant_key DESC,event_id DESC);
    CREATE INDEX IF NOT EXISTS console_account_event_time ON event_receipts(participant_key,received_at DESC,event_id DESC);`);
}

function query(input, now) {
  requireThat(shape(input, { limit: value => Number.isInteger(value) && value >= 1 && value <= 50,
    cursor: value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,768}$/.test(value), subject,
    synthetic: value => typeof value === 'boolean', from: epoch, to: epoch,
    type: value => typeof value === 'string' && Object.hasOwn(eventSchemas, value) }, []), 422, 'INVALID_CONSOLE_QUERY');
  let cursor = null;
  if (input.cursor) {
    try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')); }
    catch { requireThat(false, 422, 'INVALID_CONSOLE_CURSOR'); }
    requireThat(shape(cursor, cursorFields), 422, 'INVALID_CONSOLE_CURSOR');
  }
  const synthetic = input.synthetic ?? cursor?.synthetic ?? false;
  const result = { limit: input.limit ?? 25, subject: input.subject ?? cursor?.subject ?? null,
    type: input.type ?? cursor?.type ?? null, synthetic,
    from: input.from ?? cursor?.from ?? Math.max(0, now - (synthetic ? 14 : 180) * DAY),
    to: input.to ?? cursor?.to ?? now, cursor };
  requireThat(result.from <= result.to && result.to <= now + 300_000
    && result.to - result.from <= 180 * DAY, 422, 'INVALID_CONSOLE_QUERY');
  if (cursor) requireThat(cursor.from === result.from && cursor.to === result.to
    && cursor.subject === result.subject && cursor.synthetic === result.synthetic && cursor.type === result.type
    && cursor.at >= result.from && cursor.at <= result.to, 422, 'INVALID_CONSOLE_CURSOR');
  return result;
}

function processSnapshot(previous, now) {
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  const elapsed = now - (previous?.at ?? now);
  return { sample: { at: now, cpu }, value: { scope: 'process', sampledAt: now,
    uptimeSeconds: Math.floor(process.uptime()), cpuBasis: 'one_core',
    cpuPercent: elapsed > 0 ? Math.max(0, (cpu.user + cpu.system - previous.cpu.user - previous.cpu.system) / (elapsed * 10)) : null,
    memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal } } };
}

export function createConsole(store, config, { clock = Date.now } = {}) {
  const db = store.db;
  let cached, previous;
  const status = () => {
    const now = clock();
    if (cached && now - cached.sampledAt < 10_000) return cached;
    const sample = processSnapshot(previous, now); previous = sample.sample;
    const recent = db.prepare(`WITH recent AS MATERIALIZED (
      SELECT participant_key FROM event_receipts INDEXED BY console_event_time WHERE received_at>=?
      ORDER BY received_at DESC,participant_key DESC,event_id DESC LIMIT 5001)
      SELECT p.synthetic FROM recent r JOIN ${TABLES.participants} p ON p.participant_key=r.participant_key`).all(now - 60_000);
    const latest = db.prepare(`SELECT received_at FROM event_receipts INDEXED BY console_event_time
      ORDER BY received_at DESC,participant_key DESC,event_id DESC LIMIT 1`).get();
    const bytes = path => { try { return statSync(path).size; } catch { return 0; } };
    return cached = { ok: true, sampledAt: now, process: sample.value,
      storage: { databaseBytes: bytes(config.dbPath), walBytes: bytes(`${config.dbPath}-wal`) },
      collection: { enabled: Boolean(config.realEnabled),
        restoreGate: db.prepare("SELECT value FROM collector_settings WHERE key='restore_gate'").get().value,
        latestReceivedAt: latest?.received_at ?? null, receivedLastMinute: recent.slice(0, 5000).filter(row => row.synthetic === 0).length,
        receivedLastMinuteCapped: recent.length > 5000 } };
  };
  const events = (input, now = clock()) => {
    const request = query(input, now);
    return db.transaction(() => {
      const result = { ok: true, sampledAt: now, timeBasis: 'receivedAt', from: request.from, to: request.to,
        events: [], nextCursor: null, scanned: 0 };
      if (db.prepare("SELECT value FROM collector_settings WHERE key='restore_gate'").get().value !== 'open') return result;
      const participant = request.subject ? db.prepare(`SELECT participant_key FROM ${TABLES.accounts} WHERE account_subject=?`).get(request.subject)?.participant_key : null;
      if (request.subject && !participant) return result;
      const params = [request.from, request.to];
      const filters = ['r.received_at>=?', 'r.received_at<=?'];
      if (participant) { filters.push('r.participant_key=?'); params.push(participant); }
      if (request.cursor) {
        filters.push('(r.received_at,r.participant_key,r.event_id)<(?,?,?)');
        params.push(request.cursor.at, request.cursor.participant, request.cursor.event);
      }
      const rows = db.prepare(`WITH chosen AS MATERIALIZED (
        SELECT r.participant_key,r.event_id,r.first_batch_id,r.received_at
        FROM event_receipts r INDEXED BY ${participant ? 'console_account_event_time' : 'console_event_time'}
        WHERE ${filters.join(' AND ')} ORDER BY r.received_at DESC,r.participant_key DESC,r.event_id DESC LIMIT 201)
        SELECT c.*,a.openid,p.synthetic,b.received_at AS batch_received_at,
          (p.status='active' AND p.grant_id=b.grant_id AND ${purposeVersionSql('p.purpose_version')}=${purposeVersionSql('b.purpose_version')}) AS eligible
        FROM chosen c LEFT JOIN ${TABLES.participants} p ON p.participant_key=c.participant_key
        LEFT JOIN ingest_batches b ON b.participant_key=c.participant_key AND b.batch_id=c.first_batch_id
        LEFT JOIN ${TABLES.accounts} a ON a.participant_key=c.participant_key
        ORDER BY c.received_at DESC,c.participant_key DESC,c.event_id DESC`).all(...params);
      const batches = new Map();
      const readBatch = db.prepare('SELECT payload,codec,raw_bytes FROM ingest_batches WHERE participant_key=? AND batch_id=?');
      let bytes = 0, last = null, decoded = 0;
      for (const row of rows.slice(0, 200)) {
        if (result.events.length >= request.limit || decoded >= 50) break;
        if (row.eligible === 1 && row.synthetic === Number(request.synthetic)
          && row.batch_received_at > now - (request.synthetic ? 14 : 180) * DAY) {
          const key = `${row.participant_key}/${row.first_batch_id}`;
          let body = batches.get(key);
          if (!body) {
            const saved = readBatch.get(row.participant_key, row.first_batch_id);
            try {
              body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodePayload(saved.payload, saved.codec, saved.raw_bytes)));
              validateBatch(body, now, false);
              requireThat(body.batchId === row.first_batch_id, 503, 'CONSOLE_SCHEMA_UNAVAILABLE');
            } catch { requireThat(false, 503, 'CONSOLE_SCHEMA_UNAVAILABLE'); }
            batches.set(key, body); decoded++;
          }
          const event = body.events.find(event => event.eventId === row.event_id);
          requireThat(event, 503, 'CONSOLE_SCHEMA_UNAVAILABLE');
          if (!request.type || request.type === event.eventName) {
            const item = { openid: row.openid ?? null, participantKey: row.participant_key,
              batchId: row.first_batch_id, receivedAt: row.received_at, ...event };
            const size = Buffer.byteLength(JSON.stringify(item));
            if (bytes + size > MAX_RESPONSE) break;
            bytes += size; result.events.push(item);
          }
        }
        last = row; result.scanned++;
      }
      if (last && result.scanned < rows.length) result.nextCursor = Buffer.from(JSON.stringify({ at: last.received_at,
        participant: last.participant_key, event: last.event_id, from: request.from, to: request.to,
        subject: request.subject, synthetic: request.synthetic, type: request.type })).toString('base64url');
      return result;
    }).deferred();
  };
  return { status, events };
}
