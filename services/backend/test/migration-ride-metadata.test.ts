import assert from 'node:assert/strict';
import test from 'node:test';
import { rideMetadataFields, validateRideMetadata } from '../src/migration/ride-metadata.ts';
import type { RideMetadataContext } from '../src/migration/ride-metadata.ts';
import type { Document, MigrationIssue } from '../src/migration/types.ts';

const owner = 'private-owner', passenger = 'private-passenger';
const createdAt = '2026-09-01T15:00:00.000Z', departureAt = '2026-09-02T15:00:00.000Z', countedAt = '2026-09-02T16:00:00.000Z';
const source = (patch: Document = {}): Document => ({ _id: 'ride-fixture', _openid: owner, status: 'past',
  cityKey: 'ny_nj', cityLabel: 'NY / NJ', createdAt, ...patch });
const context = (): RideMetadataContext => ({
  sourceUsers: [{ _id: 'private-source-owner', _openid: owner }, { _id: 'private-source-passenger', _openid: passenger }],
  ride: { id: 'ride-fixture', kind: 'offer', status: 'closed', cityKey: 'ny_nj', createdAt },
  lastDepartureAt: departureAt,
  completions: [
    { rideId: 'ride-fixture', userId: 'user-one', role: 'driver', countedAt: null, eventId: null },
    { rideId: 'ride-fixture', userId: 'user-two', role: 'passenger', countedAt: null, eventId: null },
  ],
});
const served = (patch: Document = {}): Document => ({ servedStatsCounted: true, servedStatsDelta: 2,
  servedStatsSource: 'syncTripStatus:carpool', servedStatsCountedAt: { $date: Date.parse(countedAt) }, ...patch });
const checkpoint = (patch: Document = {}): Document => ({ _rideCompletionVersion: 1, _rideCompletionSettled: true,
  _rideCompletionParticipantCount: 2, _rideCompletionCheckedAt: countedAt, ...patch });
const validate = (raw: Document, ctx = context(), collection: 'Carpool' | 'CarpoolRequest' = 'Carpool') => {
  const issues: MigrationIssue[] = [];
  validateRideMetadata(raw, collection, ctx, (collection, code, field = '-', severity = 'error') => {
    const found = issues.find(row => row.collection === collection && row.code === code && row.field === field && row.severity === severity);
    if (found) found.count++;
    else issues.push({ collection, code, field, severity, count: 1 });
  });
  return issues;
};
const errors = (issues: MigrationIssue[]) => issues.filter(issue => issue.severity === 'error');
const codes = (issues: MigrationIssue[]) => issues.map(issue => issue.code);
const requestContext = () => ({ ...context(), ride: { ...context().ride, kind: 'request' as const } });

test('metadata is source evidence only; absent checkpoints do not create or infer any facts', () => {
  const raw = source({ ...served(), ...checkpoint(), driverID: 'private-source-owner', routeCityKey: 'ny_nj', routeCityLabel: 'NY / NJ' });
  const ctx = context(), before = structuredClone({ raw, ctx });
  assert.deepEqual(validate(raw, ctx), []);
  assert.deepEqual({ raw, ctx }, before);
  assert.deepEqual(validate(source()), []);
  assert.deepEqual(validate(source({ unrecognizedPrivateField: 'secret-value' })), []);
  assert.equal(new Set(rideMetadataFields).size, rideMetadataFields.length);
  assert.equal(rideMetadataFields.includes('statsDriverCounted'), true);
});

test('every known served source is validated against its collection, including removed manual endpoints', () => {
  for (const src of ['syncTripStatus:carpool', 'syncMyTripStatus:carpool', 'updateCarpoolStatus', 'driverCompleteTrip', 'tripManageCompleteCarpool']) {
    assert.deepEqual(validate(source(served({ servedStatsSource: src }))), []);
  }
  for (const src of ['syncTripStatus:request', 'syncMyTripStatus:request', 'updateCarpoolRequestStatus', 'creatorQuitAndClose', 'tripManageCompleteRequest']) {
    assert.deepEqual(validate(source(served({ servedStatsSource: src, servedStatsDelta: 0 })), requestContext(), 'CarpoolRequest'), []);
  }
  assert.ok(codes(validate(source(served({ servedStatsSource: 'syncTripStatus:request' })))).includes('INVALID_SERVED_STATS_SOURCE'));
});

test('served metadata rejects incomplete groups, malformed types, amounts and unsafe source strings', () => {
  for (const patch of [{ servedStatsCounted: false }, { servedStatsCounted: 1 }, { servedStatsDelta: -1 },
    { servedStatsDelta: 6 }, { servedStatsDelta: 1.5 }, { servedStatsDelta: '2' }, { servedStatsSource: 'private-unknown-source' },
    { servedStatsSource: {} }, { servedStatsCountedAt: '2026-09-02 16:00:00' },
    { servedStatsCountedAt: '2026-02-30T00:00:00Z' }, { servedStatsCountedAt: null }]) {
    assert.ok(errors(validate(source(served(patch)))).length);
  }
  for (const field of ['servedStatsCounted', 'servedStatsCountedAt', 'servedStatsDelta', 'servedStatsSource']) {
    const partial = served(); delete partial[field];
    assert.ok(codes(validate(source(partial))).includes('INCOMPLETE_RIDE_METADATA'));
  }
});

test('counted raw-open, cancelled or context-open rides remain blocked even if an export cutoff would close them', () => {
  for (const metadata of [served(), checkpoint(), { statsDriverCounted: true }]) {
    for (const status of ['open', 'full', 'cancelled']) {
      assert.ok(codes(validate(source({ ...metadata, status }))).includes('COUNTED_RIDE_NOT_CLOSED'));
    }
    assert.ok(codes(validate(source(metadata), { ...context(), ride: { ...context().ride, status: 'open' } })).includes('COUNTED_RIDE_NOT_CLOSED'));
  }
});

test('settled checkpoints match original receipts even when people have left or the ride is now unmatched', () => {
  // No members are supplied. Both committed recipients survive independently
  // of their current membership or the currently assigned driver.
  assert.deepEqual(validate(source(checkpoint())), []);
  const extra = { ...context(), completions: [...context().completions,
    { rideId: 'different-ride', userId: 'user-three', role: 'passenger' as const, countedAt: null, eventId: null }] };
  assert.deepEqual(validate(source(checkpoint()), extra), []);
  for (const completions of [[], context().completions.slice(0, 1), [context().completions[0]!, context().completions[0]!]]) {
    assert.ok(codes(validate(source(checkpoint()), { ...context(), completions })).includes('COMPLETION_CHECKPOINT_MISMATCH'));
  }
});

test('a valid partial completion attempt has settled false and count zero without discarding already committed receipts', () => {
  assert.deepEqual(validate(source(checkpoint({ _rideCompletionSettled: false, _rideCompletionParticipantCount: 0 }))), []);
  assert.ok(codes(validate(source(checkpoint({ _rideCompletionSettled: false })))).includes('INVALID_COMPLETION_PARTICIPANT_COUNT'));
  for (const patch of [{ _rideCompletionVersion: 2 }, { _rideCompletionVersion: '1' }, { _rideCompletionSettled: 1 },
    { _rideCompletionParticipantCount: 1 }, { _rideCompletionParticipantCount: 41 },
    { _rideCompletionParticipantCount: 2.5 }, { _rideCompletionParticipantCount: '2' },
    { _rideCompletionCheckedAt: null }, { _rideCompletionCheckedAt: createdAt }]) {
    assert.ok(errors(validate(source(checkpoint(patch)))).length);
  }
  const partial = checkpoint(); delete partial._rideCompletionSettled;
  assert.ok(codes(validate(source(partial))).includes('INCOMPLETE_RIDE_METADATA'));
});

test('timestamps cannot precede creation, while public counters may legitimately precede the last departure', () => {
  const beforeCreation = '2026-08-31T15:00:00.000Z';
  for (const metadata of [served({ servedStatsCountedAt: beforeCreation }),
    checkpoint({ _rideCompletionCheckedAt: beforeCreation }), { completedAt: beforeCreation, completedBy: owner }]) {
    assert.ok(codes(validate(source(metadata))).includes('INVALID_TIMESTAMP_ORDER'));
  }
  assert.deepEqual(validate(source(served({ servedStatsCountedAt: createdAt }))), []);
});

test('offer driverID is an old user document reference and never becomes another OpenID authority', () => {
  assert.deepEqual(validate(source({ driverID: 'private-source-owner' })), []);
  assert.deepEqual(validate(source({ driverID: '' })), []);
  assert.deepEqual(validate(source({ driverID: 'private-deleted-document' })), [{ collection: 'Carpool',
    code: 'DANGLING_DRIVER_DOCUMENT', field: 'driverID', severity: 'notice', count: 1 }]);
  assert.ok(codes(validate(source({ driverID: 'private-source-passenger' }))).includes('CONFLICTING_DRIVER_ALIAS'));
  assert.ok(codes(validate(source({ driverID: 'private-source-owner' }), {
    ...context(), sourceUsers: [...context().sourceUsers, context().sourceUsers[0]!],
  })).includes('CONFLICTING_DRIVER_ALIAS'));
  assert.ok(codes(validate(source({ driverID: 'private-source-owner' }), {
    ...context(), sourceUsers: [{ _id: 'private-source-owner', openid: owner }],
  })).includes('CONFLICTING_DRIVER_ALIAS'));
});

test('request driverID only corroborates the canonical assigned-driver field; empty legacy defaults are allowed', () => {
  assert.deepEqual(validate(source({ driverID: passenger, driverOpenid: passenger }), requestContext(), 'CarpoolRequest'), []);
  assert.deepEqual(validate(source({ driverID: '' }), requestContext(), 'CarpoolRequest'), []);
  for (const patch of [{ driverID: owner, driverOpenid: passenger }, { driverID: passenger }, { driverID: [] }, { driverID: ` ${passenger}` }]) {
    assert.ok(errors(validate(source(patch), requestContext(), 'CarpoolRequest')).length);
  }
});

test('city aliases can only corroborate canonical values and cannot repair or overwrite unknown cities', () => {
  assert.deepEqual(validate(source({ routeCityKey: 'ny', routeCityLabel: 'NY / NJ' })), []);
  for (const patch of [{ routeCityKey: 'private-city' }, { routeCityKey: null }, { routeCityLabel: '' },
    { routeCityLabel: 'private-other-label' }, { routeCityKey: 'ny_nj', cityKey: undefined },
    { routeCityLabel: 'NY / NJ', cityLabel: undefined }]) assert.ok(errors(validate(source(patch))).length);
  assert.ok(codes(validate(source({ routeCityKey: 'ny_nj' }), {
    ...context(), ride: { ...context().ride, cityKey: null },
  })).includes('CONFLICTING_CITY_ALIAS'));
});

test('manual completion preserves early historical facts and checks the actor according to the old endpoint', () => {
  const early = '2026-09-01T16:00:00.000Z';
  assert.deepEqual(validate(source({ completedAt: early, completedBy: owner })), [{ collection: 'Carpool',
    code: 'EARLY_MANUAL_COMPLETION', field: 'completedAt', severity: 'notice', count: 1 }]);
  assert.deepEqual(validate(source({ completedAt: countedAt, completedBy: passenger, driverOpenid: passenger }), requestContext(), 'CarpoolRequest'), []);
  for (const patch of [{ completedAt: countedAt }, { completedBy: owner }, { completedAt: countedAt, completedBy: passenger },
    { completedAt: countedAt, completedBy: '' }, { completedAt: countedAt, completedBy: ` ${owner}` }]) {
    assert.ok(errors(validate(source(patch))).length);
  }
  assert.ok(codes(validate(source({ completedAt: countedAt, completedBy: owner, driverOpenid: passenger }), requestContext(), 'CarpoolRequest')).includes('INVALID_COMPLETION_ACTOR'));
});

test('the removed first-passenger public counter is archived without inferring its amount', () => {
  assert.deepEqual(validate(source({ statsDriverCounted: true })), [{ collection: 'Carpool',
    code: 'ARCHIVED_OLD_JOIN_COUNTER', field: 'statsDriverCounted', severity: 'notice', count: 1 }]);
  assert.deepEqual(validate(source({ statsDriverCounted: false, status: 'open' }), { ...context(), ride: { ...context().ride, status: 'open' } }), []);
  for (const value of [null, 1, 'true', {}]) assert.ok(codes(validate(source({ statsDriverCounted: value }))).includes('INVALID_OLD_JOIN_COUNTER'));
  assert.ok(codes(validate(source({ statsDriverCounted: false }), requestContext(), 'CarpoolRequest')).includes('INVALID_OLD_JOIN_COUNTER'));
});

test('diagnostics contain only fixed fields and never evaluate getters or expose source data', () => {
  let invoked = false;
  const getter = Object.defineProperty({}, 'driverID', { enumerable: true, get() { invoked = true; return owner; } });
  const invalid = source(); invalid.privateCycle = invalid;
  const results = [validate(getter), validate(invalid), validate(source(served({ servedStatsSource: 'private-source-text' }))),
    validate(source({ driverID: { secret: owner } })), validate(source({ completedAt: countedAt, completedBy: passenger }))];
  assert.equal(invoked, false);
  assert.ok(results.every(result => errors(result).length));
  assert.doesNotMatch(JSON.stringify(results), /private-|secret|ride-fixture|user-one/);
  assert.ok(codes(validate(source(), requestContext())).includes('INVALID_RIDE_MAPPING'));
});
