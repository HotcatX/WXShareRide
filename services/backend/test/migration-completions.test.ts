import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCompletions } from '../src/migration/completions.ts';

const appId = 'wx-completion-fixture';
const users = [
  { appId, id: '11111111-1111-4111-8111-111111111111', openid: 'private-fixture-owner' },
  { appId, id: '22222222-2222-4222-8222-222222222222', openid: 'private-fixture-other' },
];
const rides = [{ id: 'offer-one', kind: 'offer' as const }, { id: 'request-one', kind: 'request' as const }];
const source = (patch: object = {}) => ({ _id: 'user-source', _openid: users[0].openid,
  rideStats: { completedDriverTrips: 1, completedPassengerTrips: 1, completedTrips: 2 },
  _rideCompletionV1: { version: 1, driverKeys: ['Carpool|offer-one'], passengerKeys: ['CarpoolRequest|request-one'] }, ...patch });
const convert = (documents: unknown) => normalizeCompletions(documents, users, rides, appId);
const codes = (result: ReturnType<typeof convert>) => result.issues.map(issue => issue.code);

test('completion receipts preserve the original role without inventing times, events or current membership', () => {
  const doc = source({ rideStats: { ...source().rideStats, driverRatingCount: 2, driverRatingSum: 9 } });
  const original = structuredClone(doc);
  // The converter intentionally receives no members/status. A removed person
  // or currently unmatched ride must not erase an already committed receipt.
  const result = convert([doc]);
  assert.deepEqual(result, { rows: [
    { rideId: 'offer-one', userId: users[0].id, role: 'driver', countedAt: null, eventId: null },
    { rideId: 'request-one', userId: users[0].id, role: 'passenger', countedAt: null, eventId: null },
  ], issues: [] });
  assert.deepEqual(doc, original);
  assert.doesNotMatch(JSON.stringify(result.rows), /private-fixture|Rating|member|joinedAt/);
});

test('zero counters need no private map, and absent counters do not create receipts', () => {
  assert.deepEqual(convert([{ _openid: users[0].openid }]), { rows: [], issues: [] });
  assert.deepEqual(convert([{ _openid: users[0].openid, rideStats: {
    completedDriverTrips: 0, completedPassengerTrips: 0, completedTrips: 0,
  } }]), { rows: [], issues: [] });
  assert.deepEqual(convert([{ _openid: users[0].openid, _rideCompletionV1: {
    version: 1, driverKeys: [], passengerKeys: [],
  } }]), { rows: [], issues: [] });
});

test('sparse aliases and anonymous index records are not additional counting authorities', () => {
  const result = convert([source(), { _id: 'alias', openid: users[0].openid, tripDriver: ['offer-one'] }, { _id: 'anonymous' }]);
  assert.equal(result.rows?.length, 2);
  assert.deepEqual(result.issues, []);
  for (const doc of [
    { openid: users[0].openid, _rideCompletionV1: source()._rideCompletionV1 },
    { openid: users[0].openid, rideStats: { completedTrips: 2 } },
    { rideStats: { completedTrips: 1 } },
    { openid: 'private-unknown-alias' },
  ]) {
    const result = convert([source(), doc]);
    assert.equal(result.rows, null);
    assert.ok(codes(result).some(code => ['UNVERIFIED_COMPLETION_IDENTITY', 'UNKNOWN_USER'].includes(code)));
    assert.doesNotMatch(JSON.stringify(result.issues), /private-unknown-alias|private-fixture/);
  }
});

test('unknown, malformed, conflicting or duplicate canonical identities block the complete result', () => {
  for (const patch of [{ _openid: 'private-unknown-owner' }, { _openid: '' }, { _openid: null },
    { _openid: ` ${users[0].openid}` }, { openid: users[1].openid }]) {
    assert.equal(convert([source(patch)]).rows, null);
  }
  assert.ok(codes(convert([source(), source({ _id: 'second-source' })])).includes('DUPLICATE_OPENID'));
  assert.ok(codes(convert([{ _openid: users[0].openid }, source()])).includes('DUPLICATE_OPENID'));
});

test('all completion counts must be safe nonnegative integers and match both role lists and total', () => {
  for (const stats of [null, [], 'private-stats',
    { ...source().rideStats, completedDriverTrips: -1 },
    { ...source().rideStats, completedDriverTrips: '1' },
    { ...source().rideStats, completedDriverTrips: null },
    { ...source().rideStats, completedPassengerTrips: 1.5 },
    { ...source().rideStats, completedTrips: Number.MAX_SAFE_INTEGER + 1 },
    { ...source().rideStats, completedTrips: 1 },
    { completedDriverTrips: 2, completedPassengerTrips: 0, completedTrips: 2 },
  ]) assert.equal(convert([source({ rideStats: stats })]).rows, null);
  const missing = convert([{ _openid: users[0].openid, rideStats: source().rideStats }]);
  assert.ok(codes(missing).includes('MISSING_COMPLETION_KEYS'));
});

test('private completion metadata has one strict version and two bounded lists', () => {
  for (const keys of [null, [], 'private-keys', {}, { ...source()._rideCompletionV1, version: 0 },
    { ...source()._rideCompletionV1, version: '1' },
    { version: 1, driverKeys: [] },
    { ...source()._rideCompletionV1, driverKeys: {} },
    { ...source()._rideCompletionV1, passengerKeys: Array(10001).fill('CarpoolRequest|request-one') },
    { ...source()._rideCompletionV1, privateUnknownField: 'sensitive-value' },
  ]) {
    const result = convert([source({ _rideCompletionV1: keys })]);
    assert.equal(result.rows, null);
    assert.doesNotMatch(JSON.stringify(result.issues), /private-keys|privateUnknownField|sensitive-value/);
  }
  const typo = convert([source({ rideStats: { ...source().rideStats, completedDriverTrip: 7 } })]);
  assert.ok(codes(typo).includes('UNMAPPED_FIELD'));
});

test('receipt keys must use the exact legacy grammar and identify an existing ride of the same kind', () => {
  for (const key of [null, 1, {}, 'private-invalid-key', 'Carpool|offer-one ', 'Carpool|',
    'Carpool|a/b', `Carpool|${'x'.repeat(129)}`, 'Carpool|private-missing-ride', 'CarpoolRequest|offer-one']) {
    const result = convert([source({ _rideCompletionV1: { ...source()._rideCompletionV1, driverKeys: [key] } })]);
    assert.equal(result.rows, null);
    assert.doesNotMatch(JSON.stringify(result.issues), /private-invalid-key|private-missing-ride|offer-one/);
  }
});

test('one user cannot be counted twice for one ride, within a role or across the role arrays', () => {
  const within = convert([source({ rideStats: { completedDriverTrips: 2, completedPassengerTrips: 1, completedTrips: 3 },
    _rideCompletionV1: { ...source()._rideCompletionV1, driverKeys: ['Carpool|offer-one', 'Carpool|offer-one'] } })]);
  assert.ok(codes(within).includes('DUPLICATE_COMPLETION'));
  assert.equal(within.rows, null);
  const across = convert([source({ _rideCompletionV1: { version: 1, driverKeys: ['Carpool|offer-one'], passengerKeys: ['Carpool|offer-one'] } })]);
  assert.ok(codes(across).includes('DUPLICATE_COMPLETION'));
  assert.equal(across.rows, null);
});

test('different users retain independent receipts and output order does not depend on source order', () => {
  const first = source(), second = source({ _id: 'other-source', _openid: users[1].openid });
  const result = convert([first, second]);
  assert.equal(result.rows?.length, 4);
  assert.deepEqual(convert([second, first]), result);
});

test('shared user and ride maps cannot contain duplicate or untrusted identities', () => {
  for (const mapping of [[...users, users[0]], [{ ...users[0], appId: 'private-other-app' }],
    [{ ...users[0], id: 'private-not-uuid' }], [{ ...users[0], openid: ' padded ' }]]) {
    const result = normalizeCompletions([source()], mapping, rides, appId);
    assert.equal(result.rows, null);
    assert.ok(codes(result).includes('INVALID_USER_MAPPING'));
  }
  for (const mapping of [[...rides, rides[0]], [{ id: 'bad/private-id', kind: 'offer' as const }],
    [{ id: 'offer-one', kind: 'invalid' as 'offer' }]]) {
    const result = normalizeCompletions([source()], users, mapping, appId);
    assert.equal(result.rows, null);
    assert.ok(codes(result).includes('INVALID_RIDE_MAPPING'));
  }
});

test('invalid JSON is rejected without evaluating getters or leaking source content', () => {
  let invoked = false;
  const getter = Object.defineProperty({}, '_openid', { enumerable: true, get() { invoked = true; return 'private-getter'; } });
  const cyclic: Record<string, unknown> = source(); cyclic.privateValue = cyclic;
  for (const raw of [getter, cyclic, source({ name: 'private\u0000name' }), source({ name: '\ud800' })]) {
    const result = convert([raw]);
    assert.equal(result.rows, null);
    assert.ok(codes(result).includes('INVALID_SOURCE_JSON'));
    assert.doesNotMatch(JSON.stringify(result.issues), /private-getter|private.name|privateValue/);
  }
  assert.equal(invoked, false);
  assert.equal(convert(null).rows, null);
  assert.equal(convert([null]).rows, null);
});

test('diagnostics aggregate only fixed fields and codes without receipt or user identifiers', () => {
  const result = convert([source({ _rideCompletionV1: null }), source({ _openid: users[1].openid, _rideCompletionV1: null })]);
  assert.deepEqual(result, { rows: null, issues: [{ collection: 'userInfo', code: 'INVALID_COMPLETION_KEYS',
    field: '_rideCompletionV1', severity: 'error', count: 2 }] });
  assert.doesNotMatch(JSON.stringify(result.issues), /private-fixture|offer-one|request-one|11111111/);
});
