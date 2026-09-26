import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRatings } from '../src/migration/ratings.ts';
import type { MemberRow, RideRow } from '../src/migration/types.ts';

const appId = 'ratings-fixture';
const users = [
  { id: 'aaaaaaaa-1111-4111-8111-111111111111', appId, openid: 'synthetic-driver' },
  { id: 'bbbbbbbb-2222-4222-8222-222222222222', appId, openid: 'synthetic-passenger' },
  { id: 'cccccccc-3333-4333-8333-333333333333', appId, openid: 'synthetic-stranger' }
];
const createdAt = '2026-09-01T12:00:00.000Z';
const departureAt = '2026-09-02T12:00:00.000Z';
const ratedAt = '2026-09-03T12:00:00.000Z';
const ride = (patch: Partial<RideRow> = {}): RideRow => ({
  id: 'synthetic-ride', kind: 'offer', creatorId: users[0]!.id, cityKey: 'ny_nj', status: 'closed',
  seatCapacity: 1, departureAt, timeZone: 'America/New_York', listedPriceCents: 800, listedPriceLabel: '8',
  details: {}, version: 1, createdAt, updatedAt: null, ...patch
});
const members = (patch: Partial<MemberRow> = {}): MemberRow[] => [
  { rideId: 'synthetic-ride', userId: users[0]!.id, role: 'driver', seatCount: 0, state: 'active', joinedAt: createdAt, leftAt: null, details: {} },
  { rideId: 'synthetic-ride', userId: users[1]!.id, role: 'passenger', seatCount: 1, state: 'active', joinedAt: null, leftAt: null, details: {}, ...patch }
];
const rating = (patch: Record<string, unknown> = {}) => ({
  _id: 'synthetic-rating', _openid: users[0]!.openid, tripId: 'synthetic-ride', type: 'carpool', collection: 'Carpool',
  raterOpenid: users[0]!.openid, targetOpenid: users[1]!.openid, raterRole: 'driver', targetRole: 'passenger', score: 5,
  comment: '', createdAt: { $date: ratedAt }, updatedAt: ratedAt, ...patch
});
const convert = (documents: unknown, rides = [ride()], participants = members(), accounts = users) =>
  normalizeRatings(documents, accounts, rides, participants, appId);
const hasError = (result: ReturnType<typeof convert>, code: string) => result.issues.some(issue => issue.severity === 'error' && issue.code === code);

test('ratings preserve source text IDs, role, exact score and timestamp without rebuilding events or users', () => {
  const original = rating({ _id: 'MixedCase:Rating_1' });
  const before = structuredClone(original);
  const result = convert([original]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.rows, [{ id: original._id, rideId: 'synthetic-ride', raterId: users[0]!.id, targetId: users[1]!.id,
    raterRole: 'driver', targetRole: 'passenger', score: 5, createdAt: ratedAt, eventId: null }]);
  assert.deepEqual(original, before);
  assert.equal('comment' in result.rows![0]!, false);
  assert.equal('updatedAt' in result.rows![0]!, false);
  assert.doesNotMatch(JSON.stringify(result.rows), /synthetic-driver|synthetic-passenger/);
});

test('request ratings and reciprocal ratings require the actual counterpart memberships', () => {
  const documents = [rating({ type: 'request', collection: 'CarpoolRequest' }), rating({ _id: 'reverse-rating', type: 'request', collection: 'CarpoolRequest',
    _openid: users[1]!.openid, raterOpenid: users[1]!.openid, targetOpenid: users[0]!.openid,
    raterRole: 'passenger', targetRole: 'driver', score: 4 })];
  const result = convert(documents, [ride({ kind: 'request', creatorId: users[1]!.id, seatCapacity: 4 })]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.rows?.length, 2);
  assert.equal(result.rows![1]!.raterId, users[1]!.id);
  assert.equal(result.rows![1]!.score, 4);
});

test('source IDs and directed ride/rater/target pairs are independently unique', () => {
  const duplicateSource = convert([rating(), rating()]);
  assert.equal(duplicateSource.rows, null);
  assert.ok(hasError(duplicateSource, 'DUPLICATE_SOURCE_ID'));
  const duplicatePair = convert([rating(), rating({ _id: 'other-rating', score: 1 })]);
  assert.equal(duplicatePair.rows, null);
  assert.ok(hasError(duplicatePair, 'DUPLICATE_RATING'));
  // Text IDs are case-sensitive even though account UUIDs are not.
  const cases = convert([rating({ _id: 'Rating' }), rating({ _id: 'rating', _openid: users[1]!.openid,
    raterOpenid: users[1]!.openid, targetOpenid: users[0]!.openid, raterRole: 'passenger', targetRole: 'driver' })]);
  assert.deepEqual(cases.issues, []);
  assert.deepEqual(cases.rows!.map(row => row.id), ['Rating', 'rating']);
  assert.deepEqual(convert([]), { rows: [], issues: [] });
});

test('identity aliases cannot confer ownership and missing users never create synthetic accounts', () => {
  for (const patch of [
    { _openid: users[1]!.openid }, { raterOpenid: users[1]!.openid }, { _openid: 'unknown-account' },
    { raterOpenid: 'unknown-account' }, { targetOpenid: 'unknown-account' }, { targetOpenid: ` ${users[1]!.openid} ` },
    { _openid: undefined }, { targetOpenid: users[0]!.openid }
  ]) assert.equal(convert([rating(patch)]).rows, null);
  assert.ok(hasError(convert([rating({ _openid: users[1]!.openid })]), 'CONFLICTING_ALIASES'));
  assert.ok(hasError(convert([rating({ targetOpenid: users[0]!.openid })]), 'SELF_RATING'));
  const empty = convert([rating()], [ride()], members(), []);
  assert.equal(empty.rows, null);
  assert.ok(hasError(empty, 'MISSING_OR_INVALID_IDENTITY'));
  assert.equal(users.length, 3);
});

test('account mapping is app-scoped and UUID duplicates are rejected regardless of case', () => {
  for (const accounts of [
    [{ ...users[0]!, appId: 'different-app' }, users[1]!],
    [...users, { ...users[0]!, id: users[0]!.id.toUpperCase(), openid: 'another-openid' }],
    [{ ...users[0]!, id: 'not-a-uuid' }, users[1]!]
  ]) {
    const result = convert([rating()], [ride()], members(), accounts);
    assert.equal(result.rows, null);
    assert.ok(hasError(result, 'INVALID_USER_MAPPING'));
  }
  const caseAccounts = users.map(user => ({ ...user, id: user.id.toUpperCase() }));
  const result = convert([rating()], [ride()], members().map(member => ({ ...member, userId: member.userId.toUpperCase() })), caseAccounts);
  assert.deepEqual(result.issues, []);
  assert.equal(result.rows![0]!.raterId, users[0]!.id);
});

test('type, source collection and canonical ride kind must agree and the ride must exist closed', () => {
  for (const patch of [
    { type: 'request' }, { type: 'offer' }, { collection: 'CarpoolRequest' }, { collection: undefined },
    { tripId: 'unknown-ride' }, { tripId: 'bad / ride' }
  ]) assert.equal(convert([rating(patch)]).rows, null);
  assert.ok(hasError(convert([rating()], [ride({ kind: 'request' })]), 'CONFLICTING_RIDE_TYPE'));
  assert.ok(hasError(convert([rating({ tripId: 'unknown-ride' })]), 'UNKNOWN_RIDE'));
  for (const status of ['open', 'cancelled'] as const) {
    const result = convert([rating()], [ride({ status })]);
    assert.equal(result.rows, null);
    assert.ok(hasError(result, 'RATING_REQUIRES_CLOSED_RIDE'));
  }
  assert.ok(hasError(convert([rating()], [ride(), ride()]), 'INVALID_RIDE_MAPPING'));
});

test('same-side, missing and mismatched roles cannot be guessed from a score or creator', () => {
  for (const patch of [{ raterRole: 'owner' }, { targetRole: '' }, { raterRole: 'passenger' },
    { raterRole: 'passenger', targetRole: 'driver' }, { targetOpenid: users[2]!.openid }]) {
    assert.equal(convert([rating(patch)]).rows, null);
  }
  assert.ok(hasError(convert([rating({ raterRole: 'passenger' })]), 'INVALID_RATING_ROLE_PAIR'));
  assert.ok(hasError(convert([rating({ raterRole: 'passenger', targetRole: 'driver' })]), 'RATING_MEMBER_ROLE_MISMATCH'));
  assert.ok(hasError(convert([rating({ targetOpenid: users[2]!.openid })]), 'RATING_USER_NOT_MEMBER'));
  assert.ok(hasError(convert([rating()], [ride()], [members()[0]!]), 'RATING_USER_NOT_MEMBER'));
  assert.ok(hasError(convert([rating()], [ride()], [...members(), members()[1]!]), 'INVALID_MEMBER_MAPPING'));
});

test('only strict integer scores from one through five are accepted without rounding or coercion', () => {
  for (const score of [1, 2, 3, 4, 5]) assert.deepEqual(convert([rating({ score })]).issues, []);
  for (const score of [0, 6, -1, 2.5, '5', null, true]) {
    const result = convert([rating({ score })]);
    assert.equal(result.rows, null);
    assert.ok(hasError(result, 'INVALID_RATING_SCORE'));
  }
});

test('rating clocks preserve explicit instants and reject invalid source clocks or ratings predating the ride', () => {
  const normalized = convert([rating({ createdAt: { $date: Date.parse(ratedAt) }, updatedAt: '2026-09-03T08:00:00-04:00' })]);
  assert.deepEqual(normalized.issues, []);
  assert.equal(normalized.rows![0]!.createdAt, ratedAt);
  for (const patch of [{ createdAt: '2026-09-03 12:00:00' }, { createdAt: '2026-02-30T12:00:00Z' },
    { createdAt: null }, { updatedAt: null }, { updatedAt: 'invalid-clock' }, { updatedAt: createdAt }]) {
    assert.equal(convert([rating(patch)]).rows, null);
  }
  const beforeRide = convert([rating({ createdAt: '2026-08-31T12:00:00Z' })]);
  assert.ok(hasError(beforeRide, 'RATING_BEFORE_RIDE_CREATED'));
  assert.ok(hasError(convert([rating()], [ride({ departureAt: 'invalid-clock' })]), 'INVALID_RIDE_MAPPING'));
});

test('an early historical rating keeps its own time and score with notice, never a later notification or update clock', () => {
  const earlyTime = '2026-09-02T10:00:00.000Z';
  const original = rating({ createdAt: earlyTime, updatedAt: ratedAt, score: 2 });
  const result = convert([original]);
  assert.deepEqual(result.issues, [{ collection: 'other', code: 'LEGACY_EARLY_RATING_PRESERVED',
    field: 'TripRatings.createdAt', severity: 'notice', count: 1 }]);
  assert.equal(result.rows?.length, 1);
  assert.equal(result.rows![0]!.createdAt, earlyTime);
  assert.equal(result.rows![0]!.score, 2);
  assert.equal(result.rows![0]!.eventId, null);
  // Notification metadata is not a rating source or a fallback clock.
  const inventedClock = convert([rating({ createdAt: null, notificationCreatedAt: ratedAt })]);
  assert.equal(inventedClock.rows, null);
  assert.ok(hasError(inventedClock, 'MISSING_OR_INVALID_TIMESTAMP'));
  assert.ok(hasError(inventedClock, 'UNMAPPED_FIELD'));
});

test('retired comments are explicitly empty and unknown fields cannot be silently archived', () => {
  for (const comment of ['Synthetic text', ' ', null, [], 0]) {
    const result = convert([rating({ comment })]);
    assert.equal(result.rows, null);
    assert.ok(hasError(result, 'UNSUPPORTED_RATING_COMMENT'));
  }
  const unknown = convert([rating({ syntheticPrivateField: 'Synthetic secret' })]);
  assert.equal(unknown.rows, null);
  assert.ok(hasError(unknown, 'UNMAPPED_FIELD'));
  assert.doesNotMatch(JSON.stringify(unknown.issues), /syntheticPrivateField|Synthetic secret/);
});

test('invalid documents, source IDs and lossy JSON reject the whole batch with aggregate-only issues', () => {
  for (const invalid of [null, [], rating({ _id: '' }), rating({ _id: 'invalid / id' }), rating({ _id: 'x'.repeat(161) }),
    rating({ score: NaN }), rating({ comment: 'Synthetic\u0000secret' }), rating({ comment: '\ud800' })]) {
    const result = convert([rating(), invalid]);
    assert.equal(result.rows, null);
    assert.ok(result.issues.some(issue => issue.severity === 'error'));
    assert.doesNotMatch(JSON.stringify(result.issues), /Synthetic|synthetic-driver|synthetic-passenger|invalid \/ id/);
  }
  let invoked = false;
  const getter = Object.defineProperty({}, '_id', { enumerable: true, get() { invoked = true; return 'private-getter'; } });
  assert.ok(hasError(convert([getter]), 'INVALID_SOURCE_JSON'));
  assert.equal(invoked, false);
  assert.equal(convert({}).rows, null);
  const repeated = convert([rating({ _id: 'first-bad', score: 0 }), rating({ _id: 'second-bad', score: 0 })]);
  assert.equal(repeated.issues.find(issue => issue.code === 'INVALID_RATING_SCORE')?.count, 2);
  assert.ok(repeated.issues.every(issue => issue.collection === 'other' && issue.field.startsWith('TripRatings.')));
});
