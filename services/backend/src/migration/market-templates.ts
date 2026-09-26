import { marketTemplateDataSchema, marketTemplateIdSchema, marketTemplateNameSchema } from '../admin/market-templates.ts';
import type { MarketTemplateData } from '../admin/market-templates.ts';
import { serializeSource } from './source.ts';
import type { IssueReporter } from './types.ts';
import { object, parseExportTimestamp } from './values.ts';

export type MarketTemplateRow = {
  id: string; appId: string; name: string; data: MarketTemplateData; status: 'active' | 'deleted';
  createdByAdminId: string | null; updatedByAdminId: string | null; createdAt: string | null; updatedAt: string | null;
};
type Context = { appId: string; adminOwners: readonly { accountId: string; ownerKey: string }[] };
const rowFields = new Set(['_id', 'name', 'data', 'status', 'ownerKey', 'createdBy', 'updatedBy', 'createdAtMs', 'updatedAtMs', '_openid']);
const textFields = ['title', 'category', 'condition', 'region', 'regionState', 'regionCounty', 'regionArea', 'Apartment',
  'regionDisplay', 'buildingName', 'sellerName', 'sellerWechat', 'sellerPhone', 'sellerNote', 'pickupStartDate', 'pickupEndDate',
  'availableStartDate', 'leaseEndDate', 'deposit', 'roomType', 'housingType', 'genderPreference', 'roommateCount'];
const pictureFields = ['imageFileID', 'imageFileIDs', 'thumbFileID', 'thumbFileIDs'];
const dataFields = new Set([...textFields, ...pictureFields, 'desc', 'listingType', 'price', 'furnished', 'utilitiesIncluded', 'location']);
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160 &&
  value.trim() === value && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);
const adminId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{2,63}$/.test(value);
const ownerKey = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

function cents(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number' || typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match || String(value).length > 32) return null;
  const amount = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  return amount <= 10_000_000_000n ? Number(amount) : null;
}

/** Audited legacy template drafts, not published listings. Preserve the text
 * _id exactly, including pre-website IDs: no fake UUID/owner ACL is introduced.
 * Payload aliases become the canonical listing draft fields, then pass the
 * same runtime template schema. Missing title/dates remain absent; prices never
 * round. Images were excluded by templateView and remain source archives only.
 * The caller archives every original row and rejects its whole plan on errors. */
export function normalizeMarketTemplates(documents: unknown, context: Context, issue: IssueReporter): MarketTemplateRow[] {
  let failed = false;
  const report = (code: string, field = 'content', severity: 'error' | 'notice' = 'error') => {
    if (severity === 'error') failed = true;
    issue('other', code, `MarketAdminTemplates.${field}`, severity);
  };
  if (!Array.isArray(documents)) { report('INVALID_MARKET_TEMPLATES_COLLECTION'); return []; }
  if (!context || !identity(context.appId) || !Array.isArray(context.adminOwners)) { report('INVALID_MARKET_TEMPLATES_CONTEXT'); return []; }
  const admins = new Map<string, string>();
  for (const admin of context.adminOwners) {
    if (!object(admin) || !adminId(admin.accountId) || !ownerKey(admin.ownerKey) || admins.has(admin.accountId)) report('INVALID_MARKET_TEMPLATE_ADMIN_MAPPING', 'actor');
    else admins.set(admin.accountId, admin.ownerKey);
  }
  const rows: MarketTemplateRow[] = [], ids = new Set<string>();
  const actor = (value: unknown): string | null => {
    if (value === undefined || value === null) { report('UNKNOWN_MARKET_TEMPLATE_ACTOR', 'actor', 'notice'); return null; }
    if (!identity(value)) { report('INVALID_MARKET_TEMPLATE_ACTOR', 'actor'); return null; }
    if (!admins.has(value)) { report('UNKNOWN_MARKET_TEMPLATE_ACTOR', 'actor', 'notice'); return null; }
    return value;
  };
  const stamp = (value: unknown): string | null => {
    if (value === undefined || value === null) { report('UNKNOWN_MARKET_TEMPLATE_TIMESTAMP', 'timestamps', 'notice'); return null; }
    const result = typeof value === 'number' ? parseExportTimestamp(value) : null;
    if (!result) report('INVALID_MARKET_TEMPLATE_TIMESTAMP', 'timestamps');
    return result;
  };
  for (const raw of documents) {
    try { serializeSource(raw); } catch { report('INVALID_SOURCE_JSON'); continue; }
    if (!object(raw) || !object(raw.data)) { report('INVALID_MARKET_TEMPLATE_DOCUMENT'); continue; }
    for (const field of Object.keys(raw)) if (!rowFields.has(field)) report('UNMAPPED_MARKET_TEMPLATE_FIELD');
    if (!marketTemplateIdSchema.safeParse(raw._id).success || ids.has(raw._id as string)) { report('INVALID_MARKET_TEMPLATE_ID', 'id'); continue; }
    ids.add(raw._id as string);
    const name = marketTemplateNameSchema.safeParse(raw.name);
    if (!name.success || name.data !== raw.name) report('INVALID_MARKET_TEMPLATE_NAME', 'name');
    if (raw.status !== 'active' && raw.status !== 'deleted') report('INVALID_MARKET_TEMPLATE_STATUS', 'status');
    const createdByAdminId = actor(raw.createdBy), updatedByAdminId = actor(raw.updatedBy);
    const createdAt = stamp(raw.createdAtMs), updatedAt = stamp(raw.updatedAtMs);
    if (createdAt && updatedAt && updatedAt < createdAt) report('INVALID_MARKET_TEMPLATE_TIMESTAMP_ORDER', 'timestamps');
    if (raw.ownerKey !== undefined) {
      if (!ownerKey(raw.ownerKey) || createdByAdminId && admins.get(createdByAdminId) !== raw.ownerKey) report('INVALID_MARKET_TEMPLATE_CREATOR', 'actor');
      else report('MARKET_TEMPLATE_CREATOR_OWNER_ARCHIVED', 'actor', 'notice');
    }
    if (raw._openid !== undefined) {
      if (!identity(raw._openid)) report('INVALID_MARKET_TEMPLATE_LEGACY_IDENTITY', 'actor');
      else report('MARKET_TEMPLATE_LEGACY_IDENTITY_ARCHIVED', 'actor', 'notice');
    }

    const source = raw.data;
    for (const field of Object.keys(source)) if (!dataFields.has(field)) report('UNMAPPED_MARKET_TEMPLATE_DATA');
    const string = (field: string, maximum = 240) => {
      const value = source[field];
      if (value === undefined) return '';
      if (typeof value !== 'string' || value.length > maximum || value.trim() !== value || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(value)) {
        report('INVALID_MARKET_TEMPLATE_TEXT'); return '';
      }
      return value;
    };
    const data: Record<string, unknown> = {
      listingType: source.listingType ?? 'goods', priceCents: source.price === undefined ? 0 : cents(source.price),
      region: { state: string('regionState'), county: string('regionCounty'), area: string('regionArea') },
      sellerContact: { name: string('sellerName'), wechat: string('sellerWechat'), phone: string('sellerPhone'),
        avatar: '', note: string('sellerNote', 2000) },
    };
    if (source.price !== undefined && typeof source.price !== 'number') report('INVALID_MARKET_TEMPLATE_PRICE');
    if (source.price === undefined) report('MARKET_TEMPLATE_DEFAULT_PRICE_PRESERVED', 'price', 'notice');
    for (const [field, target, maximum] of [['title', 'title', 240], ['desc', 'description', 10000], ['category', 'category', 240],
      ['condition', 'condition', 240]] as const) {
      const value = string(field, maximum);
      if (value !== '' || target === 'description' || target === 'condition') data[target] = value;
    }
    const region = data.region as { state: string; county: string; area: string };
    region.state = ({ '新泽西': 'NJ', 'NEW JERSEY': 'NJ', '纽约': 'NY', 'NEW YORK': 'NY' } as Record<string, string>)[region.state.toUpperCase()] ?? region.state.toUpperCase();
    const expectedRegion = [region.state, region.county, region.area].join(' / ');
    for (const field of ['region', 'regionDisplay']) if (string(field) && string(field) !== expectedRegion) report('CONFLICTING_MARKET_TEMPLATE_ALIASES', 'region');
    const buildingName = string('buildingName') || string('Apartment');
    if (string('buildingName') && string('Apartment') && string('buildingName') !== string('Apartment')) report('CONFLICTING_MARKET_TEMPLATE_ALIASES', 'buildingName');
    data.buildingName = buildingName;
    for (const [target, first, second] of [['startDate', 'pickupStartDate', 'availableStartDate'], ['endDate', 'pickupEndDate', 'leaseEndDate']] as const) {
      const primary = string(first), alias = string(second);
      if (primary && alias && primary !== alias || alias && data.listingType !== 'sublet') report('CONFLICTING_MARKET_TEMPLATE_ALIASES', 'dates');
      if (primary || alias) data[target] = primary || alias;
    }

    data.location = null;
    if (source.location !== undefined) {
      if (!object(source.location)) report('INVALID_MARKET_TEMPLATE_LOCATION');
      else {
        const location = source.location;
        const allowed = new Set(['latitude', 'longitude', 'name', 'address', 'displayName', 'cityKey', 'cityLabel', 'regionState', 'regionArea', 'regionKey', 'areaLabel', 'buildingName']);
        for (const field of Object.keys(location)) if (!allowed.has(field)) report('UNMAPPED_MARKET_TEMPLATE_LOCATION');
        for (const field of allowed) {
          if (field === 'latitude' || field === 'longitude' || location[field] === undefined) continue;
          if (typeof location[field] !== 'string' || location[field].length > 240 || location[field] !== location[field].trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(location[field])) report('INVALID_MARKET_TEMPLATE_LOCATION');
        }
        const displayName = location.displayName || location.name || location.address || '';
        if (location.name && ![displayName, buildingName, location.address].includes(location.name)) report('UNMAPPED_MARKET_TEMPLATE_LOCATION_NAME');
        if (location.regionState && location.regionState !== region.state || location.regionArea && location.regionArea !== region.area ||
          location.areaLabel && location.areaLabel !== region.area || location.buildingName && location.buildingName !== buildingName) report('CONFLICTING_MARKET_TEMPLATE_ALIASES', 'location');
        if (Object.keys(location).some(field => !['latitude', 'longitude', 'name', 'displayName', 'address'].includes(field))) report('MARKET_TEMPLATE_LOCATION_METADATA_ARCHIVED', 'location', 'notice');
        data.location = { displayName, address: location.address ?? '', latitude: location.latitude ?? null, longitude: location.longitude ?? null };
      }
    }

    if (data.listingType === 'sublet') {
      const roomType = string('roomType');
      if (roomType && data.category && roomType !== data.category) report('CONFLICTING_MARKET_TEMPLATE_ALIASES', 'category');
      if (!data.category && roomType) data.category = roomType;
      let roommateCount: number | null = null;
      if (source.roommateCount !== undefined && source.roommateCount !== '') {
        if (typeof source.roommateCount === 'string' && /^\d+$/.test(source.roommateCount) && source.roommateCount.length <= 16) roommateCount = Number(source.roommateCount);
        else report('INVALID_MARKET_TEMPLATE_ROOMMATE_COUNT');
      }
      const deposit = source.deposit === undefined || source.deposit === '' ? null : cents(source.deposit);
      if (deposit === null && source.deposit !== undefined && source.deposit !== '') report('INVALID_MARKET_TEMPLATE_DEPOSIT');
      data.sublet = { housingType: string('housingType'), depositCents: deposit, furnished: source.furnished ?? false,
        utilitiesIncluded: source.utilitiesIncluded ?? false, genderPreference: string('genderPreference'), roommateCount };
    } else {
      for (const field of ['deposit', 'roomType', 'housingType', 'roommateCount', 'furnished', 'utilitiesIncluded', 'genderPreference']) {
        if (source[field] !== undefined && source[field] !== '' && source[field] !== false) {
          // blankDraft always supplies this hidden default, including on goods.
          if (field === 'genderPreference' && source[field] === '不限') report('MARKET_TEMPLATE_INACTIVE_DEFAULT_ARCHIVED', 'sublet', 'notice');
          else report('UNMAPPED_MARKET_TEMPLATE_SUBLET_FACT', 'sublet');
        }
      }
      data.sublet = null;
    }
    if (pictureFields.some(field => source[field] !== undefined)) report('MARKET_TEMPLATE_UNUSED_IMAGES_ARCHIVED', 'images', 'notice');
    const parsed = marketTemplateDataSchema.safeParse(data);
    if (!parsed.success) report('INVALID_MARKET_TEMPLATE_DATA');
    if (name.success && parsed.success) rows.push({ id: raw._id as string, appId: context.appId, name: name.data, data: parsed.data,
      status: raw.status as MarketTemplateRow['status'], createdByAdminId, updatedByAdminId, createdAt, updatedAt });
  }
  return failed ? [] : rows;
}
