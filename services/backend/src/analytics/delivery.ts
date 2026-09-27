import { createSignedCollectorRequest } from './transport.ts';
import type { Pool } from 'pg';
import { AppError } from '../errors.ts';

const path = '/internal/v1/places/business-events';
const maxBatchBytes = 112 * 1024;
const eventIdPattern = /^[A-Za-z0-9_-]{1,80}$/;
const unavailable = () => new AppError(503, 'COLLECTOR_DELIVERY_UNAVAILABLE', '统计事件交付暂不可用');
export type CollectorTransport = (body: string) => Promise<unknown>;
export type DeliveryResult = { sent: number; delivered: number; lockSkipped: 0 | 1 };

/** Frozen business facts use the shared bounded transport, but only a 200
 * collector ACK can advance their durable delivery marker. */
export function createCollectorTransport(config: { origin: string; key: Buffer }, transport: typeof fetch = fetch): CollectorTransport {
  const request = createSignedCollectorRequest(config, path, transport);
  return async body => {
    const response = await request(body);
    if (response.status !== 200) throw unavailable();
    return response.body;
  };
}

type EventRow = { id: string; collector_payload: string; size: number };
function batch(rows: EventRow[]) {
  const parts: string[] = [];
  const ids = new Map<string, string>();
  let size = Buffer.byteLength('{"schemaVersion":1,"events":[]}');
  for (const row of rows) {
    if (typeof row.collector_payload !== 'string' || row.size !== Buffer.byteLength(row.collector_payload)) throw unavailable();
    const nextSize = row.size + (parts.length ? 1 : 0);
    if (size + nextSize > maxBatchBytes) {
      if (!parts.length) throw unavailable();
      break;
    }
    const event: unknown = JSON.parse(row.collector_payload);
    if (!event || typeof event !== 'object' || Array.isArray(event) ||
        !('eventId' in event) || typeof event.eventId !== 'string' || !eventIdPattern.test(event.eventId) || event.eventId !== row.id ||
        JSON.stringify(event) !== row.collector_payload || ids.has(event.eventId)) throw unavailable();
    ids.set(event.eventId, row.id); parts.push(row.collector_payload); size += nextSize;
  }
  return { body: `{"schemaVersion":1,"events":[${parts.join(',')}]}`, ids };
}

function acknowledged(response: unknown, sent: Map<string, string>): string[] {
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw unavailable();
  const ack = response as Record<string, unknown>;
  if (Object.keys(ack).some(key => !['ok', 'acceptedEventIds', 'duplicateEventIds'].includes(key)) || ack.ok !== true) throw unavailable();
  const ids = new Set<string>();
  for (const field of ['acceptedEventIds', 'duplicateEventIds']) {
    const values = ack[field];
    if (!Array.isArray(values) || values.length > sent.size || new Set(values).size !== values.length) throw unavailable();
    for (const id of values) {
      if (typeof id !== 'string' || !eventIdPattern.test(id) || !sent.has(id)) throw unavailable();
      ids.add(sent.get(id)!);
    }
  }
  return [...ids];
}

/** One bounded batch per call; the caller decides when to invoke it again.
 * The session lock prevents overlap without holding a business transaction over
 * network I/O. Only collector ACKs can complete a frozen event; a lost ACK retries
 * identical bytes and the collector deduplicates their immutable event IDs. */
export async function deliverBusinessEvents(pool: Pool, appId: string, send: CollectorTransport): Promise<DeliveryResult> {
  if (typeof appId !== 'string' || !appId.length || appId.length > 128 || appId.trim() !== appId || typeof send !== 'function') throw unavailable();
  const lock = JSON.stringify(['linkx-collector-delivery', appId]);
  const client = await pool.connect().catch(() => { throw unavailable(); });
  let locked = false, broken = false;
  const failed = () => { broken = true; };
  client.on('error', failed);
  try {
    locked = (await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [lock])).rows[0]?.acquired === true;
    if (!locked) return { sent: 0, delivered: 0, lockSkipped: 1 };
    const rows = (await client.query<EventRow>(
      `SELECT e.id, e.collector_payload, octet_length(e.collector_payload) AS size
       FROM business_events e JOIN rides r ON r.id=e.ride_id JOIN users u ON u.id=r.creator_id
       WHERE u.app_id=$1 AND e.collector_payload IS NOT NULL AND e.collector_delivered_at IS NULL
       ORDER BY e.created_at,e.id LIMIT 10`, [appId]
    )).rows;
    if (!rows.length) return { sent: 0, delivered: 0, lockSkipped: 0 };
    const selected = batch(rows);
    const response = await send(selected.body);
    if (broken) throw unavailable();
    const ids = acknowledged(response, selected.ids);
    let delivered = 0;
    if (ids.length) {
      const result = await client.query(
        `UPDATE business_events e SET collector_delivered_at=clock_timestamp()
         FROM rides r JOIN users u ON u.id=r.creator_id
         WHERE e.ride_id=r.id AND u.app_id=$1 AND e.id=ANY($2::text[]) AND e.collector_delivered_at IS NULL`,
        [appId, ids]
      );
      delivered = result.rowCount ?? 0;
      if (delivered !== ids.length) throw unavailable();
    }
    return { sent: selected.ids.size, delivered, lockSkipped: 0 };
  } catch { throw unavailable(); }
  finally {
    if (locked && !broken) {
      try {
        const result = await client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked', [lock]);
        if (result.rows[0]?.unlocked !== true) broken = true;
      } catch { broken = true; }
    }
    client.release(broken);
    client.removeListener('error', failed);
  }
}
