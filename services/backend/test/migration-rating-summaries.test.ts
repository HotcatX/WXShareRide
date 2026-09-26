import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRatingSummaries } from '../src/migration/rating-summaries.ts';
import type { RatingRow } from '../src/migration/ratings.ts';
import type { Document, IssueReporter } from '../src/migration/types.ts';

const appId = 'rating-summary-fixture';
const users = [
  { id: 'aaaaaaaa-1111-4111-8111-111111111111', openid: 'synthetic-first', appId },
  { id: 'bbbbbbbb-2222-4222-8222-222222222222', openid: 'synthetic-second', appId },
  { id: 'cccccccc-3333-4333-8333-333333333333', openid: 'synthetic-third', appId }
];
const at = '2026-09-03T12:00:00.000Z';
const score = (id: string, targetIndex: number, targetRole: RatingRow['targetRole'], value: number): RatingRow => ({
  id, rideId: `ride-${id}`, raterId: users[2]!.id, targetId: users[targetIndex]!.id,
  raterRole: targetRole === 'driver' ? 'passenger' : 'driver', targetRole, score: value, createdAt: at, eventId: null
});
const ratings = [score('first', 0, 'driver', 5), score('second', 0, 'driver', 2),
  score('third', 0, 'passenger', 4), score('fourth', 1, 'passenger', 1)];
const summary = (): Document => ({
  ratingSum: 11, ratingCount: 3, ratingAvg: 3.7, ratingWeightedAvg: 4.2,
  driverRatingSum: 7, driverRatingCount: 2, driverRatingAvg: 3.5, driverRatingWeightedAvg: 4.2,
  passengerRatingSum: 4, passengerRatingCount: 1, passengerRatingAvg: 4, passengerRatingWeightedAvg: 4.5,
  lastRatedAt: { $date: '2026-09-03T12:00:00.025Z' }
});
const documents = (): Document[] => [
  { _id: 'source-first', _openid: users[0]!.openid, rideStats: summary() },
  { _id: 'source-second', _openid: users[1]!.openid, rideStats: {
    ratingSum: 1, ratingCount: 1, ratingAvg: 1, ratingWeightedAvg: 3.8,
    passengerRatingSum: 1, passengerRatingCount: 1, passengerRatingAvg: 1, passengerRatingWeightedAvg: 3.8,
    lastRatedAt: { $date: Date.parse(at) }
  } },
  { _id: 'source-third', _openid: users[2]!.openid, rideStats: { completedTrips: 10, completedDriverTrips: 4, completedPassengerTrips: 6 } }
];
function validate(source: unknown = documents(), facts: readonly RatingRow[] = ratings, accounts = users) {
  const issues: { collection: string; code: string; field: string; severity: string }[] = [];
  const issue: IssueReporter = (collection, code, field = '-', severity = 'error') => issues.push({ collection, code, field, severity });
  validateRatingSummaries(source, accounts, facts, appId, issue);
  return issues;
}
const fieldMismatch = (issues: ReturnType<typeof validate>, field: string) => issues.some(issue => issue.code === 'RATING_SUMMARY_MISMATCH' && issue.field === `rideStats.${field}`);

test('per-user overall and both role summaries reconcile independently without copying or editing legacy fields', () => {
  const source = documents();
  const before = structuredClone(source);
  assert.deepEqual(validate(source), []);
  assert.deepEqual(source, before);
  assert.deepEqual(validate([...source].reverse(), [...ratings].reverse()), []);
  assert.equal(ratings.reduce((sum, rating) => sum + rating.score, 0), 12);
});

test('missing summaries default to zero only when there are no corresponding rating facts', () => {
  assert.deepEqual(validate([{ _id: 'zero', _openid: users[2]!.openid }], []), []);
  assert.deepEqual(validate([{ _id: 'zero', _openid: users[2]!.openid, rideStats: {
    ratingSum: 0, ratingCount: 0, ratingAvg: 0, ratingWeightedAvg: 0,
    driverRatingSum: 0, driverRatingCount: 0, driverRatingAvg: 0, driverRatingWeightedAvg: 0,
    passengerRatingSum: 0, passengerRatingCount: 0, passengerRatingAvg: 0, passengerRatingWeightedAvg: 0
  } }], []), []);
  for (const field of Object.keys(summary()).filter(field => field !== 'lastRatedAt')) {
    const source = documents();
    delete (source[0]!.rideStats as Document)[field];
    assert.ok(fieldMismatch(validate(source), field), `missing ${field} must not be treated as valid zero`);
  }
  const missingAll = documents(); delete missingAll[0]!.rideStats;
  assert.ok(fieldMismatch(validate(missingAll), 'ratingCount'));
});

test('correct global totals cannot conceal assigning scores to the wrong role or account', () => {
  const wrongRole = documents();
  Object.assign(wrongRole[0]!.rideStats as Document, {
    driverRatingSum: 4, driverRatingCount: 1, driverRatingAvg: 4, driverRatingWeightedAvg: 4.5,
    passengerRatingSum: 7, passengerRatingCount: 2, passengerRatingAvg: 3.5, passengerRatingWeightedAvg: 4.2
  });
  assert.ok(fieldMismatch(validate(wrongRole), 'driverRatingSum'));
  assert.ok(fieldMismatch(validate(wrongRole), 'passengerRatingCount'));
  assert.equal(fieldMismatch(validate(wrongRole), 'ratingSum'), false);
  const wrongOwner = documents();
  [wrongOwner[0]!.rideStats, wrongOwner[1]!.rideStats] = [wrongOwner[1]!.rideStats, wrongOwner[0]!.rideStats];
  assert.ok(fieldMismatch(validate(wrongOwner), 'ratingCount'));
});

test('all four values are checked separately for each group, including the legacy weighted prior', () => {
  for (const field of Object.keys(summary()).filter(field => field !== 'lastRatedAt')) {
    const source = documents(), stats = source[0]!.rideStats as Document;
    stats[field] = Number(stats[field]) + (field.endsWith('Avg') ? -0.1 : 1);
    assert.ok(fieldMismatch(validate(source), field), `${field} must reconcile independently`);
  }
  const wrongPrior = documents();
  (wrongPrior[0]!.rideStats as Document).ratingWeightedAvg = 3.7;
  assert.ok(fieldMismatch(validate(wrongPrior), 'ratingWeightedAvg'));
});

test('non-numeric, non-integer and out-of-range cached values block rather than coerce', () => {
  for (const [field, value] of [
    ['ratingSum', '11'], ['ratingSum', 11.5], ['ratingSum', -1], ['ratingSum', Number.MAX_SAFE_INTEGER + 1],
    ['ratingCount', '3'], ['ratingCount', 3.1], ['ratingCount', null], ['ratingAvg', '3.7'], ['ratingAvg', 6],
    ['ratingWeightedAvg', false], ['driverRatingCount', {}], ['passengerRatingAvg', -0.1]
  ] as const) {
    const source = documents(); (source[0]!.rideStats as Document)[field] = value;
    assert.ok(validate(source).some(issue => issue.code === 'INVALID_RATING_SUMMARY_VALUE' && issue.field === `rideStats.${field}`));
  }
});

test('lastRatedAt remains a separate validated clock, not an exact copy of the last score time', () => {
  const source = documents();
  assert.deepEqual(validate(source), [], 'a later summary update time is valid');
  const before = structuredClone(source);
  validateRatingSummaries(source, users, ratings, appId, () => {});
  assert.deepEqual(source, before);
  const noTimestamp = documents(); delete (noTimestamp[0]!.rideStats as Document).lastRatedAt;
  assert.ok(validate(noTimestamp).some(issue => issue.code === 'MISSING_RATING_SUMMARY_TIMESTAMP'));
  for (const value of [null, 'bad-private-clock', '2026-09-03 12:00:00', { $date: '2026-02-30T12:00:00Z' }]) {
    const bad = documents(); (bad[0]!.rideStats as Document).lastRatedAt = value;
    assert.ok(validate(bad).some(issue => issue.code === 'INVALID_RATING_SUMMARY_TIMESTAMP'));
  }
  const earlier = documents(); (earlier[0]!.rideStats as Document).lastRatedAt = '2026-09-03T11:59:59.999Z';
  assert.ok(validate(earlier).some(issue => issue.code === 'RATING_SUMMARY_TIMESTAMP_ORDER'));
});

test('sparse aliases never replace primary summaries or hide a missing primary account', () => {
  const alias = { _id: 'source-alias', openid: users[0]!.openid, rideStats: summary() };
  assert.ok(validate([...documents(), alias]).some(issue => issue.code === 'UNVERIFIED_RATING_SUMMARY_IDENTITY'));
  const replacement = [alias, ...documents().slice(1)];
  const issues = validate(replacement);
  assert.ok(issues.some(issue => issue.code === 'UNVERIFIED_RATING_SUMMARY_IDENTITY'));
  assert.ok(issues.some(issue => issue.code === 'MISSING_RATING_SUMMARY_SOURCE'));
  assert.deepEqual(validate([...documents(), { _id: 'bare-alias', openid: users[0]!.openid, role: 'driver' }]), []);
  assert.ok(validate([...documents(), documents()[0]!]).some(issue => issue.code === 'DUPLICATE_OPENID'));
  const conflicting = documents(); conflicting[0]!.openid = users[1]!.openid;
  assert.ok(validate(conflicting).some(issue => issue.code === 'CONFLICTING_ALIASES'));
});

test('absence of rating facts cannot certify nonzero legacy summaries', () => {
  const issues = validate(documents(), []);
  assert.ok(fieldMismatch(issues, 'ratingSum'));
  assert.ok(fieldMismatch(issues, 'ratingCount'));
  assert.ok(fieldMismatch(issues, 'driverRatingSum'));
  assert.ok(fieldMismatch(issues, 'passengerRatingCount'));
  assert.ok(validate([], ratings).some(issue => issue.code === 'MISSING_RATING_SUMMARY_SOURCE'));
});

test('known completion fields are left to the completion validator while unknown stats remain errors', () => {
  const source = documents();
  (source[2]!.rideStats as Document).completedTrips = 'checked-by-completions';
  assert.deepEqual(validate(source), []);
  for (const field of ['completedTrip', 'driverRatingCounts', 'syntheticPrivateField']) {
    const bad = documents(); (bad[0]!.rideStats as Document)[field] = 'Synthetic secret';
    const issues = validate(bad);
    assert.ok(issues.some(issue => issue.code === 'UNMAPPED_FIELD' && issue.field === 'rideStats'));
    assert.doesNotMatch(JSON.stringify(issues), /completedTrip|driverRatingCounts|syntheticPrivateField|Synthetic secret/);
  }
});

test('bad users, canonical facts and source JSON produce fixed errors without exposing private input', () => {
  const foreign = [{ ...users[0]!, appId: 'private-other-app' }, ...users.slice(1)];
  assert.ok(validate(documents(), ratings, foreign).some(issue => issue.code === 'INVALID_USER_MAPPING'));
  const unknown = documents(); unknown[0]!._openid = 'private-unknown-owner';
  const issues = validate(unknown);
  assert.ok(issues.some(issue => issue.code === 'UNKNOWN_USER'));
  assert.doesNotMatch(JSON.stringify(issues), /private-unknown-owner|synthetic-first/);
  for (const facts of [[{ ...ratings[0]!, targetId: 'private-unknown-target' }], [{ ...ratings[0]!, score: 2.5 }],
    [{ ...ratings[0]!, createdAt: 'private-invalid-time' }]]) {
    assert.ok(validate(documents(), facts).some(issue => issue.code === 'INVALID_RATING_MAPPING'));
  }
  for (const source of [null, {}, [null], [{ _id: 'bad', _openid: users[0]!.openid, rideStats: [] }]]) {
    assert.ok(validate(source).some(issue => issue.severity === 'error'));
  }
  let invoked = false;
  const getter = Object.defineProperty({}, 'rideStats', { enumerable: true, get() { invoked = true; return {}; } });
  assert.ok(validate([getter]).some(issue => issue.code === 'INVALID_SOURCE_JSON'));
  assert.equal(invoked, false);
});
