import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { normalizeContentFiles } from '../src/migration/content-files.ts';
import { stableFileId, type FileRow, type FileReferenceRow } from '../src/migration/files.ts';
import type { AdFileReference } from '../src/migration/ads.ts';
import type { CommunityFileReference } from '../src/migration/community.ts';
import type { MigrationIssue } from '../src/migration/types.ts';

const appId = 'content-files-fixture';
const admin = { accountId: 'admin_fixture', ownerKey: 'owner_fixture' };
const context = { appId, adminOwners: [admin] };
const createdAt = '2026-09-01T12:00:00.000Z', updatedAt = '2026-09-02T12:00:00.000Z';
const webLocator = `cloud://fixture/web-admin/${admin.accountId}/${'a'.repeat(32)}.jpg`;
const communityLocator = `cloud://fixture/web-admin/${admin.accountId}/${'b'.repeat(32)}.jpg`;
const legacyLocator = 'cloud://fixture/old-community/image.png';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const uploadPair = (fileID = webLocator, patch: Record<string, unknown> = {}) => {
  const data = { accountId: admin.accountId, ownerKey: admin.ownerKey, purpose: 'market', contentHash: sha256(fileID),
    contentType: 'image/jpeg', size: 100, cloudPath: fileID.split('/').slice(3).join('/'), status: 'ready',
    createdAtMs: Date.parse(createdAt), updatedAtMs: Date.parse(updatedAt), fileID, ...patch };
  return [{ _id: 'file_' + sha256(String(data.fileID)), ...data },
    { _id: 'request_' + sha256(`${data.accountId}:${data.purpose}:${data.contentHash}`), ...data }];
};
const marketFile = (patch: Partial<FileRow> = {}): FileRow => ({ id: stableFileId(appId, webLocator), appId,
  provider: 'cloudbase', locator: webLocator, ownerUserId: null, adminOwnerKey: admin.ownerKey, uploadedByAdminId: admin.accountId,
  legacyReadonly: true, status: 'ready', sizeBytes: null, mediaType: null, sha256: null, verifiedAt: null,
  createdAt: '2026-09-03T12:00:00.000Z', updatedAt: '2026-09-04T12:00:00.000Z', ...patch });
const listingRef = (patch: Partial<FileReferenceRow> = {}): FileReferenceRow => ({ appId, resourceKind: 'listing',
  resourceId: 'listing_fixture', slot: 'image.0', fileId: stableFileId(appId, webLocator), ...patch });
const adRef = (patch: Partial<AdFileReference> = {}): AdFileReference => ({ appId, resourceKind: 'ad',
  resourceId: 'ad_fixture', slot: 'image', locator: legacyLocator, ...patch });
const communityRef = (patch: Partial<CommunityFileReference> = {}): CommunityFileReference => ({ appId,
  resourceKind: 'community', resourceId: 'main', slot: 'group', locator: communityLocator, ...patch });
type Input = Parameters<typeof normalizeContentFiles>[0];
const fixture = (patch: Partial<Input> = {}): Input => ({ market: { files: [marketFile()], references: [listingRef()] },
  adReferences: [adRef()], communityReferences: [communityRef()],
  uploads: [...uploadPair(), ...uploadPair(communityLocator, { purpose: 'community' })], ...patch });
function convert(input = fixture(), ctx = context) {
  const issues: Omit<MigrationIssue, 'count'>[] = [];
  const result = normalizeContentFiles(input, ctx, (collection, code, field = '-', severity = 'error') => {
    issues.push({ collection, code, field, severity });
  });
  return { ...result, issues, errors: issues.filter(item => item.severity === 'error') };
}
function rejects(input: Input, code: string, ctx = context) {
  const result = convert(input, ctx);
  assert.ok(result.errors.some(item => item.code === code), `Expected controlled code ${code}`);
  assert.deepEqual(result.files, []); assert.deepEqual(result.references, []);
  assert.ok(result.issues.every(item => !JSON.stringify(item).includes('cloud://') && !JSON.stringify(item).includes(admin.accountId)));
}

test('unifies three domains by exact locator without mutating input or promoting metadata to binary verification', () => {
  const input = fixture(), before = JSON.stringify(input), result = convert(input);
  assert.deepEqual(result.errors, []); assert.equal(result.files.length, 3); assert.equal(result.references.length, 3);
  assert.equal(JSON.stringify(input), before);
  assert.ok(result.files.every(file => file.legacyReadonly && file.verifiedAt === null && file.sizeBytes === null && file.mediaType === null && file.sha256 === null));
  assert.ok(result.files.every(file => file.id === stableFileId(appId, file.locator)));
  const market = result.files.find(file => file.locator === webLocator)!;
  assert.deepEqual(market, marketFile(), 'MarketFiles clocks remain independent of upload clocks');
  const community = result.files.find(file => file.locator === communityLocator)!;
  assert.equal(community.createdAt, createdAt); assert.equal(community.updatedAt, updatedAt);
  assert.equal(community.adminOwnerKey, admin.ownerKey); assert.equal(community.uploadedByAdminId, admin.accountId);
  const legacy = result.files.find(file => file.locator === legacyLocator)!;
  assert.equal(legacy.ownerUserId, null); assert.equal(legacy.adminOwnerKey, null); assert.equal(legacy.uploadedByAdminId, null);
  assert.equal(legacy.createdAt, null); assert.equal(legacy.updatedAt, null);
  assert.ok(result.issues.some(item => item.code === 'CONTENT_FILE_UNKNOWN_PROVENANCE'));
});

test('multiple resources and current/history slots retain one physical file without inventing ownership', () => {
  const result = convert(fixture({
    adReferences: [adRef(), adRef({ slot: 'thumbnail' }), adRef({ resourceId: 'second_ad' })],
    communityReferences: [communityRef({ locator: legacyLocator }),
      communityRef({ locator: legacyLocator, slot: 'history.1.before.group' }),
      communityRef({ locator: legacyLocator, slot: 'history.1.after.announcement' })],
  }));
  assert.deepEqual(result.errors, []); assert.equal(result.files.length, 3); assert.equal(result.references.length, 7);
  assert.equal(new Set(result.references.slice(1).map(ref => ref.fileId)).size, 1);
  assert.equal(result.files.find(file => file.locator === legacyLocator)!.adminOwnerKey, null);
});

test('all complete uploads survive even without current references, and shared owner keys are permitted', () => {
  const result = convert(fixture({ market: { files: [], references: [] }, adReferences: [], communityReferences: [] }),
    { ...context, adminOwners: [admin, { accountId: 'another_admin', ownerKey: admin.ownerKey }] });
  assert.deepEqual(result.errors, []); assert.equal(result.files.length, 2); assert.equal(result.references.length, 0);
  assert.ok(result.files.every(file => file.createdAt === createdAt && file.uploadedByAdminId === admin.accountId));
});

test('ready records need both transactionally identical SHA256 indices', () => {
  const pair = uploadPair();
  rejects(fixture({ uploads: [pair[0]] }), 'INCOMPLETE_WEB_UPLOAD_INDEX_PAIR');
  rejects(fixture({ uploads: [pair[1]] }), 'INCOMPLETE_WEB_UPLOAD_INDEX_PAIR');
  rejects(fixture({ uploads: [pair[0], { ...pair[1], size: 101 }] }), 'CONFLICTING_WEB_UPLOAD_INDEX_PAIR');
  rejects(fixture({ uploads: [pair[0], { ...pair[1], updatedAtMs: Date.parse(updatedAt) + 1 }] }), 'CONFLICTING_WEB_UPLOAD_INDEX_PAIR');
  rejects(fixture({ uploads: [...pair, pair[0]] }), 'INVALID_WEB_UPLOAD_INDEX');
  rejects(fixture({ uploads: [{ ...pair[0], _id: 'file_' + '0'.repeat(64) }, pair[1]] }), 'WEB_UPLOAD_INDEX_MISMATCH');
  rejects(fixture({ uploads: [pair[0], { ...pair[1], _id: 'request_' + '0'.repeat(64) }] }), 'WEB_UPLOAD_INDEX_MISMATCH');
});

test('upload reservations never become invented provider locators or silently omitted candidates', () => {
  const pair = uploadPair(), reservation: Record<string, unknown> = { ...pair[1], status: 'uploading' };
  delete reservation.fileID; delete reservation.updatedAtMs;
  rejects(fixture({ uploads: [reservation] }), 'UNRESOLVED_WEB_UPLOAD');
  for (const status of ['deleted', 'failed', 'READY', null]) {
    rejects(fixture({ uploads: uploadPair(webLocator, { status }) }), 'UNKNOWN_WEB_UPLOAD_STATUS');
  }
  rejects(fixture({ uploads: uploadPair(webLocator, { fileID: undefined }) }), 'INVALID_SOURCE_JSON');
});

test('trusted uploader mapping and market ownership cannot be overwritten by another upload ledger', () => {
  rejects(fixture({ uploads: uploadPair(webLocator, { ownerKey: 'unknown_owner' }) }), 'INVALID_WEB_UPLOAD_OWNER');
  rejects(fixture({ uploads: uploadPair(webLocator, { accountId: 'unknown_admin' }) }), 'INVALID_WEB_UPLOAD_OWNER');
  rejects(fixture({ market: { files: [marketFile({ ownerUserId: 'bfbf7e2b-a8b7-4d82-91bf-c03845325d1b', adminOwnerKey: null, uploadedByAdminId: null })], references: [listingRef()] } }), 'CONTENT_FILE_OWNER_CONFLICT');
  const other = { accountId: 'other_admin', ownerKey: admin.ownerKey };
  rejects(fixture({ market: { files: [marketFile({ uploadedByAdminId: other.accountId })], references: [listingRef()] } }),
    'CONTENT_FILE_OWNER_CONFLICT', { ...context, adminOwners: [admin, other] });
});

test('purpose and path are exact producer facts, not inferred from arbitrary IDs or filename extensions', () => {
  rejects(fixture({ uploads: uploadPair(webLocator, { purpose: 'advertising' }) }), 'INVALID_WEB_UPLOAD_PURPOSE');
  rejects(fixture({ uploads: uploadPair(webLocator, { purpose: 'community' }) }), 'CONTENT_FILE_PURPOSE_CONFLICT');
  rejects(fixture({ uploads: uploadPair(webLocator, { purpose: 'market_thumb' }) }), 'CONTENT_FILE_PURPOSE_CONFLICT');
  rejects(fixture({ uploads: uploadPair(webLocator, { cloudPath: `web-admin/other/${'a'.repeat(32)}.jpg` }) }), 'INVALID_WEB_UPLOAD_PATH');
  rejects(fixture({ uploads: uploadPair(webLocator, { cloudPath: `web-admin/${admin.accountId}/${'c'.repeat(32)}.jpg` }) }), 'INVALID_WEB_UPLOAD_LOCATOR');
  for (const fileID of [webLocator.replace('a'.repeat(32), 'x'.repeat(32)), webLocator.replace('/web-admin/', '/wrong/'), webLocator.replace('.jpg', '.jpeg')]) {
    rejects(fixture({ uploads: uploadPair(fileID) }), 'INVALID_WEB_UPLOAD_PATH');
  }
});

test('recorded media/hash/size metadata is strictly checked, but never used as verified content', () => {
  for (const patch of [{ contentType: 'application/octet-stream' }, { contentType: 'image/png' }, { size: 11 }, { size: 2097153 }, { size: 12.5 }, { size: '100' }]) {
    const result = convert(fixture({ uploads: uploadPair(webLocator, patch) }));
    assert.ok(result.errors.length); assert.deepEqual(result.files, []);
  }
  for (const contentHash of ['0'.repeat(63), 'G'.repeat(64), null]) {
    rejects(fixture({ uploads: uploadPair(webLocator, { contentHash }) }), 'INVALID_WEB_UPLOAD_HASH');
  }
  for (const [extension, contentType] of [['png', 'image/png'], ['webp', 'image/webp']] as const) {
    const loc = communityLocator.replace('.jpg', '.' + extension);
    const result = convert(fixture({ uploads: [...uploadPair(), ...uploadPair(loc, { purpose: 'community', contentType })], communityReferences: [communityRef({ locator: loc })] }));
    assert.deepEqual(result.errors, []); assert.equal(result.files.find(file => file.locator === loc)!.mediaType, null);
  }
});

test('unknown fields, malformed or reversed clocks block instead of defaulting to now', () => {
  rejects(fixture({ uploads: uploadPair(webLocator, { extra: true }) }), 'UNMAPPED_WEB_UPLOAD_FIELD');
  for (const patch of [{ createdAtMs: null }, { createdAtMs: String(Date.parse(createdAt)) }, { updatedAtMs: null },
    { updatedAtMs: Date.parse(createdAt) - 1 }, { createdAtMs: 0 }, { updatedAtMs: -1 }]) {
    rejects(fixture({ uploads: uploadPair(webLocator, patch) }), 'INVALID_WEB_UPLOAD_TIMESTAMP');
  }
});

test('duplicate slots reject the whole merge, including an identical repeated reference', () => {
  rejects(fixture({ adReferences: [adRef(), adRef()] }), 'DUPLICATE_CONTENT_FILE_SLOT');
  rejects(fixture({ communityReferences: [communityRef(), communityRef({ locator: legacyLocator })] }), 'DUPLICATE_CONTENT_FILE_SLOT');
  rejects(fixture({ market: { files: [marketFile()], references: [listingRef(), listingRef()] } }), 'DUPLICATE_CONTENT_FILE_SLOT');
});

test('cross-app files/references, malformed resource IDs and unsupported slots are blocked', () => {
  rejects(fixture({ market: { files: [marketFile({ appId: 'foreign-app' })], references: [] } }), 'INVALID_CONTENT_MARKET_FILE');
  rejects(fixture({ market: { files: [marketFile()], references: [listingRef({ appId: 'foreign-app' })] } }), 'INVALID_CONTENT_MARKET_REFERENCE');
  rejects(fixture({ adReferences: [adRef({ appId: 'foreign-app' })] }), 'INVALID_CONTENT_FILE_REFERENCE');
  rejects(fixture({ communityReferences: [communityRef({ appId: 'foreign-app' })] }), 'INVALID_CONTENT_FILE_REFERENCE');
  for (const slot of ['history.0.before.group', 'history.01.before.group', 'history.2147483648.before.group', 'history.1.future.group', 'arbitrary', 'x'.repeat(65)]) {
    rejects(fixture({ communityReferences: [communityRef({ slot })] }), 'INVALID_CONTENT_FILE_REFERENCE');
  }
  rejects(fixture({ adReferences: [adRef({ resourceId: '../outside' })] }), 'INVALID_CONTENT_FILE_REFERENCE');
  rejects(fixture({ adReferences: [adRef({ locator: 'https://example.invalid/image.png' })] }), 'INVALID_CONTENT_FILE_REFERENCE');
  rejects(fixture({ adReferences: [adRef({ locator: legacyLocator.replace('image.png', '../image.png') })] }), 'INVALID_CONTENT_FILE_REFERENCE');
});

test('pending market ledger rows stay pending, and content references cannot silently promote them', () => {
  const input = fixture({ market: { files: [marketFile({ status: 'pending' })], references: [] } });
  const result = convert(input);
  assert.deepEqual(result.errors, []); assert.equal(result.files.find(file => file.locator === webLocator)!.status, 'pending');
  rejects({ ...input, adReferences: [adRef({ locator: webLocator })] }, 'CONTENT_FILE_PENDING_REFERENCED');
});

test('reordering export documents does not change IDs, provenance or reference meaning', () => {
  const first = convert(); const input = fixture(); input.uploads = [...input.uploads as unknown[]].reverse();
  const second = convert(input);
  assert.deepEqual(second.errors, []);
  assert.deepEqual(second.files.sort((a, b) => a.id.localeCompare(b.id)), first.files.sort((a, b) => a.id.localeCompare(b.id)));
  assert.deepEqual(second.references, first.references);
});
