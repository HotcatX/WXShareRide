import type { Pool } from 'pg';
import { z } from 'zod';
import { transaction } from '../db.ts';
import { AppError } from '../errors.ts';
import { advanceRideVersion, recordRideEvent } from './events.ts';

type DueRide = { id: string; kind: 'offer' | 'request'; creator_id: string; version: number };
type Member = { user_id: string; role: 'driver' | 'passenger'; seat_count: number };

/** Internal job only. Never expose a client endpoint that can advance lifecycle. */
export async function closeDueRides(pool: Pool, appId: string, batchSize = 100) {
  z.string().min(1).refine(value => value === value.trim()).parse(appId);
  z.number().int().min(1).max(500).parse(batchSize);
  return transaction(pool, async client => {
    // The first departure is the booking deadline, while the final departure
    // determines closure. A missing departure does not become automatically due.
    // Disjoint workers skip each other's rides instead of recounting them.
    const due = await client.query<DueRide>(`SELECT r.id,r.kind,r.creator_id,r.version
      FROM rides r JOIN users u ON u.id=r.creator_id
      WHERE u.app_id=$1 AND r.status='open' AND r.departure_at<clock_timestamp()
        AND (SELECT max(s.departure_at) FROM ride_stops s
          WHERE s.ride_id=r.id AND s.kind='departure')<clock_timestamp()
      ORDER BY r.departure_at,r.id LIMIT $2 FOR UPDATE OF r SKIP LOCKED`, [appId, batchSize]);
    let servedDelta = 0;
    let completions = 0;
    for (const ride of due.rows) {
      const members = (await client.query<Member>(`SELECT user_id,role,seat_count FROM ride_members
        WHERE ride_id=$1 AND state='active' ORDER BY user_id`, [ride.id])).rows;
      const driver = members.find(member => member.role === 'driver');
      const passengers = members.filter(member => member.role === 'passenger');
      // These are the existing two different metrics: public person-trips
      // include a lone offer driver and cap at five; personal counts need a
      // matched driver/passenger pair and count each account once, not seats.
      const delta = driver ? Math.min(5, 1 + passengers.reduce((sum, member) => sum + member.seat_count, 0)) : 0;
      const completedMembers = driver && passengers.length ? [driver, ...passengers] : [];
      await client.query("UPDATE rides SET status='closed' WHERE id=$1", [ride.id]);
      const changed = await advanceRideVersion(client, ride);
      const eventId = await recordRideEvent(client, changed, null, 'closed', { servedDelta: delta });
      for (const member of completedMembers) {
        // Imported receipts can predate the current membership. Never change
        // the first recorded role or turn them into membership authority.
        const receipt = await client.query(`INSERT INTO ride_completions(ride_id,user_id,role,counted_at,event_id)
          VALUES($1,$2,$3,clock_timestamp(),$4) ON CONFLICT(ride_id,user_id) DO NOTHING`,
        [ride.id, member.user_id, member.role, eventId]);
        completions += receipt.rowCount ?? 0;
      }
      servedDelta += delta;
    }
    if (due.rows.length) {
      const updated = await client.query(`UPDATE public_statistics SET served_count=served_count+$2,
        updated_at=clock_timestamp() WHERE app_id=$1`, [appId, servedDelta]);
      if (!updated.rowCount) throw new AppError(503, 'STATISTICS_NOT_INITIALIZED', '统计基线尚未初始化');
    }
    return { closed: due.rows.length, completions, servedDelta };
  });
}
