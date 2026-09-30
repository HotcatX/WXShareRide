import type { PoolClient } from 'pg';
import { AppError } from '../errors.ts';
import { getUser } from '../users/service.ts';
import { formatStatistics, statisticsProjection } from '../statistics/service.ts';
import type { StatisticsFacts } from '../statistics/service.ts';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : [];
type Dependencies = { avatarUrl?: (fileId: string, userId: string) => Promise<string> };
const avatarUnavailable = () => new AppError(503, 'FILE_STORAGE_UNAVAILABLE', '图片服务暂不可用，请稍后重试');

/** The bridge supplies the verified app/OpenID and owns the nonce transaction.
 * This read never creates an identity, opens a transaction or restores stored
 * CloudBase profile/index arrays. Only current PG facts enter the legacy DTO. */
export async function runProfileRead(client: PoolClient, appId: string, openid: string, deps: Dependencies = {}) {
  const actor = (await client.query<{ id: string; referralCode: string | null }>(`
    SELECT u.id,c.code AS "referralCode" FROM users u
    LEFT JOIN referral_codes c ON c.user_id=u.id
    WHERE u.app_id=$1 AND u.openid=$2`, [appId, openid])).rows[0];
  if (!actor) return { data: [] };
  const user = await getUser(client, actor.id);
  const facts = (await client.query<{ all: StatisticsFacts; driver: StatisticsFacts; passenger: StatisticsFacts }>(`
    SELECT ${statisticsProjection('selfAll')} AS all,
      ${statisticsProjection('selfDriver')} AS driver,
      ${statisticsProjection('selfPassenger')} AS passenger
    FROM users u WHERE u.id=$1`, [actor.id])).rows[0];
  if (!facts) throw new AppError(404, 'USER_NOT_FOUND', '账号不存在');
  const all = formatStatistics(facts.all), driver = formatStatistics(facts.driver), passenger = formatStatistics(facts.passenger);

  // Same retained-member/current-vs-history rules as listMyRides; these arrays
  // are response aliases, not another synchronized membership model.
  const memberships = (await client.query<{ id: string; kind: 'offer' | 'request'; role: 'driver' | 'passenger';
    isCreator: boolean; history: boolean }>(`
    SELECT r.id,r.kind,m.role,r.creator_id=m.user_id AS "isCreator",
      (r.status='closed' OR r.departure_at<=now()) AS history
    FROM ride_members m JOIN rides r ON r.id=m.ride_id JOIN users creator ON creator.id=r.creator_id
    WHERE m.user_id=$1 AND m.state='active' AND r.status<>'cancelled' AND creator.app_id=$2
    ORDER BY r.departure_at,r.id LIMIT 10001`, [actor.id, appId])).rows;
  // This endpoint keeps getUserInfo's OpenID wire list; the canonical profile
  // API still uses UUIDs. No duplicate block model or stored alias is created.
  const blocks = (await client.query<{ openid: string }>(`SELECT target.openid FROM user_blocks b
    JOIN users target ON target.id=b.target_id AND target.app_id=$2
    WHERE b.blocker_id=$1 AND b.active ORDER BY b.updated_at DESC,b.target_id LIMIT 10001`, [actor.id, appId])).rows;
  if (memberships.length > 10000 || blocks.length > 10000) {
    throw new AppError(409, 'PROFILE_REQUIRES_NEW_CLIENT', '资料较多，请使用新版小程序查看');
  }
  const rides = { tripDriver: [] as string[], tripDriverJoin: [] as string[], tripPassengerCreate: [] as string[], tripPassenger: [] as string[],
    tripDriverHistory: [] as string[], tripDriverJoinHistory: [] as string[], tripPassengerCreateHistory: [] as string[], tripPassengerHistory: [] as string[] };
  for (const row of memberships) {
    const field = row.role === 'driver' ? row.kind === 'offer' ? 'tripDriver' : 'tripDriverJoin'
      : row.kind === 'request' && row.isCreator ? 'tripPassengerCreate' : 'tripPassenger';
    const key: keyof typeof rides = row.history ? `${field}History` : field;
    rides[key].push(row.id);
  }
  const p = user.profile, vehicle = object(p.vehicle), zelle = object(p.zelle), region = object(p.region),
    location = object(p.location), preferences = object(p.preferences), prices = object(preferences.routePrices);
  let avatarUrl: string | undefined;
  if (user.avatarFileId) {
    try {
      if (!deps.avatarUrl) throw avatarUnavailable();
      avatarUrl = await deps.avatarUrl(user.avatarFileId, actor.id);
      if (typeof avatarUrl !== 'string' || avatarUrl.length > 8192 || avatarUrl.trim() !== avatarUrl || /[\u0000-\u001f\u007f]/u.test(avatarUrl)) throw avatarUnavailable();
      const url = new URL(avatarUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw avatarUnavailable();
    } catch { throw avatarUnavailable(); }
  }
  return { data: [{
    // The shipped server adapter also uses the canonical user UUID as _id.
    // Never guess a historical userInfo document ID from archived records.
    _id: user.id, _openid: user.openid, name: user.name, avatarFileId: user.avatarFileId,
    ...(avatarUrl === undefined ? {} : { avatarUrl }),
    ...(actor.referralCode === null ? {} : { referralCode: actor.referralCode }),
    wechatID: text(p.wechatId), phone: text(p.phone), regionPhone: text(p.phoneRegion) || 'US', bio: text(p.bio),
    carNumber: text(vehicle.plate), carBrand: text(vehicle.brand), carModel: text(vehicle.model),
    zelleName: text(zelle.name), zelleAccount: text(zelle.account), defaultShowZelle: zelle.public === true,
    regionState: text(region.state), regionCounty: text(region.county), regionArea: text(region.area),
    regionKey: text(region.key), regionDisplay: text(region.label), bigregion: text(region.label),
    Apartment: text(location.residence), address: text(location.residence), buildingName: text(location.residence),
    location: { displayName: text(location.label), address: text(location.address),
      ...(typeof location.latitude === 'number' && Number.isFinite(location.latitude) ? { lat: location.latitude } : {}),
      ...(typeof location.longitude === 'number' && Number.isFinite(location.longitude) ? { lng: location.longitude } : {}) },
    pickupSpot: strings(preferences.pickupAddresses), dropoffSpot: strings(preferences.dropoffAddresses),
    commonComments: strings(preferences.comments),
    customPrice: typeof prices.fortLeeNonCore === 'string' ? { fortLeeNonCore: prices.fortLeeNonCore } : {},
    profileCompleted: p.profileCompleted === true, updatedAt: user.updatedAt,
    rideStats: { completedTrips: all.completedTrips, completedDriverTrips: driver.completedTrips, completedPassengerTrips: passenger.completedTrips,
      ratingCount: all.ratingCount, ratingAvg: all.averageRating, ratingWeightedAvg: all.weightedRating,
      driverRatingCount: driver.ratingCount, driverRatingAvg: driver.averageRating, driverRatingWeightedAvg: driver.weightedRating,
      passengerRatingCount: passenger.ratingCount, passengerRatingAvg: passenger.averageRating, passengerRatingWeightedAvg: passenger.weightedRating },
    blockedUsers: blocks.map(row => row.openid), ...rides,
  }] };
}
