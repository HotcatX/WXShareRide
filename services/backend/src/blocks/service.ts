import type { Pool, PoolClient } from 'pg';
import { withIdempotency } from '../db.ts';
import { AppError } from '../errors.ts';
import { blockUserSchema, listBlocksSchema, targetUserIdSchema } from './schemas.ts';

/**
 * Block/unblock only take these pair locks. Join first locks its ride, then
 * takes all relevant pair locks in this same order. Never acquire a ride lock
 * after a pair lock: a block may wait for a join, but cannot form a lock cycle.
 * A pair covers both directions, including when neither block row exists yet.
 */
export async function lockBlockPairs(client: PoolClient, userId: string, otherIds: string[]) {
  const actor = userId.toLowerCase();
  const keys = [...new Set(otherIds.map(id => id.toLowerCase()).filter(id => id !== actor)
    .map(id => JSON.stringify(['user-block-pair', ...[actor, id].sort()])))].sort();
  for (const key of keys) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

/** Caller holds the ride lock so its participant set cannot change under us. */
export async function assertNoBlockedMembers(client: PoolClient, userId: string, otherIds: string[]) {
  const targets = [...new Set(otherIds.filter(id => id !== userId))];
  await lockBlockPairs(client, userId, targets);
  const blocked = await client.query(`SELECT 1 FROM user_blocks WHERE active AND
    ((blocker_id = $1 AND target_id = ANY($2::uuid[])) OR
     (target_id = $1 AND blocker_id = ANY($2::uuid[]))) LIMIT 1`, [userId, targets]);
  // Do not reveal which participant blocked whom, or their private reason.
  if (blocked.rowCount) throw new AppError(403, 'USER_BLOCKED', '无法加入该行程');
}

async function assertTarget(client: PoolClient, userId: string, targetId: string) {
  if (userId === targetId) throw new AppError(400, 'CANNOT_BLOCK_SELF', '不能拉黑自己');
  const target = await client.query(`SELECT 1 FROM users target JOIN users actor ON actor.app_id = target.app_id
    WHERE actor.id = $1 AND target.id = $2`, [userId, targetId]);
  if (!target.rowCount) throw new AppError(404, 'USER_NOT_FOUND', '用户不存在');
}

export async function blockUser(pool: Pool, userId: string, key: unknown, body: unknown) {
  const input = blockUserSchema.parse(body);
  return withIdempotency(pool, userId, 'blocks.create', key, input, async client => {
    await assertTarget(client, userId, input.targetUserId);
    await lockBlockPairs(client, userId, [input.targetUserId]);
    // Re-blocking refreshes the reason. Re-activation starts a new blockedAt,
    // matching the old collection's new active record after an unblock.
    await client.query(`INSERT INTO user_blocks(blocker_id, target_id, reason)
      VALUES ($1, $2, $3) ON CONFLICT (blocker_id, target_id) DO UPDATE
      SET active = true, reason = EXCLUDED.reason,
        blocked_at = CASE WHEN user_blocks.active THEN user_blocks.blocked_at ELSE clock_timestamp() END,
        updated_at = clock_timestamp()`, [userId, input.targetUserId, input.reason]);
    return { status: 200, data: { targetUserId: input.targetUserId, active: true } };
  });
}

export async function unblockUser(pool: Pool, userId: string, key: unknown, target: unknown) {
  const targetUserId = targetUserIdSchema.parse(target);
  return withIdempotency(pool, userId, 'blocks.delete', key, { targetUserId }, async client => {
    await assertTarget(client, userId, targetUserId);
    await lockBlockPairs(client, userId, [targetUserId]);
    const result = await client.query(`UPDATE user_blocks SET active = false, updated_at = clock_timestamp()
      WHERE blocker_id = $1 AND target_id = $2 AND active`, [userId, targetUserId]);
    return { status: 200, data: { targetUserId, active: false, changed: !!result.rowCount } };
  });
}

export async function listBlocks(pool: Pool, userId: string, query: unknown) {
  const input = listBlocksSchema.parse(query);
  // An owner-only projection: never return sessions, OpenIDs, arbitrary profile
  // fields, or incoming blocks. Keep the existing blocked-list contact display.
  const result = await pool.query(`SELECT b.target_id AS "targetUserId", u.name, u.avatar_url AS "avatarUrl",
    COALESCE(u.profile->>'wechatId', '') AS "wechatId", b.reason,
    b.blocked_at AS "blockedAt", b.updated_at AS "updatedAt"
    FROM user_blocks b JOIN users u ON u.id = b.target_id
    WHERE b.blocker_id = $1 AND b.active ORDER BY b.updated_at DESC, b.target_id
    LIMIT $2 OFFSET $3`, [userId, input.limit + 1, (input.page - 1) * input.limit]);
  return { blocks: result.rows.slice(0, input.limit),
    nextPage: input.page < 1000 && result.rows.length > input.limit ? input.page + 1 : null };
}

