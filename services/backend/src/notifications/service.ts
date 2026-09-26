import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { withIdempotency } from '../db.ts';
import { AppError } from '../errors.ts';

const notificationId = z.string().min(1).max(160).regex(/^[a-zA-Z0-9:_-]+$/);
const emptyBody = z.strictObject({});
const cursorValue = z.strictObject({ at: z.string().datetime({ precision: 6 }), id: notificationId });
const listQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).regex(/^[a-zA-Z0-9_-]+$/).optional() });

export async function unreadNotifications(pool: Pool, userId: string) {
  const result = await pool.query('SELECT count(*)::integer AS count FROM notifications WHERE user_id=$1 AND read=false', [userId]);
  return { unreadCount: result.rows[0].count as number };
}

export async function listNotifications(pool: Pool, userId: string, query: unknown) {
  const input = listQuery.parse(query);
  let cursor: z.infer<typeof cursorValue> | undefined;
  if (input.cursor) {
    try { cursor = cursorValue.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))); }
    catch { throw new AppError(400, 'INVALID_CURSOR', '分页位置不正确'); }
  }
  // Preserve PostgreSQL microseconds in the cursor; JS Date loses them and can skip rows.
  const result = await pool.query(`SELECT id, ride_id AS "rideId", type, title, content, read,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
    FROM notifications WHERE user_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::text))
    ORDER BY created_at DESC, id DESC LIMIT $4`, [userId, cursor?.at ?? null, cursor?.id ?? null, input.limit + 1]);
  const items = result.rows.slice(0, input.limit);
  const last = items.at(-1);
  const nextCursor = result.rows.length > input.limit && last
    ? Buffer.from(JSON.stringify({ at: last.createdAt, id: last.id })).toString('base64url') : null;
  return { items, nextCursor, ...await unreadNotifications(pool, userId) };
}

export async function markNotificationRead(pool: Pool, userId: string, key: unknown, id: unknown, body: unknown) {
  const parsedId = notificationId.parse(id);
  emptyBody.parse(body ?? {});
  return withIdempotency(pool, userId, 'notifications.read', key, { id: parsedId }, async client => {
    const result = await client.query('UPDATE notifications SET read=true WHERE id=$1 AND user_id=$2 RETURNING id', [parsedId, userId]);
    if (!result.rowCount) throw new AppError(404, 'NOTIFICATION_NOT_FOUND', '通知不存在');
    return { status: 200, data: { id: parsedId, read: true } };
  });
}

export async function markAllNotificationsRead(pool: Pool, userId: string, key: unknown, body: unknown) {
  emptyBody.parse(body ?? {});
  return withIdempotency(pool, userId, 'notifications.readAll', key, {}, async client => {
    const result = await client.query('UPDATE notifications SET read=true WHERE user_id=$1 AND read=false', [userId]);
    return { status: 200, data: { changed: result.rowCount ?? 0 } };
  });
}

export async function clearNotifications(pool: Pool, userId: string, key: unknown, body: unknown) {
  emptyBody.parse(body ?? {});
  return withIdempotency(pool, userId, 'notifications.clear', key, {}, async client => {
    const result = await client.query('DELETE FROM notifications WHERE user_id=$1', [userId]);
    return { status: 200, data: { deleted: result.rowCount ?? 0 } };
  });
}

type RideEvent = { eventId: string; rideId: string; kind: 'offer' | 'request'; creatorId: string;
  actorId: string | null; action: string; payload: Record<string, unknown> };

/** Called inside the ride mutation transaction, never through a public send endpoint. */
export async function notifyRideEvent(client: PoolClient, event: RideEvent) {
  if (!['joined', 'left', 'cancelled', 'removed', 'rated', 'closed'].includes(event.action)) return;
  const members = ['removed', 'rated'].includes(event.action) ? [] : (await client.query<{ user_id: string; role: string }>(
    "SELECT user_id,role FROM ride_members WHERE ride_id=$1 AND state='active'", [event.rideId])).rows;
  const driver = members.find(member => member.role === 'driver');
  const passengerChange = event.payload.role === 'passenger';
  // Removal is sent only to its former member, who is already inactive. The
  // target comes from the authorized mutation's event, never a public send API.
  // A closure only invites ratings when there is an actual driver/passenger pair.
  if (event.action === 'closed' && (!driver || !members.some(member => member.role === 'passenger'))) return;
  const targets = event.action === 'rated' ? [z.uuid().parse(event.payload.targetId)]
    : event.action === 'closed' ? members.map(member => member.user_id)
    : event.action === 'removed' ? [z.uuid().parse(event.payload.memberId)]
    : event.action === 'cancelled' || (event.kind === 'request' && !passengerChange)
    ? members.map(member => member.user_id)
    : [event.creatorId, driver?.user_id];
  const recipients = [...new Set(targets.filter((id): id is string => !!id && id !== event.actorId))];
  if (!recipients.length) return;
  const type = event.action === 'rated' ? 'ride_rating' : event.action === 'closed' ? 'rating_invitation'
    : event.action === 'removed' ? 'member_removed' : event.action === 'cancelled' ? 'ride_cancelled'
    : event.action === 'joined' ? (passengerChange ? 'passenger_joined' : 'driver_assigned')
      : (passengerChange ? 'passenger_left' : 'driver_left');
  const title = { ride_rating: '你收到一条行程评价', rating_invitation: '行程已结束，可以评价同行成员',
    member_removed: '你已被移出行程', ride_cancelled: '行程已取消', passenger_joined: '有乘客加入行程',
    driver_assigned: '已有司机接单', passenger_left: '有乘客退出行程', driver_left: '司机已退出行程' }[type];
  const route = (await client.query<{ address: string }>(
    'SELECT address FROM ride_stops WHERE ride_id=$1 ORDER BY position', [event.rideId])).rows;
  const description = route.length ? `${route[0]!.address} → ${route.at(-1)!.address}` : '本次行程';
  const reason = typeof event.payload.reason === 'string' ? event.payload.reason : '';
  const score = event.action === 'rated' ? z.number().int().min(1).max(5).parse(event.payload.score) : null;
  const content = `${description}：${title}${score !== null ? `（${score} 分）` : ''}${reason ? `。理由：${reason}` : ''}`;
  for (const recipient of recipients) {
    await client.query(`INSERT INTO notifications(id,user_id,event_id,ride_id,type,title,content)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(event_id,user_id) DO NOTHING`,
    [randomUUID(), recipient, event.eventId, event.rideId, type, title, content]);
  }
}
