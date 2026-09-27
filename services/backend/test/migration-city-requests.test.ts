import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCloudBaseExport } from '../src/migration/normalize.ts';
import { migrationCityRequestId } from '../src/migration/city-requests.ts';
import { migrationUserId } from '../src/migration/users.ts';
import { importSnapshot, ImportAuditError } from '../src/migration/import.ts';
import { serializeSource } from '../src/migration/source.ts';
import type { CloudBaseExport, Document } from '../src/migration/types.ts';
import { createTestDatabase } from './helpers/database.ts';
const appId = 'synthetic-city-migration', at = '2026-09-01T12:00:00.000Z', openid = 'synthetic-city-owner';
const options = { timeZone: 'America/New_York' } as const;
function fixture(): CloudBaseExport {
  return { kind: 'cloudbase-full-export', appId, collections: {
    userInfo: [{ _id: 'user', _openid: openid, name: 'Synthetic', createdAt: at }], Carpool: [], CarpoolRequest: [],
    CarpoolTemplate: [], Notifications: [], UserBlocks: [], TripRatings: [], PublicStats: [{ _id: 'home', servedTrips: 0, updatedAt: at }],
    ride_city_demand_events: [1, 2].map(i => ({ _id: `city-event-${i}`, cityKey: 'boston', cityLabel: 'Historical Boston', cityAliases: ['Boston'], sourcePage: 'carpoolList', openid, createdAt: at })),
    ride_city_demand: [{ _id: 'ride_city_boston', cityKey: 'boston', cityLabel: 'Historical Boston', cityAliases: ['Boston'], sourcePage: 'carpoolList', requestCount: 2, requestOpenids: [openid], createdAt: at, updatedAt: at }],
  } };
}
test('city migration preserves real event identity/time and reconciles cumulative counts without inventing events', () => {
  const source = fixture(), before = serializeSource(source), result = normalizeCloudBaseExport(source, options);
  assert.equal(result.report.ready, true, JSON.stringify(result.report.issues)); assert.equal(result.report.candidateCounts.cityRequests, 2);
  assert.deepEqual(result.plan!.cityRequests[0], { id: migrationCityRequestId(appId, 'city-event-1'), userId: migrationUserId(appId, openid), cityKey: 'boston', cityLabel: 'Historical Boston', cityAliases: ['Boston'], sourcePage: 'carpoolList', createdAt: at });
  assert.equal(serializeSource(source), before); assert.notEqual(migrationCityRequestId('another-app', 'city-event-1'), result.plan!.cityRequests[0]!.id);
});
test('city missing events, aggregate drift, unknown actor, duplicate IDs and unrecognized source fields block the whole plan', () => {
  const change: ((source: CloudBaseExport) => void)[] = [
    s => { delete s.collections.ride_city_demand_events; }, s => { s.collections.ride_city_demand_events = []; },
    s => { (s.collections.ride_city_demand![0] as Document).requestCount = 3; },
    s => { (s.collections.ride_city_demand_events![0] as Document).openid = 'unverified-secret-person'; },
    s => { (s.collections.ride_city_demand![0] as Document).requestOpenids = ['unverified-secret-person']; },
    s => { (s.collections.ride_city_demand_events![1] as Document)._id = 'city-event-1'; },
    s => { (s.collections.ride_city_demand_events![0] as Document).unknown = 'secret'; },
    s => { (s.collections.ride_city_demand_events![0] as Document).createdAt = null; },
    s => { s.collections.ride_city_demand = []; },
  ];
  for (const mutate of change) {
    const source = fixture(); mutate(source); const result = normalizeCloudBaseExport(source, options);
    assert.equal(result.plan, null); assert.equal(result.report.ready, false);
    assert.doesNotMatch(JSON.stringify(result.report), /secret|synthetic-city-owner|Historical Boston/);
  }
});
test('real PG import archives both old collections verbatim, imports only events, replays safely and rolls all facts back on failure',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async () => {
    const db = await createTestDatabase();
    try {
      const invalid = fixture(); (invalid.collections.ride_city_demand![0] as Document).requestCount = 9;
      await assert.rejects(importSnapshot(db.pool, invalid, appId), error => error instanceof ImportAuditError);
      await db.pool.query(`CREATE FUNCTION synthetic_reject_city() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic city failure'; END; $$;
        CREATE TRIGGER synthetic_reject_city BEFORE INSERT ON city_requests FOR EACH ROW EXECUTE FUNCTION synthetic_reject_city()`);
      await assert.rejects(importSnapshot(db.pool, fixture(), appId), /synthetic city failure/);
      for (const table of ['users', 'city_requests', 'migration_sources', 'migration_batches']) assert.equal((await db.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
      await db.pool.query('DROP TRIGGER synthetic_reject_city ON city_requests');
      const source = fixture(), receipt = await importSnapshot(db.pool, source, appId);
      assert.equal(receipt.counts.cityRequests, 2); assert.deepEqual(await importSnapshot(db.pool, source, appId), receipt);
      const events = (await db.pool.query('SELECT * FROM city_requests ORDER BY id')).rows;
      assert.equal(events.length, 2); assert.ok(events.every(row => row.created_at.toISOString() === at && row.city_label === 'Historical Boston' && row.user_id === migrationUserId(appId, openid)));
      const archive = (await db.pool.query("SELECT collection,source_id,document_json FROM migration_sources WHERE collection IN ('ride_city_demand','ride_city_demand_events')")).rows;
      assert.equal(archive.length, 3);
      for (const collection of ['ride_city_demand', 'ride_city_demand_events']) for (const row of source.collections[collection] as Document[]) {
        assert.equal(archive.find(a => a.collection === collection && a.source_id === row._id).document_json, serializeSource(row));
      }
    } finally { await db.close(); }
  });
