import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { AppError } from '../errors.ts';
import { getUser } from '../users/service.ts';
import { getMarketSeller } from '../market/read.ts';
import { getRideParticipants } from '../rides/participants.ts';
import type { RideParticipant } from '../rides/participants.ts';
import { userStatistics } from '../statistics/service.ts';
import type { Statistics } from '../statistics/service.ts';

export const legacyProfilesSchema = z.strictObject({
  openids: z.array(z.string().regex(/^[A-Za-z0-9_-]{16,128}$/)).min(1).max(20)
    .refine(values => new Set(values).size === values.length),
});
type Dependencies = { avatarUrl?: (fileId: string, viewerId: string) => Promise<string> };
type LegacyUser = {
  _id: string; _openid: string; name: string; avatarFileId: string | null; avatarUrl?: string;
  phone?: string; wechatID?: string; regionPhone?: string; bio?: string; regionDisplay?: string;
  carNumber?: string; carBrand?: string; carModel?: string; rideStats?: Record<string, number | null>;
};
const unavailable = () => new AppError(403, 'PROFILES_REQUIRE_NEW_CLIENT', '无法查看这批资料，请使用新版小程序');
const avatarUnavailable = () => new AppError(503, 'FILE_STORAGE_UNAVAILABLE', '图片服务暂不可用，请稍后重试');
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const string = (key: string, value: unknown) => typeof value === 'string' ? { [key]: value } : {};
function roleStatistics(role: 'driver' | 'passenger', value: Statistics) {
  return { [role === 'driver' ? 'completedDriverTrips' : 'completedPassengerTrips']: value.completedTrips,
    [`${role}RatingCount`]: value.ratingCount, [`${role}RatingAvg`]: value.averageRating,
    [`${role}RatingWeightedAvg`]: value.weightedRating };
}
function participant(user: RideParticipant, openid: string): LegacyUser {
  return { _id: user.id, _openid: openid, name: user.name, avatarFileId: user.avatarFileId,
    ...string('phone', user.phone), ...string('wechatID', user.wechatId), ...string('regionPhone', user.phoneRegion),
    ...string('carNumber', user.vehicle?.plate), ...string('carBrand', user.vehicle?.brand), ...string('carModel', user.vehicle?.model),
    rideStats: roleStatistics(user.role, user.statistics) };
}

/** Old callers have no ride context. Candidate IDs never authorize a profile:
 * only the existing self, seller or participant reader supplies disclosed data.
 * The caller owns the nonce transaction; no identities, sessions or rows are written. */
export async function runProfilesRead(client: PoolClient, appId: string, openid: string, input: unknown, deps: Dependencies = {}) {
  const { openids } = legacyProfilesSchema.parse(input);
  const actor = (await client.query<{ id: string }>('SELECT id FROM users WHERE app_id=$1 AND openid=$2', [appId, openid])).rows[0];
  if (!actor) throw unavailable();
  const identities = (await client.query<{ id: string; openid: string }>(
    'SELECT id,openid FROM users WHERE app_id=$1 AND openid=ANY($2::text[])', [appId, openids])).rows;
  if (identities.length !== openids.length) throw unavailable();
  const targets = new Map(identities.map(row => [row.openid, row.id]));
  // These canonical read helpers only use query(). Keep every query on the
  // supplied client/transaction instead of opening a separate pool transaction.
  const reader = client as unknown as Pool;
  const rides = new Map<string, Awaited<ReturnType<typeof getRideParticipants>> | null>();
  const users: LegacyUser[] = [];
  for (const targetOpenid of openids) {
    const targetId = targets.get(targetOpenid)!;
    if (targetId === actor.id) {
      const own = await getUser(client, actor.id), p = own.profile, vehicle = object(p.vehicle), region = object(p.region);
      const stats = await userStatistics(reader, actor.id);
      users.push({ _id: own.id, _openid: targetOpenid, name: own.name, avatarFileId: own.avatarFileId,
        ...string('phone', p.phone), ...string('wechatID', p.wechatId), ...string('regionPhone', p.phoneRegion),
        ...string('bio', p.bio), ...string('regionDisplay', region.label),
        ...string('carNumber', vehicle.plate), ...string('carBrand', vehicle.brand), ...string('carModel', vehicle.model),
        rideStats: { completedTrips: stats.all.completedTrips, ratingCount: stats.all.ratingCount,
          ratingAvg: stats.all.averageRating, ratingWeightedAvg: stats.all.weightedRating,
          ...roleStatistics('driver', stats.driver), ...roleStatistics('passenger', stats.passenger) } });
      continue;
    }
    let allowed: LegacyUser | undefined;
    let after: string | null = null;
    // Keyset pages remain bounded even for large historical relationships.
    // Hitting the limit without an authorized projection is an explicit failure,
    // never a partially successful list or a fabricated empty contact.
    for (let examined = 0; examined < 20 && !allowed; examined += 10) {
      const candidates: { id: string }[] = (await client.query<{ id: string }>(`
        SELECT r.id FROM rides r JOIN users owner ON owner.id=r.creator_id AND owner.app_id=$1
        JOIN ride_members mine ON mine.ride_id=r.id AND mine.user_id=$2 AND mine.state='active'
        JOIN ride_members target ON target.ride_id=r.id AND target.user_id=$3 AND target.state='active'
        WHERE r.status<>'cancelled' AND ($4::text IS NULL OR r.id COLLATE "C">$4 COLLATE "C")
        ORDER BY r.id COLLATE "C" LIMIT 11`, [appId, actor.id, targetId, after])).rows;
      for (const candidate of candidates.slice(0, 10)) {
        if (!rides.has(candidate.id)) {
          try { rides.set(candidate.id, await getRideParticipants(reader, actor.id, candidate.id)); }
          catch (error) {
            if (!(error instanceof AppError && error.code === 'RIDE_NOT_FOUND')) throw error;
            rides.set(candidate.id, null);
          }
        }
        const member = rides.get(candidate.id)?.participants.find(value => value.id === targetId);
        if (member) { allowed = participant(member, targetOpenid); break; }
      }
      if (allowed || candidates.length <= 10) break;
      after = candidates[9]!.id;
    }
    if (!allowed) {
      try {
        const seller = await getMarketSeller(reader, appId, actor.id, targetId);
        allowed = { _id: seller.userId, _openid: targetOpenid, name: seller.name, avatarFileId: seller.avatarFileId,
          ...string('phone', seller.phone), ...string('wechatID', seller.wechatId),
          ...string('bio', seller.bio), ...string('regionDisplay', seller.regionLabel) };
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'SELLER_NOT_FOUND')) throw error;
      }
    }
    if (!allowed) throw unavailable();
    users.push(allowed);
  }
  // No address, pickup instruction, GPS or payment field is context-free.
  // Sign only after the ENTIRE batch has an authorized projection, always for
  // the actual viewer. A target UUID must never impersonate an avatar's owner.
  const signed = new Map<string, string>();
  for (const user of users) {
    if (!user.avatarFileId) continue;
    if (!signed.has(user.avatarFileId)) {
      try {
        if (!deps.avatarUrl) throw avatarUnavailable();
        const value = await deps.avatarUrl(user.avatarFileId, actor.id);
        if (typeof value !== 'string' || value.length > 8192 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) throw avatarUnavailable();
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw avatarUnavailable();
        signed.set(user.avatarFileId, value);
      } catch { throw avatarUnavailable(); }
    }
    user.avatarUrl = signed.get(user.avatarFileId)!;
  }
  return { ok: true as const, data: users };
}
