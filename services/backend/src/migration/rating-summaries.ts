import type { IssueReporter, UserRow } from './types.ts';
import type { RatingRow } from './ratings.ts';
import { indexMigrationUsers, object, parseExportTimestamp, present, text } from './values.ts';
import { serializeSource } from './source.ts';

const groups = {
  all: ['ratingSum', 'ratingCount', 'ratingAvg', 'ratingWeightedAvg'],
  driver: ['driverRatingSum', 'driverRatingCount', 'driverRatingAvg', 'driverRatingWeightedAvg'],
  passenger: ['passengerRatingSum', 'passengerRatingCount', 'passengerRatingAvg', 'passengerRatingWeightedAvg']
} as const;
const ratingFields = [...Object.values(groups).flat(), 'lastRatedAt'];
const knownFields = new Set([...ratingFields, 'completedTrips', 'completedDriverTrips', 'completedPassengerTrips']);
type Totals = { sum: number; count: number };
type Summary = { all: Totals; driver: Totals; passenger: Totals; lastRatedAt: string | null };
const emptySummary = (): Summary => ({ all: { sum: 0, count: 0 }, driver: { sum: 0, count: 0 },
  passenger: { sum: 0, count: 0 }, lastRatedAt: null });

/** Validate cached legacy scores against rating facts; no summary becomes editable profile state. */
export function validateRatingSummaries(
  documents: unknown,
  users: readonly Pick<UserRow, 'id' | 'openid' | 'appId'>[],
  ratings: readonly RatingRow[],
  appId: string,
  issue: IssueReporter
): void {
  const userMap = indexMigrationUsers(users, appId, issue);
  const expected = new Map<string, Summary>([...userMap.values()].map(user => [user.id.toLowerCase(), emptySummary()]));
  for (const rating of ratings) {
    const summary = object(rating) && typeof rating.targetId === 'string' ? expected.get(rating.targetId.toLowerCase()) : undefined;
    const at = object(rating) ? parseExportTimestamp(rating.createdAt) : null;
    if (!summary || !at || (rating.targetRole !== 'driver' && rating.targetRole !== 'passenger') ||
      typeof rating.score !== 'number' || !Number.isInteger(rating.score) || rating.score < 1 || rating.score > 5) {
      issue('other', 'INVALID_RATING_MAPPING', 'ratings'); continue;
    }
    for (const group of [summary.all, summary[rating.targetRole]]) {
      group.sum += rating.score;
      group.count++;
    }
    if (!summary.lastRatedAt || Date.parse(at) > Date.parse(summary.lastRatedAt)) summary.lastRatedAt = at;
  }
  if (!Array.isArray(documents)) { issue('userInfo', 'INVALID_COLLECTION'); return; }
  const seen = new Set<string>();
  for (const raw of documents) {
    if (!object(raw)) { issue('userInfo', 'INVALID_DOCUMENT'); continue; }
    try { serializeSource(raw); } catch { issue('userInfo', 'INVALID_SOURCE_JSON'); continue; }
    const stats = raw.rideStats === undefined ? {} : raw.rideStats;
    if (!object(stats)) { issue('userInfo', 'INVALID_RATING_SUMMARY', 'rideStats'); continue; }
    // Completion values are checked independently against their receipt keys.
    for (const field of Object.keys(stats)) if (!knownFields.has(field)) issue('userInfo', 'UNMAPPED_FIELD', 'rideStats');
    if (!Object.hasOwn(raw, '_openid')) {
      if (raw.openid !== undefined && (!text(raw.openid) || raw.openid.trim() !== raw.openid || !userMap.has(raw.openid))) {
        issue('userInfo', 'UNKNOWN_USER', 'openid');
      }
      if (ratingFields.some(field => stats[field] !== undefined)) issue('userInfo', 'UNVERIFIED_RATING_SUMMARY_IDENTITY', 'rideStats');
      continue;
    }
    const user = text(raw._openid) && raw._openid.trim() === raw._openid ? userMap.get(raw._openid) : undefined;
    if (!user) { issue('userInfo', 'UNKNOWN_USER', '_openid'); continue; }
    const id = user.id.toLowerCase();
    if (seen.has(id)) { issue('userInfo', 'DUPLICATE_OPENID', '_openid'); continue; }
    seen.add(id);
    if (present(raw.openid) && raw.openid !== raw._openid) issue('userInfo', 'CONFLICTING_ALIASES', 'openid');
    const summary = expected.get(id)!;
    for (const [group, fields] of Object.entries(groups) as [keyof typeof groups, typeof groups[keyof typeof groups]][]) {
      const { sum, count } = summary[group];
      const average = count ? Number((sum / count).toFixed(1)) : 0;
      // Same prior as old tripManage.computeWeightedRating. With verified 1–5
      // scores its outer 0–5 clamp is redundant and cannot alter this result.
      const weightedAverage = count ? Number(((sum + 4.7 * 3) / (count + 3)).toFixed(1)) : 0;
      const values = [sum, count, average, weightedAverage];
      fields.forEach((field, index) => {
        const value = stats[field] === undefined ? 0 : stats[field];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
          (index < 2 ? !Number.isSafeInteger(value) : value > 5)) {
          issue('userInfo', 'INVALID_RATING_SUMMARY_VALUE', `rideStats.${field}`);
        } else if (value !== values[index]) issue('userInfo', 'RATING_SUMMARY_MISMATCH', `rideStats.${field}`);
      });
    }
    if (stats.lastRatedAt === undefined) {
      if (summary.lastRatedAt) issue('userInfo', 'MISSING_RATING_SUMMARY_TIMESTAMP', 'rideStats.lastRatedAt');
    } else {
      const lastRatedAt = parseExportTimestamp(stats.lastRatedAt);
      if (!lastRatedAt) issue('userInfo', 'INVALID_RATING_SUMMARY_TIMESTAMP', 'rideStats.lastRatedAt');
      else if (summary.lastRatedAt && Date.parse(lastRatedAt) < Date.parse(summary.lastRatedAt)) {
        issue('userInfo', 'RATING_SUMMARY_TIMESTAMP_ORDER', 'rideStats.lastRatedAt');
      }
    }
  }
  for (const [id, summary] of expected) {
    if (summary.all.count > 0 && !seen.has(id)) issue('userInfo', 'MISSING_RATING_SUMMARY_SOURCE', 'rideStats');
  }
}
