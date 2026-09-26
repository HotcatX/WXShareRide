import { z } from 'zod';
import type { Pool } from 'pg';
import { AppError } from '../errors.ts';
import { listRidesSchema, rideIdSchema } from './schemas.ts';
import { publicProjection } from './service.ts';

export type RideParticipant = {
  id: string; name: string; avatarUrl: string;
  role: 'driver' | 'passenger'; seatCount: number;
  phone?: string; phoneRegion?: string; wechatId?: string;
  vehicle?: { plate?: string; brand?: string; model?: string };
  zelle?: { name?: string; account?: string };
  pickupAddress?: string; dropoffAddress?: string;
};

type Participants = {
  rideId: string; kind: 'offer' | 'request'; version: number;
  participants: RideParticipant[]; largeLuggageCount?: number;
};

// Authorization, current membership and every disclosed field are read by this
// one statement. PostgreSQL's statement snapshot cannot mix an old permission
// check with a replacement driver or newly joined member from a later snapshot.
// Keep the whitelist in SQL: never select a complete profile or member details.
export async function getRideParticipants(pool: Pool, userId: string, id: unknown): Promise<Participants> {
  const rideId = rideIdSchema.parse(id);
  const result = await pool.query<Participants & { largeLuggageCount: unknown }>(`
    SELECT r.id AS "rideId", r.kind, r.version,
      CASE WHEN r.kind = 'request' THEN r.details->'largeLuggageCount' END AS "largeLuggageCount",
      COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', u.id, 'name', u.name, 'avatarUrl', u.avatar_url,
        'role', m.role, 'seatCount', m.seat_count,
        'phone', CASE WHEN jsonb_typeof(u.profile->'phone') = 'string' THEN u.profile->'phone' END,
        'phoneRegion', CASE WHEN jsonb_typeof(u.profile->'phoneRegion') = 'string' THEN u.profile->'phoneRegion' END,
        'wechatId', CASE WHEN jsonb_typeof(u.profile->'wechatId') = 'string' THEN u.profile->'wechatId' END,
        'vehicle', CASE WHEN m.role = 'driver' THEN NULLIF(jsonb_strip_nulls(jsonb_build_object(
          'plate', CASE WHEN jsonb_typeof(u.profile->'vehicle'->'plate') = 'string' THEN u.profile->'vehicle'->'plate' END,
          'brand', CASE WHEN jsonb_typeof(u.profile->'vehicle'->'brand') = 'string' THEN u.profile->'vehicle'->'brand' END,
          'model', CASE WHEN jsonb_typeof(u.profile->'vehicle'->'model') = 'string' THEN u.profile->'vehicle'->'model' END
        )), '{}'::jsonb) END,
        'zelle', CASE WHEN m.role = 'driver' AND (r.kind = 'request' OR r.details->'zelleDisplay' = 'true'::jsonb)
          THEN NULLIF(jsonb_strip_nulls(jsonb_build_object(
            'name', CASE WHEN jsonb_typeof(u.profile->'zelle'->'name') = 'string' THEN u.profile->'zelle'->'name' END,
            'account', CASE WHEN jsonb_typeof(u.profile->'zelle'->'account') = 'string' THEN u.profile->'zelle'->'account' END
          )), '{}'::jsonb) END,
        'pickupAddress', CASE WHEN r.kind = 'offer' AND m.role = 'passenger'
          AND (mine.role = 'driver' OR m.user_id = mine.user_id)
          AND jsonb_typeof(m.details->'pickupAddress') = 'string' THEN m.details->'pickupAddress' END,
        'dropoffAddress', CASE WHEN r.kind = 'offer' AND m.role = 'passenger'
          AND (mine.role = 'driver' OR m.user_id = mine.user_id)
          AND jsonb_typeof(m.details->'dropoffAddress') = 'string' THEN m.details->'dropoffAddress' END
      )) ORDER BY CASE m.role WHEN 'driver' THEN 0 ELSE 1 END, m.user_id)
      FROM ride_members m JOIN users u ON u.id = m.user_id
      WHERE m.ride_id = r.id AND m.state = 'active'
        AND (r.kind = 'request' OR mine.role = 'driver' OR m.user_id = mine.user_id OR m.role = 'driver')
      ), '[]'::jsonb) AS participants
    FROM rides r JOIN ride_members mine ON mine.ride_id = r.id
    WHERE r.id = $1 AND r.status <> 'cancelled' AND mine.user_id = $2 AND mine.state = 'active'`,
  [rideId, userId]);
  const row = result.rows[0];
  // The same response covers absent, cancelled and unauthorized rides.
  if (!row) throw new AppError(404, 'RIDE_NOT_FOUND', '行程不存在或无权查看');
  const { largeLuggageCount, ...data } = row;
  return typeof largeLuggageCount === 'number' && Number.isSafeInteger(largeLuggageCount) && largeLuggageCount >= 0
    ? { ...data, largeLuggageCount } : data;
}

const myRidesSchema = listRidesSchema.pick({ page: true, limit: true }).extend({
  scope: z.enum(['current', 'history']).default('current'),
  role: z.enum(['driver', 'passenger']).optional(),
});

/** History means a retained relationship on a past/closed ride, not confirmed travel. */
export async function listMyRides(pool: Pool, userId: string, query: unknown) {
  const input = myRidesSchema.parse(query);
  const order = input.scope === 'current' ? 'ASC' : 'DESC';
  const result = await pool.query(`SELECT ${publicProjection}, mine.role, mine.seat_count AS "seatCount"
    FROM rides r JOIN ride_members mine ON mine.ride_id = r.id
    WHERE mine.user_id = $1 AND mine.state = 'active' AND r.status <> 'cancelled'
      AND ($2::text IS NULL OR mine.role = $2)
      AND (($3 = 'current' AND r.status = 'open' AND r.departure_at > now())
        OR ($3 = 'history' AND (r.status = 'closed' OR r.departure_at <= now())))
    ORDER BY r.departure_at ${order}, r.id ${order} LIMIT $4 OFFSET $5`,
  [userId, input.role ?? null, input.scope, input.limit + 1, (input.page - 1) * input.limit]);
  return { rides: result.rows.slice(0, input.limit), nextPage: input.page < 1000 && result.rows.length > input.limit ? input.page + 1 : null };
}
