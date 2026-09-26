import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCloudBaseExport, localDepartureCandidates, parseExportTimestamp, migrationUserId } from '../src/migration/normalize.ts';
import { migrationSource, serializeSource, sourceHash } from '../src/migration/source.ts';

const options = { timeZone: 'America/New_York' } as const;
const now = '2026-09-25T03:00:00.000Z';
function fixture() {
  return {
    kind: 'cloudbase-full-export', appId: 'test-app', collections: {
      userInfo: [
        { _id: 'user-doc-1', _openid: 'private-driver', name: 'Private Driver', createdAt: now, updatedAt: now },
        { _id: 'user-doc-2', _openid: 'private-passenger', name: 'Private Passenger', createdAt: now, updatedAt: now },
      ] as Record<string, unknown>[],
      Carpool: [{ _id: 'ride-legacy-1', _openid: 'private-driver', cityKey: 'ny_nj', cityLabel: '纽约/新泽西', status: 'open', passengerCount: 2, availSeatNum: 1, referencePrice: '15.25$/人',
        departures: [{ address: 'Private Street', date: '2026-09-29', time: '15:00' }], destinations: [{ address: 'Campus' }],
        passengers: [{ _openid: 'private-passenger', joinedAt: now, pickupAddress: 'Private Pickup', dropoffAddress: 'Campus' }],
        createdAt: now, updatedAt: now, businessVersion: 4, businessSynthetic: false,
      }] as Record<string, unknown>[],
      CarpoolRequest: [] as Record<string, unknown>[],
    },
  };
}
const issues = (input: unknown) => normalizeCloudBaseExport(input, options).report.issues.map(issue => issue.code);

test('complete offer export keeps legacy ride ID and trusted account relation, not user arrays', () => {
  const input = fixture(); input.collections.userInfo[0]!.tripDriver = ['ride-legacy-1'];
  const before = JSON.stringify(input);
  const { plan, report } = normalizeCloudBaseExport(input, options);
  assert.equal(report.ready, true);
  assert.equal(plan!.rides[0]!.id, 'ride-legacy-1');
  assert.equal(plan!.rides[0]!.listedPriceCents, 1525);
  assert.equal(plan!.rides[0]!.departureAt, '2026-09-29T19:00:00.000Z');
  assert.equal(plan!.members.find(member => member.role === 'driver')!.seatCount, 0);
  assert.equal(plan!.members.find(member => member.role === 'passenger')!.details.pickupAddress, 'Private Pickup');
  assert.deepEqual(plan!.users[0]!.profile, {});
  assert.equal(JSON.stringify(input), before);
});

test('identity normalization is deterministic, app-scoped, and rejects duplicate OpenIDs', () => {
  assert.equal(migrationUserId('a', 'b'), migrationUserId('a', 'b'));
  assert.notEqual(migrationUserId('a', 'b'), migrationUserId('c', 'b'));
  assert.match(migrationUserId('a', 'b'), /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  const input = fixture(); input.collections.userInfo.push({ ...input.collections.userInfo[0], _id: 'duplicate' });
  const result = normalizeCloudBaseExport(input, options);
  assert.equal(result.plan, null);
  assert.ok(issues(input).includes('DUPLICATE_OPENID'));
});

test('profile conversion uses one canonical schema and does not silently resolve aliases', () => {
  const input = fixture();
  Object.assign(input.collections.userInfo[0]!, { wechatID: 'private-contact', carNumber: 'private-plate', carBrand: 'Brand', carModel: 'Model', regionPhone: '+1', defaultShowZelle: false, commonComments: ['No smoke'], location: { displayName: 'Label', name: 'Label', address: 'private-home', lat: 40.8, lng: -73.9 } });
  const result = normalizeCloudBaseExport(input, options);
  assert.equal(result.report.ready, true);
  assert.deepEqual(result.plan!.users[0]!.profile, { wechatId: 'private-contact', phoneRegion: '+1', vehicle: { plate: 'private-plate', brand: 'Brand', model: 'Model' }, zelle: { public: false }, preferences: { comments: ['No smoke'] }, location: { label: 'Label', address: 'private-home', latitude: 40.8, longitude: -73.9 } });
  input.collections.userInfo[0]!.wechatId = 'different-contact';
  assert.ok(issues(input).includes('CONFLICTING_ALIASES'));
});

test('report is aggregate only, including unknown field and collection names containing personal data', () => {
  const input = fixture(); input.collections.userInfo[0]!['private-field-name'] = 'private-field-value';
  Object.assign(input.collections, { 'private-collection-name': [{ personal: 'private-value' }] });
  const { report, plan } = normalizeCloudBaseExport(input, options);
  assert.equal(plan, null);
  assert.equal(report.ready, false);
  assert.doesNotMatch(JSON.stringify(report), /private-|Private|Campus|test-app/);
  assert.ok(report.issues.some(issue => issue.code === 'UNMAPPED_COLLECTION'));
});

test('analytics snapshots and missing full business collections cannot be treated as backups', () => {
  const input = fixture();
  assert.ok(issues({ ...input, kind: 'analytics-snapshot' }).includes('FULL_EXPORT_REQUIRED'));
  const missing = { ...input, collections: { Carpool: input.collections.Carpool } };
  assert.ok(issues(missing).includes('COLLECTION_MISSING'));
});

test('timestamps accept only explicit instants and reject silent rollover and host timezone dependence', () => {
  assert.equal(parseExportTimestamp({ $date: now }), now);
  assert.equal(parseExportTimestamp(Date.parse(now)), now);
  assert.equal(parseExportTimestamp('2026-09-24T23:00:00-04:00'), now);
  for (const value of ['2026-09-25 03:00:00', '2026-02-30T00:00:00Z', '2026-09-25T24:00:00Z', 'invalid', { $date: now, extra: true }]) assert.equal(parseExportTimestamp(value), null);
});

test('New York daylight saving gaps and overlaps require explicit resolution', () => {
  assert.deepEqual(localDepartureCandidates('2026-03-08', '02:30'), []);
  assert.deepEqual(localDepartureCandidates('2026-11-01', '01:30'), ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
  assert.deepEqual(localDepartureCandidates('2026-02-30', '15:00'), []);
  const input = fixture(); input.collections.Carpool[0]!.departures = [{ address: 'Place', date: '2026-11-01', time: '01:30' }];
  assert.ok(issues(input).includes('AMBIGUOUS_LOCAL_TIME'));
  assert.equal(normalizeCloudBaseExport(input, options).plan, null);
});

test('missing address/time, contradicting cache, or unknown status stops the plan', () => {
  const input = fixture(); Object.assign(input.collections.Carpool[0]!, { departures: [{ address: '', date: '2026-09-29' }], status: 'finished', departureAtMs: 1 });
  const codes = issues(input);
  assert.ok(codes.includes('MISSING_ADDRESS'));
  assert.ok(codes.includes('UNMAPPED_RIDE_STATUS'));
  assert.ok(codes.includes('CONFLICTING_DEPARTURE_TIME'));
  assert.equal(normalizeCloudBaseExport(input, options).plan, null);
});

test('price text and notes survive migration without invented prices or duplicate canonical aliases', () => {
  for (const [label,cents] of [[' 15 USD ',1500], ['请参考打车价格',null], ['2人共30',null], ['15-20$/人',null]] as const) {
    const input = fixture(); Object.assign(input.collections.Carpool[0]!, { referencePrice: label, comment: 'Private note' });
    const result = normalizeCloudBaseExport(input, options);
    assert.equal(result.report.ready, true);
    assert.equal(result.plan!.rides[0]!.listedPriceLabel, label);
    assert.equal(result.plan!.rides[0]!.listedPriceCents, cents);
    assert.deepEqual(result.plan!.rides[0]!.details, { note: 'Private note' });
    assert.doesNotMatch(JSON.stringify(result.report), /Private|USD|2人|15-20/);
  }
  const invalid = fixture(); invalid.collections.Carpool[0]!.referencePrice = { value: 15 };
  assert.equal(normalizeCloudBaseExport(invalid, options).plan, null);
  assert.ok(issues(invalid).includes('INVALID_PRICE_VALUE'));
});

test('unknown member, overbooking, and stale user membership arrays are visible blockers', () => {
  const input = fixture(); input.collections.userInfo[0]!.tripDriver = ['missing-ride'];
  input.collections.Carpool[0]!.passengers = [{ _openid: 'unknown', joinedAt: now }];
  input.collections.Carpool[0]!.availSeatNum = -1;
  const codes = issues(input);
  assert.ok(codes.includes('UNKNOWN_USER'));
  assert.ok(codes.includes('SEAT_BALANCE_MISMATCH'));
  assert.ok(codes.includes('UNRESOLVED_LEGACY_MEMBERSHIP'));
});

test('request group size is distinct from capacity and an accepted driver has no invented join time', () => {
  const input = fixture(); input.collections.Carpool = [];
  input.collections.CarpoolRequest = [{ _id: 'request-1', _openid: 'private-passenger', cityKey: 'ny_nj', status: 'open', passengerCount: 3, passengerID: ['private-passenger'], referencePrice: '20$/人', departures: [{ address: 'Start', date: '2026-09-29', time: '15:00' }], destinations: [{ address: 'End' }], createdAt: now, updatedAt: now }];
  const result = normalizeCloudBaseExport(input, options);
  assert.equal(result.report.ready, true);
  assert.equal(result.plan!.rides[0]!.seatCapacity, 4);
  assert.equal(result.plan!.members[0]!.seatCount, 3);
  input.collections.CarpoolRequest[0]!.driverOpenid = 'private-driver';
  assert.ok(issues(input).includes('MISSING_MEMBERSHIP_TIMESTAMP'));
  const withDriver = normalizeCloudBaseExport(input, options);
  assert.equal(withDriver.report.ready, true);
  assert.equal(withDriver.plan!.members.find(member => member.role === 'driver')!.joinedAt, null);
});

test('closed inconsistent capacity and absent city remain unknown, without dropping participants or source evidence', () => {
  const input = fixture();
  const ride = input.collections.Carpool[0]!;
  Object.assign(ride, { status: 'past', passengerCount: 0, availSeatNum: 3 });
  delete ride.cityKey; delete ride.updatedAt;
  const result = normalizeCloudBaseExport(input, options);
  assert.equal(result.report.ready, true);
  assert.equal(result.plan!.rides[0]!.seatCapacity, null);
  assert.equal(result.plan!.rides[0]!.cityKey, null);
  assert.equal(result.plan!.rides[0]!.updatedAt, null);
  assert.equal(result.plan!.members.length, 2);
  assert.deepEqual(JSON.parse(result.plan!.sources.find(source => source.collection === 'Carpool')!.documentJson), ride);
  assert.doesNotMatch(JSON.stringify(result.report), /Private|private-|Campus/);
  ride.status = 'open';
  assert.equal(normalizeCloudBaseExport(input, options).plan, null);
  ride.status = 'past'; ride.cityKey = 'unrecognized-city';
  assert.equal(normalizeCloudBaseExport(input, options).plan, null);
});

test('historical over-capacity relations stay intact and missing membership clocks are never fabricated', () => {
  const input = fixture();
  Object.assign(input.collections.Carpool[0]!, { status: 'closed', passengerCount: 1, availSeatNum: -1 });
  input.collections.userInfo.push({ _id: 'user-doc-3', _openid: 'second-passenger', createdAt: now });
  (input.collections.Carpool[0]!.passengers as unknown[]).push('second-passenger');
  const result = normalizeCloudBaseExport(input, options);
  assert.equal(result.report.ready, true);
  assert.equal(result.plan!.rides[0]!.seatCapacity, null);
  assert.equal(result.plan!.members.length, 3);
  const second = result.plan!.users.find(user => user.openid === 'second-passenger')!;
  assert.equal(second.updatedAt, null);
  assert.equal(result.plan!.members.find(member => member.userId === second.id)!.joinedAt, null);
  (input.collections.Carpool[0]!.passengers as unknown[])[1] = { _openid: 'second-passenger', joinedAt: 'bad-time' };
  assert.equal(normalizeCloudBaseExport(input, options).plan, null);
});

test('independent profile write clocks produce only the last recorded update; absence stays unknown', () => {
  const input = fixture();
  const user = input.collections.userInfo[0]!;
  Object.assign(user, { updateTime: '2026-09-25T04:00:00.000Z', bigregionUpdatedAt: '2026-09-25T05:00:00.000Z' });
  assert.equal(normalizeCloudBaseExport(input, options).plan!.users[0]!.updatedAt, '2026-09-25T05:00:00.000Z');
  user.updateTime = 'bad-time';
  assert.equal(normalizeCloudBaseExport(input, options).plan, null);
});

test('old payment visibility is boolean and contact snapshots remain only in private source evidence', () => {
  const input = fixture();
  Object.assign(input.collections.Carpool[0]!, { zelle: 'yes' });
  const passenger = (input.collections.Carpool[0]!.passengers as Record<string, unknown>[])[0]!;
  Object.assign(passenger, { name: 'Stale private name', avatarUrl: 'https://old.invalid/avatar' });
  const result = normalizeCloudBaseExport(input, options);
  assert.equal(result.plan!.rides[0]!.details.zelleDisplay, true);
  assert.deepEqual(result.plan!.members.find(member => member.role === 'passenger')!.details, { pickupAddress: 'Private Pickup', dropoffAddress: 'Campus' });
  assert.equal(JSON.parse(result.plan!.sources.find(source => source.collection === 'Carpool')!.documentJson).passengers[0].name, passenger.name);
  input.collections.Carpool[0]!.zelle = 'no';
  assert.equal(normalizeCloudBaseExport(input, options).plan!.rides[0]!.details.zelleDisplay, false);
  input.collections.Carpool[0]!.zelle = 'maybe';
  assert.equal(normalizeCloudBaseExport(input, options).plan, null);
});

test('source IDs and lossless JSON are required even when core business mapping otherwise passes', () => {
  const input = fixture();
  const initial = normalizeCloudBaseExport(input, options).plan!;
  assert.equal(initial.sources.length, 3);
  assert.match(initial.sourceSha256, /^[a-f0-9]{64}$/);
  const rerun = normalizeCloudBaseExport(JSON.parse(JSON.stringify(input)), options).plan!;
  assert.deepEqual(rerun.sources, initial.sources);
  assert.equal(rerun.sourceSha256, initial.sourceSha256);
  input.collections.userInfo[1]!._id = input.collections.userInfo[0]!._id;
  assert.ok(issues(input).includes('DUPLICATE_SOURCE_ID'));
  delete input.collections.userInfo[1]!._id;
  assert.ok(issues(input).includes('MISSING_SOURCE_ID'));
  input.collections.userInfo[1]!.name = undefined;
  assert.ok(issues(input).includes('INVALID_SOURCE_JSON'));
});

test('invalid database version and reversed or excessive source stops cannot produce an import plan', () => {
  const input = fixture();
  input.collections.Carpool[0]!.businessVersion = 2_147_483_648;
  assert.ok(issues(input).includes('INVALID_VERSION'));
  assert.equal(normalizeCloudBaseExport(input, options).plan, null);
  input.collections.Carpool[0]!.businessVersion = 2_147_483_647;
  assert.equal(normalizeCloudBaseExport(input, options).report.ready, true);
  input.collections.Carpool[0]!.departures = [
    { address: 'First', date: '2026-09-29', time: '15:00' },
    { address: 'Second', date: '2026-09-29', time: '14:00' },
  ];
  assert.ok(issues(input).includes('UNORDERED_DEPARTURE_TIMES'));
  assert.equal(normalizeCloudBaseExport(input, options).plan, null);
  input.collections.Carpool[0]!.departures = Array.from({ length: 11 }, () => ({ address: 'Place', date: '2026-09-29', time: '15:00' }));
  assert.ok(issues(input).includes('TOO_MANY_STOPS'));
});

test('inherited object names are never statuses and imported ride IDs remain routable', () => {
  for (const status of ['constructor', 'toString', '__proto__']) {
    const input = fixture(); input.collections.Carpool[0]!.status = status;
    assert.equal(normalizeCloudBaseExport(input, options).plan, null);
    assert.ok(issues(input).includes('UNMAPPED_RIDE_STATUS'));
  }
  for (const id of ['spaces inside', 'slash/id', 'x'.repeat(161)]) {
    const input = fixture(); input.collections.Carpool[0]!._id = id;
    assert.equal(normalizeCloudBaseExport(input, options).plan, null);
    assert.ok(issues(input).includes('INVALID_RIDE_ID'));
  }
});

test('source serialization does not invoke custom conversion or silently discard non-JSON fields', () => {
  let calls = 0;
  const converted = Object.defineProperty({ _id: 'original' }, 'toJSON', { value() { calls++; return { _id: 'changed' }; } });
  const getter = Object.defineProperty({ _id: 'original' }, 'value', { enumerable: true, get() { calls++; return 1; } });
  for (const value of [converted, getter, { _id: 'x', [Symbol('hidden')]: 1 }, { _id: 'x', value: NaN }, { _id: 'x', value: new Date(now) }, { _id: 'x', value: '\u0000' }, { _id: 'x', value: '\ud800' }]) {
    assert.throws(() => migrationSource('collection', value), /Invalid source JSON/);
  }
  assert.equal(calls, 0);
  assert.throws(() => serializeSource([, 1]), /Invalid source JSON/);
  const original = { _id: 'x', valid: '中文🚗', nested: { array: [null, true, 0, 'a'] } };
  const source = migrationSource('collection', original);
  assert.deepEqual(JSON.parse(source.documentJson), original);
  assert.equal(source.sha256, sourceHash(source.documentJson));
});

test('legacy and synthetic business facts are never silently mixed into a new production import', () => {
  const input = fixture(); input.collections.Carpool[0]!.businessSynthetic = true;
  assert.ok(issues(input).includes('SYNTHETIC_RECORD_REQUIRES_SEPARATE_IMPORT'));
  input.collections.CarpoolRequest = [{ ...input.collections.Carpool[0] }];
  assert.ok(issues(input).includes('DUPLICATE_RIDE_ID'));
});

test('analyze CLI emits only aggregate JSON, with no raw values and no write command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linkx-migration-test-'));
  try {
    const file = join(directory, 'input.json'); await writeFile(file, JSON.stringify(fixture()));
    const output = execFileSync(process.execPath, [new URL('../src/migration/analyze.ts', import.meta.url).pathname, file], { encoding: 'utf8' });
    const report = JSON.parse(output);
    assert.equal(report.ready, true);
    assert.doesNotMatch(output, /private-|Private|Campus|test-app/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
