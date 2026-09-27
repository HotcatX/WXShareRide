import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { getLocationCatalog } from '../src/locations/routes.ts';
import { normalizeCloudBaseExport } from '../src/migration/normalize.ts';
import { importSnapshot, ImportAuditError } from '../src/migration/import.ts';
import { serializeSource, sourceHash } from '../src/migration/source.ts';
import type { CloudBaseExport, Document } from '../src/migration/types.ts';
import { createTestDatabase } from './helpers/database.ts';

const receiver = await import(new URL('../../analytics-collector/src/places.mjs', import.meta.url).href);
const appId = 'archive-test-app', owner = 'synthetic-archive-owner', at = '2026-09-01T12:00:00.000Z';
const options = { timeZone: 'America/New_York' } as const;
function delivered(): Document {
  const tripId = 'deleted-synthetic-ride', version = 2;
  const eventId = createHash('sha256').update(`ride-business-v1\ncarpool\n${tripId}\n${version}`).digest('hex');
  const before = { cityKey: 'ny_nj', status: 'open',
    departures: [{ address: 'Synthetic origin', placeId: '', date: '2026-09-02', time: '15:00' }],
    destinations: [{ address: 'Synthetic destination', placeId: '', date: '', time: '' }],
    referencePriceCents: null, currency: 'USD', priceKind: 'listed_reference', availableSeats: 2, passengerCount: 2,
    creatorOpenid: owner, driverOpenid: owner, passengerOpenids: [], participantEdges: [{ openid: owner, role: 'driver' }],
    serviceDate: '2026-09-02', departureAtMs: null, latestDepartureAtMs: null, tripVersion: 1 };
  return { _id: eventId, type: 'carpool', tripId, action: 'delete', actorOpenid: owner, reason: '',
    createdAt: at, deliveredAt: '2026-09-01T12:01:00.000Z', deliveryState: 'delivered',
    event: { schemaVersion: 1, eventId, tripId, tripType: 'carpool', action: 'delete', actorOpenid: owner,
      eventAtMs: Date.parse(at), version, before, after: null, affectedOpenids: [owner], synthetic: false } };
}
function fixture(): Omit<CloudBaseExport, 'collections'> & { collections: Record<string, Document[]> } {
  const catalog = getLocationCatalog();
  const snapshot = { tripId: 'deleted-synthetic-ride', role: 'driver', status: 'past', createdAt: at,
    departures: [{ address: 'Synthetic old origin', date: '2026-09-02', time: '15:00' }],
    destinations: [{ address: 'Synthetic old destination' }] };
  const collections: Record<string, Document[]> = {
    userInfo: [{ _id: 'archive-user', _openid: owner, createdAt: at }], Carpool: [], CarpoolRequest: [],
    CarpoolTemplate: [], Notifications: [], UserBlocks: [], TripRatings: [], PublicStats: [{ _id: 'home', servedTrips: 0, updatedAt: at }],
    TripActions: [delivered(), { _id: 'old-log', type: 'carpool', tripId: snapshot.tripId, action: 'deleteTrip',
      actorOpenid: owner, reason: 'Synthetic old reason', targets: [owner], createdAt: at },
    { _id: 'old-page-log', _openid: owner, type: 'request', tripId: snapshot.tripId, requestId: snapshot.tripId,
      action: 'quitTrip', targetOpenid: '', source: 'tripActionReason_page', reasonOption: 'Synthetic', reason: 'Synthetic', otherReason: '', createTime: at }],
    MyTrips: [{ _id: 'old-active', _openid: owner, userId: 'archive-user', createdAt: at, updatedAt: at, trips: [snapshot] }],
    MyTripHistory: [{ _id: 'old-history', _openid: owner, userId: 'missing-old-user-document', createdAt: at, updatedAt: at, historyTrips: [snapshot] }],
    feedback: [{ _id: 'old-feedback', _openid: owner, content: 'Synthetic old feedback', createTime: at, email: '', phone: '', region: '' }],
    CITY_TREE: catalog.regionTree.map(state => ({ _id: state.key === 'OTHER' ? 'Other' : state.key,
      ...Object.fromEntries(state.groups.map(group => [group.key, group.areas])) })),
    cityTree: [{ _id: 'default', version: 1, updatedAt: at, ...catalog.cityTree }],
    regionTree: [{ _id: 'default', version: 1, updatedAt: at, ...catalog.marketRegionTree }],
    Request_Price: catalog.requestPrices.map((row, index) => ({ _id: `price-${index}`,
      Departure: row.fromAddress, Destination: row.toAddress, Price: row.label })), MarketAdFiles: [],
    Departure: [{ _id: 'old-departure', airport: '纽瓦克', campus: '哥大' }],
    Arrival: [{ _id: 'old-arrival', airport: '纽瓦克', campus: '哥大' }],
    Departure_Request: [{ _id: 'request-departure', town: 'JC', campus: '哥大' }],
    Arrival_Request: [{ _id: 'request-arrival', town: 'JC', campus: '哥大' }],
  };
  return { kind: 'cloudbase-full-export', appId, collections };
}
const convert = (source: CloudBaseExport) => normalizeCloudBaseExport(source, options);
function rejected(source: CloudBaseExport, code?: string) {
  const result = convert(source);
  assert.equal(result.plan, null);
  if (code) assert.ok(result.report.issues.some(issue => issue.code === code), JSON.stringify(result.report.issues));
  assert.doesNotMatch(JSON.stringify(result.report), /synthetic-archive-owner|Synthetic old|deleted-synthetic-ride/);
}

test('explicit archives preserve exact source evidence and never resurrect rides or their events', () => {
  const source = fixture(), original = serializeSource(source), result = convert(source);
  assert.equal(result.report.ready, true, JSON.stringify(result.report.issues));
  assert.equal(serializeSource(source), original);
  const plan = result.plan!;
  for (const kind of ['rides', 'members', 'ratings', 'completions', 'templates'] as const) assert.equal(plan[kind].length, 0);
  assert.equal(plan.sources.length, Object.values(source.collections).reduce((sum, rows) => sum + rows.length, 0));
  for (const row of plan.sources) {
    assert.equal(row.documentJson, serializeSource(source.collections[row.collection]!.find(item => item._id === row.sourceId)));
    assert.equal(row.sha256, sourceHash(row.documentJson));
  }
  assert.ok(result.report.issues.some(issue => issue.code === 'ARCHIVED_USER_DOCUMENT_MISSING'));
  receiver.validateBusinessEvents({ schemaVersion: 1, events: [source.collections.TripActions![0]!.event] });
});

test('pending, malformed, synthetic and mismatched delivered events cannot be archived as old logs', () => {
  const changes: ((row: Document) => void)[] = [
    row => { row.deliveryState = 'pending'; }, row => { row.deliveryState = 'unknown'; },
    row => { delete row.event; }, row => { delete row.deliveredAt; }, row => { row.deliveredAt = '2026-08-01T00:00:00Z'; },
    row => { row.tripId = 'another-ride'; }, row => { row.actorOpenid = 'synthetic-other-actor'; }, row => { row.action = 'join'; },
    row => { (row.event as Document).synthetic = true; }, row => { (row.event as Document).eventId = 'f'.repeat(64); },
    row => { ((row.event as Document).before as Document).privateUnknownField = 'private-value'; },
    row => { ((row.event as Document).before as Document).referencePriceCents = 1_000_001; },
    row => { ((row.event as Document).before as Document).serviceDate = '2026-02-30'; },
    row => { row.unknownAck = true; },
  ];
  for (const change of changes) { const source = fixture(); change(source.collections.TripActions![0]!); rejected(source); }
  const source = fixture(); source.collections.TripActions![1]!.deliveryState = 'delivered'; rejected(source);
});

test('retired snapshots validate shape and owner without using absent rides as facts', () => {
  for (const name of ['MyTrips', 'MyTripHistory', 'feedback']) {
    const unknown = fixture(); unknown.collections[name]![0]!.newFact = true; rejected(unknown, 'INVALID_ARCHIVED_DOCUMENT');
    const account = fixture(); account.collections[name]![0]!._openid = 'synthetic-missing-account'; rejected(account, 'UNKNOWN_ARCHIVED_OWNER');
  }
  const conflict = fixture(); conflict.collections.userInfo!.push({ _id: 'other-user', _openid: 'synthetic-second-owner', createdAt: at });
  conflict.collections.MyTrips![0]!.userId = 'other-user'; rejected(conflict, 'CONFLICTING_ARCHIVED_OWNER');
  const invalid = fixture(); (invalid.collections.MyTripHistory![0]!.historyTrips as Document[])[0]!.departures = [{ address: 'Synthetic', hiddenField: 'private' }];
  rejected(invalid, 'INVALID_ARCHIVED_DOCUMENT');
});

test('fixed configuration requires exact content or preserved known address aliases, never arbitrary dropped values', () => {
  for (const name of ['CITY_TREE', 'cityTree', 'regionTree', 'Request_Price']) {
    const changed = fixture(); changed.collections[name]![0]!.unknown = 'private-value'; rejected(changed, 'ARCHIVED_CONFIG_MISMATCH');
    const missing = fixture(); missing.collections[name] = []; rejected(missing, 'ARCHIVED_CONFIG_MISMATCH');
  }
  const label = fixture(); label.collections.Request_Price![0]!.Price = 'different quotation'; rejected(label, 'ARCHIVED_CONFIG_MISMATCH');
  for (const name of ['Departure', 'Arrival', 'Departure_Request', 'Arrival_Request']) {
    const source = fixture(); source.collections[name]![0]!.unknown = 'Unlisted private address'; rejected(source, 'ARCHIVED_CONFIG_MISMATCH');
    const empty = fixture(); empty.collections[name] = []; rejected(empty, 'ARCHIVED_CONFIG_MISMATCH');
  }
  const request = fixture(); request.collections.Departure_Request![0]!.town = '纽瓦克'; rejected(request, 'ARCHIVED_CONFIG_MISMATCH');
});

test('reserved empty collection is explicit and unknown collections remain rejected even when empty', () => {
  const reserved = fixture(); reserved.collections.MarketAdFiles = [{ _id: 'unreviewed-file' }]; rejected(reserved, 'EXPECTED_EMPTY_COLLECTION');
  for (const rows of [[], [{ _id: 'unreviewed-user' }]]) {
    const source = fixture(); source.collections.FutureUnknown = rows; rejected(source, 'UNMAPPED_COLLECTION');
  }
  const renamed = fixture(); renamed.collections.FutureArchive = []; rejected(renamed, 'UNMAPPED_COLLECTION');
});

test('real PG imports archives atomically, retains exact JSON hashes and has no pending delivery or resurrected business rows',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL, timeout: 30000 }, async t => {
    const db = await createTestDatabase(); t.after(db.close);
    const bad = fixture(); bad.collections.TripActions![0]!.deliveryState = 'pending';
    await assert.rejects(importSnapshot(db.pool, bad, appId), error => error instanceof ImportAuditError);
    for (const table of ['users', 'migration_batches', 'migration_sources', 'business_events', 'rides']) {
      assert.equal((await db.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
    }
    const source = fixture(), receipt = await importSnapshot(db.pool, source, appId);
    const archive = (await db.pool.query('SELECT collection,source_id,document_json,sha256 FROM migration_sources')).rows;
    assert.equal(archive.length, Object.values(source.collections).reduce((sum, rows) => sum + rows.length, 0));
    for (const row of archive) {
      assert.equal(row.document_json, serializeSource(source.collections[row.collection]!.find(item => item._id === row.source_id)));
      assert.equal(row.sha256, sourceHash(row.document_json));
    }
    for (const table of ['rides', 'ride_members', 'business_events', 'ride_ratings', 'ride_completions']) {
      assert.equal((await db.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
    }
    assert.deepEqual(await importSnapshot(db.pool, source, appId), receipt);
  });
