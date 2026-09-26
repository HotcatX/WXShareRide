import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withIdempotency } from '../db.ts';
import { AppError } from '../errors.ts';

/** Counted detail views, not all impressions. A transport retry is the same
 * observation; a fresh opening has a fresh key. Historical over-limit buckets
 * are retained and cannot be incremented further. */
export async function recordListingView(pool: Pool, userId: string, key: unknown, id: unknown, body: unknown) {
  const listingId = z.string().regex(/^[a-zA-Z0-9:_-]{1,160}$/).parse(id);
  z.strictObject({}).parse(body);
  return withIdempotency(pool, userId, 'market.view', key, { listingId }, async client => {
    const user = (await client.query<{ app_id: string }>('SELECT app_id FROM users WHERE id=$1 FOR KEY SHARE', [userId])).rows[0];
    if (!user) throw new AppError(401, 'UNAUTHORIZED', '请先登录');
    // Serialize counted views for this listing so aggregate overflow and a
    // simultaneous hide/delete are checked against the admitted write order.
    const listing = (await client.query<{ status: string; owner_user_id: string | null; expires_at: Date }>(
      'SELECT status,owner_user_id,expires_at FROM market_listings WHERE app_id=$1 AND id=$2 FOR UPDATE', [user.app_id, listingId])).rows[0];
    const clock = (await client.query<{ at: Date; day: string }>(`SELECT at,to_char(at AT TIME ZONE 'America/New_York','YYYY-MM-DD') AS day
      FROM (SELECT clock_timestamp() AS at) wall_clock`)).rows[0];
    if (!listing || listing.status === 'deleted' || listing.owner_user_id !== userId &&
      (listing.status !== 'online' || listing.expires_at <= clock.at)) throw new AppError(404, 'LISTING_NOT_FOUND', '商品不存在');
    const counted = await client.query<{ count: string }>(`INSERT INTO market_views(app_id,id,listing_id,actor_user_id,day,count,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,1,$6,$6)
      ON CONFLICT(app_id,listing_id,actor_user_id,day) WHERE actor_user_id IS NOT NULL
      DO UPDATE SET count=market_views.count+1,updated_at=GREATEST(market_views.updated_at,EXCLUDED.updated_at)
      WHERE market_views.count<10 RETURNING count`, [user.app_id, randomUUID(), listingId, userId, clock.day, clock.at]);
    const daily = counted.rows[0] ?? (await client.query<{ count: string }>(`SELECT count FROM market_views
      WHERE app_id=$1 AND listing_id=$2 AND actor_user_id=$3 AND day=$4`, [user.app_id, listingId, userId, clock.day])).rows[0];
    const total = (await client.query<{ count: string }>('SELECT COALESCE(sum(count),0)::text AS count FROM market_views WHERE app_id=$1 AND listing_id=$2', [user.app_id, listingId])).rows[0];
    const viewCount = Number(total.count), dailyCount = Number(daily.count);
    if (!Number.isSafeInteger(viewCount) || !Number.isSafeInteger(dailyCount)) throw new AppError(500, 'INVALID_VIEW_COUNT', '浏览统计暂不可用');
    return { status: 200, data: { counted: !!counted.rowCount, dailyCount, dailyLimit: 10,
      viewCount, reason: counted.rowCount ? '' : 'daily_limit' } };
  });
}
