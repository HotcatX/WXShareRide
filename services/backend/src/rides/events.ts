import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { notifyRideEvent } from '../notifications/service.ts';

type EventRide = { id: string; kind: 'offer' | 'request'; creator_id: string; version: number };

/** The caller holds the ride lock and owns the transaction. */
export async function advanceRideVersion<T extends { id: string; version: number }>(client: PoolClient, ride: T): Promise<T> {
  const result = await client.query<{ version: number }>(`UPDATE rides SET version = version + 1, updated_at = clock_timestamp()
    WHERE id = $1 RETURNING version`, [ride.id]);
  return { ...ride, version: result.rows[0]!.version };
}

/** Facts and recipient notifications commit with the mutation, including system closures. */
export async function recordRideEvent(client: PoolClient, ride: EventRide, actorId: string | null, action: string, payload: Record<string, unknown>) {
  const eventId = randomUUID();
  await client.query(`INSERT INTO business_events(id, ride_id, ride_version, action, actor_id, payload, created_at)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp())`,
  [eventId, ride.id, ride.version, action, actorId, JSON.stringify(payload)]);
  await notifyRideEvent(client, { eventId, rideId: ride.id, kind: ride.kind, creatorId: ride.creator_id, actorId, action, payload });
  return eventId;
}
