import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../errors.ts';
import { rideIdSchema } from '../rides/schemas.ts';
import { getRide } from '../rides/service.ts';
import { listRides, rideCalendar } from '../rides/read.ts';
import { getRideMembership, getRideParticipants, listMyRides } from '../rides/participants.ts';
import type { RideParticipant } from '../rides/participants.ts';
import { listMyRideRatings } from '../ratings/service.ts';
import type { Statistics } from '../statistics/service.ts';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const at = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
});
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .refine(value => day.safeParse(`${value}-01`).success && value < '9999-12');
const place = z.string().max(200).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
export const legacyRideSchemas = {
  'rides.home': z.strictObject({ statuses: z.array(z.enum(['open', 'full', 'past'])).min(1).max(3).optional() }),
  'rides.history': z.strictObject({}),
  'rides.list': z.strictObject({
    action: z.literal('calendar').optional(), type: z.enum(['all', 'carpool', 'request']).optional(),
    cityKey: z.enum(['', 'all', 'ny', 'nj', 'ny_nj']).optional(), limit: z.number().int().min(1).max(100).optional(),
    quick: z.boolean().optional(), fastOnly: z.boolean().optional(),
    startDate: day.optional(), endDateExclusive: day.optional(), month: month.optional(),
    fromPlace: place.optional(), toPlace: place.optional(),
    fromPresets: z.array(place).max(100).optional(), toPresets: z.array(place).max(100).optional(),
  }).refine(input => {
    if (input.action === 'calendar') return !!input.month && !input.startDate && !input.endDateExclusive;
    if (input.month) return false;
    if (!input.startDate && !input.endDateExclusive) return true;
    if (!input.startDate || !input.endDateExclusive) return false;
    return [1, 2].includes((Date.parse(input.endDateExclusive) - Date.parse(input.startDate)) / 86400000);
  }),
  'rides.detail': z.strictObject({ type: z.enum(['carpool', 'request']).optional(),
    id: rideIdSchema.optional(), tripId: rideIdSchema.optional(), requestId: rideIdSchema.optional(),
  }).refine(input => {
    const ids = [input.id, input.tripId, input.requestId].filter(value => value !== undefined);
    return ids.length > 0 && ids.every(id => id === ids[0]);
  }),
};
type Action = keyof typeof legacyRideSchemas;
type Dependencies = { avatarUrl?: (fileId: string, userId: string) => Promise<string> };
type Row = {
  id: string; kind: 'offer' | 'request'; cityKey: string | null; status: 'open' | 'closed';
  seatCapacity: number | null; availableSeats: number | null; hasDriver: boolean;
  departureAt: string | Date | null; listedPriceCents: number | null; listedPriceLabel: string | null;
  version: number; note: string; driverStatistics: Statistics | null;
  stops: { kind: 'departure' | 'destination'; address: string; placeId: string | null; departureAt: string | null }[];
  role?: 'driver' | 'passenger'; isCreator?: boolean;
};
const upgrade = () => new AppError(409, 'LEGACY_READ_UPGRADE_REQUIRED', '此读取方式已升级，请使用新版小程序');
const changed = () => new AppError(409, 'RIDE_CHANGED', '行程已更新，请刷新重试');
const instant = (value: string | Date | null) => value === null ? null : new Date(value).getTime();
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function time(value: string | Date | null) {
  const at = instant(value);
  if (at === null || !Number.isFinite(at)) return { date: '', time: '' };
  const parts = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
function statistics(value: Statistics | null, role = 'driver') {
  if (!value) return null;
  // A role subtotal is not the user's full lifetime ride/rating total.
  return { [role === 'driver' ? 'completedDriverTrips' : 'completedPassengerTrips']: value.completedTrips,
    [`${role}RatingCount`]: value.ratingCount, [`${role}RatingAvg`]: value.averageRating,
    [`${role}RatingWeightedAvg`]: value.weightedRating };
}
function trip(row: Row, history = false) {
  const departures = row.stops.filter(stop => stop.kind === 'departure').map(stop => ({ address: stop.address,
    placeId: stop.placeId || '', ...time(stop.departureAt) }));
  const destinations = row.stops.filter(stop => stop.kind === 'destination').map(stop => ({ address: stop.address, placeId: stop.placeId || '' }));
  const at = row.stops.filter(stop => stop.kind === 'departure').map(stop => instant(stop.departureAt)).filter((n): n is number => n !== null);
  const status = row.status === 'closed' || history ? 'past' : row.availableSeats === 0 ? 'full' : 'open';
  const first = departures[0], local = first?.date;
  const label = local ? `${Number(local.slice(5, 7))}月${Number(local.slice(8, 10))}日 ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${local}T12:00:00Z`).getUTCDay()]} ${first.time}` : '';
  return { _id: row.id, cityKey: row.cityKey, businessVersion: row.version, status, canonicalStatus: row.status,
    departures, destinations, departureAtMs: instant(row.departureAt), latestDepartureAtMs: at.length ? Math.max(...at) : instant(row.departureAt),
    referencePrice: row.listedPriceLabel ?? (row.listedPriceCents === null ? '' : (row.listedPriceCents / 100).toFixed(2)),
    listedPriceCents: row.listedPriceCents, listedPriceLabel: row.listedPriceLabel,
    passengerCount: row.kind === 'offer' ? row.seatCapacity : row.seatCapacity === null || row.availableSeats === null ? null : row.seatCapacity - row.availableSeats,
    seatCapacity: row.seatCapacity, availableSeats: row.availableSeats, availSeatNum: row.availableSeats,
    hasDriver: row.hasDriver, comment: row.note,
    // Request driver aggregates were never public in the old detail contract.
    driverStats: row.kind === 'offer' ? statistics(row.driverStatistics) : null,
    _fromAddress: first?.address || '', _toAddress: destinations[0]?.address || '', _timeLabel: label,
    statusText: status, _isRequest: row.kind === 'request', __dataGeneratedAt: Date.now() };
}
type Trip = ReturnType<typeof trip>;
async function pages(read: (page: number, limit: number) => Promise<{ rides: unknown[]; nextPage: number | null; nextDate?: string | null }>,
  maximum: number, complete: boolean) {
  const rows: Row[] = [], seen = new Set<string>();
  let nextDate: string | null | undefined;
  for (let page = 1; ; page++) {
    const limit = Math.min(50, maximum), result = await read(page, limit);
    if (page > 1 && result.nextDate !== nextDate) throw changed();
    nextDate = result.nextDate;
    for (const row of result.rides as Row[]) {
      if (seen.has(row.id)) throw changed();
      seen.add(row.id); rows.push(row);
      if (!complete && rows.length === maximum) return { rows, nextDate };
    }
    if (result.nextPage === null) return { rows, nextDate };
    if (rows.length >= maximum) throw upgrade();
  }
}
function role(row: Row) {
  return row.role === 'driver' ? row.kind === 'offer' ? 'driverCreate' : 'driverJoin'
    : row.kind === 'request' && row.isCreator ? 'passengerCreate' : 'passenger';
}
async function identityMap(client: PoolClient, appId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map<string, string>();
  const rows = (await client.query<{ id: string; openid: string }>('SELECT id,openid FROM users WHERE app_id=$1 AND id=ANY($2::uuid[])', [appId, unique])).rows;
  if (rows.length !== unique.length) throw changed();
  return new Map(rows.map(row => [row.id, row.openid]));
}
async function member(value: RideParticipant, openid: string, viewerId: string, deps: Dependencies) {
  let avatarUrl = '';
  if (value.avatarFileId) {
    try {
      if (!deps.avatarUrl) throw Error();
      avatarUrl = await deps.avatarUrl(value.avatarFileId, viewerId);
      if (typeof avatarUrl !== 'string' || avatarUrl.length > 8192 || avatarUrl !== avatarUrl.trim() || /[\u0000-\u001f\u007f]/u.test(avatarUrl)) throw Error();
      const url = new URL(avatarUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw Error();
    } catch { throw new AppError(503, 'FILE_STORAGE_UNAVAILABLE', '图片服务暂不可用，请稍后重试'); }
  }
  return { _id: value.id, _openid: openid, name: value.name, avatarFileId: value.avatarFileId, avatarUrl,
    phone: value.phone || '', regionPhone: value.phoneRegion || '', wechatID: value.wechatId || '',
    carNumber: value.vehicle?.plate || '', carBrand: value.vehicle?.brand || '', carModel: value.vehicle?.model || '',
    zelleName: value.zelle?.name || '', zelleAccount: value.zelle?.account || '',
    ...(value.pickupAddress === undefined ? {} : { pickupAddress: value.pickupAddress }),
    ...(value.dropoffAddress === undefined ? {} : { dropoffAddress: value.dropoffAddress }),
    passengerCount: value.seatCount, rideStats: statistics(value.statistics, value.role) };
}

/** Only the parent verified read bridge supplies app/OpenID and owns its nonce
 * transaction. These canonical helpers are query-only: the local Pool cast
 * reuses that same client; no connection, session, lock or write is created. */
export async function runLegacyRideRead(client: PoolClient, appId: string, openid: string, action: string, body: unknown, deps: Dependencies = {}) {
  if (!Object.hasOwn(legacyRideSchemas, action)) throw upgrade();
  const parsed = legacyRideSchemas[action as Action].safeParse(body);
  if (!parsed.success) throw upgrade();
  const pool = client as unknown as Pool;
  const actor = (await client.query<{ id: string }>('SELECT id FROM users WHERE app_id=$1 AND openid=$2', [appId, openid])).rows[0];
  if (action === 'rides.home' || action === 'rides.history') {
    const history = action === 'rides.history';
    const rows = actor ? (await pages((page, limit) => listMyRides(pool, actor.id, { scope: history ? 'history' : 'current', page, limit }), 1000, true)).rows : [];
    if (history) return { ok: true, data: rows.map(row => ({ ...trip(row, true),
      historyRole: ({ driverCreate: 'driver_create', driverJoin: 'driver_join', passengerCreate: 'passenger_create', passenger: 'passenger' })[role(row)],
      historySource: row.kind === 'offer' ? 'carpool' : 'request' })) };
    const statuses = (parsed.data as z.infer<typeof legacyRideSchemas['rides.home']>).statuses ?? ['open', 'full', 'past'];
    type Item = { _id: string; role: string; from: string; tripData: Trip };
    const driver = { createList: [] as Item[], joinList: [] as Item[] }, passenger = { createList: [] as Item[], joinList: [] as Item[] };
    for (const row of rows) {
      const item = trip(row);
      if (!statuses.includes(item.status as 'open' | 'full' | 'past')) continue;
      const target = row.role === 'driver' ? driver : passenger;
      target[row.isCreator ? 'createList' : 'joinList'].push({ _id: row.id, role: role(row), from: row.kind === 'offer' ? 'carpool' : 'request', tripData: item });
    }
    return { ok: true, success: true, statuses, data: { driver, passenger,
      createList: [...driver.createList, ...passenger.createList], joinList: [...driver.joinList, ...passenger.joinList] } };
  }
  if (action === 'rides.list') {
    const input = parsed.data as z.infer<typeof legacyRideSchemas['rides.list']>;
    const filters = { cityKey: 'ny_nj', fromPlace: input.fromPlace, toPlace: input.toPlace,
      fromPresets: input.fromPresets, toPresets: input.toPresets,
      kind: input.type === 'carpool' ? 'offer' : input.type === 'request' ? 'request' : undefined };
    if (input.action === 'calendar') {
      const result = await rideCalendar(pool, { ...filters, month: input.month }, actor?.id, appId);
      return { ok: true, success: true, month: result.month, data: { days: result.days.map(day => ({
        date: day.date, carpoolCount: day.offerCount, requestCount: day.requestCount })) } };
    }
    let rows: Row[], nextDate: string | null | undefined;
    if (input.startDate) {
      ({ rows, nextDate } = await pages((page, limit) => listRides(pool, { ...filters, startDate: input.startDate,
        endDateExclusive: input.endDateExclusive, page, limit }, actor?.id, appId), 1000, true));
    } else {
      rows = [];
      for (const kind of filters.kind ? [filters.kind] : ['offer', 'request']) {
        rows.push(...(await pages((page, limit) => listRides(pool, { ...filters, kind, page, limit }, actor?.id, appId), input.limit ?? 80, false)).rows);
      }
    }
    const carpool = rows.filter(row => row.kind === 'offer').map(row => trip(row)), request = rows.filter(row => row.kind === 'request').map(row => trip(row));
    const page = input.startDate ? { page: { startDate: input.startDate, endDateExclusive: input.endDateExclusive,
      nextDate: nextDate ?? '', hasMore: !!nextDate } } : {};
    return input.type && input.type !== 'all'
      ? { ok: true, success: true, type: input.type, data: input.type === 'carpool' ? carpool : request, ...page }
      : { ok: true, success: true, data: { carpool, request }, carpoolList: carpool, requestList: request, ...page };
  }
  const input = parsed.data as z.infer<typeof legacyRideSchemas['rides.detail']>, id = (input.id ?? input.tripId ?? input.requestId)!;
  const type = input.type ?? 'carpool';
  try {
    const row = await getRide(pool, id, appId) as unknown as Row;
    if (row.kind !== (type === 'carpool' ? 'offer' : 'request')) throw new AppError(404, 'RIDE_NOT_FOUND', '行程不存在');
    const viewer = actor ? await getRideMembership(pool, actor.id, id) : null;
    if (viewer && viewer.version !== row.version) throw changed();
    if (actor && !viewer?.role && !viewer?.isCreator) {
      const blocked = (await client.query(`SELECT 1 FROM ride_members m JOIN user_blocks b ON b.active AND
        ((b.blocker_id=$2 AND b.target_id=m.user_id) OR (b.target_id=$2 AND b.blocker_id=m.user_id))
        WHERE m.ride_id=$1 AND m.state='active' AND m.user_id<>$2 LIMIT 1`, [id, actor.id])).rowCount;
      if (blocked) return { ok: false, success: false, blocked: true, errorMsg: '你和该路线成员之间存在拉黑关系，无法查看', openid, type };
    }
    const data: Trip & Record<string, unknown> = trip(row);
    let driverInfo: Awaited<ReturnType<typeof member>> | null = null, passengerProfiles: Awaited<ReturnType<typeof member>>[] = [], ratedTargetOpenids: string[] = [];
    if (actor && viewer?.role) {
      const allowed = await getRideParticipants(pool, actor.id, id);
      if (allowed.version !== row.version) throw changed();
      const ratings = await listMyRideRatings(pool, actor.id, id);
      const identities = await identityMap(client, appId, [...allowed.participants.map(p => p.id), ...ratings.ratings.map(r => r.targetId)]);
      const profiles = await Promise.all(allowed.participants.map(p => member(p, identities.get(p.id)!, actor.id, deps)));
      const driverIndex = allowed.participants.findIndex(p => p.role === 'driver');
      driverInfo = driverIndex < 0 ? null : profiles[driverIndex]!;
      const creatorIndex = allowed.participants.findIndex(p => p.isCreator);
      if (creatorIndex >= 0) data._openid = profiles[creatorIndex]!._openid;
      const passengers = profiles.filter((_, i) => allowed.participants[i]!.role === 'passenger');
      if (type === 'request') {
        if (driverInfo) data.driverOpenid = driverInfo._openid;
        data.passengerID = passengers.map(p => p._openid);
        if (viewer.role === 'driver') passengerProfiles = passengers;
      } else {
        data.passengers = passengers;
        data.zelle = driverIndex >= 0 && allowed.participants[driverIndex]!.zelle ? 'yes' : 'no';
      }
      if (allowed.largeLuggageCount !== undefined) data.largeLuggageCount = allowed.largeLuggageCount;
      ratedTargetOpenids = ratings.ratings.map(r => identities.get(r.targetId)!);
    }
    return { ok: true, success: true, data, driverInfo, driverStats: driverInfo?.rideStats ?? data.driverStats,
      ...(type === 'request' ? { passengerProfiles, passengerProfilesError: false } : {}),
      openid, type, from: type, ratedTargetOpenids, ratingState: { ratedTargetOpenids } };
  } catch (error) {
    if (!(error instanceof AppError && error.code === 'RIDE_NOT_FOUND')) throw error;
    // Old detail caches remove stale entries only on this explicit marker.
    // Storage errors and concurrent changes must remain visible failures.
    return { ok: false, success: false, notFound: true,
      errorMsg: type === 'request' ? '该求车路线不存在或已被删除' : '该路线不存在或已被删除', openid, type };
  }
}
