import type { Document, IssueReporter } from './types.ts';
import { object, text, present, migrationReaders, parseExportTimestamp } from './values.ts';

/** Recognized source fields, including evidence retained only by the source archive. */
export const profileSourceFields = [
  'phone', 'regionPhone', 'region', 'wechatID', 'wechatId', 'wechat', 'bio',
  'carNumber', 'carPlate', 'plateNumber', 'carBrand', 'carModel',
  'zelleName', 'zelleAccount', 'defaultShowZelle', 'profileCompleted',
  'regionState', 'regionCounty', 'regionGroup', 'regionArea', 'regionKey', 'regionDisplay',
  'bigregion', 'cityKey', 'cityLabel', 'location', 'Apartment', 'address', 'buildingName',
  'pickupSpot', 'dropoffSpot', 'commonPickupAddresses', 'commonDropoffAddresses', 'commonComments', 'customPrice'
] as const;

const locationSourceFields = new Set([
  'displayName', 'name', 'address', 'lat', 'lng', 'latitude', 'longitude',
  'regionState', 'regionCounty', 'regionGroup', 'regionArea', 'regionKey', 'areaLabel',
  'cityKey', 'cityLabel', 'state', 'country', 'region', 'city', 'zip', 'buildingName',
  'source', 'provider', 'coordinateAccuracy', 'updatedAtMs'
]);

// A combined service area is not a claim that the user's individual state changed.
function normalizeRegionState(value: string): string {
  return ['NY/NJ', 'NY_NJ', '纽约/新泽西'].includes(value.trim().toUpperCase()) ? 'ny_nj' : value;
}
function compatibleRegionStates(a: string, b: string): boolean {
  if (a === b) return true;
  return (a === 'ny_nj' && ['NY', 'NJ'].includes(b)) || (b === 'ny_nj' && ['NY', 'NJ'].includes(a));
}

/** Preserve current profile meaning; archived source documents retain every losing/retired value. */
export function normalizeProfile(raw: Document, issue: IssueReporter): Document {
  const { alias, unknownFields } = migrationReaders(issue);
  const profile: Document = {};
  const invalid = (field: string) => issue('userInfo', 'INVALID_PROFILE_VALUE', field);
  const validText = (value: unknown, field: string, maximum: number): value is string => {
    if (typeof value === 'string' && value.length <= maximum) return true;
    if (value !== undefined && value !== null) invalid(field);
    return false;
  };
  const assignText = (target: Document, key: string, keys: string[], maximum: number) => {
    for (const source of keys) if (present(raw[source])) validText(raw[source], key, maximum);
    const value = alias(raw, keys, 'userInfo', key);
    if (typeof value === 'string' && value.length <= maximum) target[key] = value;
  };
  const preferredText = (
    values: unknown[], field: string, maximum: number, conflictCode?: string,
    normalize = (value: string) => value,
    compatible = (a: string, b: string) => a.trim() === b.trim()
  ): string | undefined => {
    const candidates = values.filter(value => validText(value, field, maximum) && text(value)).map(value => normalize(value as string));
    if (conflictCode && candidates.some(value => !compatible(value, candidates[0]!))) {
      issue('userInfo', conflictCode, field, 'notice');
    }
    return candidates[0];
  };
  assignText(profile, 'phone', ['phone'], 32);
  assignText(profile, 'wechatId', ['wechatID', 'wechatId', 'wechat'], 200);
  assignText(profile, 'bio', ['bio'], 1000);
  const phoneRegion = preferredText([raw.regionPhone, raw.region], 'phoneRegion', 8, 'PROFILE_PHONE_REGION_CONFLICT');
  if (phoneRegion !== undefined) profile.phoneRegion = phoneRegion;
  for (const [key, fields] of Object.entries({
    vehicle: { plate: ['carNumber', 'carPlate', 'plateNumber'], brand: ['carBrand'], model: ['carModel'] },
    zelle: { name: ['zelleName'], account: ['zelleAccount'] }
  })) {
    const value: Document = {};
    for (const [name, keys] of Object.entries(fields)) assignText(value, name, keys, 200);
    if (Object.keys(value).length) profile[key] = value;
  }
  if (raw.defaultShowZelle !== undefined) {
    if (typeof raw.defaultShowZelle !== 'boolean') invalid('zelle');
    else profile.zelle = { ...(object(profile.zelle) ? profile.zelle : {}), public: raw.defaultShowZelle };
  }
  if (raw.profileCompleted !== undefined) {
    if (typeof raw.profileCompleted !== 'boolean') invalid('profileCompleted');
    else profile.profileCompleted = raw.profileCompleted;
  }

  const sourceLocation = object(raw.location) ? raw.location : {};
  if (raw.location !== undefined && !object(raw.location)) invalid('location');
  unknownFields(sourceLocation, locationSourceFields, 'userInfo', 'location');
  const region: Document = {};
  const regionFields = {
    state: [raw.regionState, raw.cityKey, sourceLocation.regionState, sourceLocation.cityKey, sourceLocation.state],
    county: [raw.regionCounty, raw.regionGroup, sourceLocation.regionCounty, sourceLocation.regionGroup],
    area: [raw.regionArea, sourceLocation.regionArea, sourceLocation.areaLabel],
    key: [raw.regionKey, sourceLocation.regionKey]
  };
  for (const [key, values] of Object.entries(regionFields)) {
    const value = preferredText(values, `region.${key}`, 200, 'PROFILE_REGION_CONFLICT',
      key === 'state' ? normalizeRegionState : undefined,
      key === 'state' ? compatibleRegionStates : undefined);
    if (value !== undefined) region[key] = value;
  }
  // A full residence-region label and a city-only label are different display levels, not aliases.
  const regionLabel = preferredText([raw.regionDisplay, raw.bigregion, raw.cityLabel, sourceLocation.cityLabel], 'region.label', 200);
  if (regionLabel !== undefined) region.label = regionLabel;
  if (Object.keys(region).length) profile.region = region;

  const location: Document = {};
  const residence = preferredText([raw.Apartment, raw.address, raw.buildingName], 'location.residence', 300, 'PROFILE_RESIDENCE_CONFLICT');
  if (residence !== undefined) location.residence = residence;
  for (const source of ['displayName', 'name']) {
    if (present(sourceLocation[source])) validText(sourceLocation[source], 'location.label', 200);
  }
  const label = alias(sourceLocation, ['displayName', 'name'], 'userInfo', 'location.label');
  if (typeof label === 'string' && label.length <= 200) location.label = label;
  if (sourceLocation.address !== undefined && validText(sourceLocation.address, 'location.address', 300)) location.address = sourceLocation.address;
  for (const [key, names, maximum] of [['latitude', ['lat', 'latitude'], 90], ['longitude', ['lng', 'longitude'], 180]] as const) {
    const value = alias(sourceLocation, [...names], 'userInfo', `location.${key}`);
    // null coordinates mean unknown; never Number(null) or a fabricated 0,0 location.
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > maximum) invalid(`location.${key}`);
    else location[key] = value;
  }
  if (Object.keys(location).length) profile.location = location;
  // These fields have no current decision-making consumer. Validate and retain them in the source archive only.
  for (const key of ['country', 'region', 'city', 'zip', 'buildingName', 'source', 'provider', 'coordinateAccuracy']) {
    if (sourceLocation[key] !== undefined) validText(sourceLocation[key], 'location', 300);
  }
  if (sourceLocation.updatedAtMs !== undefined &&
    (typeof sourceLocation.updatedAtMs !== 'number' || !parseExportTimestamp(sourceLocation.updatedAtMs))) invalid('location.updatedAtMs');

  const preferences: Document = {};
  for (const [key, sources, maximum] of [
    ['pickupAddresses', ['pickupSpot', 'commonPickupAddresses'], 300],
    ['dropoffAddresses', ['dropoffSpot', 'commonDropoffAddresses'], 300],
    ['comments', ['commonComments'], 200]
  ] as const) {
    const valid = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 20 &&
      value.every(item => typeof item === 'string' && item.length <= maximum && (key === 'comments' || text(item)));
    for (const source of sources) if (raw[source] !== undefined && !valid(raw[source])) invalid(`preferences.${key}`);
    // Current arrays take precedence, including an intentionally emptied array. Never merge deleted choices back in.
    const value = alias(raw, [...sources], 'userInfo', `preferences.${key}`);
    if (valid(value)) preferences[key] = [...value];
  }
  if (raw.customPrice !== undefined) {
    if (!object(raw.customPrice)) invalid('preferences.routePrices');
    else {
      unknownFields(raw.customPrice, new Set(['fortLeeCore', 'fortLeeNonCore']), 'userInfo', 'preferences.routePrices');
      for (const key of ['fortLeeCore', 'fortLeeNonCore']) {
        if (raw.customPrice[key] !== undefined) validText(raw.customPrice[key], 'preferences.routePrices', 1000);
      }
      // The existing core-line default is fixed at 8; importing a retired override would change live behavior.
      if (text(raw.customPrice.fortLeeCore)) issue('userInfo', 'LEGACY_CORE_PRICE_ARCHIVED', 'preferences.routePrices', 'notice');
      if (typeof raw.customPrice.fortLeeNonCore === 'string' && text(raw.customPrice.fortLeeNonCore) && raw.customPrice.fortLeeNonCore.length <= 1000) {
        preferences.routePrices = { fortLeeNonCore: raw.customPrice.fortLeeNonCore };
      }
    }
  }
  if (Object.keys(preferences).length) profile.preferences = preferences;
  return profile;
}
