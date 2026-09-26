import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMarketTemplates } from '../src/migration/market-templates.ts';
import { marketTemplateDataSchema } from '../src/admin/market-templates.ts';
import type { MigrationIssue } from '../src/migration/types.ts';

const admin = { accountId: 'fixture_admin', ownerKey: 'fixture_owner' };
const context = { appId: 'template-fixture', adminOwners: [admin] };
const at = Date.parse('2026-09-01T12:00:00Z');
const data = () => ({ listingType: 'goods', title: 'Desk', price: 12.5, desc: 'Description', category: '家具', condition: '99新',
  sellerName: 'Fixture contact', sellerWechat: 'fixture_wechat', sellerPhone: '', sellerNote: 'Contact note',
  regionState: 'NJ', regionCounty: 'Bergen', regionArea: 'Fort Lee', buildingName: 'Fixture building', Apartment: 'Fixture building',
  pickupStartDate: '2026-09-01', pickupEndDate: '2026-09-15',
  location: { name: 'Fixture building', displayName: 'Fixture street', address: 'Fixture street', latitude: 40, longitude: -74 },
  deposit: '', housingType: '', furnished: false, utilitiesIncluded: false, genderPreference: '不限', roommateCount: '' });
const source = (patch: Record<string, unknown> = {}) => ({ _id: 'web_tpl_' + 'a'.repeat(40), name: 'Fixture template', status: 'active', data: data(),
  ownerKey: admin.ownerKey, createdBy: admin.accountId, updatedBy: admin.accountId, createdAtMs: at, updatedAtMs: at + 100, ...patch });
function convert(documents: unknown = [source()], ctx = context) {
  const issues: Omit<MigrationIssue, 'count'>[] = [];
  const rows = normalizeMarketTemplates(documents, ctx, (collection, code, field = '-', severity = 'error') => issues.push({ collection, code, field, severity }));
  return { rows, issues, errors: issues.filter(item => item.severity === 'error') };
}
function rejects(documents: unknown, code: string) {
  const result = convert(documents);
  assert.deepEqual(result.rows, []); assert.ok(result.errors.some(item => item.code === code), code);
  assert.ok(!JSON.stringify(result.issues).includes('fixture_wechat'));
}

test('known empty complete collection stays empty; source IDs, independent times and canonical content are preserved', () => {
  assert.deepEqual(convert([]).rows, []); assert.deepEqual(convert([]).errors, []);
  const raw = source(), before = JSON.stringify(raw), result = convert([raw]);
  assert.deepEqual(result.errors, []); assert.equal(JSON.stringify(raw), before);
  const row = result.rows[0]!;
  assert.equal(row.id, raw._id); assert.equal(row.data.priceCents, 1250);
  assert.equal(row.createdAt, new Date(at).toISOString()); assert.equal(row.updatedAt, new Date(at + 100).toISOString());
  assert.equal(row.createdByAdminId, admin.accountId); assert.equal(row.updatedByAdminId, admin.accountId);
  assert.deepEqual(row.data.region, { state: 'NJ', county: 'Bergen', area: 'Fort Lee' });
  assert.deepEqual(row.data.location, { displayName: 'Fixture street', address: 'Fixture street', latitude: 40, longitude: -74 });
  assert.equal(row.data.sellerContact.avatar, ''); assert.equal(row.data.sellerContact.wechat, 'fixture_wechat');
  assert.equal('ownerKey' in row, false); assert.equal('images' in row.data, false);
  assert.equal(marketTemplateDataSchema.safeParse(row.data).success, true);
});

test('contact-only drafts do not invent title/dates; a zero default retains the old producer meaning', () => {
  const draft = { sellerName: 'Contact', sellerPhone: '2125550199', regionState: '新泽西', regionCounty: 'Bergen', regionArea: 'Fort Lee' };
  const result = convert([source({ data: draft })]);
  assert.deepEqual(result.errors, []);
  const row = result.rows[0]!;
  assert.equal(row.data.listingType, 'goods'); assert.equal(row.data.priceCents, 0);
  for (const field of ['title', 'startDate', 'endDate', 'category']) assert.equal(field in row.data, false);
  assert.equal(row.data.region.state, 'NJ');
  assert.ok(result.issues.some(item => item.code === 'MARKET_TEMPLATE_DEFAULT_PRICE_PRESERVED'));
});

test('sublet aliases become one canonical date/category and exact money representation', () => {
  const value = { ...data(), listingType: 'sublet', category: 'Studio', roomType: 'Studio', availableStartDate: '2026-09-01', leaseEndDate: '2026-09-15',
    deposit: '125.10', roommateCount: '2', housingType: '整租', furnished: true, utilitiesIncluded: false };
  const result = convert([source({ data: value })]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows[0]!.data.sublet, { depositCents: 12510, roommateCount: 2, housingType: '整租',
    furnished: true, utilitiesIncluded: false, genderPreference: '不限' });
  assert.equal(result.rows[0]!.data.startDate, value.availableStartDate);
  for (const patch of [{ deposit: '1.111' }, { roommateCount: '2.5' }, { roomType: '2B2B' }, { availableStartDate: '2026-09-02' }]) {
    assert.ok(convert([source({ data: { ...value, ...patch } })]).errors.length);
  }
});

test('soft-deleted source does not reactivate, and old unknown actor/time never creates access or fake dates', () => {
  const raw: Record<string, unknown> = source({ _id: 'tpl_prewebsite', status: 'deleted', _openid: 'historical-admin-openid',
    createdBy: 'removed_admin', updatedBy: 'another_removed_admin' });
  delete raw.createdAtMs; delete raw.updatedAtMs; delete raw.ownerKey;
  const result = convert([raw]);
  assert.deepEqual(result.errors, []); const row = result.rows[0]!;
  assert.equal(row.id, 'tpl_prewebsite'); assert.equal(row.status, 'deleted');
  assert.equal(row.createdByAdminId, null); assert.equal(row.updatedByAdminId, null);
  assert.equal(row.createdAt, null); assert.equal(row.updatedAt, null);
  assert.ok(!JSON.stringify(row).includes('historical-admin-openid'));
});

test('pictures excluded by the old template reader stay archive-only and never make references', () => {
  const result = convert([source({ data: { ...data(), imageFileID: 'cloud://fixture/old.jpg', imageFileIDs: ['cloud://fixture/old.jpg'],
    thumbFileID: 'cloud://fixture/thumb.jpg', thumbFileIDs: ['cloud://fixture/thumb.jpg'] } })]);
  assert.deepEqual(result.errors, []); assert.ok(!JSON.stringify(result.rows).includes('cloud://'));
  assert.ok(result.issues.some(item => item.code === 'MARKET_TEMPLATE_UNUSED_IMAGES_ARCHIVED'));
});

test('no silent currency rounding, contradictory aliases, missing contact/region, or invented source facts', () => {
  for (const patch of [{ price: 1.111 }, { price: '12.5' }, { price: -1 }, { regionState: 'unknown' }, { sellerName: '' },
    { sellerWechat: '', sellerPhone: '' }, { regionCounty: '' }, { pickupEndDate: '2026-02-30' },
    { pickupEndDate: '2026-08-31' }, { location: { latitude: 40 } }, { secret: 'unknown' }, { deposit: '4' }]) {
    assert.ok(convert([source({ data: { ...data(), ...patch } })]).errors.length);
  }
  rejects([source({ data: { ...data(), Apartment: 'Different building' } })], 'CONFLICTING_MARKET_TEMPLATE_ALIASES');
  rejects([source({ data: { ...data(), regionDisplay: 'Different area' } })], 'CONFLICTING_MARKET_TEMPLATE_ALIASES');
  rejects([source({ data: { ...data(), location: { name: 'unmapped distinctive name', address: 'Address', displayName: 'Other display' } } })], 'UNMAPPED_MARKET_TEMPLATE_LOCATION_NAME');
});

test('invalid or duplicate identities, ownership evidence, timestamps and unknown metadata reject the entire set', () => {
  rejects([source(), source()], 'INVALID_MARKET_TEMPLATE_ID');
  rejects([source({ _id: '../bad' })], 'INVALID_MARKET_TEMPLATE_ID');
  rejects([source({ secret: true })], 'UNMAPPED_MARKET_TEMPLATE_FIELD');
  rejects([source({ ownerKey: 'conflicting_owner' })], 'INVALID_MARKET_TEMPLATE_CREATOR');
  rejects([source({ updatedAtMs: at - 1 })], 'INVALID_MARKET_TEMPLATE_TIMESTAMP_ORDER');
  rejects([source({ status: 'inactive' })], 'INVALID_MARKET_TEMPLATE_STATUS');
  rejects([source({ createdAtMs: String(at) })], 'INVALID_MARKET_TEMPLATE_TIMESTAMP');
  rejects([source(), source({ _id: 'other', name: ' invalid ' })], 'INVALID_MARKET_TEMPLATE_NAME');
  assert.deepEqual(convert([], { ...context, adminOwners: [admin, admin] }).rows, []);
});

test('unsafe source data never invokes getters or writes raw values to issues', () => {
  let called = false;
  const raw = source(); Object.defineProperty(raw.data, 'extra', { enumerable: true, get() { called = true; return 'secret'; } });
  rejects([raw], 'INVALID_SOURCE_JSON'); assert.equal(called, false);
});
