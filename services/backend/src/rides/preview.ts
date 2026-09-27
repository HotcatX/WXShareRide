import { z } from 'zod';
import type { Pool } from 'pg';
import { AppError } from '../errors.ts';
import { rideIdSchema } from './schemas.ts';
import { publicRideArea } from './read.ts';

const querySchema = z.strictObject({ kind: z.enum(['offer','request']).optional(),
  offset: z.coerce.number().int().min(0).max(10000).default(0), limit: z.coerce.number().int().min(1).max(20).default(10) });
type Row = { id: string; kind: 'offer' | 'request'; departureAt: Date; listedPriceCents: number | null;
  availableSeats: number; fromAddress: string; toAddress: string };
// Only fixed area names, scalar prices and schedule/capacity are projected for
// timeline previews. No note, arbitrary price label, exact address or identity.
const projection = `r.id,r.kind,r.departure_at AS "departureAt",r.listed_price_cents AS "listedPriceCents",
  r.seat_capacity-coalesce((SELECT sum(m.seat_count) FROM ride_members m WHERE m.ride_id=r.id AND m.state='active'),0)::int AS "availableSeats",
  (SELECT s.address FROM ride_stops s WHERE s.ride_id=r.id AND s.kind='departure' ORDER BY s.position LIMIT 1) AS "fromAddress",
  (SELECT s.address FROM ride_stops s WHERE s.ride_id=r.id AND s.kind='destination' ORDER BY s.position LIMIT 1) AS "toAddress"`;
const source = "FROM rides r JOIN users owner ON owner.id=r.creator_id WHERE owner.app_id=$1 AND r.status='open' AND r.departure_at>statement_timestamp()";
function item(row: Row) {
  return { id: row.id, kind: row.kind, departureAt: row.departureAt, timeZone: 'America/New_York',
    fromArea: publicRideArea(row.fromAddress ?? ''), toArea: publicRideArea(row.toAddress ?? ''),
    listedPriceCents: row.listedPriceCents, availableSeats: row.availableSeats };
}
export async function listRidePreviews(pool: Pool, appId: string, raw: unknown) {
  const query = querySchema.parse(raw);
  const rows = (await pool.query<Row>(`SELECT ${projection} ${source} AND ($2::text IS NULL OR r.kind=$2)
    ORDER BY r.departure_at,r.id LIMIT $3 OFFSET $4`, [appId, query.kind ?? null, query.limit + 1, query.offset])).rows;
  return { items: rows.slice(0, query.limit).map(item), hasMore: rows.length > query.limit,
    nextOffset: query.offset + Math.min(rows.length, query.limit) };
}
export async function getRidePreview(pool: Pool, appId: string, rawId: unknown) {
  const id = rideIdSchema.parse(rawId);
  const row = (await pool.query<Row>(`SELECT ${projection} ${source} AND r.id=$2`, [appId,id])).rows[0];
  if (!row) throw new AppError(404, 'RIDE_NOT_FOUND', '行程不存在或已结束');
  return item(row);
}
