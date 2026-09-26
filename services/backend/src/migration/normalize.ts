import { createHash } from 'node:crypto';

type Document = Record<string, unknown>;
type Collection = 'userInfo' | 'Carpool' | 'CarpoolRequest' | 'other';
export type MigrationIssue = {
  collection: Collection; code: string; field: string; severity: 'error' | 'notice'; count: number;
};
export type UserRow = { id: string; appId: string; openid: string; name: string; avatarUrl: string; profile: Document; createdAt: string; updatedAt: string };
export type RideRow = { id: string; kind: 'offer' | 'request'; creatorId: string; cityKey: string; status: 'open' | 'cancelled' | 'closed'; seatCapacity: number; departureAt: string; timeZone: string; listedPriceCents: number | null; details: Document; version: number; createdAt: string; updatedAt: string };
export type MemberRow = { rideId: string; userId: string; role: 'driver' | 'passenger'; seatCount: number; state: 'active'; joinedAt: string; leftAt: null; details: Document };
export type StopRow = { rideId: string; position: number; kind: 'departure' | 'destination'; address: string; placeId: string | null; departureAt: string | null };
export type MigrationPlan = { users: UserRow[]; rides: RideRow[]; members: MemberRow[]; stops: StopRow[] };
export type MigrationReport = {
  sourceKind: 'cloudbase-full-export' | 'rejected'; ready: boolean;
  inputCounts: Record<Collection, number>; candidateCounts: { users: number; rides: number; members: number; stops: number };
  issues: MigrationIssue[];
};
export type CloudBaseExport = { kind: 'cloudbase-full-export'; appId: string; collections: Record<string, unknown[]> };

const collections: Collection[] = ['userInfo', 'Carpool', 'CarpoolRequest'];
const indexFields = ['tripDriver', 'tripDriverHistory', 'tripDriverJoin', 'tripDriverJoinHistory', 'tripPassenger', 'tripPassengerHistory', 'tripPassengerCreate', 'tripPassengerCreateHistory'];
const userFields = new Set([
  '_id', '_openid', 'openid', 'name', 'nickName', 'nickname', 'avatarUrl', 'createdAt', 'createdTime', 'createTime', 'updatedAt', 'updateTime',
  'phone', 'regionPhone', 'wechatID', 'wechatId', 'wechat', 'bio', 'carNumber', 'carPlate', 'plateNumber', 'carBrand', 'carModel',
  'zelleName', 'zelleAccount', 'defaultShowZelle', 'regionState', 'regionCounty', 'regionArea', 'regionKey', 'regionDisplay', 'location',
  'commonPickupAddresses', 'commonDropoffAddresses', 'commonComments', 'profileCompleted', 'status', 'role', ...indexFields,
]);
const rideFields = new Set([
  '_id', '_openid', 'cityKey', 'cityLabel', 'departures', 'destinations', 'passengerCount', 'availSeatNum', 'passengers', 'passengerID',
  'driverOpenid', 'status', 'referencePrice', 'comment', 'zelle', 'largeLuggageCount', 'createdAt', 'updatedAt',
  'departureAtMs', 'latestDepartureAtMs', 'firstDepartureDate', 'firstDepartureTime', 'businessVersion', 'businessSynthetic',
]);
const pointFields = new Set(['address', 'date', 'time', 'placeId']);
const passengerFields = new Set(['_openid', 'name', 'nickName', 'nickname', 'avatarUrl', 'joinedAt', 'pickupAddress', 'dropoffAddress']);
const object = (value: unknown): value is Document => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const present = (value: unknown) => value !== undefined && value !== null && value !== '';

/** Deterministic UUID for a verified app/OpenID pair; not an authentication mechanism. */
export function migrationUserId(appId: string, openid: string): string {
  const bytes = createHash('sha256').update(JSON.stringify(['linkx-user-v1', appId, openid])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** CloudBase Date exports and explicit UTC/offset strings only; never host-local parsing. */
export function parseExportTimestamp(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (object(value) && Object.keys(value).length === 1 && '$date' in value) return parseExportTimestamp(value.$date);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  // Reject dates which JavaScript silently rolls into the following month.
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (!year || !month || !day || month > 12 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  const [hour, minute, second] = value.slice(11, 19).split(':').map(Number);
  if (hour! > 23 || minute! > 59 || second! > 59) return null;
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Returns all matching instants. A fall DST overlap has two; a spring gap has none. */
export function localDepartureCandidates(date: unknown, time: unknown, timeZone = 'America/New_York'): string[] {
  if (typeof date !== 'string' || typeof time !== 'string') return [];
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const clock = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match || !clock) return [];
  const expected = [+match[1]!, +match[2]!, +match[3]!, +clock[1]!, +clock[2]!];
  const [year, month, day, hour, minute] = expected as [number, number, number, number, number];
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59) return [];
  const nominal = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = (ms: number) => {
    const values = Object.fromEntries(formatter.formatToParts(new Date(ms)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    return [values.year!, values.month!, values.day!, values.hour!, values.minute!];
  };
  const offsets = new Set([-36, 0, 36].map(hours => {
    const at = nominal + hours * 3_600_000;
    const p = parts(at);
    return Date.UTC(p[0]!, p[1]! - 1, p[2]!, p[3]!, p[4]!) - at;
  }));
  return [...offsets].map(offset => nominal - offset)
    .filter(candidate => parts(candidate).every((value, i) => value === expected[i]))
    .sort((a, b) => a - b).map(ms => new Date(ms).toISOString());
}

/** Explicit existing USD formats only. Never extract the first number from arbitrary text. */
export function parseListedPrice(value: unknown): { valid: boolean; cents: number | null } {
  if (value === null || value === undefined || value === '') return { valid: true, cents: null };
  if (typeof value !== 'string' && typeof value !== 'number') return { valid: false, cents: null };
  const match = /^(\d{1,8})(?:\.(\d{1,2}))?(?:\$\/人)?$/.exec(String(value).trim());
  if (!match) return { valid: false, cents: null };
  const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return { valid: Number.isSafeInteger(cents) && cents <= 2_147_483_647, cents };
}

/** Read-only candidate normalization. The plan contains private data: print only report. */
export function normalizeCloudBaseExport(input: unknown, options: { timeZone: 'America/New_York' }): { plan: MigrationPlan | null; report: MigrationReport } {
  const plan: MigrationPlan = { users: [], rides: [], members: [], stops: [] };
  const report: MigrationReport = { sourceKind: 'rejected', ready: false, inputCounts: { userInfo: 0, Carpool: 0, CarpoolRequest: 0, other: 0 }, candidateCounts: { users: 0, rides: 0, members: 0, stops: 0 }, issues: [] };
  const issue = (collection: Collection, code: string, field = '-', severity: 'error' | 'notice' = 'error') => {
    const previous = report.issues.find(item => item.collection === collection && item.code === code && item.field === field && item.severity === severity);
    if (previous) previous.count++; else report.issues.push({ collection, code, field, severity, count: 1 });
  };
  if (options.timeZone !== 'America/New_York' || !object(input) || input.kind !== 'cloudbase-full-export' || !text(input.appId) || !object(input.collections)) {
    issue('other', 'FULL_EXPORT_REQUIRED'); return { plan: null, report };
  }
  const appId = input.appId;
  const docs = input.collections;
  report.sourceKind = 'cloudbase-full-export';
  for (const required of collections) if (!Array.isArray(docs[required])) issue(required, 'COLLECTION_MISSING');
  for (const [name, values] of Object.entries(docs)) {
    const collection: Collection = collections.includes(name as Collection) ? name as Collection : 'other';
    if (!Array.isArray(values)) { issue(collection, 'INVALID_COLLECTION'); continue; }
    report.inputCounts[collection] += values.length;
    if (collection === 'other' && values.length) issue('other', 'UNMAPPED_COLLECTION');
  }
  const unknownFields = (doc: Document, allowed: Set<string>, collection: Collection, field = '-') => {
    for (const key of Object.keys(doc)) if (!allowed.has(key)) issue(collection, 'UNMAPPED_FIELD', field);
  };
  const alias = (doc: Document, keys: string[], collection: Collection, field: string): unknown => {
    const values = keys.map(key => doc[key]).filter(present);
    if (values.length > 1 && values.some(value => JSON.stringify(value) !== JSON.stringify(values[0]))) issue(collection, 'CONFLICTING_ALIASES', field);
    return values[0];
  };
  const stamp = (doc: Document, keys: string[], collection: Collection, field: string): string => {
    const values = keys.map(key => doc[key]).filter(present);
    const normalized = values.map(parseExportTimestamp);
    if (!normalized.length || normalized.some(value => !value)) { issue(collection, 'MISSING_OR_INVALID_TIMESTAMP', field); return ''; }
    if (normalized.some(value => value !== normalized[0])) issue(collection, 'CONFLICTING_ALIASES', field);
    return normalized[0]!;
  };
  const userByOpenid = new Map<string, UserRow>();
  const sourceUsers: Document[] = [];
  for (const raw of Array.isArray(docs.userInfo) ? docs.userInfo : []) {
    if (!object(raw)) { issue('userInfo', 'INVALID_DOCUMENT'); continue; }
    sourceUsers.push(raw);
    unknownFields(raw, userFields, 'userInfo');
    const openid = alias(raw, ['_openid', 'openid'], 'userInfo', 'openid');
    if (!text(openid) || openid.trim() !== openid) { issue('userInfo', 'MISSING_OR_INVALID_IDENTITY', 'openid'); continue; }
    if (userByOpenid.has(openid)) { issue('userInfo', 'DUPLICATE_OPENID', 'openid'); continue; }
    const profile: Document = {};
    const assignText = (target: Document, key: string, keys: string[]) => {
      const value = alias(raw, keys, 'userInfo', key);
      if (value === undefined) return;
      if (typeof value !== 'string') issue('userInfo', 'INVALID_PROFILE_VALUE', key); else target[key] = value;
    };
    for (const [key, keys] of Object.entries({ phone: ['phone'], phoneRegion: ['regionPhone'], wechatId: ['wechatID', 'wechatId', 'wechat'], bio: ['bio'] })) assignText(profile, key, keys);
    for (const [key, fields] of Object.entries({
      vehicle: { plate: ['carNumber', 'carPlate', 'plateNumber'], brand: ['carBrand'], model: ['carModel'] },
      zelle: { name: ['zelleName'], account: ['zelleAccount'] },
      region: { state: ['regionState'], county: ['regionCounty'], area: ['regionArea'], key: ['regionKey'], label: ['regionDisplay'] },
    })) {
      const value: Document = {};
      for (const [name, keys] of Object.entries(fields)) assignText(value, name, keys);
      if (Object.keys(value).length) profile[key] = value;
    }
    if (raw.defaultShowZelle !== undefined) {
      if (typeof raw.defaultShowZelle !== 'boolean') issue('userInfo', 'INVALID_PROFILE_VALUE', 'zelle');
      else profile.zelle = { ...(object(profile.zelle) ? profile.zelle : {}), public: raw.defaultShowZelle };
    }
    if (raw.profileCompleted !== undefined) {
      if (typeof raw.profileCompleted !== 'boolean') issue('userInfo', 'INVALID_PROFILE_VALUE', 'profileCompleted'); else profile.profileCompleted = raw.profileCompleted;
    }
    const preferences: Document = {};
    for (const [old, canonical] of [['commonPickupAddresses', 'pickupAddresses'], ['commonDropoffAddresses', 'dropoffAddresses'], ['commonComments', 'comments']]) {
      const value = raw[old!];
      if (value === undefined) continue;
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) issue('userInfo', 'INVALID_PROFILE_VALUE', 'preferences');
      else preferences[canonical!] = [...value];
    }
    if (Object.keys(preferences).length) profile.preferences = preferences;
    if (raw.location !== undefined) {
      if (!object(raw.location)) issue('userInfo', 'INVALID_PROFILE_VALUE', 'location');
      else if (Object.keys(raw.location).length) {
        unknownFields(raw.location, new Set(['displayName', 'name', 'address', 'lat', 'lng', 'latitude', 'longitude']), 'userInfo', 'location');
        const location: Document = {};
        // displayName and name are separately persisted labels in old records. Conflicts require review.
        const label = alias(raw.location, ['displayName', 'name'], 'userInfo', 'location');
        if (label !== undefined) { if (typeof label === 'string') location.label = label; else issue('userInfo', 'INVALID_PROFILE_VALUE', 'location'); }
        if (raw.location.address !== undefined) { if (typeof raw.location.address === 'string') location.address = raw.location.address; else issue('userInfo', 'INVALID_PROFILE_VALUE', 'location'); }
        for (const [key, names, maximum] of [['latitude', ['lat', 'latitude'], 90], ['longitude', ['lng', 'longitude'], 180]] as const) {
          const value = alias(raw.location, [...names], 'userInfo', 'location');
          if (value === undefined) continue;
          if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > maximum) issue('userInfo', 'INVALID_PROFILE_VALUE', 'location'); else location[key] = value;
        }
        profile.location = location;
      }
    }
    if (present(raw.status) && raw.status !== 'normal') issue('userInfo', 'UNMAPPED_ACCOUNT_STATUS', 'status');
    if (present(raw.role)) issue('userInfo', 'LEGACY_ROLE_NOT_MEMBERSHIP', 'role', 'notice');
    const name = alias(raw, ['name', 'nickName', 'nickname'], 'userInfo', 'name');
    if (name !== undefined && typeof name !== 'string') issue('userInfo', 'INVALID_PROFILE_VALUE', 'name');
    if (raw.avatarUrl !== undefined && typeof raw.avatarUrl !== 'string') issue('userInfo', 'INVALID_PROFILE_VALUE', 'avatarUrl');
    const user: UserRow = { id: migrationUserId(appId, openid), appId, openid, name: typeof name === 'string' ? name : '', avatarUrl: typeof raw.avatarUrl === 'string' ? raw.avatarUrl : '', profile, createdAt: stamp(raw, ['createdAt', 'createdTime', 'createTime'], 'userInfo', 'createdAt'), updatedAt: stamp(raw, ['updatedAt', 'updateTime'], 'userInfo', 'updatedAt') };
    if (user.createdAt && user.updatedAt && user.updatedAt < user.createdAt) issue('userInfo', 'INVALID_TIMESTAMP_ORDER');
    userByOpenid.set(openid, user); plan.users.push(user);
  }
  const rideIds = new Set<string>();
  for (const collection of ['Carpool', 'CarpoolRequest'] as const) {
    for (const raw of Array.isArray(docs[collection]) ? docs[collection] : []) {
      if (!object(raw)) { issue(collection, 'INVALID_DOCUMENT'); continue; }
      unknownFields(raw, rideFields, collection);
      if (!text(raw._id)) { issue(collection, 'MISSING_RIDE_ID'); continue; }
      if (rideIds.has(raw._id)) { issue(collection, 'DUPLICATE_RIDE_ID'); continue; }
      rideIds.add(raw._id);
      if (raw.businessSynthetic === true) issue(collection, 'SYNTHETIC_RECORD_REQUIRES_SEPARATE_IMPORT');
      const creator = typeof raw._openid === 'string' ? userByOpenid.get(raw._openid) : undefined;
      if (!creator) { issue(collection, 'UNKNOWN_USER', 'creator'); continue; }
      const kind = collection === 'Carpool' ? 'offer' : 'request';
      for (const field of kind === 'offer' ? ['passengerID', 'driverOpenid', 'largeLuggageCount'] : ['passengers', 'availSeatNum', 'zelle']) {
        if (raw[field] !== undefined) issue(collection, 'UNMAPPED_FIELD_FOR_RIDE_KIND', field);
      }
      if (raw.businessSynthetic !== undefined && typeof raw.businessSynthetic !== 'boolean') issue(collection, 'INVALID_SYNTHETIC_FLAG', 'businessSynthetic');
      const createdAt = stamp(raw, ['createdAt'], collection, 'createdAt');
      const updatedAt = stamp(raw, ['updatedAt'], collection, 'updatedAt');
      if (createdAt && updatedAt && updatedAt < createdAt) issue(collection, 'INVALID_TIMESTAMP_ORDER');
      const stops: StopRow[] = [];
      for (const [field, stopKind] of [['departures', 'departure'], ['destinations', 'destination']] as const) {
        if (!Array.isArray(raw[field]) || !raw[field].length) { issue(collection, 'MISSING_STOPS', field); continue; }
        for (const point of raw[field]) {
          if (!object(point) || !text(point.address)) { issue(collection, 'MISSING_ADDRESS', field); continue; }
          unknownFields(point, pointFields, collection, field);
          let departureAt: string | null = null;
          if (stopKind === 'departure' || present(point.date) || present(point.time)) {
            const candidates = localDepartureCandidates(point.date, point.time, options.timeZone);
            if (candidates.length !== 1) issue(collection, candidates.length > 1 ? 'AMBIGUOUS_LOCAL_TIME' : 'MISSING_OR_INVALID_LOCAL_TIME', field);
            else departureAt = candidates[0]!;
          }
          if (point.placeId !== undefined && point.placeId !== null && !text(point.placeId)) issue(collection, 'INVALID_PLACE_ID', field);
          stops.push({ rideId: raw._id, position: stops.length, kind: stopKind, address: point.address, placeId: text(point.placeId) ? point.placeId : null, departureAt });
        }
      }
      const times = stops.filter(stop => stop.kind === 'departure' && stop.departureAt).map(stop => stop.departureAt!).sort();
      if (present(raw.firstDepartureDate) || present(raw.firstDepartureTime)) {
        const cached = localDepartureCandidates(raw.firstDepartureDate, raw.firstDepartureTime, options.timeZone);
        if (cached.length !== 1 || cached[0] !== times[0]) issue(collection, 'CONFLICTING_DEPARTURE_TIME', 'firstDeparture');
      }
      for (const [field, time] of [['departureAtMs', times[0]], ['latestDepartureAtMs', times[times.length - 1]]] as const) {
        if (present(raw[field]) && parseExportTimestamp(raw[field]) !== time) issue(collection, 'CONFLICTING_DEPARTURE_TIME', field);
      }
      const statuses: Record<string, RideRow['status']> = { open: 'open', full: 'open', past: 'closed', closed: 'closed', cancelled: 'cancelled', canceled: 'cancelled' };
      const status = typeof raw.status === 'string' ? statuses[raw.status] : undefined;
      if (!status) issue(collection, 'UNMAPPED_RIDE_STATUS', 'status');
      const price = parseListedPrice(raw.referencePrice);
      if (!price.valid) issue(collection, 'UNRESOLVED_PRICE', 'referencePrice');
      const seatCount = typeof raw.passengerCount === 'number' ? raw.passengerCount : NaN;
      if (!Number.isInteger(seatCount) || seatCount < 1 || seatCount > (kind === 'offer' ? 8 : 4)) issue(collection, 'INVALID_SEAT_COUNT', 'passengerCount');
      const version = raw.businessVersion === undefined ? 1 : raw.businessVersion;
      if (raw.businessVersion === undefined) issue(collection, 'INITIAL_VERSION_ASSIGNED', 'businessVersion', 'notice');
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) issue(collection, 'INVALID_VERSION', 'businessVersion');
      const details: Document = {};
      for (const key of ['comment', 'zelle'] as const) if (raw[key] !== undefined) {
        if (typeof raw[key] !== 'string') issue(collection, 'INVALID_RIDE_DETAIL', key); else details[key === 'zelle' ? 'zelleDisplay' : key] = raw[key];
      }
      if (raw.largeLuggageCount !== undefined) {
        if (typeof raw.largeLuggageCount !== 'number' || !Number.isInteger(raw.largeLuggageCount) || raw.largeLuggageCount < 0) issue(collection, 'INVALID_RIDE_DETAIL', 'largeLuggageCount'); else details.largeLuggageCount = raw.largeLuggageCount;
      }
      if (raw.cityKey !== 'ny_nj' && raw.cityKey !== 'ny' && raw.cityKey !== 'nj') issue(collection, 'UNMAPPED_CITY', 'cityKey');
      if (raw.cityKey === 'ny' || raw.cityKey === 'nj') issue(collection, 'CITY_ALIAS_NORMALIZED', 'cityKey', 'notice');
      const ride: RideRow = { id: raw._id, kind, creatorId: creator.id, cityKey: 'ny_nj', status: status || 'open', seatCapacity: kind === 'offer' ? seatCount : 4, departureAt: times[0] || '', timeZone: options.timeZone, listedPriceCents: price.cents, details, version: typeof version === 'number' ? version : 1, createdAt, updatedAt };
      plan.rides.push(ride); plan.stops.push(...stops);
      const members: MemberRow[] = [];
      const addMember = (openid: unknown, role: MemberRow['role'], seats: number, joinedAt: string, memberDetails: Document = {}) => {
        const user = typeof openid === 'string' ? userByOpenid.get(openid) : undefined;
        if (!user) { issue(collection, 'UNKNOWN_USER', 'member'); return; }
        if (members.some(member => member.userId === user.id)) { issue(collection, 'DUPLICATE_MEMBER', 'member'); return; }
        if (joinedAt && createdAt && joinedAt < createdAt) issue(collection, 'INVALID_TIMESTAMP_ORDER', 'joinedAt');
        members.push({ rideId: ride.id, userId: user.id, role, seatCount: seats, state: 'active', joinedAt, leftAt: null, details: memberDetails });
      };
      if (kind === 'offer') {
        addMember(creator.openid, 'driver', 0, createdAt);
        if (!Array.isArray(raw.passengers)) issue(collection, 'INVALID_MEMBER_LIST', 'passengers');
        else for (const passenger of raw.passengers) {
          if (typeof passenger === 'string') { issue(collection, 'MISSING_MEMBERSHIP_TIMESTAMP', 'passengers'); addMember(passenger, 'passenger', 1, ''); continue; }
          if (!object(passenger)) { issue(collection, 'INVALID_MEMBER', 'passengers'); continue; }
          unknownFields(passenger, passengerFields, collection, 'passengers');
          const memberDetails: Document = {};
          const name = alias(passenger, ['name', 'nickName', 'nickname'], collection, 'passengerName');
          if (name !== undefined) { if (typeof name !== 'string') issue(collection, 'INVALID_MEMBER_DETAIL', 'passengers'); else memberDetails.name = name; }
          for (const key of ['avatarUrl', 'pickupAddress', 'dropoffAddress']) if (passenger[key] !== undefined) {
            if (typeof passenger[key] !== 'string') issue(collection, 'INVALID_MEMBER_DETAIL', 'passengers'); else memberDetails[key] = passenger[key];
          }
          addMember(passenger._openid, 'passenger', 1, stamp(passenger, ['joinedAt'], collection, 'joinedAt'), memberDetails);
        }
        if (typeof raw.availSeatNum !== 'number' || raw.availSeatNum !== seatCount - members.filter(member => member.role === 'passenger').length) issue(collection, 'SEAT_BALANCE_MISMATCH', 'availSeatNum');
      } else {
        if (!Array.isArray(raw.passengerID) || raw.passengerID.some(id => !text(id))) issue(collection, 'INVALID_MEMBER_LIST', 'passengerID');
        const ids: string[] = Array.isArray(raw.passengerID) ? raw.passengerID.filter(text) : [];
        if (new Set(ids).size !== ids.length) issue(collection, 'DUPLICATE_MEMBER', 'passengerID');
        if (!ids.includes(creator.openid)) issue(collection, 'CREATOR_MISSING_FROM_MEMBERS', 'passengerID');
        const others = ids.filter(id => id !== creator.openid);
        const creatorSeats = seatCount - others.length;
        if (!Number.isInteger(creatorSeats) || creatorSeats < 1) issue(collection, 'SEAT_BALANCE_MISMATCH', 'passengerCount');
        // Existing joinTrip adds exactly one seat per additional account. Extra seats belong to the creator's original group.
        addMember(creator.openid, 'passenger', creatorSeats, createdAt);
        for (const id of others) { issue(collection, 'MISSING_MEMBERSHIP_TIMESTAMP', 'passengerID'); addMember(id, 'passenger', 1, ''); }
        if (present(raw.driverOpenid)) { issue(collection, 'MISSING_MEMBERSHIP_TIMESTAMP', 'driverOpenid'); addMember(raw.driverOpenid, 'driver', 0, ''); }
      }
      if (members.filter(member => member.role === 'passenger').reduce((sum, member) => sum + member.seatCount, 0) > ride.seatCapacity) issue(collection, 'SEAT_CAPACITY_EXCEEDED');
      const occupied = members.filter(member => member.role === 'passenger').reduce((sum, member) => sum + member.seatCount, 0);
      if ((raw.status === 'full' && occupied !== ride.seatCapacity) || (raw.status === 'open' && occupied >= ride.seatCapacity)) issue(collection, 'SEAT_STATUS_MISMATCH', 'status');
      plan.members.push(...members);
    }
  }
  // Old user arrays are indexes, not membership facts. Report disagreements instead of importing a second truth.
  for (const user of sourceUsers) {
    const openid = typeof user._openid === 'string' ? user._openid : user.openid;
    const target = typeof openid === 'string' ? userByOpenid.get(openid) : undefined;
    for (const field of indexFields) {
      if (user[field] === undefined) continue;
      if (!Array.isArray(user[field])) { issue('userInfo', 'INVALID_LEGACY_INDEX', 'rideIndexes'); continue; }
      for (const id of user[field]) {
        const ride = plan.rides.find(ride => ride.id === id);
        const member = plan.members.find(member => member.rideId === id && member.userId === target?.id);
        const expectedRole = field.startsWith('tripDriver') ? 'driver' : 'passenger';
        const expectedKind = field.startsWith('tripDriverJoin') || field.startsWith('tripPassengerCreate') ? 'request' : field.startsWith('tripDriver') ? 'offer' : undefined;
        if (!text(id) || !ride || !member || member.role !== expectedRole || (expectedKind && ride.kind !== expectedKind) ||
          (field.startsWith('tripPassengerCreate') && ride.creatorId !== target?.id)) issue('userInfo', 'UNRESOLVED_LEGACY_MEMBERSHIP', 'rideIndexes');
      }
    }
  }
  report.candidateCounts = { users: plan.users.length, rides: plan.rides.length, members: plan.members.length, stops: plan.stops.length };
  report.issues.sort((a, b) => `${a.collection}:${a.code}:${a.field}`.localeCompare(`${b.collection}:${b.code}:${b.field}`));
  report.ready = !report.issues.some(item => item.severity === 'error');
  // Never expose a partially valid import plan, invented fallback status, or unresolved timestamps.
  return { plan: report.ready ? plan : null, report };
}
