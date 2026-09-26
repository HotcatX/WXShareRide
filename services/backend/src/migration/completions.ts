import type { IssueReporter, MigrationIssue, RideRow, UserRow } from './types.ts';
import { indexMigrationUsers, object, text } from './values.ts';
import { serializeSource } from './source.ts';

export type CompletionRow = {
  rideId: string; userId: string; role: 'driver' | 'passenger'; countedAt: null; eventId: null;
};
const countFields = ['completedDriverTrips', 'completedPassengerTrips', 'completedTrips'] as const;
const keyFields = new Set(['version', 'driverKeys', 'passengerKeys']);
const keyPattern = /^(Carpool|CarpoolRequest)\|([a-zA-Z0-9_-]{1,128})$/;

/** Receipts preserve prior counting; they never create or restore membership. */
export function normalizeCompletions(
  documents: unknown,
  users: readonly Pick<UserRow, 'id' | 'openid' | 'appId'>[],
  rides: readonly Pick<RideRow, 'id' | 'kind'>[],
  appId: string,
): { rows: CompletionRow[] | null; issues: MigrationIssue[] } {
  const issues: MigrationIssue[] = [];
  const issue: IssueReporter = (collection, code, field = '-', severity = 'error') => {
    const existing = issues.find(item => item.collection === collection && item.code === code && item.field === field && item.severity === severity);
    if (existing) existing.count++;
    else issues.push({ collection, code, field, severity, count: 1 });
  };
  const userMap = indexMigrationUsers(users, appId, issue);
  const rideMap = new Map<string, Pick<RideRow, 'id' | 'kind'>>();
  for (const ride of rides) {
    if (!object(ride) || typeof ride.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(ride.id) ||
      !['offer', 'request'].includes(ride.kind) || rideMap.has(ride.id)) {
      issue('other', 'INVALID_RIDE_MAPPING', 'rides');
      continue;
    }
    rideMap.set(ride.id, ride);
  }
  if (!Array.isArray(documents)) { issue('userInfo', 'INVALID_COLLECTION'); return { rows: null, issues }; }
  const seenUsers = new Set<string>();
  const rows: CompletionRow[] = [];
  for (const raw of documents) {
    if (!object(raw)) { issue('userInfo', 'INVALID_DOCUMENT'); continue; }
    try { serializeSource(raw); } catch { issue('userInfo', 'INVALID_SOURCE_JSON'); continue; }
    const stats = raw.rideStats === undefined ? {} : raw.rideStats;
    if (!object(stats)) { issue('userInfo', 'INVALID_COMPLETION_COUNTS', 'rideStats'); continue; }
    // Other profile and rating fields are checked by their central converters.
    // Do not silently accept misspelled completion counters as absent zeros.
    for (const field of Object.keys(stats)) {
      if (field.startsWith('completed') && !countFields.some(known => known === field)) {
        issue('userInfo', 'UNMAPPED_FIELD', 'rideStats.completed');
      }
    }
    const hasCompletionData = raw._rideCompletionV1 !== undefined || countFields.some(field => stats[field] !== undefined);
    if (!Object.hasOwn(raw, '_openid')) {
      // Sparse alias records and the old anonymous index are source evidence,
      // not a second authority for a user's completion receipts.
      if (raw.openid !== undefined && (!text(raw.openid) || raw.openid.trim() !== raw.openid || !userMap.has(raw.openid))) {
        issue('userInfo', 'UNKNOWN_USER', 'openid');
      }
      if (hasCompletionData) issue('userInfo', 'UNVERIFIED_COMPLETION_IDENTITY', '_openid');
      continue;
    }
    const user = typeof raw._openid === 'string' ? userMap.get(raw._openid) : undefined;
    if (!text(raw._openid) || raw._openid.trim() !== raw._openid || !user) {
      issue('userInfo', 'UNKNOWN_USER', '_openid'); continue;
    }
    if (seenUsers.has(raw._openid)) { issue('userInfo', 'DUPLICATE_OPENID', '_openid'); continue; }
    seenUsers.add(raw._openid);
    if (raw.openid !== undefined && raw.openid !== raw._openid) issue('userInfo', 'CONFLICTING_ALIASES', 'openid');
    const counts = countFields.map(field => stats[field] === undefined ? 0 : stats[field]);
    if (counts.some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) {
      issue('userInfo', 'INVALID_COMPLETION_COUNTS', 'rideStats'); continue;
    }
    const [driverCount, passengerCount, totalCount] = counts as [number, number, number];
    if (totalCount !== driverCount + passengerCount) issue('userInfo', 'COMPLETION_COUNT_MISMATCH', 'rideStats.completedTrips');
    const keys = raw._rideCompletionV1;
    if (keys === undefined) {
      if (counts.some(value => value !== 0)) issue('userInfo', 'MISSING_COMPLETION_KEYS', '_rideCompletionV1');
      continue;
    }
    if (!object(keys)) { issue('userInfo', 'INVALID_COMPLETION_KEYS', '_rideCompletionV1'); continue; }
    for (const field of Object.keys(keys)) if (!keyFields.has(field)) issue('userInfo', 'UNMAPPED_FIELD', '_rideCompletionV1');
    if (keys.version !== 1) issue('userInfo', 'INVALID_COMPLETION_VERSION', '_rideCompletionV1.version');
    const seenRides = new Set<string>();
    for (const [role, field, count] of [
      ['driver', 'driverKeys', driverCount], ['passenger', 'passengerKeys', passengerCount],
    ] as const) {
      const list = keys[field];
      if (!Array.isArray(list) || list.length > 10000) {
        issue('userInfo', 'INVALID_COMPLETION_KEYS', `_rideCompletionV1.${field}`); continue;
      }
      if (list.length !== count) issue('userInfo', 'COMPLETION_COUNT_MISMATCH', `rideStats.${role === 'driver' ? 'completedDriverTrips' : 'completedPassengerTrips'}`);
      for (const key of list) {
        const match = typeof key === 'string' ? keyPattern.exec(key) : null;
        if (!match) { issue('userInfo', 'INVALID_COMPLETION_KEY', `_rideCompletionV1.${field}`); continue; }
        const rideId = match[2]!, kind = match[1] === 'Carpool' ? 'offer' : 'request';
        const ride = rideMap.get(rideId);
        if (!ride) { issue('userInfo', 'UNKNOWN_COMPLETION_RIDE', '_rideCompletionV1'); continue; }
        if (ride.kind !== kind) { issue('userInfo', 'COMPLETION_RIDE_KIND_MISMATCH', '_rideCompletionV1'); continue; }
        // A receipt spans both role arrays. Keeping the original role does not
        // require that person to remain in today's ride_members snapshot.
        if (seenRides.has(rideId)) { issue('userInfo', 'DUPLICATE_COMPLETION', '_rideCompletionV1'); continue; }
        seenRides.add(rideId);
        rows.push({ rideId, userId: user.id, role, countedAt: null, eventId: null });
      }
    }
  }
  rows.sort((a, b) => a.userId.localeCompare(b.userId) || a.rideId.localeCompare(b.rideId));
  return { rows: issues.some(item => item.severity === 'error') ? null : rows, issues };
}
