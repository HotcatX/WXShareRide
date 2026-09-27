import type { PoolClient } from 'pg';
import { AppError } from '../errors.ts';

// This is the existing collector v1 wire contract. Business rows keep their
// full values; only this bounded projection crosses the collector boundary.
const recordId = /^[A-Za-z0-9_-]{1,80}$/;
const openid = /^[A-Za-z0-9_-]{16,128}$/;
const placeId = /^[a-z][a-z0-9_]{1,79}$/;
const code = /^[A-Za-z0-9_.:-]{1,80}$/;
const localTime = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fail = () => new AppError(409, 'RIDE_EVENT_INCOMPATIBLE', '行程数据暂不能同步，请联系客服');
const integer = (value: number | null, max = Number.MAX_SAFE_INTEGER) =>
  value !== null && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
function address(value: string): string {
  // Do not split a UTF-16 surrogate pair at the receiver's 200-code-unit bound.
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 200).replace(/[\uD800-\uDBFF]$/, '');
}
function pointTime(value: string | null) {
  if (value === null) return { date: '', time: '' };
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) throw fail();
  const parts = Object.fromEntries(localTime.formatToParts(at).map(part => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date: /^20\d\d-\d\d-\d\d$/.test(date) ? date : '', time: `${parts.hour}:${parts.minute}` };
}

type Member = { userId: string; appId: string; openid: string; role: 'driver' | 'passenger'; seatCount: number };
type Stop = { kind: 'departure' | 'destination'; address: string; placeId: string | null; departureAt: string | null };
type StateRow = { appId: string; creatorOpenid: string; kind: 'offer' | 'request'; status: 'open' | 'closed' | 'cancelled';
  cityKey: string | null; seatCapacity: number | null; listedPriceCents: number | null; version: number;
  stops: Stop[]; members: Member[] };
export type CollectorSnapshot = {
  cityKey: string; status: 'open' | 'full' | 'past' | 'cancelled';
  departures: { address: string; placeId: string; date: string; time: string }[];
  destinations: { address: string; placeId: string; date: string; time: string }[];
  referencePriceCents: number | null; currency: 'USD'; priceKind: 'listed_reference'; availableSeats: number | null;
  passengerCount: number; creatorOpenid: string; driverOpenid: string; passengerOpenids: string[];
  participantEdges: { openid: string; role: 'driver' | 'passenger' }[];
  serviceDate: string; departureAtMs: number | null; latestDepartureAtMs: number | null; tripVersion: number;
};
export type CapturedRide = { appId: string; tripId: string; tripType: 'carpool' | 'request'; snapshot: CollectorSnapshot; memberUserIds: string[] };

/** Read under the caller's ride lock, before or after the actual mutation. */
export async function captureRide(client: PoolClient, tripId: string): Promise<CapturedRide> {
  if (!recordId.test(tripId)) throw fail(); // An identity is never shortened or replaced.
  const result = await client.query<StateRow>(`SELECT u.app_id AS "appId",u.openid AS "creatorOpenid",r.kind,r.status,
    r.city_key AS "cityKey",r.seat_capacity AS "seatCapacity",r.listed_price_cents AS "listedPriceCents",r.version,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',s.kind,'address',s.address,'placeId',s.place_id,
      'departureAt',s.departure_at) ORDER BY s.position) FROM ride_stops s WHERE s.ride_id=r.id),'[]'::jsonb) AS stops,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('userId',mu.id,'appId',mu.app_id,'openid',mu.openid,'role',m.role,
      'seatCount',m.seat_count) ORDER BY mu.openid) FROM ride_members m JOIN users mu ON mu.id=m.user_id
      WHERE m.ride_id=r.id AND m.state='active'),'[]'::jsonb) AS members
    FROM rides r JOIN users u ON u.id=r.creator_id WHERE r.id=$1`, [tripId]);
  const row = result.rows[0];
  if (!row || !openid.test(row.creatorOpenid) || !row.cityKey || !code.test(row.cityKey) || integer(row.version, 2_147_483_647) === null || row.version < 1 ||
    row.members.length > 101 || row.members.some(member => member.appId !== row.appId || !openid.test(member.openid))) throw fail();
  const passengers = row.members.filter(member => member.role === 'passenger');
  if (passengers.length > 100) throw fail();
  const occupied = passengers.reduce((sum, member) => sum + member.seatCount, 0);
  if (integer(occupied, 100) === null) throw fail();
  const available = row.seatCapacity === null ? null : integer(row.seatCapacity - occupied, 20);
  const points = (kind: Stop['kind']) => {
    const raw = row.stops.filter(stop => stop.kind === kind).slice(0, 12);
    return raw.length ? raw.map(stop => ({ address: address(stop.address),
      placeId: stop.placeId && placeId.test(stop.placeId) && !['unknown', 'custom'].includes(stop.placeId) ? stop.placeId : '',
      ...pointTime(stop.departureAt) })) : [{ address: '', placeId: '', date: '', time: '' }];
  };
  const departures = points('departure');
  const times = row.stops.filter(stop => stop.kind === 'departure' && stop.departureAt !== null)
    .map(stop => new Date(stop.departureAt!).getTime());
  if (times.some(at => integer(at) === null)) throw fail();
  const driver = row.members.find(member => member.role === 'driver');
  return { appId: row.appId, tripId, tripType: row.kind === 'offer' ? 'carpool' : 'request', memberUserIds: row.members.map(member => member.userId), snapshot: {
    cityKey: row.cityKey,
    status: row.status === 'closed' ? 'past' : row.status === 'cancelled' ? 'cancelled' : available === 0 ? 'full' : 'open',
    departures, destinations: points('destination'), referencePriceCents: integer(row.listedPriceCents, 1_000_000),
    currency: 'USD', priceKind: 'listed_reference', availableSeats: available,
    // Preserve v1's existing meaning: offer capacity, request occupied seats.
    // Distinct passenger identities remain in passengerOpenids/participantEdges.
    passengerCount: row.kind === 'offer' ? integer(row.seatCapacity, 100) ?? passengers.length : occupied, creatorOpenid: row.creatorOpenid,
    driverOpenid: driver?.openid ?? '', passengerOpenids: passengers.map(member => member.openid),
    participantEdges: row.members.map(member => ({ openid: member.openid, role: member.role })),
    serviceDate: departures[0]!.date, departureAtMs: times.length ? Math.min(...times) : null,
    latestDepartureAtMs: times.length ? Math.max(...times) : null, tripVersion: row.version,
  } };
}

/** Serialize once in the committing transaction; retries send these exact bytes. */
export async function freezeCollectorEvent(client: PoolClient, event: { id: string; createdAt: Date;
  rideId: string; version: number; actorId: string | null; action: string; payload: Record<string, unknown> },
  before: CapturedRide | null): Promise<string> {
  const after = await captureRide(client, event.rideId);
  if (after.snapshot.tripVersion !== event.version || (event.action === 'created' ? before !== null :
    !before || before.tripId !== after.tripId || before.tripType !== after.tripType || before.appId !== after.appId ||
      before.snapshot.tripVersion !== event.version - 1)) throw fail();
  const action = event.action === 'joined' ? (after.tripType === 'request' && event.payload.role === 'driver' ? 'accept' : 'join') :
    ({ created: 'publish', left: 'quit', removed: 'kick', cancelled: 'cancel', closed: 'status' } as Record<string, string>)[event.action];
  if (!action || !recordId.test(event.id) || !Number.isSafeInteger(event.createdAt.getTime())) throw fail();
  let actorOpenid = '';
  if (event.actorId !== null) {
    const actor = (await client.query<{ openid: string }>('SELECT openid FROM users WHERE id=$1 AND app_id=$2', [event.actorId, after.appId])).rows[0];
    if (!actor || !openid.test(actor.openid)) throw fail();
    actorOpenid = actor.openid;
  } else if (action !== 'status') throw fail();
  const affectedOpenids = [...new Set([...(before?.snapshot.participantEdges ?? []), ...after.snapshot.participantEdges].map(member => member.openid))].sort();
  if (affectedOpenids.length > 101) throw fail();
  const serialized = JSON.stringify({ schemaVersion: 1, eventId: event.id, tripId: after.tripId, tripType: after.tripType,
    action, actorOpenid, eventAtMs: event.createdAt.getTime(), version: event.version,
    before: before?.snapshot ?? null, after: after.snapshot, affectedOpenids, synthetic: false });
  if (Buffer.byteLength(serialized) > 112 * 1024 - 64) throw fail();
  return serialized;
}
