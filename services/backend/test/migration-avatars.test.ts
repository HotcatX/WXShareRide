import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeAvatarFiles, legacyDefaultAvatarUrl } from '../src/migration/avatar-files.ts';
import { stableFileId, type FileRow, type FileReferenceRow } from '../src/migration/files.ts';
import { importSnapshot, ImportAuditError } from '../src/migration/import.ts';
import { normalizeCloudBaseExport } from '../src/migration/normalize.ts';
import { serializeSource } from '../src/migration/source.ts';
import type { CloudBaseExport, Document, MigrationIssue } from '../src/migration/types.ts';
import { migrationUserId } from '../src/migration/users.ts';
import { createTestDatabase } from './helpers/database.ts';

const appId = 'wx8a8a389199aa2a0e';
const prefix = 'cloud://cloud1-7gmtcu4s3aebce27.636c-cloud1-7gmtcu4s3aebce27-1383643768/userAvatar/';
const locator = prefix + 'synthetic-avatar.jpg';
const at = '2026-09-01T12:00:00.000Z';
const options = { timeZone: 'America/New_York' } as const;
const pgOptions = { skip: !process.env.BACKEND_TEST_DATABASE_URL, timeout: 30000 };
const user = (index: number, avatarUrl?: unknown): Document => ({ _id: `synthetic-user-${index}`,
  _openid: `synthetic-avatar-user-${index}`, name: 'Synthetic user', createdAt: at,
  ...(avatarUrl === undefined ? {} : { avatarUrl }) });
function fixture(): CloudBaseExport {
  return { kind: 'cloudbase-full-export', appId, collections: {
    userInfo: [user(1, locator), user(2, locator), user(3, legacyDefaultAvatarUrl), user(4, ''), user(5),
      { _id: 'synthetic-alias', openid: 'synthetic-avatar-user-1', tripDriver: [] }, { _id: 'synthetic-unattributed' }],
    Carpool: [], CarpoolRequest: [], CarpoolTemplate: [], Notifications: [], UserBlocks: [], TripRatings: [],
    PublicStats: [{ _id: 'home', servedTrips: 0, updatedAt: at }],
  } };
}
function contentFixture() {
  const source = fixture();
  Object.assign(source.collections, { WebAdminAccounts: [], market_goods: [], MarketFiles: [], market_view_events: [],
    MarketImportBatches: [], WebAdminUploads: [], market_ad_events: [], community_config: [], CommunityConfigHistory: [],
    market_ads: [{ _id: 'synthetic-ad', status: 'online', placement: 'market_feed', title: 'Synthetic ad', subtitle: '',
      badgeText: '广告', ctaText: '查看', weight: 1, priority: 1, startAtMs: 0, endAtMs: 0,
      imageFileID: locator, thumbFileID: locator, targetType: 'contact', contactSessionFrom: 'synthetic',
      contactMessageTitle: '', contactMessagePath: '', showMessageCard: false, createTime: at, updateTime: at }],
  });
  return source;
}
function merge(files: FileRow[], references: FileReferenceRow[] = []) {
  const source = fixture(), plan = normalizeCloudBaseExport(source, options).plan!;
  const issues: Omit<MigrationIssue, 'count'>[] = [];
  const result = normalizeAvatarFiles({ users: plan.users, sourceUsers: source.collections.userInfo as Document[], files, references }, appId,
    (collection, code, field = '-', severity = 'error') => issues.push({ collection, code, field, severity }));
  return { ...result, errors: issues.filter(row => row.severity === 'error') };
}

test('core-only normalization preserves current avatar references with unknown provenance and complete source evidence', () => {
  const source = fixture(), before = serializeSource(source), result = normalizeCloudBaseExport(source, options);
  assert.equal(result.report.ready, true, JSON.stringify(result.report.issues));
  assert.equal(result.plan!.users.length, 5);
  assert.equal(result.plan!.files.length, 1);
  assert.equal(result.plan!.fileReferences.length, 2);
  assert.deepEqual(result.plan!.files[0], { id: stableFileId(appId, locator), appId, provider: 'cloudbase', locator,
    ownerUserId: null, adminOwnerKey: null, uploadedByAdminId: null, legacyReadonly: true, status: 'ready',
    sizeBytes: null, mediaType: null, sha256: null, verifiedAt: null, createdAt: null, updatedAt: null });
  assert.deepEqual(result.plan!.fileReferences, [1, 2].map(index => ({ appId, resourceKind: 'user',
    resourceId: migrationUserId(appId, `synthetic-avatar-user-${index}`), slot: 'avatar', fileId: stableFileId(appId, locator) })));
  assert.ok(result.plan!.users.every(row => !('avatarUrl' in row) && !('avatarFileId' in row) && !('avatarUrl' in row.profile)));
  assert.equal(result.plan!.sources.length, 8);
  assert.equal(serializeSource(source), before);
});

test('only the exact current default image is omitted; namespace, path and external URL anomalies block the whole plan', async () => {
  for (const path of ['../../../pages/profile/addInfo/addInfo.js', '../../../pages/profile/editInfo/editInfo.js']) {
    assert.ok((await readFile(new URL(path, import.meta.url), 'utf8')).includes(legacyDefaultAvatarUrl));
  }
  for (const value of [legacyDefaultAvatarUrl + '?size=96', 'https://private.example/avatar', 'http://127.0.0.1/private',
    '/local/private.jpg', 'cloud://other.other/userAvatar/x.jpg', prefix.replace('636c-', 'wrong-') + 'x.jpg',
    prefix.replace('/userAvatar/', '/market/') + 'x.jpg', prefix, prefix + '../private.jpg', prefix + '%2e%2e/private.jpg',
    prefix + 'x.jpg?token=private', prefix + 'x.jpg#private', prefix + 'x\\private.jpg', prefix + 'x\u0000.jpg',
    prefix + 'x'.repeat(1024), null, 3, {}]) {
    const source = fixture(); (source.collections.userInfo![0] as Document).avatarUrl = value;
    const before = JSON.stringify(source), result = normalizeCloudBaseExport(source, options);
    assert.equal(result.plan, null, `unexpectedly accepted avatar shape ${typeof value}`);
    assert.ok(result.report.issues.some(row => ['UNSUPPORTED_AVATAR_SOURCE', 'INVALID_SOURCE_JSON'].includes(row.code)));
    assert.doesNotMatch(JSON.stringify(result.report), /private|synthetic-avatar|cloud:\/\//);
    assert.equal(JSON.stringify(source), before);
  }
});

test('the audited cloud namespace cannot be imported under another app or selected through alias documents', () => {
  const source = fixture(); source.appId = 'another-app';
  assert.equal(normalizeCloudBaseExport(source, options).plan, null);
  source.collections.userInfo = [user(1, legacyDefaultAvatarUrl), user(2, '')];
  assert.equal(normalizeCloudBaseExport(source, options).report.ready, true);
  const alias = fixture(); (alias.collections.userInfo![5] as Document).avatarUrl = prefix + 'alias.jpg';
  assert.ok(normalizeCloudBaseExport(alias, options).report.issues.some(row => row.code === 'UNVERIFIED_ALIAS_PROFILE'));
  assert.equal(normalizeCloudBaseExport(alias, options).plan, null);
});

test('avatar and content references share the existing file without replacing recorded ownership or clocks', () => {
  const file = normalizeCloudBaseExport(fixture(), options).plan!.files[0]!;
  const known = { ...file, ownerUserId: migrationUserId(appId, 'synthetic-avatar-user-5'), createdAt: at, updatedAt: at };
  const reference: FileReferenceRow = { appId, resourceKind: 'ad', resourceId: 'synthetic-ad', slot: 'image', fileId: known.id };
  const before = JSON.stringify({ known, reference }), merged = merge([known], [reference]);
  assert.deepEqual(merged.errors, []);
  assert.deepEqual(merged.files, [known]);
  assert.equal(merged.references.length, 3);
  assert.deepEqual(merged.references[0], reference);
  assert.equal(JSON.stringify({ known, reference }), before);
  const central = normalizeCloudBaseExport(contentFixture(), options);
  assert.equal(central.report.ready, true, JSON.stringify(central.report.issues));
  assert.equal(central.plan!.files.length, 1);
  assert.equal(central.plan!.fileReferences.length, 4);
});

test('inconsistent existing file identities, references and pending state cannot be silently overwritten', () => {
  const file = normalizeCloudBaseExport(fixture(), options).plan!.files[0]!;
  for (const files of [[file, file], [{ ...file, id: migrationUserId(appId, 'wrong-file') }],
    [{ ...file, appId: 'wrong-app' }], [{ ...file, status: 'pending' as const }]]) {
    const result = merge(files);
    assert.ok(result.errors.length); assert.deepEqual(result.files, []); assert.deepEqual(result.references, []);
  }
  const reference: FileReferenceRow = { appId, resourceKind: 'ad', resourceId: 'synthetic-ad', slot: 'image', fileId: file.id };
  for (const refs of [[reference, reference], [{ ...reference, fileId: 'missing' }], [{ ...reference, appId: 'another-app' }]]) {
    assert.ok(merge([file], refs).errors.length);
  }
});

test('central PostgreSQL import stores avatar facts and exact original sources for both core and full content slices', pgOptions, async () => {
  for (const source of [fixture(), contentFixture()]) {
    const database = await createTestDatabase();
    try {
      const receipt = await importSnapshot(database.pool, source, appId);
      assert.equal(receipt.counts.files, 1);
      assert.equal(receipt.counts.fileReferences, source.collections.market_ads ? 4 : 2);
      const file = (await database.pool.query('SELECT * FROM files')).rows[0];
      assert.equal(file.locator, locator); assert.equal(file.id, stableFileId(appId, locator));
      for (const field of ['owner_user_id', 'admin_owner_key', 'uploaded_by_admin_id', 'size_bytes', 'media_type',
        'sha256', 'verified_at', 'created_at', 'updated_at']) assert.equal(file[field], null, field);
      const refs = (await database.pool.query("SELECT resource_id,slot,file_id FROM file_references WHERE resource_kind='user' ORDER BY resource_id")).rows;
      assert.equal(refs.length, 2); assert.ok(refs.every(row => row.file_id === file.id && row.slot === 'avatar'));
      assert.deepEqual(refs.map(row => row.resource_id).sort(), [1, 2].map(index => migrationUserId(appId, `synthetic-avatar-user-${index}`)).sort());
      const archive = (await database.pool.query("SELECT source_id,document_json FROM migration_sources WHERE collection='userInfo'")).rows;
      for (const doc of source.collections.userInfo as Document[]) assert.equal(archive.find(row => row.source_id === doc._id).document_json, serializeSource(doc));
      assert.deepEqual(await importSnapshot(database.pool, source, appId), receipt);
      assert.equal((await database.pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='users' AND column_name='avatar_url'")).rowCount, 0);
    } finally { await database.close(); }
  }
});

test('avatar import rejects unknown source without writes and rolls back all facts if a reference write fails', pgOptions, async () => {
  const database = await createTestDatabase();
  try {
    const invalid = fixture(); (invalid.collections.userInfo![0] as Document).avatarUrl = 'https://private.example/custom';
    await assert.rejects(importSnapshot(database.pool, invalid, appId), error => error instanceof ImportAuditError);
    await database.pool.query(`CREATE FUNCTION synthetic_reject_avatar() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic avatar reference failure'; END; $$;
      CREATE TRIGGER synthetic_reject_avatar BEFORE INSERT ON file_references FOR EACH ROW EXECUTE FUNCTION synthetic_reject_avatar()`);
    await assert.rejects(importSnapshot(database.pool, fixture(), appId), /synthetic avatar reference failure/);
    for (const table of ['users', 'files', 'file_references', 'migration_batches', 'migration_sources', 'public_statistics']) {
      assert.equal((await database.pool.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count, 0, table);
    }
  } finally { await database.close(); }
});
