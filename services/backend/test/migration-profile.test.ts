import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProfile, profileSourceFields } from '../src/migration/profile.ts';
import { migrationReaders } from '../src/migration/values.ts';
import type { Document, IssueReporter } from '../src/migration/types.ts';
import { profileSchema } from '../src/users/routes.ts';

function normalize(raw: Document) {
  const issues: { code: string; field: string; severity: string }[] = [];
  const issue: IssueReporter = (_collection, code, field = '-', severity = 'error') => issues.push({ code, field, severity });
  const profile = normalizeProfile(raw, issue);
  return { profile, issues, issue };
}

test('existing contact, vehicle, payment, and preference fields retain their canonical shape', () => {
  const result = normalize({
    phone: '+10000000000', regionPhone: '+1', wechatID: 'synthetic-handle', bio: 'Synthetic profile',
    carNumber: 'TEST', carBrand: 'Brand', carModel: 'Model',
    zelleName: 'Synthetic name', zelleAccount: 'synthetic@example.invalid', defaultShowZelle: false,
    profileCompleted: true, commonComments: ['No smoke'],
    location: { displayName: 'Synthetic place', name: 'Synthetic place', address: 'Synthetic map address', lat: 40, lng: -73 }
  });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.profile, {
    phone: '+10000000000', phoneRegion: '+1', wechatId: 'synthetic-handle', bio: 'Synthetic profile',
    vehicle: { plate: 'TEST', brand: 'Brand', model: 'Model' },
    zelle: { name: 'Synthetic name', account: 'synthetic@example.invalid', public: false }, profileCompleted: true,
    preferences: { comments: ['No smoke'] },
    location: { label: 'Synthetic place', address: 'Synthetic map address', latitude: 40, longitude: -73 }
  });
  assert.equal(profileSchema.safeParse(result.profile).success, true);
});

test('residence priority is explicit, map addresses stay distinct, and conflicting source remains untouched', () => {
  const source = {
    Apartment: 'Synthetic apartment', address: 'Synthetic former residence', buildingName: 'Synthetic former residence',
    updateTime: '2099-01-01T00:00:00Z',
    location: { address: 'Synthetic map address', buildingName: 'Synthetic former residence', updatedAtMs: 1_700_000_000_000 }
  };
  const before = structuredClone(source);
  const result = normalize(source);
  assert.deepEqual(result.profile, { location: { residence: 'Synthetic apartment', address: 'Synthetic map address' } });
  assert.deepEqual(result.issues, [{ code: 'PROFILE_RESIDENCE_CONFLICT', field: 'location.residence', severity: 'notice' }]);
  assert.deepEqual(source, before);
  assert.deepEqual(normalize({ Apartment: '', address: 'Synthetic address', buildingName: 'Synthetic building' }).profile,
    { location: { residence: 'Synthetic address' } });
  assert.deepEqual(normalize({ buildingName: 'Synthetic building' }).profile, { location: { residence: 'Synthetic building' } });
  assert.deepEqual(normalize({ Apartment: 'Same', address: 'Same', buildingName: 'Same' }).issues, []);
});

test('non-core default price text remains exact and the retired core default never becomes active', () => {
  const originalPrice = ' 13 per seat; 20 for an alternate pickup ';
  const result = normalize({ customPrice: { fortLeeCore: '99', fortLeeNonCore: originalPrice } });
  assert.deepEqual(result.profile, { preferences: { routePrices: { fortLeeNonCore: originalPrice } } });
  assert.deepEqual(result.issues, [{ code: 'LEGACY_CORE_PRICE_ARCHIVED', field: 'preferences.routePrices', severity: 'notice' }]);
  assert.deepEqual(profileSchema.parse(result.profile), result.profile);
  const empty = normalize({ customPrice: { fortLeeCore: '', fortLeeNonCore: '' } });
  assert.deepEqual(empty.profile, {});
  assert.deepEqual(empty.issues, []);
});

test('phone region uses the current field before the legacy region and reports real conflicts', () => {
  const result = normalize({ regionPhone: 'US', region: 'CN' });
  assert.deepEqual(result.profile, { phoneRegion: 'US' });
  assert.deepEqual(result.issues, [{ code: 'PROFILE_PHONE_REGION_CONFLICT', field: 'phoneRegion', severity: 'notice' }]);
  assert.deepEqual(normalize({ regionPhone: '', region: 'CN' }).profile, { phoneRegion: 'CN' });
  assert.deepEqual(normalize({ regionPhone: 'US', region: 'US' }).issues, []);
  assert.ok(normalize({ regionPhone: 'US', region: 1 }).issues.some(issue => issue.severity === 'error'));
});

test('nested-only region fields fill the canonical region while acquisition metadata stays archived', () => {
  const result = normalize({ location: {
    regionState: 'NY/NJ', regionCounty: 'Synthetic county', regionArea: 'Synthetic area', regionKey: 'synthetic-area', cityLabel: 'Synthetic city',
    country: 'US', region: 'Synthetic region', city: 'Synthetic city', zip: '',
    provider: 'synthetic-provider', source: 'manual', coordinateAccuracy: 'synthetic-accuracy', updatedAtMs: 1_700_000_000_000
  } });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.profile, { region: { state: 'ny_nj', county: 'Synthetic county', area: 'Synthetic area', key: 'synthetic-area', label: 'Synthetic city' } });
  assert.deepEqual(normalize({ cityKey: 'ny_nj', bigregion: 'Synthetic full region', cityLabel: 'Synthetic city' }).profile,
    { region: { state: 'ny_nj', label: 'Synthetic full region' } });
  assert.deepEqual(normalize({ location: { state: 'NJ', regionGroup: 'Synthetic group', areaLabel: 'Synthetic area' } }).profile,
    { region: { state: 'NJ', county: 'Synthetic group', area: 'Synthetic area' } });
});

test('equivalent region aliases and different granularity do not manufacture conflicts', () => {
  const result = normalize({
    regionState: 'NJ', cityKey: 'ny_nj', regionCounty: 'County', regionDisplay: 'Detailed region', bigregion: 'Broader region',
    location: { regionState: 'NY/NJ', cityKey: 'NY_NJ', regionGroup: 'County', cityLabel: 'City only' }
  });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.profile, { region: { state: 'NJ', county: 'County', label: 'Detailed region' } });
  assert.deepEqual(normalize({ regionState: 'NY/NJ', location: { regionState: 'ny_nj' } }).issues, []);
  const conflict = normalize({ regionState: 'NY', location: { regionState: 'NJ' } });
  assert.deepEqual(conflict.profile, { region: { state: 'NY' } });
  assert.deepEqual(conflict.issues, [{ code: 'PROFILE_REGION_CONFLICT', field: 'region.state', severity: 'notice' }]);
});

test('current saved spots map directly, legacy arrays fill absence, and deleted spots are not merged back', () => {
  const result = normalize({ pickupSpot: ['Synthetic pickup'], dropoffSpot: ['Synthetic dropoff'], commonComments: ['Comment'] });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.profile, { preferences: { pickupAddresses: ['Synthetic pickup'], dropoffAddresses: ['Synthetic dropoff'], comments: ['Comment'] } });
  assert.deepEqual(normalize({ commonPickupAddresses: ['Legacy pickup'], commonDropoffAddresses: ['Legacy dropoff'] }).profile,
    { preferences: { pickupAddresses: ['Legacy pickup'], dropoffAddresses: ['Legacy dropoff'] } });
  const conflict = normalize({ pickupSpot: [], commonPickupAddresses: ['Deleted pickup'] });
  assert.deepEqual(conflict.profile, { preferences: { pickupAddresses: [] } });
  assert.deepEqual(conflict.issues, [{ code: 'CONFLICTING_ALIASES', field: 'preferences.pickupAddresses', severity: 'error' }]);
  assert.deepEqual(normalize({ pickupSpot: ['Same'], commonPickupAddresses: ['Same'] }).issues, []);
});

test('null coordinates remain unknown, valid aliases preserve numbers, and disagreements block', () => {
  const unknown = normalize({ location: { name: 'Synthetic unknown place', lat: null, lng: null } });
  assert.deepEqual(unknown.issues, []);
  assert.deepEqual(unknown.profile, { location: { label: 'Synthetic unknown place' } });
  assert.deepEqual(normalize({ location: { lat: 0, latitude: 0, lng: 0, longitude: 0 } }).profile,
    { location: { latitude: 0, longitude: 0 } });
  const conflict = normalize({ location: { lat: 1, latitude: 2, lng: -181 } });
  assert.ok(conflict.issues.some(issue => issue.code === 'CONFLICTING_ALIASES'));
  assert.ok(conflict.issues.some(issue => issue.code === 'INVALID_PROFILE_VALUE' && issue.field === 'location.longitude'));
});

test('source validation remains strict without exposing raw fields or values in issues', () => {
  const result = normalize({
    customPrice: { fortLeeNonCore: { unexpected: 'Synthetic value' }, unexpectedPrivateKey: 'Synthetic value' },
    location: { unexpectedPrivateKey: 'Synthetic value', provider: {}, updatedAtMs: '2026-01-01T00:00:00Z' },
    pickupSpot: [7], dropoffSpot: [''], regionPhone: 7
  });
  assert.ok(result.issues.some(issue => issue.code === 'UNMAPPED_FIELD' && issue.field === 'location'));
  assert.ok(result.issues.some(issue => issue.code === 'UNMAPPED_FIELD' && issue.field === 'preferences.routePrices'));
  assert.equal(result.issues.filter(issue => issue.code === 'INVALID_PROFILE_VALUE').length, 6);
  assert.equal(JSON.stringify(result.issues).includes('Synthetic value'), false);
  assert.equal(JSON.stringify(result.issues).includes('unexpectedPrivateKey'), false);
  const check = normalize({});
  migrationReaders(check.issue).unknownFields({ customPrice: {}, Apartment: '', unknownPrivateKey: '' }, new Set(profileSourceFields), 'userInfo');
  assert.deepEqual(check.issues, [{ code: 'UNMAPPED_FIELD', field: '-', severity: 'error' }]);
});

test('new canonical fields are bounded, preserve raw labels, and reject retired aliases', () => {
  assert.equal(profileSchema.safeParse({ location: { residence: 'x'.repeat(300) }, preferences: { routePrices: { fortLeeNonCore: 'x'.repeat(1000) } } }).success, true);
  for (const profile of [
    { location: { residence: 'x'.repeat(301) } },
    { preferences: { routePrices: { fortLeeNonCore: 'x'.repeat(1001) } } },
    { preferences: { routePrices: { fortLeeCore: '8' } } },
    { customPrice: { fortLeeNonCore: '13' } },
    { Apartment: 'Synthetic apartment' },
    { location: { metadata: {} } }
  ]) assert.equal(profileSchema.safeParse(profile).success, false);
  const result = normalize({ Apartment: 'x'.repeat(301), customPrice: { fortLeeNonCore: 'x'.repeat(1001) } });
  assert.deepEqual(result.profile, {});
  assert.equal(result.issues.filter(issue => issue.severity === 'error').length, 2);
});
