import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { notifyRideEvent } from '../notifications/service.ts';
import { freezeCollectorEvent } from './collector-event.ts';
import type { CapturedRide } from './collector-event.ts';
import { AppError } from '../errors.ts';

type EventRide = { id: string; kind: 'offer' | 'request'; creator_id: string; version: number };

/** The caller holds the ride lock and owns the transaction. */
export async function advanceRideVersion<T extends { id: string; version: number }>(client: PoolClient, ride: T): Promise<T> {
  const result = await client.query<{ version: number }>(`UPDATE rides SET version = version + 1, updated_at = clock_timestamp()
    WHERE id = $1 RETURNING version`, [ride.id]);
  return { ...ride, version: result.rows[0]!.version };
}

/** Facts and recipient notifications commit with the mutation, including system closures. */
export async function recordRideEvent(client: PoolClient, ride: EventRide, actorId: string | null, action: string, payload: Record<string, unknown>, before?: CapturedRide | null) {
  const eventId = randomUUID();
  // Ratings do not change place participation. Keep their version in the main
  // ledger, but never invent a compatible place action or backfill old facts.
  if (action !== 'rated' && before === undefined) throw new AppError(500, 'RIDE_EVENT_SNAPSHOT_REQUIRED', '行程暂不可更新');
  // Keep PostgreSQL microseconds for ledger ordering; the v1 wire timestamp
  // explicitly uses milliseconds. Both originate from this single DB clock.
  const createdAt = (await client.query<{ at: string }>(`SELECT
    to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0]!.at;
  const collectorPayload = action === 'rated' ? null : await freezeCollectorEvent(client, {
    id: eventId, createdAt: new Date(createdAt), rideId: ride.id, version: ride.version, actorId, action, payload,
  }, before!);
  await client.query(`INSERT INTO business_events(id, ride_id, ride_version, action, actor_id, payload, created_at, collector_payload)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
  [eventId, ride.id, ride.version, action, actorId, JSON.stringify(payload), createdAt, collectorPayload]);
  await notifyRideEvent(client, { eventId, rideId: ride.id, kind: ride.kind, creatorId: ride.creator_id, actorId, action, payload,
    cancelledRecipients: action === 'cancelled' ? before!.memberUserIds : undefined });
  return eventId;
}
