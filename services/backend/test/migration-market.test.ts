import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMarketListings } from '../src/migration/market.ts';
import type { MigrationIssue, UserRow } from '../src/migration/types.ts';

const createdAt = '2026-09-01T12:00:00.000Z';
const updatedAt = '2026-09-02T12:00:00.000Z';
const user: UserRow = { id: 'bfbf7e2b-a8b7-4d82-91bf-c03845325d1b', appId: 'market-test', openid: 'fixture-owner',
  name: 'Fixture', avatarUrl: '', profile: {}, createdAt, updatedAt };
const context = { appId: 'market-test', users: [user], adminOwners: [{ accountId: 'fixture-admin', ownerKey: 'fixture-admin-owner' }] };
const fixture = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  _id: 'market_fixture', _openid: user.openid, listingType: 'goods', title: 'Desk', desc: 'Good condition\nPickup available',
  price: 12.5, category: '家具', condition: '99新', regionState: 'NJ', regionCounty: 'Bergen', regionArea: 'Fort Lee',
  region: 'NJ / Bergen / Fort Lee', regionDisplay: 'NJ / Bergen / Fort Lee', Apartment: 'Fixture building', buildingName: 'Fixture building',
  location: { displayName: 'Fixture place', name: 'Fixture place', address: 'Fixture address', lat: 40, lng: -74 },
  pickupStartDate: '2026-09-01', pickupEndDate: '2026-09-30', pickupRangeText: '2026-09-01 至 2026-09-30', expiresAtText: '2026-09-30',
  expireTime: Date.parse('2026-09-30T23:59:59.999Z'), imageFileID: 'cloud://fixture/market/a.jpg', imageFileIDs: ['cloud://fixture/market/a.jpg'],
  thumbFileID: 'cloud://fixture/market_thumb/a.jpg', thumbFileIDs: ['cloud://fixture/market_thumb/a.jpg'], hasImage: true,
  status: 'online', createTime: { $date: createdAt }, updateTime: { $date: updatedAt }, ok: true,
  clientRequestId: 'fixture-create', viewCount: 2, wantCount: 0, lastViewAt: { $date: updatedAt }, ...patch,
});
const adminFixture = () => {
  const value = fixture({ managedByAdmin: true, managedByAccountId: 'fixture-admin', managedByOwnerKey: 'fixture-admin-owner',
    ownerKey: 'fixture-admin-owner', managedSource: 'web_admin', webAdminVersion: 3, webAdminRequestHash: 'a'.repeat(64),
    adminBatchId: 'batch-fixture', adminExternalId: 'row-1', sellerName: 'Consignor', sellerWechat: 'fixture-contact' });
  delete value._openid;
  return value;
};
const subletFixture = (patch: Record<string, unknown> = {}) => fixture({ listingType: 'sublet', category: 'Studio', roomType: 'Studio',
  availableStartDate: '2026-09-01', leaseEndDate: '2026-09-30', housingType: '公寓', deposit: '', furnished: false,
  utilitiesIncluded: false, genderPreference: '不限', roommateCount: '', condition: '转租', ...patch });
function convert(documents: unknown, ctx = context) {
  const issues: Omit<MigrationIssue, 'count'>[] = [];
  const rows = normalizeMarketListings(documents, ctx, (collection, code, field = '-', severity = 'error') => issues.push({ collection, code, field, severity }));
  return { rows, issues, errors: issues.filter(issue => issue.severity === 'error') };
}

test('market conversion preserves original expiry and source identity, removes aliases, and never mutates source', () => {
  const source = fixture(), before = JSON.stringify(source);
  const { rows, errors, issues } = convert([source]);
  assert.deepEqual(errors, []);
  const row = rows[0]!;
  assert.equal(row.id, 'market_fixture'); assert.equal(row.ownerUserId, user.id);
  assert.equal(row.adminOwnerKey, null); assert.equal(row.sharedAdminManagement, false);
  assert.equal(row.priceCents, 1250); assert.equal(row.version, 0);
  assert.equal(row.expiresAt, '2026-09-30T23:59:59.999Z', 'do not silently extend to New York midnight');
  assert.equal(row.createdAt, createdAt); assert.equal(row.updatedAt, updatedAt);
  assert.deepEqual(row.location, { displayName: 'Fixture place', address: 'Fixture address', latitude: 40, longitude: -74 });
  assert.deepEqual(row.images, [{ fileId: 'cloud://fixture/market/a.jpg', thumbFileId: 'cloud://fixture/market_thumb/a.jpg' }]);
  assert.equal(row.sellerContact, null); assert.equal(row.sublet, null);
  for (const key of ['_openid', 'imageFileID', 'hasImage', 'Apartment', 'viewCount', 'clientRequestId', 'ok', 'expireTime']) assert.equal(key in row, false);
  assert.ok(issues.some(issue => issue.code === 'MARKET_INITIAL_VERSION_APPLIED' && issue.severity === 'notice'));
  assert.equal(JSON.stringify(source), before);
});

test('explicit admin ownership requires the trusted account mapping and never invents an OpenID', () => {
  const source = adminFixture();
  const result = convert([source]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0]!.ownerUserId, null); assert.equal(result.rows[0]!.adminOwnerKey, 'fixture-admin-owner');
  assert.equal(result.rows[0]!.sharedAdminManagement, false); assert.equal(result.rows[0]!.version, 3);
  assert.deepEqual(result.rows[0]!.sellerContact, { name: 'Consignor', wechat: 'fixture-contact', phone: '', avatar: '', note: '' });
  for (const patch of [{ _openid: user.openid }, { managedByOpenid: user.openid }, { managedByAdmin: false },
    { managedByAccountId: 'unknown' }, { managedByOwnerKey: 'different' }, { ownerKey: 'different' }]) {
    assert.equal(convert([{ ...source, ...patch }]).rows.length, 0);
  }
  assert.equal(convert([source], { ...context, adminOwners: [] }).rows.length, 0);
});

test('legacy admin-managed records preserve their real user owner and explicit shared policy', () => {
  const source = fixture({ managedByAdmin: true, managedByOpenid: user.openid, managedSource: 'old-import', sellerWechat: 'fixture-contact' });
  const result = convert([source]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0]!.ownerUserId, user.id); assert.equal(result.rows[0]!.adminOwnerKey, null);
  assert.equal(result.rows[0]!.sharedAdminManagement, true);
  for (const patch of [{ managedByOpenid: 'another-user' }, { managedByAccountId: 'fixture-admin' }, { managedByAdmin: 'true' }]) {
    assert.equal(convert([{ ...source, ...patch }]).rows.length, 0);
  }
  const missing = { ...source }; delete missing.managedByOpenid;
  assert.equal(convert([missing]).rows.length, 0);
  assert.equal(convert([fixture({ managedByOpenid: user.openid })]).rows.length, 0);
});

test('identity context rejects duplicate, unknown, malformed and cross-app identities', () => {
  for (const users of [[user, user], [{ ...user, id: 'invalid' }], [{ ...user, appId: 'other-app' }]]) {
    assert.equal(convert([fixture()], { ...context, users }).rows.length, 0);
  }
  for (const adminOwners of [[context.adminOwners[0]!, context.adminOwners[0]!], [{ accountId: '', ownerKey: 'owner' }]]) {
    assert.equal(convert([fixture()], { ...context, adminOwners }).rows.length, 0);
  }
  assert.equal(convert([fixture({ _openid: 'unknown' })]).rows.length, 0);
  assert.equal(convert([fixture()], { ...context, appId: ' ' }).rows.length, 0);
  assert.ok(convert([fixture(), fixture()]).errors.some(issue => issue.code === 'DUPLICATE_MARKET_ID'));
});

test('price and deposit conversion uses exact decimal cents without permissive coercion or rounding', () => {
  for (const [price, expected] of [[0, 0], [0.29, 29], [1.01, 101], [100_000_000, 10_000_000_000]]) {
    const result = convert([fixture({ price })]); assert.deepEqual(result.errors, []); assert.equal(result.rows[0]!.priceCents, expected);
  }
  for (const price of ['12', '', false, null, 0.001, -1, 100_000_001, 0.1 + 0.2]) {
    assert.equal(convert([fixture({ price })]).rows.length, 0);
  }
  for (const [deposit, expected] of [['', null], ['0', 0], ['123.45', 12345], [1.01, 101]] as const) {
    const result = convert([subletFixture({ deposit })]); assert.deepEqual(result.errors, []);
    assert.equal(result.rows[0]!.sublet!.depositCents, expected);
  }
  for (const deposit of ['1.005', '1e2', '1 USD', ' ', null, false, -1]) assert.equal(convert([subletFixture({ deposit })]).rows.length, 0);
});

test('housing is a single explicit extension with no duplicated room type or lease dates', () => {
  const result = convert([subletFixture({ roommateCount: '2' })]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows[0]!.sublet, { housingType: '公寓', depositCents: null, furnished: false,
    utilitiesIncluded: false, genderPreference: '不限', roommateCount: 2 });
  for (const patch of [{ availableStartDate: '2026-09-02' }, { leaseEndDate: '2026-10-01' }, { roomType: '1B1B' },
    { furnished: 'false' }, { roommateCount: '2 people' }, { roommateCount: 1.5 }, { roommateCount: '9007199254740992' }]) {
    assert.equal(convert([subletFixture(patch)]).rows.length, 0);
  }
  assert.deepEqual(convert([fixture({ housingType: '', furnished: false, utilitiesIncluded: false, deposit: '' })]).errors, []);
  for (const patch of [{ housingType: 'House' }, { furnished: true }, { deposit: 0 }]) assert.equal(convert([fixture(patch)]).rows.length, 0);
});

test('redundant display and location aliases must agree before being archived', () => {
  for (const patch of [{ Apartment: 'Other building' }, { region: 'Different region' }, { regionDisplay: 'Different region' },
    { pickupRangeText: 'Other dates' }, { expiresAtText: '2026-10-01' },
    { location: { displayName: 'A', name: 'B', address: '', lat: null, lng: null } },
    { location: { displayName: 'A', name: 'A', address: '', lat: 40, lng: null } },
    { location: { displayName: 'A', name: 'A', address: '', lat: null, lng: null, extra: {} } }]) {
    assert.equal(convert([fixture(patch)]).rows.length, 0);
  }
  assert.equal(convert([fixture({ location: {} })]).rows[0]!.location, null);
  const result = convert([fixture({ location: { displayName: 'A', name: 'A', address: '', lat: null, lng: null } })]);
  assert.deepEqual(result.errors, []); assert.equal(result.rows[0]!.location!.latitude, null);
});

test('ordered image pairs and first-image aliases cannot diverge or silently drop files', () => {
  const imageFileIDs = ['cloud://fixture/market/b.jpg', 'cloud://fixture/market/a.jpg'];
  const thumbFileIDs = ['cloud://fixture/market_thumb/b.jpg', 'cloud://fixture/market_thumb/a.jpg'];
  const source = fixture({ imageFileIDs, imageFileID: imageFileIDs[0], thumbFileIDs, thumbFileID: thumbFileIDs[0] });
  const result = convert([source]); assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows[0]!.images.map(image => image.fileId), imageFileIDs);
  for (const patch of [{ imageFileID: imageFileIDs[1] }, { thumbFileID: thumbFileIDs[1] }, { hasImage: false },
    { thumbFileIDs: [thumbFileIDs[0]] }, { imageFileIDs: [imageFileIDs[0], imageFileIDs[0]] },
    { imageFileIDs: 'not-array' }]) assert.equal(convert([{ ...source, ...patch }]).rows.length, 0);
  const noThumb = convert([{ ...source, thumbFileID: '', thumbFileIDs: [] }]);
  assert.deepEqual(noThumb.errors, []); assert.equal(noThumb.rows[0]!.images[0]!.thumbFileId, undefined);
  const single = fixture(); delete single.imageFileIDs; delete single.thumbFileIDs;
  assert.equal(convert([single]).rows[0]!.images.length, 1);
});

test('ordinary owners can retain their separately supplied contact without replacing identity', () => {
  const result = convert([fixture({ sellerName: 'Seller', sellerPhone: 'fixture-phone', sellerWechat: 'fixture-contact', sellerNote: 'Private note' })]);
  assert.deepEqual(result.errors, []); assert.equal(result.rows[0]!.ownerUserId, user.id);
  assert.equal(result.rows[0]!.sellerContact!.wechat, 'fixture-contact');
  assert.equal(result.rows[0]!.sharedAdminManagement, false);
  assert.equal(convert([fixture({ sellerPhone: 123 })]).rows.length, 0);
});

test('timestamps, version and statuses are preserved or rejected without invented history', () => {
  const missingUpdate = fixture(); delete missingUpdate.updateTime;
  const result = convert([missingUpdate]); assert.deepEqual(result.errors, []); assert.equal(result.rows[0]!.updatedAt, null);
  for (const status of ['online', 'offline', 'sold']) assert.equal(convert([fixture({ status })]).rows[0]!.status, status);
  for (const patch of [{ status: 'expired' }, { expireTime: 0 }, { createTime: '2026-09-01' }, { updateTime: 'not-a-date' },
    { updateTime: '2026-08-01T00:00:00Z' }, { webAdminVersion: -1 }, { webAdminVersion: '3' }, { webAdminVersion: 1.5 }]) {
    assert.equal(convert([fixture(patch)]).rows.length, 0);
  }
});

test('only validated nonbusiness metadata is archived; unresolved facts and unknown fields block', () => {
  for (const patch of [{ wantCount: 1 }, { viewCount: -1 }, { viewCount: 1.5 }, { buyerOpenid: 'fixture-buyer' },
    { futureBusinessField: true }, { clientRequestId: {} }, { ok: false }, { lastViewAt: 'bad' }, { webAdminRequestHash: 'bad' }]) {
    assert.equal(convert([fixture(patch)]).rows.length, 0);
  }
  const updated = { ...adminFixture(), webAdminUpdatedBy: 'fixture-admin', webAdminUpdatedAtMs: Date.parse(updatedAt), webAdminLastUpdateHash: 'b'.repeat(64) };
  assert.deepEqual(convert([updated]).errors, []);
  for (const patch of [{ webAdminUpdatedBy: 'unknown' }, { webAdminLastUpdateHash: 'bad' }, { webAdminUpdatedAtMs: Date.parse('2026-08-01T00:00:00Z') }]) {
    assert.equal(convert([{ ...updated, ...patch }]).rows.length, 0);
  }
});

test('issue output is controlled and malformed JSON cannot invoke accessors or leak private fields', () => {
  const result = convert([fixture({ 'private-dynamic-field-name': 'private-raw-value', _openid: 'private-unknown-owner' })]);
  assert.equal(result.rows.length, 0);
  assert.doesNotMatch(JSON.stringify(result.issues), /private-dynamic|private-raw|private-unknown/);
  for (const source of [null, [], 'not-a-document', fixture({ price: Infinity }), fixture({ value: undefined })]) {
    assert.equal(convert([source]).rows.length, 0);
  }
  let invoked = false;
  const source = fixture(); Object.defineProperty(source, 'trap', { enumerable: true, get() { invoked = true; return 'private'; } });
  assert.equal(convert([source]).rows.length, 0); assert.equal(invoked, false);
  assert.equal(convert({}).rows.length, 0);
});

test('admin update evidence must match the actual ownership policy, not only an existing account', () => {
  const ctx = { ...context, adminOwners: [...context.adminOwners,
    { accountId: 'same-owner-admin', ownerKey: 'fixture-admin-owner' },
    { accountId: 'different-owner-admin', ownerKey: 'different-owner' }] };
  const update = { webAdminVersion: 3, webAdminUpdatedAtMs: Date.parse(updatedAt), webAdminLastUpdateHash: 'b'.repeat(64) };
  const shared = fixture({ managedByAdmin: true, managedByOpenid: user.openid });
  for (const updater of ctx.adminOwners) {
    const metadata = { ...update, webAdminUpdatedBy: updater.accountId };
    const owned = convert([{ ...adminFixture(), ...metadata }], ctx);
    assert.equal(owned.errors.length === 0, updater.ownerKey === 'fixture-admin-owner');
    assert.equal(owned.rows.length, updater.ownerKey === 'fixture-admin-owner' ? 1 : 0);
    assert.equal(convert([{ ...fixture(), ...metadata }], ctx).rows.length, 0, 'ordinary listings are not admin-managed');
    assert.deepEqual(convert([{ ...shared, ...metadata }], ctx).errors, [], 'explicit legacy shared policy is preserved');
  }
});
