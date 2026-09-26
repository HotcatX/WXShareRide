import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withIdempotency } from '../db.ts';
import { AppError } from '../errors.ts';
import { advanceRideVersion, recordRideEvent } from '../rides/events.ts';
import { rideIdSchema } from '../rides/schemas.ts';

const ratingSchema = z.strictObject({
  targetId: z.uuid().transform(value => value.toLowerCase()),
  score: z.number().int().min(1).max(5),
});
type RatingRole = 'driver' | 'passenger';
type LockedRide = { id: string; kind: 'offer' | 'request'; creator_id: string;
  status: 'open' | 'closed' | 'cancelled'; version: number };

/** Only the caller's own choices are returned; other members' scores stay private. */
export async function listMyRideRatings(pool: Pool, userId: string, id: unknown) {
  const rideId = rideIdSchema.parse(id);
  // Authorization and projection share one statement snapshot, so a membership
  // change cannot expose ratings between an access check and a second query.
  const result = await pool.query<{ ratings: { targetId: string; score: number }[] }>(`
    SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('targetId', target_id, 'score', score) ORDER BY target_id)
      FROM ride_ratings WHERE ride_id=r.id AND rater_id=$2), '[]'::jsonb) AS ratings
    FROM rides r JOIN ride_members m ON m.ride_id=r.id AND m.user_id=$2 AND m.state='active'
    WHERE r.id=$1 AND r.status<>'cancelled'`, [rideId, userId]);
  if (!result.rowCount) throw new AppError(404, 'RIDE_NOT_FOUND', '行程不存在');
  return { ratings: result.rows[0]!.ratings };
}

export async function rateRide(pool: Pool, userId: string, key: unknown, id: unknown, body: unknown) {
  const rideId = rideIdSchema.parse(id);
  const input = ratingSchema.parse(body);
  return withIdempotency(pool, userId, 'rides.rate', key, { rideId, ...input }, async client => {
    const locked = await client.query<LockedRide>(`
      SELECT id,kind,creator_id,status,version FROM rides WHERE id=$1 FOR UPDATE`, [rideId]);
    const ride = locked.rows[0];
    if (!ride || ride.status === 'cancelled') throw new AppError(404, 'RIDE_NOT_FOUND', '行程不存在');
    const members = (await client.query<{ user_id: string; role: RatingRole }>(`
      SELECT user_id,role FROM ride_members WHERE ride_id=$1 AND state='active' AND user_id=ANY($2::uuid[])`,
    [rideId, [userId, input.targetId]])).rows;
    const rater = members.find(member => member.user_id === userId);
    if (!rater) throw new AppError(404, 'RIDE_NOT_FOUND', '行程不存在');
    // Recheck the last departure using the database clock after acquiring the
    // ride lock. Neither a client clock nor the first stop proves completion.
    const elapsed = await client.query<{ ended: boolean }>(`
      SELECT COALESCE(max(departure_at)<clock_timestamp(), false) AS ended
      FROM ride_stops WHERE ride_id=$1 AND kind='departure'`, [rideId]);
    if (ride.status !== 'closed' || !elapsed.rows[0]!.ended) {
      throw new AppError(409, 'RIDE_NOT_ENDED', '行程结束后才能评价');
    }
    if (input.targetId === userId) throw new AppError(400, 'SELF_RATING_NOT_ALLOWED', '不能评价自己');
    const target = members.find(member => member.user_id === input.targetId);
    if (!target) throw new AppError(404, 'RATING_TARGET_NOT_FOUND', '同行成员不存在');
    if (rater.role === target.role) throw new AppError(403, 'RATING_ROLE_MISMATCH', '仅支持司机与乘客互评');
    const previous = await client.query(`SELECT 1 FROM ride_ratings WHERE ride_id=$1 AND rater_id=$2 AND target_id=$3`,
      [rideId, userId, input.targetId]);
    if (previous.rowCount) throw new AppError(409, 'ALREADY_RATED', '已评价该同行成员');

    const advanced = await advanceRideVersion(client, ride);
    const eventId = await recordRideEvent(client, advanced, userId, 'rated', {
      targetId: input.targetId, score: input.score, raterRole: rater.role, targetRole: target.role,
    });
    const ratingId = randomUUID();
    await client.query(`INSERT INTO ride_ratings(id,ride_id,rater_id,target_id,rater_role,target_role,score,event_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ratingId, rideId, userId, input.targetId, rater.role, target.role, input.score, eventId]);
    return { status: 201, data: { ratingId, rideId, targetId: input.targetId, score: input.score } };
  });
}
