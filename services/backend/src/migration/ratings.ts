import type { Document, IssueReporter, MemberRow, MigrationIssue, RideRow, UserRow } from './types.ts';
import { indexMigrationUsers, object, parseExportTimestamp, text } from './values.ts';
import { serializeSource } from './source.ts';

export type RatingRow = {
  id: string; rideId: string; raterId: string; targetId: string;
  raterRole: 'driver' | 'passenger'; targetRole: 'driver' | 'passenger';
  score: number; createdAt: string; eventId: null;
};
const sourceFields = new Set(['_id', '_openid', 'tripId', 'type', 'collection', 'raterOpenid', 'targetOpenid',
  'raterRole', 'targetRole', 'score', 'comment', 'createdAt', 'updatedAt']);
const sourceId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value);
const role = (value: unknown): value is RatingRow['raterRole'] => value === 'driver' || value === 'passenger';

/** Import only independently evidenced scores; never reconstruct ratings from summaries or notifications. */
export function normalizeRatings(
  documents: unknown,
  users: readonly Pick<UserRow, 'id' | 'openid' | 'appId'>[],
  rides: readonly RideRow[],
  members: readonly MemberRow[],
  appId: string
): { rows: RatingRow[] | null; issues: MigrationIssue[] } {
  const issues: MigrationIssue[] = [];
  const issue = (code: string, field: string, severity: 'error' | 'notice' = 'error') => {
    const existing = issues.find(item => item.code === code && item.field === `TripRatings.${field}` && item.severity === severity);
    if (existing) existing.count++;
    else issues.push({ collection: 'other', code, field: `TripRatings.${field}`, severity, count: 1 });
  };
  const mappingIssue: IssueReporter = (_collection, code, field = '-', severity = 'error') => issue(code, field, severity);
  const userMap = indexMigrationUsers(users, appId, mappingIssue);
  const userIds = new Set([...userMap.values()].map(user => user.id.toLowerCase()));
  const rideMap = new Map<string, RideRow>();
  for (const ride of rides) {
    if (!object(ride) || !sourceId(ride.id) || !['offer', 'request'].includes(ride.kind) ||
      !['open', 'closed', 'cancelled'].includes(ride.status) || rideMap.has(ride.id)) {
      issue('INVALID_RIDE_MAPPING', 'rides'); continue;
    }
    rideMap.set(ride.id, ride);
  }
  const memberMap = new Map<string, MemberRow>();
  for (const member of members) {
    if (!object(member) || !rideMap.has(member.rideId) || typeof member.userId !== 'string' ||
      !userIds.has(member.userId.toLowerCase()) || !role(member.role) || member.state !== 'active') {
      issue('INVALID_MEMBER_MAPPING', 'members'); continue;
    }
    const key = JSON.stringify([member.rideId, member.userId.toLowerCase()]);
    if (memberMap.has(key)) { issue('INVALID_MEMBER_MAPPING', 'members'); continue; }
    memberMap.set(key, member);
  }
  if (!Array.isArray(documents)) { issue('INVALID_COLLECTION', '-'); return { rows: null, issues }; }
  const rows: RatingRow[] = [];
  const ids = new Set<string>();
  const pairs = new Set<string>();
  for (const value of documents) {
    if (!object(value)) { issue('INVALID_DOCUMENT', '-'); continue; }
    const raw: Document = value;
    try { serializeSource(raw); } catch { issue('INVALID_SOURCE_JSON', '-'); continue; }
    for (const key of Object.keys(raw)) if (!sourceFields.has(key)) issue('UNMAPPED_FIELD', '-');
    if (!sourceId(raw._id)) { issue('INVALID_SOURCE_ID', '_id'); continue; }
    // Rating/ride IDs are text, not UUID columns: preserve case exactly.
    if (ids.has(raw._id)) issue('DUPLICATE_SOURCE_ID', '_id');
    ids.add(raw._id);
    const identities = new Map<string, string>();
    for (const field of ['_openid', 'raterOpenid', 'targetOpenid']) {
      const openid = raw[field];
      const user = text(openid) && openid.trim() === openid ? userMap.get(openid) : undefined;
      if (!user) issue('MISSING_OR_INVALID_IDENTITY', field);
      else identities.set(field, user.id.toLowerCase());
    }
    if (raw._openid !== raw.raterOpenid) issue('CONFLICTING_ALIASES', 'raterOpenid');
    const raterId = identities.get('raterOpenid'), targetId = identities.get('targetOpenid');
    if (raterId && raterId === targetId) issue('SELF_RATING', 'targetOpenid');
    if (!role(raw.raterRole)) issue('INVALID_RATING_ROLE', 'raterRole');
    if (!role(raw.targetRole)) issue('INVALID_RATING_ROLE', 'targetRole');
    if (role(raw.raterRole) && role(raw.targetRole) && raw.raterRole === raw.targetRole) issue('INVALID_RATING_ROLE_PAIR', 'roles');
    if (typeof raw.score !== 'number' || !Number.isInteger(raw.score) || raw.score < 1 || raw.score > 5) issue('INVALID_RATING_SCORE', 'score');

    const createdAt = parseExportTimestamp(raw.createdAt), updatedAt = parseExportTimestamp(raw.updatedAt);
    if (!createdAt) issue('MISSING_OR_INVALID_TIMESTAMP', 'createdAt');
    if (!updatedAt) issue('MISSING_OR_INVALID_TIMESTAMP', 'updatedAt');
    if (createdAt && updatedAt && Date.parse(updatedAt) < Date.parse(createdAt)) issue('TIMESTAMP_ORDER', 'updatedAt');
    // Old rateUser always wrote an empty comment and never edited a rating.
    // Validate these legacy fields before preserving them only in source evidence.
    if (raw.comment !== '') issue('UNSUPPORTED_RATING_COMMENT', 'comment');

    const ride = sourceId(raw.tripId) ? rideMap.get(raw.tripId) : undefined;
    if (!sourceId(raw.tripId)) issue('INVALID_RIDE_ID', 'tripId');
    else if (!ride) issue('UNKNOWN_RIDE', 'tripId');
    const expectedKind = raw.type === 'carpool' ? 'offer' : raw.type === 'request' ? 'request' : null;
    const expectedCollection = raw.type === 'carpool' ? 'Carpool' : raw.type === 'request' ? 'CarpoolRequest' : null;
    if (!expectedKind || raw.collection !== expectedCollection || (ride && ride.kind !== expectedKind)) issue('CONFLICTING_RIDE_TYPE', 'type');
    if (ride) {
      if (ride.status !== 'closed') issue('RATING_REQUIRES_CLOSED_RIDE', 'tripId');
      const rideCreatedAt = parseExportTimestamp(ride.createdAt), departureAt = parseExportTimestamp(ride.departureAt);
      if (!rideCreatedAt || !departureAt) issue('INVALID_RIDE_MAPPING', 'rideTime');
      if (createdAt && rideCreatedAt && Date.parse(createdAt) < Date.parse(rideCreatedAt)) issue('RATING_BEFORE_RIDE_CREATED', 'createdAt');
      // A previously submitted score is historical evidence, not a new rating
      // permission check. Keep its original clock even if old status handling
      // allowed it before departure; runtime eligibility remains independent.
      if (createdAt && departureAt && Date.parse(createdAt) < Date.parse(departureAt)) {
        issue('LEGACY_EARLY_RATING_PRESERVED', 'createdAt', 'notice');
      }
      for (const [id, sourceRole, field] of [[raterId, raw.raterRole, 'raterRole'], [targetId, raw.targetRole, 'targetRole']] as const) {
        if (!id) continue;
        const member = memberMap.get(JSON.stringify([ride.id, id]));
        if (!member) issue('RATING_USER_NOT_MEMBER', field);
        else if (member.role !== sourceRole) issue('RATING_MEMBER_ROLE_MISMATCH', field);
      }
    }
    if (ride && raterId && targetId) {
      const pair = JSON.stringify([ride.id, raterId, targetId]);
      if (pairs.has(pair)) issue('DUPLICATE_RATING', 'pair');
      pairs.add(pair);
    }
    if (ride && raterId && targetId && role(raw.raterRole) && role(raw.targetRole) && typeof raw.score === 'number' && createdAt) {
      rows.push({ id: raw._id, rideId: ride.id, raterId, targetId, raterRole: raw.raterRole,
        targetRole: raw.targetRole, score: raw.score, createdAt, eventId: null });
    }
  }
  issues.sort((a, b) => `${a.code}:${a.field}:${a.severity}`.localeCompare(`${b.code}:${b.field}:${b.severity}`));
  return { rows: issues.some(item => item.severity === 'error') ? null : rows, issues };
}
