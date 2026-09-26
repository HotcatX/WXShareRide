import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { Pool } from 'pg';
import { importSnapshot, ImportAuditError } from '../src/migration/import.ts';
import { normalizeCloudBaseExport } from '../src/migration/normalize.ts';
import { migrationUserId } from '../src/migration/users.ts';
import { serializeSource, sourceHash } from '../src/migration/source.ts';
import type { Document } from '../src/migration/types.ts';
import { createTestDatabase } from './helpers/database.ts';

const appId = 'synthetic-import-app';
const createdAt = '2026-09-01T12:00:00.000Z';
const updatedAt = '2026-09-07T12:00:00.000Z';
const ratedAt = '2026-09-05T00:00:00.000Z';
const driver = 'synthetic-import-driver', passenger = 'synthetic-import-passenger';
const userId = (openid: string) => migrationUserId(appId, openid);
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
const options = { skip: !process.env.BACKEND_TEST_DATABASE_URL, timeout: 30000 };

// Composite of the existing normalization/rating/completion/template fixtures:
// all eight source collections are explicit, and both ride kinds are exercised.
function fixture() {
  const collections: Record<string, Document[]> = {
    userInfo: [
      { _id: 'import-user-driver', _openid: driver, name: 'Synthetic Driver', phone: 'synthetic-private-phone',
        referralCode: 'ref_0123456789ab', blockedUsers: [], createdAt, updatedAt,
        _rideCompletionV1: { version: 1, driverKeys: ['Carpool|import-offer', 'CarpoolRequest|import-request'], passengerKeys: [] },
        rideStats: { completedTrips: 2, completedDriverTrips: 2, completedPassengerTrips: 0,
          ratingSum: 5, ratingCount: 1, ratingAvg: 5, ratingWeightedAvg: 4.8,
          driverRatingSum: 5, driverRatingCount: 1, driverRatingAvg: 5, driverRatingWeightedAvg: 4.8, lastRatedAt: ratedAt } },
      { _id: 'import-user-passenger', _openid: passenger, name: 'Synthetic Passenger', createdAt,
        _rideCompletionV1: { version: 1, driverKeys: [], passengerKeys: ['Carpool|import-offer', 'CarpoolRequest|import-request'] },
        rideStats: { completedTrips: 2, completedDriverTrips: 0, completedPassengerTrips: 2 } },
    ],
    Carpool: [{ _id: 'import-offer', _openid: driver, status: 'past', passengerCount: 2, availSeatNum: 0,
      referencePrice: '协商', comment: 'Synthetic legacy note', zelle: 'yes',
      departures: [{ address: 'Synthetic historical origin', date: '2026-09-04', time: '15:00', placeId: 'synthetic-origin' }],
      destinations: [{ address: 'Synthetic historical destination' }], passengers: [passenger], createdAt }],
    CarpoolRequest: [{ _id: 'import-request', _openid: passenger, status: 'past', passengerCount: 1,
      cityKey: 'ny_nj', referencePrice: '12.50', largeLuggageCount: 1, passengerID: [passenger], driverOpenid: driver,
      departures: [{ address: 'Synthetic request origin', date: '2026-09-06', time: '15:00' }],
      destinations: [{ address: 'Synthetic request destination' }], createdAt, updatedAt }],
    CarpoolTemplate: [{ _id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', _openid: driver, templateName: 'Synthetic weekly class',
      departureAddress: 'Synthetic template origin', destinationAddress: 'Synthetic template destination',
      weekdayIndex: 1, weekdayText: '星期二', departureTime: '15:00', passengerCount: '2', referencePrice: '15',
      comment: 'Synthetic template note', carNumber: 'ARCHIVED-SNAPSHOT', createdAt }],
    Notifications: [{ _id: 'import-notification', _openid: driver, carpoolId: 'import-offer', type: 'new_rating',
      title: 'Synthetic notification', content: 'Synthetic historical content', read: true, createdAt: ratedAt,
      extra: { tripId: 'import-offer', role: 'passenger' } }],
    UserBlocks: [{ _id: 'import-block', _openid: driver, blockerOpenid: driver, targetOpenid: passenger,
      active: false, reason: 'Synthetic past block', createdAt, updatedAt }],
    TripRatings: [{ _id: 'Import-Rating', _openid: passenger, raterOpenid: passenger, targetOpenid: driver,
      tripId: 'import-offer', type: 'carpool', collection: 'Carpool', raterRole: 'passenger', targetRole: 'driver',
      score: 5, comment: '', createdAt: ratedAt, updatedAt: ratedAt }],
    PublicStats: [{ _id: 'home', servedTrips: 700, coverageText: 'Synthetic coverage', createdAt, updatedAt }],
  };
  return { kind: 'cloudbase-full-export', appId, collections };
}

async function database(t: TestContext) {
  const value = await createTestDatabase();
  t.after(value.close);
  return value.pool;
}

async function assertEmpty(pool: Pool) {
  const tables = (await pool.query(`SELECT quote_ident(tablename) AS name FROM pg_tables
    WHERE schemaname=current_schema() AND tablename <> 'schema_migrations'`)).rows;
  for (const table of tables) assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ${table.name}`)).rows[0].count, 0, table.name);
}

// Scheduling only; every statement and lock is executed by PostgreSQL.
function scheduledPool(pool: Pool, match: (sql: string) => boolean, pauseAfterQuery: boolean) {
  let reached!: (pid: number) => void, resume!: () => void;
  const entered = new Promise<number>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  let used = false;
  return { entered, resume, pool: { async connect() {
    const client = await pool.connect();
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    return {
      async query(sql: string, values?: unknown[]) {
        const selected = !used && match(sql);
        if (selected) { used = true; if (!pauseAfterQuery) reached(pid); }
        const result = await client.query(sql, values);
        if (selected && pauseAfterQuery) { reached(pid); await gate; }
        return result;
      },
      release() { client.release(); },
    };
  } } as unknown as Pool };
}

async function assertWaiting(pool: Pool, pid: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await pool.query('SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted', [pid])).rowCount) return;
    await setTimeout(5);
  }
  assert.fail('Expected a real PostgreSQL lock wait');
}

test('snapshot import stores all preserved facts and exact source evidence in one batch', options, async t => {
  const pool = await database(t), source = fixture();
  const original = serializeSource(source);
  const sourceSha256 = sourceHash(original);
  const observation = { sourceSha256, at: '2026-09-26T02:00:00.000Z' };
  const receipt = await importSnapshot(pool, source, appId, observation);
  assert.equal(serializeSource(source), original, 'the importer must not mutate its source');
  assert.equal(receipt.sourceSha256, sourceSha256);
  assert.deepEqual(receipt.counts, { users: 2, rides: 2, members: 4, stops: 4, templates: 1,
    notifications: 1, blocks: 1, ratings: 1, completions: 4, publicStatistics: 1, referralCodes: 1,
    adminAccounts: 0, adminOrigins: 0, adminAudit: 0, adminMarketBatches: 0, adminRequests: 0, marketTemplates: 0, listings: 0, files: 0, fileReferences: 0, marketViews: 0,
    ads: 0, adClicks: 0, communityConfigs: 0, communityRevisions: 0 });
  const batch = (await pool.query('SELECT source_sha256, plan_sha256, imported_counts, observed_before FROM migration_batches WHERE id=$1', [receipt.batchId])).rows[0];
  assert.equal(batch.source_sha256, sourceSha256);
  assert.match(batch.plan_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(batch.imported_counts, receipt.counts);
  assert.equal(batch.observed_before.toISOString(), observation.at);
  const archive = (await pool.query('SELECT collection, source_id, document_json, sha256 FROM migration_sources WHERE batch_id=$1', [receipt.batchId])).rows;
  assert.equal(archive.length, 9);
  for (const [collection, documents] of Object.entries(source.collections)) {
    for (const document of documents) {
      const row = archive.find(row => row.collection === collection && row.source_id === document._id);
      assert.ok(row, `archive missing a synthetic ${collection} document`);
      assert.equal(row.document_json, serializeSource(document));
      assert.equal(row.sha256, sourceHash(row.document_json));
    }
  }
  const storedUser = (await pool.query('SELECT profile, updated_at FROM users WHERE id=$1', [userId(passenger)])).rows[0];
  assert.equal(storedUser.updated_at, null, 'unknown historical update time must not be fabricated');
  assert.equal(Object.hasOwn(storedUser.profile, 'rideStats'), false);
  assert.deepEqual((await pool.query('SELECT user_id,code FROM referral_codes')).rows,
    [{ user_id: userId(driver), code: 'ref_0123456789ab' }]);
  const offer = (await pool.query('SELECT * FROM rides WHERE id=$1', ['import-offer'])).rows[0];
  assert.equal(offer.city_key, null);
  assert.equal(offer.seat_capacity, null, 'inconsistent historical capacity remains unknown');
  assert.equal(offer.listed_price_cents, null);
  assert.equal(offer.listed_price_label, '协商');
  assert.equal(offer.status, 'closed');
  assert.equal(offer.departure_at.toISOString(), '2026-09-04T19:00:00.000Z');
  assert.deepEqual(offer.details, { note: 'Synthetic legacy note', zelleDisplay: true });
  const request = (await pool.query('SELECT seat_capacity,listed_price_cents,details FROM rides WHERE id=$1', ['import-request'])).rows[0];
  assert.equal(request.seat_capacity, 4);
  assert.equal(request.listed_price_cents, 1250);
  assert.deepEqual(request.details, { largeLuggageCount: 1 });
  const member = (await pool.query('SELECT role,seat_count,joined_at FROM ride_members WHERE ride_id=$1 AND user_id=$2', ['import-offer', userId(passenger)])).rows[0];
  assert.deepEqual(member, { role: 'passenger', seat_count: 1, joined_at: null });
  const template = (await pool.query('SELECT weekday,local_time,updated_at,definition FROM ride_templates')).rows[0];
  assert.equal(template.weekday, 2);
  assert.equal(template.local_time, '15:00');
  assert.equal(template.updated_at, null);
  assert.equal(JSON.stringify(template.definition).includes('ARCHIVED-SNAPSHOT'), false);
  assert.deepEqual((await pool.query('SELECT active,reason FROM user_blocks')).rows, [{ active: false, reason: 'Synthetic past block' }]);
  const notice = (await pool.query('SELECT read,content,event_id,created_at FROM notifications')).rows[0];
  assert.equal(notice.read, true);
  assert.equal(notice.content, 'Synthetic historical content');
  assert.equal(notice.event_id, null);
  assert.equal(notice.created_at.toISOString(), ratedAt);
  const rating = (await pool.query('SELECT id,score,created_at,event_id FROM ride_ratings')).rows[0];
  assert.equal(rating.id, 'Import-Rating');
  assert.equal(rating.score, 5);
  assert.equal(rating.created_at.toISOString(), ratedAt);
  assert.equal(rating.event_id, null);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM ride_completions WHERE counted_at IS NULL AND event_id IS NULL')).rows[0].count, 4);
  assert.deepEqual((await pool.query('SELECT served_count,coverage_text FROM public_statistics')).rows,
    [{ served_count: '700', coverage_text: 'Synthetic coverage' }]);
  for (const table of ['business_events', 'sessions', 'idempotency_requests', 'referral_bindings']) {
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count, 0, `${table} must not be reconstructed`);
  }
});

test('incomplete, mismatched and unauditable sources cannot begin a bootstrap', options, async t => {
  const pool = await database(t);
  for (const name of Object.keys(fixture().collections)) {
    const source = fixture(); delete source.collections[name];
    await assert.rejects(importSnapshot(pool, source, appId), code('INCOMPLETE_IMPORT_SOURCE'));
  }
  await assert.rejects(importSnapshot(pool, fixture(), 'different-app'), code('IMPORT_APP_MISMATCH'));
  const malformed = fixture(); malformed.collections.userInfo![0]!.phone = undefined;
  await assert.rejects(importSnapshot(pool, malformed, appId), code('INVALID_IMPORT_SOURCE'));
  const invalid = fixture(); invalid.collections.Carpool![0]!.status = 'not-a-status';
  await assert.rejects(importSnapshot(pool, invalid, appId), error => error instanceof ImportAuditError &&
    !error.report.ready && error.report.issues.some(issue => issue.code === 'UNMAPPED_RIDE_STATUS'));
  await assertEmpty(pool);
});

test('future observation metadata cannot bootstrap data or promote an unexpired ride to historical status', options, async t => {
  const pool = await database(t);
  for (const promoteFutureRide of [false, true]) {
    const source = fixture();
    if (promoteFutureRide) {
      // Remove unrelated score/completion facts so the future cutoff itself is
      // the only invalid premise. The pure normalizer intentionally has no wall
      // clock; the importer must validate this observation against PostgreSQL.
      for (const user of source.collections.userInfo!) {
        delete user._rideCompletionV1;
        delete user.rideStats;
      }
      source.collections.TripRatings = [];
      source.collections.CarpoolRequest = [];
      const ride = source.collections.Carpool![0]!;
      ride.status = 'open';
      ride.departures = [{ address: 'Synthetic future origin', date: '2099-09-04', time: '15:00' }];
    }
    const observation = { sourceSha256: sourceHash(serializeSource(source)), at: '2100-01-01T00:00:00.000Z' };
    const normalized = normalizeCloudBaseExport(source, { timeZone: 'America/New_York', observation });
    assert.equal(normalized.report.ready, true, JSON.stringify(normalized.report.issues));
    if (promoteFutureRide) {
      assert.equal(source.collections.Carpool![0]!.status, 'open');
      assert.equal(normalized.plan!.rides.find(ride => ride.id === 'import-offer')!.status, 'closed');
    }
    await assert.rejects(importSnapshot(pool, source, appId, observation), error =>
      code('INVALID_EXPORT_OBSERVATION')(error) && !!error && typeof error === 'object' && 'status' in error && error.status === 400);
    await assertEmpty(pool);
  }
});

test('concurrent imports of the same source really wait and replay one committed receipt', options, async t => {
  const pool = await database(t), source = fixture();
  const first = scheduledPool(pool, sql => sql.startsWith('INSERT INTO users('), true);
  const second = scheduledPool(pool, sql => sql.includes('pg_advisory_xact_lock'), false);
  const importing = importSnapshot(first.pool, source, appId);
  await first.entered;
  const replaying = importSnapshot(second.pool, structuredClone(source), appId);
  try { await assertWaiting(pool, await second.entered); }
  finally { first.resume(); }
  assert.deepEqual(await replaying, await importing);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM migration_batches')).rows[0].count, 1);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM migration_sources')).rows[0].count, 9);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM users')).rows[0].count, 2);
});

test('the empty-target table lock blocks runtime writes until the complete import commits', options, async t => {
  const pool = await database(t);
  const scheduled = scheduledPool(pool, sql => sql.startsWith('LOCK TABLE '), true);
  const importing = importSnapshot(scheduled.pool, fixture(), appId);
  await scheduled.entered;
  const runtime = await pool.connect();
  const pid = (await runtime.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const writing = runtime.query('INSERT INTO users(app_id,openid,name) VALUES($1,$2,$3)',
    [appId, 'synthetic-runtime-owner', 'Created after import']);
  try { await assertWaiting(pool, pid); }
  finally { scheduled.resume(); }
  let receipt: Awaited<ReturnType<typeof importSnapshot>>;
  try { receipt = await importing; await writing; }
  finally { runtime.release(); }
  assert.equal(receipt.counts.users, 2);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM users')).rows[0].count, 3);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM migration_sources')).rows[0].count, 9);
});

test('existing business data or a prior unmatched batch is rejected without overwriting it', options, async t => {
  for (const kind of ['user', 'baseline', 'batch']) await t.test(kind, async child => {
    const pool = await database(child);
    if (kind === 'user') await pool.query("INSERT INTO users(app_id,openid,name) VALUES ('existing-app','existing-owner','Keep this name')");
    if (kind === 'baseline') await pool.query("INSERT INTO public_statistics(app_id,served_count) VALUES ('existing-app',321)");
    if (kind === 'batch') await pool.query("INSERT INTO migration_batches(app_id,source_sha256) VALUES ('existing-app',repeat('a',64))");
    const table = kind === 'user' ? 'users' : kind === 'baseline' ? 'public_statistics' : 'migration_batches';
    const before = (await pool.query(`SELECT to_jsonb(row) AS value FROM ${table} row`)).rows;
    await assert.rejects(importSnapshot(pool, fixture(), appId), code('IMPORT_TARGET_NOT_EMPTY'));
    assert.deepEqual((await pool.query(`SELECT to_jsonb(row) AS value FROM ${table} row`)).rows, before);
    for (const untouched of ['rides', 'migration_sources', 'referral_codes']) assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ${untouched}`)).rows[0].count, 0);
  });
});

test('a late archive failure rolls back every model and receipt, allowing a clean retry', options, async t => {
  const pool = await database(t), source = fixture();
  await pool.query(`CREATE FUNCTION reject_import_archive() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic archive failure'; END $$`);
  await pool.query('CREATE TRIGGER fail_archive BEFORE INSERT ON migration_sources FOR EACH ROW EXECUTE FUNCTION reject_import_archive()');
  await assert.rejects(importSnapshot(pool, source, appId), /synthetic archive failure/);
  await assertEmpty(pool);
  await pool.query('DROP TRIGGER fail_archive ON migration_sources');
  assert.equal((await importSnapshot(pool, source, appId)).counts.ratings, 1);
});

test('new domain tables are protected without maintaining a second table-name list', options, async t => {
  const pool = await database(t);
  // The quoted identifier also verifies catalog names cannot become SQL code.
  await pool.query('CREATE TABLE "future ""records;--" (value text NOT NULL)');
  await pool.query('INSERT INTO "future ""records;--" VALUES ($1)', ['Existing domain data']);
  await assert.rejects(importSnapshot(pool, fixture(), appId), code('IMPORT_TARGET_NOT_EMPTY'));
  assert.deepEqual((await pool.query('SELECT * FROM "future ""records;--"')).rows, [{ value: 'Existing domain data' }]);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM migration_batches')).rows[0].count, 0);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM users')).rows[0].count, 0);
});

test('bootstrap waits for the schema runner and sees tables it creates before releasing the lock', options, async t => {
  const pool = await database(t), schemaWriter = await pool.connect();
  await schemaWriter.query("SELECT pg_advisory_lock(hashtext('linkx-backend-schema'))");
  const scheduled = scheduledPool(pool, sql => sql.includes('pg_advisory_xact_lock'), false);
  const importing = importSnapshot(scheduled.pool, fixture(), appId);
  const rejected = assert.rejects(importing, code('IMPORT_TARGET_NOT_EMPTY'));
  try {
    await assertWaiting(pool, await scheduled.entered);
    await schemaWriter.query('CREATE TABLE newly_migrated_records (value text NOT NULL)');
    await schemaWriter.query("INSERT INTO newly_migrated_records VALUES ('Preserve new domain')");
  } finally {
    await schemaWriter.query("SELECT pg_advisory_unlock(hashtext('linkx-backend-schema'))");
    schemaWriter.release();
  }
  await rejected;
  assert.deepEqual((await pool.query('SELECT * FROM newly_migrated_records')).rows, [{ value: 'Preserve new domain' }]);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM users')).rows[0].count, 0);
});

test('the same source with a different conversion fingerprint cannot masquerade as a replay', options, async t => {
  const pool = await database(t), source = fixture();
  const sourceSha256 = sourceHash(serializeSource(source));
  const receipt = await importSnapshot(pool, source, appId);
  const before = (await pool.query('SELECT to_jsonb(batch) AS value FROM migration_batches batch')).rows;
  // Observation affects the conversion plan but never rewrites original source
  // bytes. Supplying it only on the retry must require an explicit migration.
  await assert.rejects(importSnapshot(pool, source, appId, { sourceSha256, at: '2026-09-26T02:00:00.000Z' }), code('IMPORT_PLAN_CHANGED'));
  assert.deepEqual((await pool.query('SELECT to_jsonb(batch) AS value FROM migration_batches batch')).rows, before);
  assert.deepEqual(await importSnapshot(pool, source, appId), receipt);
});

test('replaying after normal business changes returns the original receipt without restoring old state', options, async t => {
  const pool = await database(t), source = fixture();
  const receipt = await importSnapshot(pool, source, appId);
  await pool.query('UPDATE users SET name=$2 WHERE id=$1', [userId(driver), 'New business value']);
  await pool.query('UPDATE public_statistics SET served_count=served_count+3 WHERE app_id=$1', [appId]);
  await pool.query("UPDATE notifications SET read=false WHERE id='import-notification'");
  await pool.query('INSERT INTO referral_bindings(referred_user_id,referrer_user_id) VALUES($1,$2)', [userId(passenger), userId(driver)]);
  assert.deepEqual(await importSnapshot(pool, source, appId), receipt);
  assert.equal((await pool.query('SELECT name FROM users WHERE id=$1', [userId(driver)])).rows[0].name, 'New business value');
  assert.equal((await pool.query('SELECT served_count FROM public_statistics WHERE app_id=$1', [appId])).rows[0].served_count, '703');
  assert.equal((await pool.query('SELECT read FROM notifications')).rows[0].read, false);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM referral_bindings')).rows[0].count, 1);
  const different = fixture(); different.collections.userInfo![0]!.name = 'Changed source';
  await assert.rejects(importSnapshot(pool, different, appId), code('IMPORT_TARGET_NOT_EMPTY'));
});

test('mutating nested source data after the first await cannot change the captured plan or archive', options, async t => {
  const pool = await database(t), source = fixture();
  const originalJson = serializeSource(source), originalHash = sourceHash(originalJson);
  let reached!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const waitingPool = { async connect() { reached(); await gate; return pool.connect(); } } as unknown as Pool;
  const importing = importSnapshot(waitingPool, source, appId);
  await entered;
  source.appId = 'mutated-app';
  source.collections.userInfo![0]!.phone = 'mutated-private-value';
  source.collections.Carpool![0]!.referencePrice = '999';
  source.collections.Notifications!.length = 0;
  resume();
  const receipt = await importing;
  assert.equal(receipt.sourceSha256, originalHash);
  assert.equal(receipt.counts.notifications, 1);
  assert.equal((await pool.query('SELECT profile FROM users WHERE id=$1', [userId(driver)])).rows[0].profile.phone, 'synthetic-private-phone');
  assert.equal((await pool.query("SELECT listed_price_label FROM rides WHERE id='import-offer'")).rows[0].listed_price_label, '协商');
  const archive = (await pool.query('SELECT collection,source_id,document_json FROM migration_sources')).rows;
  const original = JSON.parse(originalJson) as ReturnType<typeof fixture>;
  for (const [collection, documents] of Object.entries(original.collections)) for (const document of documents) {
    assert.equal(archive.find(row => row.collection === collection && row.source_id === document._id)?.document_json, serializeSource(document));
  }
});
