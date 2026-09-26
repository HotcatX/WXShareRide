import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { transaction, withIdempotency } from '../db.ts';
import { AppError } from '../errors.ts';

const bindSchema = z.strictObject({ code: z.string().length(16).regex(/^ref_[a-f0-9]{12}$/) });

async function lockUser(client: PoolClient, userId: string) {
  // Code allocation and first binding serialize on this user only. NO KEY
  // UPDATE permits FK KEY SHARE locks, so mutual referrals cannot deadlock
  // while each transaction holds its own user's lock.
  const result = await client.query<{ id: string; openid: string; app_id: string }>(
    'SELECT id, openid, app_id FROM users WHERE id=$1 FOR NO KEY UPDATE', [userId]);
  const user = result.rows[0];
  if (!user) throw new AppError(401, 'UNAUTHORIZED', '请先登录');
  return user;
}

/** Caller must hold an open transaction; identity comes from the stored user. */
export async function ensureReferralCode(client: PoolClient, userId: string): Promise<string> {
  const user = await lockUser(client, userId);
  const existing = await client.query<{ code: string }>('SELECT code FROM referral_codes WHERE user_id=$1', [user.id]);
  if (existing.rows[0]) return existing.rows[0].code;

  // Preserve the old deterministic code when available. The unique constraint
  // arbitrates collisions across accounts/apps without replacing an owner.
  let code = `ref_${createHash('sha1').update(user.openid).digest('hex').slice(0, 12)}`;
  for (let attempt = 0; attempt < 16; attempt++) {
    const inserted = await client.query<{ code: string }>(`INSERT INTO referral_codes(user_id, code)
      VALUES ($1, $2) ON CONFLICT (code) DO NOTHING RETURNING code`, [user.id, code]);
    if (inserted.rows[0]) return inserted.rows[0].code;
    code = `ref_${randomBytes(6).toString('hex')}`;
  }
  throw new AppError(503, 'REFERRAL_CODE_UNAVAILABLE', '邀请码暂不可用，请稍后重试');
}

export async function getMyReferral(pool: Pool, userId: string) {
  return transaction(pool, async client => {
    const code = await ensureReferralCode(client, userId);
    const result = await client.query<{ referral_count: number }>(`SELECT count(*)::integer AS referral_count
      FROM referral_bindings b JOIN users referrer ON referrer.id=b.referrer_user_id
      JOIN users referred ON referred.id=b.referred_user_id AND referred.app_id=referrer.app_id
      WHERE b.referrer_user_id=$1`, [userId]);
    return { code, referralCount: result.rows[0]!.referral_count };
  });
}

export async function bindReferral(pool: Pool, userId: string, key: unknown, body: unknown) {
  const input = bindSchema.parse(body);
  return withIdempotency(pool, userId, 'referrals.bind', key, input, async client => {
    const actor = await lockUser(client, userId);
    const result = await client.query<{ user_id: string }>(`SELECT c.user_id
      FROM referral_codes c JOIN users u ON u.id=c.user_id
      WHERE c.code=$1 AND u.app_id=$2`, [input.code, actor.app_id]);
    const referrer = result.rows[0];
    // The same response covers unknown and other-app codes without disclosing
    // another application's accounts or referral relationships.
    if (!referrer) throw new AppError(404, 'REFERRAL_CODE_NOT_FOUND', '邀请码不存在');
    if (referrer.user_id === actor.id) throw new AppError(400, 'CANNOT_REFER_SELF', '不能使用自己的邀请码');

    const existing = await client.query<{ referrer_user_id: string }>(
      'SELECT referrer_user_id FROM referral_bindings WHERE referred_user_id=$1', [actor.id]);
    if (existing.rows[0]) {
      if (existing.rows[0].referrer_user_id !== referrer.user_id) {
        throw new AppError(409, 'REFERRAL_ALREADY_BOUND', '已有邀请关系，不能更换邀请码');
      }
      return { status: 200, data: { changed: false } };
    }
    // This is first valid binding, including an existing account. Registration
    // age and rewards are not inferred from the old client's login callback.
    await client.query(`INSERT INTO referral_bindings(referred_user_id, referrer_user_id)
      VALUES ($1, $2)`, [actor.id, referrer.user_id]);
    return { status: 200, data: { changed: true } };
  });
}
