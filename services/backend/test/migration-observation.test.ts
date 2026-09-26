import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCloudBaseExport } from '../src/migration/normalize.ts';
import { serializeSource, sourceHash } from '../src/migration/source.ts';
import type { CloudBaseExport, Document, ExportObservation } from '../src/migration/types.ts';

const options = { timeZone: 'America/New_York' } as const;
const createdAt = '2026-09-25T03:00:00.000Z';
const lastDepartureAt = '2026-09-29T19:00:00.000Z';
const cutoff = '2026-09-30T00:00:00.000Z';

// Same minimal full-export shape as migration-normalize.test.ts. All values
// are synthetic; these tests never read a local or online business export.
function fixture(kind: 'offer' | 'request' = 'offer'): CloudBaseExport {
  const shared = { _id: 'ride-legacy-1', status: 'open', referencePrice: '15.25$/人',
    departures: [{ address: 'Private Street', date: '2026-09-29', time: '15:00' }], destinations: [{ address: 'Campus' }],
    createdAt, updatedAt: createdAt, businessVersion: 4, businessSynthetic: false };
  return { kind: 'cloudbase-full-export', appId: 'test-app', collections: {
    userInfo: [
      { _id: 'user-doc-1', _openid: 'private-driver', name: 'Private Driver', createdAt, updatedAt: createdAt },
      { _id: 'user-doc-2', _openid: 'private-passenger', name: 'Private Passenger', createdAt, updatedAt: createdAt },
    ],
    Carpool: kind === 'offer' ? [{ ...shared, _openid: 'private-driver', passengerCount: 2, availSeatNum: 1,
      passengers: [{ _openid: 'private-passenger', joinedAt: createdAt, pickupAddress: 'Private Pickup', dropoffAddress: 'Campus' }] }] : [],
    CarpoolRequest: kind === 'request' ? [{ ...shared, _openid: 'private-passenger', passengerCount: 1,
      passengerID: ['private-passenger'], driverOpenid: 'private-driver' }] : [],
    PublicStats: [{ _id: 'home', servedTrips: 8875, coverageText: 'NY / NJ', updatedAt: createdAt }],
  } };
}
const ride = (input: CloudBaseExport): Document => (input.collections.Carpool!.length ? input.collections.Carpool![0] : input.collections.CarpoolRequest![0]) as Document;
const observation = (input: CloudBaseExport, at = cutoff): ExportObservation => ({ sourceSha256: sourceHash(serializeSource(input)), at });
const convert = (input: CloudBaseExport, at = cutoff) => normalizeCloudBaseExport(input, { ...options, observation: observation(input, at) });
const codes = (result: ReturnType<typeof convert>) => result.report.issues.map(issue => issue.code);
function addCompletionReceipts(input: CloudBaseExport) {
  const collection = input.collections.Carpool!.length ? 'Carpool' : 'CarpoolRequest';
  Object.assign(input.collections.userInfo![0] as Document, {
    rideStats: { completedTrips: 1, completedDriverTrips: 1, completedPassengerTrips: 0 },
    _rideCompletionV1: { version: 1, driverKeys: [`${collection}|ride-legacy-1`], passengerKeys: [] },
  });
  Object.assign(input.collections.userInfo![1] as Document, {
    rideStats: { completedTrips: 1, completedDriverTrips: 0, completedPassengerTrips: 1 },
    _rideCompletionV1: { version: 1, driverKeys: [], passengerKeys: [`${collection}|ride-legacy-1`] },
  });
}

test('a hash-bound observation archives only an expired unlocated ride without producing completion or public increments', () => {
  for (const kind of ['offer', 'request'] as const) {
    const input = fixture(kind), before = structuredClone(input), result = convert(input);
    assert.equal(result.report.ready, true);
    assert.ok(result.plan);
    assert.equal(result.plan.observedBefore, cutoff);
    assert.equal(result.plan.sourceSha256, sourceHash(serializeSource(input)));
    assert.equal(result.plan.rides[0]!.status, 'closed');
    assert.equal(result.plan.rides[0]!.cityKey, null);
    assert.equal(result.plan.rides[0]!.version, 4);
    assert.equal(result.plan.rides[0]!.createdAt, createdAt);
    assert.equal(result.plan.rides[0]!.updatedAt, createdAt);
    assert.deepEqual(result.plan.completions, []);
    assert.deepEqual(result.plan.ratings, []);
    assert.deepEqual(result.plan.notifications, []);
    assert.equal(Object.hasOwn(result.plan, 'events'), false);
    assert.equal(Object.hasOwn(result.plan, 'businessEvents'), false);
    assert.deepEqual(result.plan.publicStatistics, [{ appId: input.appId, servedCount: 8875, coverageText: 'NY / NJ', updatedAt: createdAt }]);
    const archived = result.plan.sources.find(source => source.collection === (kind === 'offer' ? 'Carpool' : 'CarpoolRequest'))!;
    assert.deepEqual(JSON.parse(archived.documentJson), ride(before));
    assert.equal(JSON.parse(archived.documentJson).status, 'open');
    assert.deepEqual(input, before);
    assert.ok(codes(result).includes('EXPIRED_UNLOCATED_RIDE_ARCHIVED'));
    assert.ok(codes(result).includes('UNKNOWN_HISTORICAL_CITY'));
  }
});

test('last departure must be strictly before the observation, independent of the current system date', () => {
  for (const at of [lastDepartureAt, '2026-09-29T18:59:59.999Z', '1970-01-01T00:00:00.000Z']) {
    const result = convert(fixture(), at);
    assert.equal(result.plan, null);
    assert.ok(codes(result).includes('UNMAPPED_CITY'));
    assert.equal(codes(result).includes('EXPIRED_UNLOCATED_RIDE_ARCHIVED'), false);
  }
  assert.equal(convert(fixture(), '2026-09-29T19:00:00.001Z').plan?.rides[0]!.status, 'closed');
});

test('multiple departures use the final stop, so an earlier first stop cannot archive a still-current ride', () => {
  const input = fixture();
  ride(input).departures = [
    { address: 'First Private Stop', date: '2026-09-29', time: '15:00' },
    { address: 'Last Private Stop', date: '2026-09-29', time: '16:00' },
  ];
  for (const at of ['2026-09-29T19:30:00.000Z', '2026-09-29T20:00:00.000Z']) {
    const result = convert(input, at);
    assert.equal(result.plan, null);
    assert.equal(codes(result).includes('EXPIRED_UNLOCATED_RIDE_ARCHIVED'), false);
  }
  assert.equal(convert(input, '2026-09-29T20:00:00.001Z').plan?.rides[0]!.status, 'closed');
});

test('a missing observation does not quietly use the wall clock to repair an open ride without a city', () => {
  const result = normalizeCloudBaseExport(fixture(), options);
  assert.equal(result.plan, null);
  assert.ok(codes(result).includes('UNMAPPED_CITY'));
  assert.equal(codes(result).includes('EXPIRED_UNLOCATED_RIDE_ARCHIVED'), false);
});

test('observations bind the exact serialized source and reject mismatches or later source changes', () => {
  const input = fixture(), bound = observation(input);
  const badHash = normalizeCloudBaseExport(input, { ...options, observation: { ...bound, sourceSha256: '0'.repeat(64) } });
  assert.equal(badHash.plan, null);
  assert.ok(codes(badHash).includes('INVALID_EXPORT_OBSERVATION'));
  (input.collections.userInfo![0] as Document).name = 'Private Changed Name';
  const changed = normalizeCloudBaseExport(input, { ...options, observation: bound });
  assert.equal(changed.plan, null);
  assert.ok(codes(changed).includes('INVALID_EXPORT_OBSERVATION'));
  assert.equal(codes(changed).includes('EXPIRED_UNLOCATED_RIDE_ARCHIVED'), false);
  assert.doesNotMatch(JSON.stringify(changed.report), /Private|private-|test-app/);
});

test('an observation requires a valid explicit instant and its exact supported shape', () => {
  const input = fixture(), bound = observation(input);
  for (const value of [null, {}, { ...bound, at: '2026-09-30 00:00:00' },
    { ...bound, at: '2026-02-30T00:00:00Z' }, { ...bound, at: 1_800_000_000_000 },
    { ...bound, at: '' }, { ...bound, privateUnknownField: 'private-value' }]) {
    const result = normalizeCloudBaseExport(input, { ...options, observation: value as ExportObservation });
    assert.equal(result.plan, null);
    assert.ok(codes(result).includes('INVALID_EXPORT_OBSERVATION'));
    assert.doesNotMatch(JSON.stringify(result.report), /privateUnknownField|private-value/);
  }
  assert.equal(convert(input, '2026-09-29T20:00:00-04:00').plan?.observedBefore, cutoff);
});

test('known-city expired open rides retain their lifecycle for the normal post-cutover counting job', () => {
  for (const cityKey of ['ny_nj', 'ny', 'nj']) {
    const input = fixture(); ride(input).cityKey = cityKey;
    const result = convert(input);
    assert.equal(result.report.ready, true);
    assert.equal(result.plan!.rides[0]!.status, 'open');
    assert.equal(result.plan!.rides[0]!.cityKey, 'ny_nj');
    assert.deepEqual(result.plan!.completions, []);
    assert.equal(result.plan!.publicStatistics[0]!.servedCount, 8875);
    assert.equal(codes(result).includes('EXPIRED_UNLOCATED_RIDE_ARCHIVED'), false);
  }
});

test('unknown nonempty cities remain errors instead of being erased by the observation', () => {
  for (const cityKey of ['private-unrecognized-city', ' ', 7, {}]) {
    const input = fixture(); ride(input).cityKey = cityKey;
    const result = convert(input);
    assert.equal(result.plan, null);
    assert.ok(codes(result).includes('UNMAPPED_CITY'));
    assert.equal(codes(result).includes('EXPIRED_UNLOCATED_RIDE_ARCHIVED'), false);
    assert.doesNotMatch(JSON.stringify(result.report), /private-unrecognized-city/);
  }
});

test('only normalized open states are candidates; existing closed and cancelled states are retained', () => {
  const full = fixture(); Object.assign(ride(full), { status: 'full', passengerCount: 1, availSeatNum: 0 });
  assert.equal(convert(full).plan?.rides[0]!.status, 'closed');
  const closed = fixture(); ride(closed).status = 'past';
  const result = convert(closed);
  assert.equal(result.plan?.rides[0]!.status, 'closed');
  assert.equal(codes(result).includes('EXPIRED_UNLOCATED_RIDE_ARCHIVED'), false);
  const cancelled = fixture(); Object.assign(ride(cancelled), { status: 'cancelled', cityKey: 'ny_nj' });
  assert.equal(convert(cancelled).plan?.rides[0]!.status, 'cancelled');
  assert.equal(codes(convert(cancelled)).includes('EXPIRED_UNLOCATED_RIDE_ARCHIVED'), false);
});

test('existing public counting flags cannot be hidden by archiving the raw-open ride', () => {
  for (const patch of [{ servedStatsCounted: true, servedStatsDelta: 2, servedStatsSource: 'syncTripStatus:carpool', servedStatsCountedAt: cutoff },
    { statsDriverCounted: true }]) {
    const input = fixture(); Object.assign(ride(input), patch);
    const result = convert(input);
    assert.equal(result.plan, null);
    assert.ok(codes(result).includes('COUNTED_RIDE_NOT_CLOSED'));
    assert.equal(codes(result).includes('EXPIRED_UNLOCATED_RIDE_ARCHIVED'), false);
  }
});

test('settled or partial completion checkpoints on raw-open records remain blocking inconsistencies', () => {
  for (const settled of [true, false]) {
    const input = fixture(); addCompletionReceipts(input);
    Object.assign(ride(input), { _rideCompletionVersion: 1, _rideCompletionSettled: settled,
      _rideCompletionCheckedAt: cutoff, _rideCompletionParticipantCount: settled ? 2 : 0 });
    const result = convert(input);
    assert.equal(result.plan, null);
    assert.ok(codes(result).includes('COUNTED_RIDE_NOT_CLOSED'));
    if (settled) assert.equal(codes(result).includes('EXPIRED_UNLOCATED_RIDE_ARCHIVED'), false);
  }
});

test('actual completion receipts block inferred closure even when the ride has no checkpoint flags', () => {
  for (const kind of ['offer', 'request'] as const) {
    const input = fixture(kind); addCompletionReceipts(input);
    const result = convert(input);
    assert.equal(result.plan, null);
    assert.ok(codes(result).includes('EXPIRED_RIDE_HAS_COMPLETION_RECEIPTS'));
    assert.equal(result.report.candidateCounts.completions, 2, 'original receipts remain evidence, not new writes');
  }
});
