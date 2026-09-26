import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { importSnapshot, ImportAuditError } from '../src/migration/import.ts';
import { normalizeCloudBaseExport } from '../src/migration/normalize.ts';
import { createTestDatabase } from './helpers/database.ts';
import type { Document } from '../src/migration/types.ts';

const appId = 'market-import-fixture';
const createdAt = '2026-09-01T12:00:00.000Z';
const expiresAt = '2026-09-30T23:59:59.999Z';
const options = { skip: !process.env.BACKEND_TEST_DATABASE_URL, timeout: 30000 };
function fixture() {
  const locator = 'cloud://fixture/market/private-listing.jpg';
  const collections: Record<string, Document[]> = {
    userInfo: [{ _id: 'fixture-profile', _openid: 'fixture-owner', name: 'Fixture Owner', createdAt }],
    Carpool: [], CarpoolRequest: [], CarpoolTemplate: [], Notifications: [], UserBlocks: [], TripRatings: [],
    PublicStats: [{ _id: 'home', servedTrips: 17, createdAt, updatedAt: createdAt }],
    WebAdminAccounts: [{ _id: 'fixture-admin', username: 'fixture-admin', enabled: true, role: 'admin', ownerKey: 'fixture-owner-key',
      passwordVersion: 1, passwordDigest: { algorithm: 'scrypt', salt: 'a1'.repeat(32), hash: 'b2'.repeat(64) }, createdAtMs: Date.parse(createdAt) }],
    market_goods: [{ _id: 'fixture-listing', _openid: 'fixture-owner', listingType: 'goods', title: 'Fixture desk', desc: 'Original description',
      price: 12.5, category: '家具', condition: '', regionState: 'NJ', regionCounty: 'Bergen', regionArea: 'Fort Lee',
      pickupStartDate: '2026-09-01', pickupEndDate: '2026-09-30', expireTime: { $date: expiresAt }, createTime: { $date: createdAt },
      status: 'online', imageFileIDs: [locator], thumbFileIDs: [], webAdminVersion: 3 }],
    MarketFiles: [{ _id: createHash('sha1').update(locator).digest('hex'), fileID: locator, _openid: 'fixture-owner',
      type: 'image', folder: 'market', status: 'attached', goodsId: 'fixture-listing', createdAtMs: Date.parse(createdAt), updatedAtMs: Date.parse(createdAt),
      attachedAt: { $date: createdAt }, updatedAt: { $date: createdAt } }],
    market_view_events: [],
  };
  return { kind: 'cloudbase-full-export', appId, collections };
}
const normalize = (source: unknown) => normalizeCloudBaseExport(source, { timeZone: 'America/New_York' });

test('central market plan requires explicit account and file evidence and never leaks credentials in its report', () => {
  const source = fixture();
  const result = normalize(source);
  assert.equal(result.report.ready, true, JSON.stringify(result.report.issues));
  assert.equal(result.plan!.adminAccounts.length, 1);
  assert.equal(result.plan!.listings.length, 1);
  assert.equal(result.plan!.fileReferences.length, 1);
  assert.equal(result.plan!.files[0]!.verifiedAt, null);
  for (const value of ['fixture-owner', 'fixture-owner-key', 'a1'.repeat(32), 'b2'.repeat(64), 'private-listing.jpg']) {
    assert.equal(JSON.stringify(result.report).includes(value), false);
  }
  for (const missing of ['market_goods', 'MarketFiles', 'WebAdminAccounts', 'market_view_events']) {
    const incomplete = fixture(); delete incomplete.collections[missing];
    const rejected = normalize(incomplete);
    assert.equal(rejected.plan, null);
    assert.ok(rejected.report.issues.some(issue => issue.code === 'INCOMPLETE_MARKET_SOURCE'));
  }
  const projected = fixture(); delete projected.collections.WebAdminAccounts![0]!.passwordDigest;
  assert.equal(normalize(projected).plan, null);
  const unrelated = fixture(); unrelated.collections.MarketImportBatches = [{ _id: 'fixture-batch' }];
  assert.ok(normalize(unrelated).report.issues.some(issue => issue.code === 'UNMAPPED_COLLECTION'));
});

test('central market import preserves exact credentials, expiry and ordered references without duplicate content images', options, async t => {
  const database = await createTestDatabase(); t.after(database.close);
  const source = fixture(), original = JSON.stringify(source), pool = database.pool;
  const receipt = await importSnapshot(pool, source, appId);
  assert.equal(JSON.stringify(source), original);
  assert.equal(receipt.counts.adminAccounts, 1); assert.equal(receipt.counts.listings, 1);
  assert.equal(receipt.counts.files, 1); assert.equal(receipt.counts.fileReferences, 1);
  const account = (await pool.query('SELECT password_salt,password_hash,updated_at FROM admin_accounts')).rows[0];
  assert.equal(account.password_salt.toString('hex'), 'a1'.repeat(32));
  assert.equal(account.password_hash.toString('hex'), 'b2'.repeat(64));
  assert.equal(account.updated_at, null);
  const listing = (await pool.query('SELECT expires_at,version,content,updated_at FROM market_listings')).rows[0];
  assert.equal(listing.expires_at.toISOString(), expiresAt); assert.equal(listing.version, '3'); assert.equal(listing.updated_at, null);
  assert.equal(listing.content.title, 'Fixture desk'); assert.equal(listing.content.priceCents, 1250);
  for (const absent of ['images', 'ownerUserId', 'adminOwnerKey', 'expiresAt', 'version']) assert.equal(Object.hasOwn(listing.content, absent), false);
  const references = (await pool.query(`SELECT r.slot,f.locator,f.legacy_readonly,f.verified_at FROM file_references r JOIN files f ON f.id=r.file_id`)).rows;
  assert.deepEqual(references, [{ slot: 'image.0', locator: source.collections.MarketFiles![0]!.fileID, legacy_readonly: true, verified_at: null }]);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM migration_sources')).rows[0].count, 5);
  for (const table of ['sessions', 'admin_sessions', 'admin_audit', 'admin_requests', 'idempotency_requests']) {
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count, 0);
  }
  await pool.query("UPDATE market_listings SET content=jsonb_set(content,'{title}','\"Changed after import\"')");
  assert.deepEqual(await importSnapshot(pool, fixture(), appId), receipt);
  assert.equal((await pool.query("SELECT content->>'title' AS title FROM market_listings")).rows[0].title, 'Changed after import');
});

test('an invalid file or a late database failure cannot leave accounts or listings partially imported', options, async t => {
  const database = await createTestDatabase(); t.after(database.close);
  const pool = database.pool, invalid = fixture(); invalid.collections.MarketFiles![0]!._openid = 'unknown-file-owner';
  await assert.rejects(importSnapshot(pool, invalid, appId), error => error instanceof ImportAuditError &&
    error.report.issues.some(issue => issue.code === 'UNKNOWN_MARKET_FILE_USER'));
  await pool.query(`CREATE FUNCTION reject_fixture_reference() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic reference failure'; END $$`);
  await pool.query('CREATE TRIGGER fail_reference BEFORE INSERT ON file_references FOR EACH ROW EXECUTE FUNCTION reject_fixture_reference()');
  await assert.rejects(importSnapshot(pool, fixture(), appId), /synthetic reference failure/);
  for (const table of ['users', 'admin_accounts', 'market_listings', 'files', 'file_references', 'migration_batches', 'migration_sources']) {
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count, 0);
  }
  await pool.query('DROP TRIGGER fail_reference ON file_references');
  assert.equal((await importSnapshot(pool, fixture(), appId)).counts.listings, 1);
});

test('daily view counts survive deleted listings and unknown actors without creating either', options, async t => {
  const database = await createTestDatabase(); t.after(database.close);
  const source = fixture(), pool = database.pool;
  source.collections.market_goods![0]!.viewCount = 2;
  const bucket = (goodsId: string, openid: string, count: number) => ({
    _id: createHash('sha1').update(`${goodsId}:${openid}:2026-09-01`).digest('hex'), goodsId, _openid: openid,
    dayKey: '2026-09-01', count, createTime: { $date: createdAt }, updateTime: { $date: createdAt },
    createTimeMs: Date.parse(createdAt) - 5, updateTimeMs: Date.parse(createdAt) - 5,
  });
  source.collections.market_view_events = [bucket('fixture-listing', 'fixture-owner', 2), bucket('deleted-listing', 'unknown-viewer', 6)];
  source.collections.houseShare = [structuredClone(source.collections.market_goods![0]!)];
  source.collections.houseShare[0]!.viewCount = 0;
  const receipt = await importSnapshot(pool, source, appId);
  assert.equal(receipt.counts.marketViews, 2); assert.equal(receipt.counts.listings, 1); assert.equal(receipt.counts.users, 1);
  assert.equal((await pool.query('SELECT sum(count)::integer AS total FROM market_views')).rows[0].total, 8);
  const orphan = (await pool.query("SELECT actor_user_id,day::text,count,created_at FROM market_views WHERE listing_id='deleted-listing'")).rows[0];
  assert.equal(orphan.actor_user_id, null); assert.equal(orphan.day, '2026-09-01'); assert.equal(orphan.count, '6');
  assert.equal(orphan.created_at.toISOString(), createdAt);
  const mismatch = fixture(); mismatch.collections.market_goods![0]!.viewCount = 1;
  assert.equal(normalize(mismatch).plan, null, 'missing counted views cannot silently become zero');
  const shadow = fixture(); shadow.collections.houseShare = [structuredClone(shadow.collections.market_goods![0]!)];
  shadow.collections.houseShare[0]!.title = 'Conflicting content';
  assert.equal(normalize(shadow).plan, null);
});

test('content import preserves current and historical references without inventing file ownership or ad actors', options, async t => {
  const database = await createTestDatabase(); t.after(database.close);
  const pool = database.pool, source = fixture(), at = Date.parse(createdAt);
  const picture = 'cloud://fixture/community/shared.jpg';
  const before = { group: { enabled: true, title: 'Fixture group', imageFileID: picture, expiresAt: at + 86400000 },
    announcement: { enabled: false, id: 'fixture-notice', title: 'Notice', body: 'Old body', imageFileID: '', showGroupImage: true,
      maxShows: 1, intervalHours: 24, startAt: 0, endAt: 0 } };
  const after = structuredClone(before); after.announcement.body = 'Current body';
  Object.assign(source.collections, {
    WebAdminSettings: [{ _id: 'main', allowedOrigins: ['https://admin.example.test'], updatedAtMs: at }],
    WebAdminUploads: [],
    market_ads: [{ _id: 'fixture-ad', status: 'online', placement: 'market_feed', title: 'Fixture ad', subtitle: '', badgeText: '广告',
      ctaText: '查看', weight: 2, priority: 3, startAtMs: 0, endAtMs: 0, imageFileID: picture, thumbFileID: picture,
      targetType: 'contact', contactSessionFrom: '', contactMessageTitle: 'Message', contactMessagePath: '/pages/market/market',
      showMessageCard: false, createTime: createdAt, updateTime: createdAt }],
    market_ad_events: [{ _id: 'fixture-orphan-click', _openid: 'unknown-viewer', adId: 'deleted-ad', type: 'click', placement: 'market_feed',
      listingType: 'goods', createTime: createdAt, createTimeMs: at - 20 }],
    community_config: [{ _id: 'main', ...after, version: 1, updatedBy: 'fixture-admin', updatedAtMs: at + 10,
      lastRequestHash: createHash('sha256').update(JSON.stringify(after)).digest('hex') }],
    CommunityConfigHistory: [{ _id: 'fixture-revision', version: 1, previousVersion: 0, before, after,
      updatedBy: 'fixture-admin', updatedAtMs: at }],
  });
  const normalized = normalize(source);
  assert.equal(normalized.report.ready, true, JSON.stringify(normalized.report.issues));
  const missing = structuredClone(source); delete missing.collections.WebAdminUploads;
  assert.ok(normalize(missing).report.issues.some(issue => issue.code === 'INCOMPLETE_CONTENT_SOURCE'));
  const receipt = await importSnapshot(pool, source, appId);
  assert.equal(receipt.counts.ads, 1); assert.equal(receipt.counts.adClicks, 1);
  assert.equal(receipt.counts.communityConfigs, 1); assert.equal(receipt.counts.communityRevisions, 1);
  assert.equal(receipt.counts.files, 2); assert.equal(receipt.counts.fileReferences, 6); assert.equal(receipt.counts.adminOrigins, 1);
  const file = (await pool.query('SELECT owner_user_id,admin_owner_key,uploaded_by_admin_id,created_at,verified_at FROM files WHERE locator=$1', [picture])).rows[0];
  assert.deepEqual(file, { owner_user_id: null, admin_owner_key: null, uploaded_by_admin_id: null, created_at: null, verified_at: null });
  const config = (await pool.query('SELECT version,content,updated_at FROM community_configs')).rows[0];
  assert.equal(config.version, 1); assert.equal(config.content.announcement.body, 'Current body');
  assert.equal(Object.hasOwn(config.content.group, 'imageFileID'), false); assert.equal(config.updated_at.getTime(), at + 10);
  const revision = (await pool.query('SELECT before_content,after_content,updated_at FROM community_revisions')).rows[0];
  assert.equal(revision.before_content.announcement.body, 'Old body'); assert.equal(revision.after_content.announcement.body, 'Current body');
  assert.equal(revision.updated_at.getTime(), at);
  assert.deepEqual((await pool.query('SELECT ad_id,actor_user_id FROM ad_clicks')).rows, [{ ad_id: 'deleted-ad', actor_user_id: null }]);
});
