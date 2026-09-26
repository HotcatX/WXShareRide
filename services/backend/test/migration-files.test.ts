import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { normalizeMarketFiles } from '../src/migration/files.ts';
import type { MarketListingRow } from '../src/migration/market.ts';
import type { MigrationIssue, UserRow } from '../src/migration/types.ts';

const createdAt = '2026-09-01T12:00:00.000Z';
const updatedAt = '2026-09-02T12:00:00.000Z';
const user: UserRow = { id: 'bfbf7e2b-a8b7-4d82-91bf-c03845325d1b', appId: 'files-test', openid: 'fixture-owner',
  name: 'Fixture', avatarUrl: '', profile: {}, createdAt, updatedAt };
const otherUser: UserRow = { ...user, id: '739858fb-cf75-4c19-8b99-16482ce877c2', openid: 'fixture-other' };
const admin = { accountId: 'fixture-admin', ownerKey: 'fixture-admin-owner' };
const context = { appId: 'files-test', users: [user, otherUser], adminOwners: [admin] };
const main = 'cloud://fixture/market/a.jpg';
const thumb = 'cloud://fixture/market_thumb/a.jpg';
const file = (locator = main, patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  _id: createHash('sha1').update(locator).digest('hex'), fileID: locator, _openid: user.openid,
  type: locator.includes('/market_thumb/') ? 'thumb' : 'image', folder: locator.includes('/market_thumb/') ? 'market_thumb' : 'market',
  status: 'attached', goodsId: 'listing_fixture', createdAtMs: Date.parse(createdAt), updatedAtMs: Date.parse(updatedAt),
  attachedAt: { $date: '2026-09-01T12:00:00.040Z' }, updatedAt: { $date: '2026-09-02T12:00:00.070Z' }, ...patch,
});
const listing = (patch: Partial<MarketListingRow> = {}): MarketListingRow => ({
  id: 'listing_fixture', appId: context.appId, ownerUserId: user.id, adminOwnerKey: null, sharedAdminManagement: false,
  listingType: 'goods', title: 'Desk', description: '', priceCents: 1250, category: '家具', condition: '',
  region: { state: 'NJ', county: 'Bergen', area: 'Fort Lee' }, buildingName: '', location: null,
  startDate: '2026-09-01', endDate: '2026-09-30', images: [{ fileId: main, thumbFileId: thumb }], sellerContact: null, sublet: null,
  status: 'online', expiresAt: '2026-09-30T23:59:59.999Z', version: 0, createdAt, updatedAt, ...patch,
} as MarketListingRow);
const webFile = (patch: Record<string, unknown> = {}) => {
  const value = file(`cloud://fixture/web-admin/${admin.accountId}/${'a'.repeat(32)}.jpg`, {
    ownerKey: admin.ownerKey, adminAccountId: admin.accountId, ...patch,
  });
  delete value._openid;
  return value;
};
function convert(documents: unknown = [file(), file(thumb)], listings: readonly MarketListingRow[] = [listing()], ctx = context) {
  const issues: Omit<MigrationIssue, 'count'>[] = [];
  const result = normalizeMarketFiles(documents, listings, ctx, (collection, code, field = '-', severity = 'error') => {
    issues.push({ collection, code, field, severity });
  });
  return { ...result, issues, errors: issues.filter(issue => issue.severity === 'error') };
}
function rejects(documents: unknown, listings: readonly MarketListingRow[] = [listing()], code?: string) {
  const result = convert(documents, listings);
  assert.ok(result.errors.length > 0);
  if (code) assert.ok(result.errors.some(issue => issue.code === code), `Expected controlled code ${code}`);
  assert.deepEqual(result.files, []); assert.deepEqual(result.references, []);
}

test('market slice preserves exact locators and ledger clocks, without fabricating binary verification', () => {
  const documents = [file(), file(thumb)], listings = [listing()];
  const before = JSON.stringify({ documents, listings });
  const result = convert(documents, listings);
  assert.deepEqual(result.errors, []); assert.equal(result.files.length, 2); assert.equal(result.references.length, 2);
  const row = result.files[0]!;
  assert.deepEqual(row, { id: row.id, appId: context.appId, provider: 'cloudbase', locator: main,
    ownerUserId: user.id, adminOwnerKey: null, legacyReadonly: true, status: 'ready',
    sizeBytes: null, mediaType: null, sha256: null, verifiedAt: null, createdAt, updatedAt });
  assert.deepEqual(result.references, [
    { appId: context.appId, resourceKind: 'listing', resourceId: 'listing_fixture', slot: 'image.0', fileId: row.id },
    { appId: context.appId, resourceKind: 'listing', resourceId: 'listing_fixture', slot: 'thumbnail.0', fileId: result.files[1]!.id },
  ]);
  assert.ok(result.issues.some(issue => issue.code === 'MARKET_FILE_DISTINCT_CLOCKS_PRESERVED' && issue.severity === 'notice'));
  assert.equal(JSON.stringify({ documents, listings }), before);
});

test('UUIDv8 identity is deterministic and namespaces the full app, provider and exact locator', () => {
  const first = convert().files[0]!.id;
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const bytes = createHash('sha256').update('linkx-file-v1\0').update(JSON.stringify([context.appId, 'cloudbase', main])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  assert.equal(first.replaceAll('-', ''), bytes.toString('hex'));
  assert.equal(convert().files[0]!.id, first);
  assert.notEqual(convert([file(main.replace('a.jpg', 'b.jpg'))], []).files[0]!.id, first);
  assert.notEqual(convert([file(main.replace('fixture/', 'other-env/'))], []).files[0]!.id, first);
  const app = 'second-app';
  const second = convert([file()], [], { ...context, appId: app, users: context.users.map(u => ({ ...u, appId: app })) });
  assert.deepEqual(second.errors, []); assert.notEqual(second.files[0]!.id, first);
});

test('ordered image slots are the only reference source, including shared files and old final-attachment indexes', () => {
  const second = 'cloud://fixture/market/b.jpg';
  const documents = [file(main, { goodsId: 'last_listing' }), file(second), file(thumb)];
  const result = convert(documents, [listing({ images: [{ fileId: second }, { fileId: main, thumbFileId: thumb }] }),
    listing({ id: 'second_listing', images: [{ fileId: main }] })]);
  assert.deepEqual(result.errors, []); assert.equal(result.files.length, 3); assert.equal(result.references.length, 4);
  assert.deepEqual(result.references.map(ref => ref.slot), ['image.0', 'image.1', 'thumbnail.1', 'image.0']);
  assert.equal(result.references[1]!.fileId, result.references[3]!.fileId);
  assert.ok(result.references.every(ref => ref.resourceId !== 'last_listing'));
  assert.ok(result.issues.some(issue => issue.code === 'MARKET_FILE_REFERENCE_DIFFERS_FROM_LAST_INDEX'));
});

test('deletion intent never proves deletion and referenced files remain protected', () => {
  for (const status of ['deleted', 'removed', 'cleanup']) {
    const result = convert([file(main, { status, deletedGoodsId: 'old_listing', deletedAt: { $date: '2026-09-02T12:00:00.030Z' } }), file(thumb)]);
    assert.deepEqual(result.errors, []); assert.equal(result.files[0]!.status, 'ready'); assert.equal(result.files[0]!.verifiedAt, null);
    assert.ok(result.issues.some(issue => issue.code === 'MARKET_FILE_DELETION_INTENT_UNVERIFIED'));
    assert.ok(result.issues.some(issue => issue.code === 'MARKET_FILE_REFERENCED_DELETION_INTENT_PROTECTED'));
  }
  const unreferenced = convert([file(main, { status: 'deleted' })], []);
  assert.deepEqual(unreferenced.errors, []); assert.equal(unreferenced.files[0]!.status, 'ready');
});

test('pending stays pending; references cannot silently promote it and unknown statuses block', () => {
  const pending = file(main, { status: 'pending' });
  delete pending.goodsId; delete pending.attachedAt; delete pending.updatedAt;
  const result = convert([pending], []);
  assert.deepEqual(result.errors, []); assert.equal(result.files[0]!.status, 'pending');
  rejects([pending, file(thumb)], [listing()], 'MARKET_FILE_PENDING_REFERENCED');
  for (const status of ['ready', 'cleaned', 'DELETED', '', null, false]) rejects([file(main, { status })], [], 'UNKNOWN_MARKET_FILE_STATUS');
});

test('missing ledger and original-thumbnail conflicts reject the entire slice', () => {
  rejects([file()], [listing()], 'MISSING_MARKET_FILE_LEDGER');
  rejects([file(), file(thumb)], [listing({ images: [{ fileId: thumb }] })], 'MARKET_FILE_REFERENCE_TYPE_MISMATCH');
  rejects([file(), file(thumb)], [listing({ images: [{ fileId: main, thumbFileId: main }] })], 'MARKET_FILE_REFERENCE_TYPE_MISMATCH');
  rejects([file(), file(thumb)], [listing({ images: [{ fileId: main }, { fileId: main }] })], 'INVALID_MARKET_FILE_LISTING_IMAGES');
});

test('legacy ownership is retained, but shared admin management does not authorize another user file', () => {
  const sameOwner = convert(undefined, [listing({ sharedAdminManagement: true })]);
  assert.deepEqual(sameOwner.errors, []); assert.ok(sameOwner.files.every(f => f.legacyReadonly));
  for (const sharedAdminManagement of [false, true]) {
    rejects([file(main, { _openid: otherUser.openid }), file(thumb)], [listing({ sharedAdminManagement })], 'MARKET_FILE_REFERENCE_OWNER_MISMATCH');
  }
  rejects([file(main, { _openid: 'unknown' })], [], 'UNKNOWN_MARKET_FILE_USER');
});

test('web files require the trusted account-owner mapping and exact authenticated path', () => {
  const source = webFile();
  const webListing = listing({ ownerUserId: null, adminOwnerKey: admin.ownerKey, images: [{ fileId: source.fileID as string }] });
  const result = convert([source], [webListing]);
  assert.deepEqual(result.errors, []); assert.equal(result.files[0]!.ownerUserId, null); assert.equal(result.files[0]!.adminOwnerKey, admin.ownerKey);
  for (const patch of [{ _openid: user.openid }, { ownerKey: 'other' }, { adminAccountId: 'unknown' }, { adminAccountId: null }]) {
    rejects([{ ...source, ...patch }], [], 'INVALID_MARKET_FILE_ADMIN_OWNER');
  }
  rejects([source], [listing({ images: [{ fileId: source.fileID as string }], sharedAdminManagement: true })], 'MARKET_FILE_REFERENCE_OWNER_MISMATCH');
  const secondAccount = { accountId: 'second-admin', ownerKey: admin.ownerKey };
  const sharedKey = convert([source], [webListing], { ...context, adminOwners: [admin, secondAccount] });
  assert.deepEqual(sharedKey.errors, [], 'multiple trusted accounts may share one owner key');
  const wrongPath = `cloud://fixture/web-admin/another/${'a'.repeat(32)}.jpg`;
  rejects([{ ...source, fileID: wrongPath, _id: createHash('sha1').update(wrongPath).digest('hex') }], [], 'INVALID_MARKET_FILE_PATH');
});

test('SHA1 source identity, purpose folders, type and bounded exact locators must agree', () => {
  rejects([file(main, { _id: '0'.repeat(40) })], [], 'MARKET_FILE_ID_MISMATCH');
  rejects([file(), file()], [], 'DUPLICATE_MARKET_FILE');
  for (const patch of [{ type: 'thumb' }, { folder: 'market_thumb' }, { type: 'video' }]) rejects([file(main, patch)], [], 'INVALID_MARKET_FILE_TYPE');
  for (const locator of ['cloud://fixture/community/a.jpg', 'cloud://fixture/market/../a.jpg', 'cloud://fixture/market//a.jpg',
    `cloud://fixture/web-admin/${admin.accountId}/${'a'.repeat(32)}.jpg`]) rejects([file(locator)], [], 'INVALID_MARKET_FILE_PATH');
  for (const locator of ['https://fixture/market/a.jpg', `${main}?token=x`, `${main} `,
    `cloud://fixture/market/${'界'.repeat(350)}.jpg`]) rejects([file(locator)], [], 'INVALID_MARKET_FILE_LOCATOR');
});

test('ledger milliseconds are mandatory and independent server clocks are validated and archived without tolerance guesses', () => {
  const missing = file(); delete missing.createdAtMs;
  rejects([missing], [], 'INVALID_MARKET_FILE_TIMESTAMP');
  for (const patch of [{ createdAtMs: createdAt }, { createdAtMs: 0 }, { createdAtMs: 1.5 }, { updatedAtMs: Date.parse(createdAt) - 1 },
    { updatedAt: { $date: '2026-02-30T00:00:00Z' } }, { attachedAt: '2026-09-01' },
    { attachedAt: { $date: '2026-09-03T00:00:00Z' } }, { deletedAt: { $date: '2026-09-03T00:00:00Z' } }]) rejects([file(main, patch)], []);
  const distinct = convert([file(main, { attachedAt: { $date: '2026-09-03T00:00:00Z' }, updatedAt: { $date: '2026-09-04T00:00:00Z' } })], []);
  assert.deepEqual(distinct.errors, []); assert.equal(distinct.files[0]!.createdAt, createdAt); assert.equal(distinct.files[0]!.updatedAt, updatedAt);
  assert.ok(distinct.issues.some(issue => issue.code === 'MARKET_FILE_DISTINCT_CLOCKS_PRESERVED'));
});

test('incomplete attachments, unknown facts and malformed metadata are not silently archived', () => {
  const source = file(); delete source.goodsId;
  rejects([source], [], 'INCOMPLETE_MARKET_FILE_ATTACHMENT');
  for (const patch of [{ goodsId: false }, { deletedGoodsId: '' }]) rejects([file(main, patch)], [], 'INVALID_MARKET_FILE_RESOURCE_INDEX');
  rejects([file(main, { size: 123 })], [], 'UNMAPPED_MARKET_FILE_FIELD');
  rejects([file(main, { uploadOwner: 'fixture' })], [], 'UNMAPPED_MARKET_FILE_FIELD');
});

test('invalid app, user, admin or listing context cannot create cross-app references', () => {
  for (const ctx of [{ ...context, appId: ' ' }, { ...context, users: [user, user] },
    { ...context, users: [{ ...user, appId: 'other' }] }, { ...context, adminOwners: [admin, admin] },
    { ...context, adminOwners: [{ ...admin, ownerKey: 'invalid key' }] }]) {
    const result = convert([file()], [], ctx); assert.ok(result.errors.length); assert.deepEqual(result.files, []);
  }
  for (const patch of [{ appId: 'other' }, { id: 'invalid id' }, { ownerUserId: otherUser.id },
    { adminOwnerKey: admin.ownerKey }, { ownerUserId: null }, { sharedAdminManagement: 'yes' }]) {
    rejects([file(), file(thumb)], [listing(patch as Partial<MarketListingRow>)]);
  }
  rejects([file(), file(thumb)], [listing(), listing()], 'INVALID_MARKET_FILE_LISTING');
});

test('unsafe source values are rejected without invoking accessors or emitting private values', () => {
  let called = false;
  const getter = { ...file() };
  Object.defineProperty(getter, 'private-content', { enumerable: true, get() { called = true; return 'sensitive-content'; } });
  const result = convert([getter]);
  assert.equal(called, false); assert.ok(result.errors.some(issue => issue.code === 'INVALID_SOURCE_JSON'));
  assert.equal(JSON.stringify(result.issues).includes('private-content'), false);
  assert.equal(JSON.stringify(result.issues).includes('sensitive-content'), false);
  rejects([file(main, { extra: undefined })], [], 'INVALID_SOURCE_JSON');
  rejects([file(main, { extra: Number.NaN })], [], 'INVALID_SOURCE_JSON');
  rejects(null, [], 'INVALID_MARKET_FILES_COLLECTION');
  const mixed = convert([file(), file(thumb), file('cloud://fixture/market/b.jpg', { type: 'video' })]);
  assert.ok(mixed.errors.length); assert.deepEqual(mixed.files, []); assert.deepEqual(mixed.references, [], 'no partial success on any error');
});
