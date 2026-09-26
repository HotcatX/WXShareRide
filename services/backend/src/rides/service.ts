import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withIdempotency } from '../db.ts';
import { AppError } from '../errors.ts';
import { assertNoBlockedMembers } from '../blocks/service.ts';
import { notifyRideEvent } from '../notifications/service.ts';
import { cancelRideSchema, createRideSchema, joinRideSchema, leaveRideSchema, listRidesSchema, rideIdSchema } from './schemas.ts';

type Ride = {
  id: string; kind: 'offer' | 'request'; creator_id: string;
  status: 'open' | 'cancelled' | 'closed'; seat_capacity: number;
  departure_at: Date; version: number;
};
type Member = { user_id: string; role: 'driver' | 'passenger'; seat_count: number; state: 'active' | 'left';
  details: { pickupAddress?: string; dropoffAddress?: string } };

async function lockedRide(client: PoolClient, rideId: string): Promise<Ride> {
  const result = await client.query<Ride>(`SELECT id, kind, creator_id, status, seat_capacity, departure_at, version
    FROM rides WHERE id = $1 FOR UPDATE`, [rideId]);
  if (!result.rows[0]) throw new AppError(404, 'RIDE_NOT_FOUND', '行程不存在');
  return result.rows[0];
}

function assertJoinable(ride: Ride) {
  if (ride.status !== 'open' || new Date(ride.departure_at).getTime() <= Date.now()) {
    throw new AppError(409, 'RIDE_NOT_OPEN', '行程已结束或取消');
  }
}

async function recordEvent(client: PoolClient, ride: Ride, actorId: string, action: string, payload: object) {
  const eventId = randomUUID();
  await client.query(`INSERT INTO business_events(id, ride_id, ride_version, action, actor_id, payload, created_at)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp())`,
  [eventId, ride.id, ride.version, action, actorId, JSON.stringify(payload)]);
  await notifyRideEvent(client, { eventId, rideId: ride.id, kind: ride.kind, creatorId: ride.creator_id,
    actorId, action, payload: payload as Record<string, unknown> });
}

async function advanceVersion(client: PoolClient, ride: Ride): Promise<Ride> {
  const result = await client.query<{ version: number }>(`UPDATE rides SET version = version + 1, updated_at = clock_timestamp()
    WHERE id = $1 RETURNING version`, [ride.id]);
  return { ...ride, version: result.rows[0].version };
}

const writeResult = (ride: Ride, changed = true) => ({
  status: 200,
  data: { rideId: ride.id, version: ride.version, status: ride.status, changed },
});

export async function createRide(pool: Pool, userId: string, key: unknown, body: unknown) {
  const input = createRideSchema.parse(body);
  return withIdempotency(pool, userId, 'rides.create', key, input, async client => {
    // Stop order and nondecreasing times were validated once at the boundary.
    // The first departure is the whole-ride booking deadline and list index.
    const departureAt = input.stops.find(stop => stop.kind === 'departure')!.departureAt;
    const details: Record<string, unknown> = { note: input.note };
    if (input.kind === 'offer') {
      // Freeze this ride's disclosure choice. Profile edits can change the
      // default for future rides, but cannot change an already published choice.
      const profile = await client.query<{ zelle_display: boolean }>(`SELECT
        COALESCE(profile #> '{zelle,public}' = 'true'::jsonb, false) AS zelle_display
        FROM users WHERE id = $1 FOR SHARE`, [userId]);
      if (!profile.rows[0]) throw new AppError(404, 'USER_NOT_FOUND', '用户不存在');
      details.zelleDisplay = profile.rows[0].zelle_display;
    } else details.largeLuggageCount = input.largeLuggageCount;
    // A profile lock may have waited beyond the requested first departure.
    if (Date.parse(departureAt) <= Date.now()) throw new AppError(400, 'INVALID_DEPARTURE', '请选择未来出发时间');
    const rideId = randomUUID();
    // A request creator can reserve several passenger seats. Request capacity
    // remains four, matching the existing request business rule.
    const capacity = input.kind === 'offer' ? input.seatCapacity : 4;
    const result = await client.query<Ride>(`INSERT INTO rides
      (id, kind, creator_id, city_key, status, seat_capacity, departure_at, time_zone, listed_price_cents, details)
      VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, $8, $9::jsonb)
      RETURNING id, kind, creator_id, status, seat_capacity, departure_at, version`,
    [rideId, input.kind, userId, input.cityKey, capacity, departureAt, input.timeZone,
      input.listedPriceCents, JSON.stringify(details)]);
    const ride = result.rows[0];
    await client.query(`INSERT INTO ride_stops(ride_id, position, kind, address, place_id, departure_at)
      SELECT $1, position - 1, stop->>'kind', stop->>'address', stop->>'placeId',
        (stop->>'departureAt')::timestamptz
      FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS item(stop, position)`,
    [rideId, JSON.stringify(input.stops)]);
    await client.query(`INSERT INTO ride_members(ride_id, user_id, role, seat_count, state, joined_at)
      VALUES ($1, $2, $3, $4, 'active', clock_timestamp())`,
    [rideId, userId, input.kind === 'offer' ? 'driver' : 'passenger', input.kind === 'offer' ? 0 : input.partySize]);
    await recordEvent(client, ride, userId, 'created', { rideId, kind: input.kind, capacity });
    return { ...writeResult(ride), status: 201 };
  });
}

export async function joinRide(pool: Pool, userId: string, key: unknown, id: unknown, body: unknown) {
  const rideId = rideIdSchema.parse(id);
  const input = joinRideSchema.parse(body);
  return withIdempotency(pool, userId, 'rides.join', key, { rideId, ...input }, async client => {
    // Every membership mutation locks the ride first. Available seats are
    // derived from memberships; no second counter can drift or be overwritten.
    const ride = await lockedRide(client, rideId);
    assertJoinable(ride);
    if (ride.creator_id === userId) throw new AppError(403, 'CREATOR_ALREADY_MEMBER', '不能加入自己发布的行程');
    if (ride.kind === 'offer' && input.role !== 'passenger') throw new AppError(400, 'INVALID_ROLE', '供车行程只能以乘客身份加入');
    let details: Member['details'] = {};
    if (input.role === 'passenger') {
      if (ride.kind === 'offer') {
        if (!input.pickupAddress || !input.dropoffAddress) throw new AppError(400, 'PICKUP_DROPOFF_REQUIRED', '请填写上下车说明');
        details = { pickupAddress: input.pickupAddress, dropoffAddress: input.dropoffAddress };
      } else if (input.pickupAddress !== undefined || input.dropoffAddress !== undefined) {
        throw new AppError(400, 'INVALID_JOIN_DETAILS', '求车加入不接受个人接送说明');
      }
    }
    const members = (await client.query<Member>(`SELECT user_id, role, seat_count, state, details FROM ride_members
      WHERE ride_id = $1 AND state = 'active'`, [rideId])).rows;
    const current = members.find(member => member.user_id === userId);
    const seatCount = input.role === 'passenger' ? input.seatCount : 0;
    if (current) {
      if (current.role !== input.role || current.seat_count !== seatCount ||
        current.details.pickupAddress !== details.pickupAddress || current.details.dropoffAddress !== details.dropoffAddress) {
        throw new AppError(409, 'MEMBERSHIP_EXISTS', '已加入该行程，请先退出后再调整');
      }
      return writeResult(ride, false);
    }
    // Blocking prevents new relationships, never retroactively removes an
    // existing member. Pair locks serialize this check with block/unblock.
    await assertNoBlockedMembers(client, userId, [ride.creator_id, ...members.map(member => member.user_id)]);
    // Pair-lock waits can cross the first-departure deadline as well.
    assertJoinable(ride);
    if (input.role === 'driver' && members.some(member => member.role === 'driver')) {
      throw new AppError(409, 'DRIVER_ALREADY_ASSIGNED', '该求车已被其他司机接单');
    }
    const occupied = members.reduce((sum, member) => sum + member.seat_count, 0);
    if (occupied + seatCount > ride.seat_capacity) throw new AppError(409, 'INSUFFICIENT_SEATS', '行程剩余座位不足');
    await client.query(`INSERT INTO ride_members(ride_id, user_id, role, seat_count, state, joined_at, details)
      VALUES ($1, $2, $3, $4, 'active', clock_timestamp(), $5::jsonb) ON CONFLICT (ride_id, user_id) DO UPDATE
      SET role = EXCLUDED.role, seat_count = EXCLUDED.seat_count, state = 'active',
        joined_at = EXCLUDED.joined_at, left_at = NULL, details = EXCLUDED.details`,
    [rideId, userId, input.role, seatCount, JSON.stringify(details)]);
    const changed = await advanceVersion(client, ride);
    await recordEvent(client, changed, userId, 'joined', { role: input.role, seatCount });
    return writeResult(changed);
  });
}

export async function leaveRide(pool: Pool, userId: string, key: unknown, id: unknown, body: unknown) {
  const rideId = rideIdSchema.parse(id);
  const input = leaveRideSchema.parse(body);
  return withIdempotency(pool, userId, 'rides.leave', key, { rideId, ...input }, async client => {
    const ride = await lockedRide(client, rideId);
    if (ride.creator_id === userId) throw new AppError(403, 'CREATOR_MUST_CANCEL', '创建者请取消行程');
    const member = (await client.query<Member>(`SELECT user_id, role, seat_count, state FROM ride_members
      WHERE ride_id = $1 AND user_id = $2`, [rideId, userId])).rows[0];
    if (!member) throw new AppError(409, 'NOT_A_MEMBER', '尚未加入该行程');
    if (member.state === 'left') return writeResult(ride, false);
    // Membership of completed rides is historical evidence, not a live booking.
    assertJoinable(ride);
    // now() is the transaction start, which can precede a join committed while
    // this transaction waited for the ride lock. Use the actual mutation time.
    await client.query(`UPDATE ride_members SET state = 'left', left_at = GREATEST(clock_timestamp(), joined_at)
      WHERE ride_id = $1 AND user_id = $2`, [rideId, userId]);
    const changed = await advanceVersion(client, ride);
    await recordEvent(client, changed, userId, 'left', { role: member.role, seatCount: member.seat_count, reason: input.reason });
    return writeResult(changed);
  });
}

export async function cancelRide(pool: Pool, userId: string, key: unknown, id: unknown, body: unknown) {
  const rideId = rideIdSchema.parse(id);
  const input = cancelRideSchema.parse(body);
  return withIdempotency(pool, userId, 'rides.cancel', key, { rideId, ...input }, async client => {
    const ride = await lockedRide(client, rideId);
    if (ride.creator_id !== userId) throw new AppError(403, 'NOT_RIDE_CREATOR', '只有创建者可以取消行程');
    if (ride.status === 'cancelled') return writeResult(ride, false);
    assertJoinable(ride);
    await client.query(`UPDATE rides SET status = 'cancelled' WHERE id = $1`, [rideId]);
    const changed = await advanceVersion(client, { ...ride, status: 'cancelled' });
    // Capture the active recipients before closing memberships, in this same transaction.
    await recordEvent(client, changed, userId, 'cancelled', { reason: input.reason });
    await client.query(`UPDATE ride_members SET state = 'left', left_at = GREATEST(clock_timestamp(), joined_at)
      WHERE ride_id = $1 AND state = 'active'`, [rideId]);
    return writeResult(changed);
  });
}

// Explicit public projection: never serialize users, memberships, OpenID,
// arbitrary imported details, contact information or business event payloads.
export const publicProjection = `r.id, r.kind, r.city_key AS "cityKey", r.status,
  r.seat_capacity AS "seatCapacity", r.departure_at AS "departureAt", r.time_zone AS "timeZone",
  r.listed_price_cents AS "listedPriceCents", r.listed_price_label AS "listedPriceLabel", r.version,
  COALESCE(r.details->>'note', '') AS note,
  r.seat_capacity - COALESCE((SELECT sum(m.seat_count) FROM ride_members m
    WHERE m.ride_id = r.id AND m.state = 'active'), 0)::integer AS "availableSeats",
  EXISTS(SELECT 1 FROM ride_members m WHERE m.ride_id = r.id AND m.role = 'driver'
    AND m.state = 'active') AS "hasDriver",
  COALESCE((SELECT jsonb_agg(jsonb_build_object('position', s.position, 'kind', s.kind,
    'address', s.address, 'placeId', s.place_id, 'departureAt', s.departure_at) ORDER BY s.position)
    FROM ride_stops s WHERE s.ride_id = r.id), '[]'::jsonb) AS stops`;

export async function listRides(pool: Pool, query: unknown) {
  const input = listRidesSchema.parse(query);
  const result = await pool.query(`SELECT ${publicProjection} FROM rides r
    WHERE r.city_key = $1 AND r.status = 'open' AND r.departure_at > now()
      AND ($2::text IS NULL OR r.kind = $2)
    ORDER BY r.departure_at, r.id LIMIT $3 OFFSET $4`,
  [input.cityKey, input.kind || null, input.limit + 1, (input.page - 1) * input.limit]);
  return { rides: result.rows.slice(0, input.limit), nextPage: input.page < 1000 && result.rows.length > input.limit ? input.page + 1 : null };
}

export async function getRide(pool: Pool, id: unknown) {
  const rideId = rideIdSchema.parse(id);
  const result = await pool.query(`SELECT ${publicProjection} FROM rides r
    WHERE r.id = $1 AND r.status <> 'cancelled'`, [rideId]);
  if (!result.rows[0]) throw new AppError(404, 'RIDE_NOT_FOUND', '行程不存在');
  return result.rows[0];
}
