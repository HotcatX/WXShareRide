import assert from 'node:assert/strict';
import test from 'node:test';
import {
  marketDateOnlySchema, marketFileIdSchema, marketImagesSchema, marketListingContentSchema,
  marketListingPatchSchema, marketListingStatusSchema, marketLocationSchema, marketRegionSchema,
} from '../src/market/schemas.ts';

function goods() {
  return {
    listingType: 'goods' as const, title: 'Desk', description: 'First line\nSecond line',
    priceCents: 1250, category: '家具', condition: '99新',
    region: { state: 'NJ', county: 'Bergen', area: 'Fort Lee' }, buildingName: '',
    location: null, startDate: '2026-09-25', endDate: '2026-10-09', images: [],
    sellerContact: null, sublet: null,
  };
}
function sublet() {
  return {
    ...goods(), listingType: 'sublet' as const, category: 'Studio', condition: '转租',
    sublet: { housingType: '公寓', depositCents: null, furnished: false,
      utilitiesIncluded: false, genderPreference: '不限', roommateCount: null },
  };
}

test('one strict canonical DTO preserves goods, sublet and explicit unknowns', () => {
  assert.deepEqual(marketListingContentSchema.parse(goods()), goods());
  assert.deepEqual(marketListingContentSchema.parse(sublet()), sublet());
  for (const value of [{ ...goods(), sublet: sublet().sublet }, { ...sublet(), sublet: null },
    { ...sublet(), category: 'unrecognized room' }, { ...goods(), listingType: 'rent' }]) {
    assert.equal(marketListingContentSchema.safeParse(value).success, false);
  }
});

test('money is finite exact integer cents including the existing admin maximum', () => {
  for (const priceCents of [0, 29, 10_000_000_000]) assert.equal(marketListingContentSchema.safeParse({ ...goods(), priceCents }).success, true);
  for (const priceCents of [-1, 1.5, '100', NaN, Infinity, 10_000_000_001, Number.MAX_SAFE_INTEGER]) {
    assert.equal(marketListingContentSchema.safeParse({ ...goods(), priceCents }).success, false);
  }
  assert.equal(marketListingContentSchema.safeParse({ ...sublet(), sublet: { ...sublet().sublet, depositCents: 0, roommateCount: 0 } }).success, true);
  for (const invalid of [{ depositCents: -1 }, { depositCents: 1.5 }, { roommateCount: 1.5 }, { roommateCount: -1 }, { furnished: 'false' }]) {
    assert.equal(marketListingContentSchema.safeParse({ ...sublet(), sublet: { ...sublet().sublet, ...invalid } }).success, false);
  }
});

test('region supports every existing geographic code without accepting arbitrary state codes', () => {
  for (const state of ['NY', 'NJ', 'NY_NJ', 'CA', 'DC', 'HI', 'WV']) {
    assert.equal(marketRegionSchema.safeParse({ state, county: 'Editable county label', area: 'Editable area label' }).success, true);
  }
  for (const patch of [{ state: 'XX' }, { state: 'ny' }, { county: '' }, { area: ' '.repeat(4) }, { county: 'a'.repeat(241) }, { area: 'x\u0085y' }, { ownerId: 'owner' }]) {
    assert.equal(marketRegionSchema.safeParse({ ...goods().region, ...patch }).success, false);
  }
});

test('locations allow unknown coordinates but reject partial, nonfinite or aliased coordinates', () => {
  const location = { displayName: 'Meeting location', address: '', latitude: null, longitude: null };
  assert.equal(marketLocationSchema.safeParse(location).success, true);
  assert.equal(marketLocationSchema.safeParse({ ...location, latitude: 40, longitude: -74 }).success, true);
  for (const patch of [{ latitude: 40 }, { latitude: 91, longitude: -74 }, { latitude: 40, longitude: -181 },
    { latitude: NaN, longitude: 0 }, { latitude: Infinity, longitude: 0 }, { lat: 40 }, { cityKey: 'NY' }]) {
    assert.equal(marketLocationSchema.safeParse({ ...location, ...patch }).success, false);
  }
});

test('ordered images retain pairs and optional thumbnails without accepting duplicates or derived fields', () => {
  const images = [
    { fileId: 'cloud://fixture/market/b.jpg', thumbFileId: 'cloud://fixture/market_thumb/b.jpg' },
    { fileId: 'cloud://fixture/market/a.jpg' },
  ];
  assert.deepEqual(marketImagesSchema.parse(images), images);
  assert.equal(marketImagesSchema.safeParse([]).success, true);
  assert.equal(marketImagesSchema.safeParse(Array.from({ length: 6 }, (_, index) => ({ fileId: `cloud://fixture/market/${index}.jpg` }))).success, true);
  for (const invalid of [[images[0], images[0]], [...images, { fileId: 'cloud://fixture/market/c.jpg', thumbFileId: images[0].thumbFileId }],
    Array.from({ length: 7 }, (_, index) => ({ fileId: `cloud://fixture/market/${index}.jpg` })),
    [{ ...images[0], imageUrl: 'https://example.test/a.jpg' }], [{ thumbFileId: images[0].thumbFileId }]]) {
    assert.equal(marketImagesSchema.safeParse(invalid).success, false);
  }
  for (const fileId of ['https://example.test/image', 'cloud://fixture', 'cloud:///image', 'cloud://fixture/a b', 'cloud://fixture/a\u0000b', 'cloud://fixture/a#fragment']) {
    assert.equal(marketFileIdSchema.safeParse(fileId).success, false);
  }
});

test('contact content is independent of account ownership, bounded, and explicit', () => {
  const sellerContact = { name: 'Consignor', wechat: 'fixture-contact', phone: '', avatar: '', note: 'Contact details\nSecond line' };
  assert.deepEqual(marketListingContentSchema.parse({ ...goods(), sellerContact }).sellerContact, sellerContact);
  for (const avatar of ['https://example.test/avatar.png', 'cloud://fixture/avatar/a.png']) {
    assert.equal(marketListingContentSchema.safeParse({ ...goods(), sellerContact: { ...sellerContact, avatar } }).success, true);
  }
  for (const patch of [{ avatar: 'http://example.test/avatar.png' }, { avatar: 'javascript:alert(1)' },
    { avatar: 'https://name:password@example.test/a.png' }, { openid: 'arbitrary' }, { note: 'a'.repeat(2001) }]) {
    assert.equal(marketListingContentSchema.safeParse({ ...goods(), sellerContact: { ...sellerContact, ...patch } }).success, false);
  }
});

test('content rejects owners, status, timestamps, aliases and uncontrolled nested data', () => {
  for (const key of ['ownerId', '_openid', 'ownerKey', 'managedByAdmin', 'status', 'version', 'expiresAt', 'expireTime',
    'price', 'hasImage', 'imageFileID', 'roomType', 'pickupStartDate', 'payload']) {
    assert.equal(marketListingContentSchema.safeParse({ ...goods(), [key]: 'untrusted' }).success, false, key);
    assert.equal(marketListingPatchSchema.safeParse({ title: 'New title', [key]: 'untrusted' }).success, false, key);
  }
  assert.equal(marketListingContentSchema.safeParse({ ...sublet(), sublet: { ...sublet().sublet, arbitrary: {} } }).success, false);
});

test('date-only validation is strict and historical content is independent of wall-clock time', () => {
  for (const value of ['2024-02-29', '2026-09-25']) assert.equal(marketDateOnlySchema.safeParse(value).success, true);
  for (const value of ['2025-02-29', '2026-04-31', '2026-2-01', '2026-01-00', '2026-13-01', '0000-01-01', '2026-01-01T00:00:00Z']) {
    assert.equal(marketDateOnlySchema.safeParse(value).success, false, value);
  }
  assert.equal(marketListingContentSchema.safeParse({ ...goods(), startDate: '2020-01-01', endDate: '2020-01-02' }).success, true);
  assert.equal(marketListingContentSchema.safeParse({ ...goods(), startDate: '2026-10-02', endDate: '2026-10-01' }).success, false);
});

test('patches require meaningful fields and full validation after shallow merge', () => {
  for (const value of [{}, { title: undefined }, { region: { area: 'New area' } }, { sublet: { furnished: true } }]) {
    assert.equal(marketListingPatchSchema.safeParse(value).success, false);
  }
  const patch = marketListingPatchSchema.parse({ title: 'New title', images: [], sellerContact: null });
  const result = marketListingContentSchema.parse({ ...goods(), ...patch });
  assert.equal(result.title, 'New title');
  assert.equal(result.priceCents, goods().priceCents);
  const backwards = marketListingPatchSchema.parse({ endDate: '2026-09-01' });
  assert.equal(marketListingContentSchema.safeParse({ ...goods(), ...backwards }).success, false);
  assert.equal(marketListingContentSchema.safeParse({ ...goods(), ...marketListingPatchSchema.parse({ listingType: 'sublet' }) }).success, false);
});

test('only the separate status contract accepts existing lifecycle states', () => {
  for (const status of ['online', 'offline', 'sold']) assert.equal(marketListingStatusSchema.safeParse({ status }).success, true);
  for (const value of [{ status: 'deleted' }, { status: 'expired' }, { status: 'online', ownerId: 'owner' }]) {
    assert.equal(marketListingStatusSchema.safeParse(value).success, false);
  }
});
