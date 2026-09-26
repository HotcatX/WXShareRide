import { marketListingContentSchema, marketListingStatusSchema } from '../market/schemas.ts';
import type { MarketListingContent } from '../market/schemas.ts';
import { serializeSource } from './source.ts';
import { indexMigrationUsers, object, parseExportTimestamp, present } from './values.ts';
import type { IssueReporter, UserRow } from './types.ts';

export type MarketListingRow = MarketListingContent & {
  id: string; appId: string; ownerUserId: string | null; adminOwnerKey: string | null;
  sharedAdminManagement: boolean; status: 'online' | 'offline' | 'sold'; expiresAt: string;
  version: number; createdAt: string; updatedAt: string | null;
};
type Context = {
  appId: string; users: readonly UserRow[];
  adminOwners: readonly { accountId: string; ownerKey: string }[];
};
const fields = new Set([
  '_id', '_openid', 'listingType', 'title', 'desc', 'price', 'category', 'condition',
  'regionState', 'regionCounty', 'regionArea', 'region', 'regionDisplay', 'Apartment', 'buildingName', 'location',
  'pickupStartDate', 'pickupEndDate', 'pickupRangeText', 'expireTime', 'expiresAtText',
  'availableStartDate', 'leaseEndDate', 'deposit', 'roomType', 'housingType', 'furnished',
  'utilitiesIncluded', 'genderPreference', 'roommateCount', 'imageFileID', 'imageFileIDs',
  'thumbFileID', 'thumbFileIDs', 'hasImage', 'sellerName', 'sellerWechat', 'sellerPhone', 'sellerAvatar', 'sellerNote',
  'status', 'createTime', 'updateTime', 'clientRequestId', 'viewCount', 'wantCount', 'lastViewAt', 'ok',
  'managedByAdmin', 'managedByOpenid', 'managedSource', 'managedByAccountId', 'managedByOwnerKey', 'ownerKey',
  'adminBatchId', 'adminExternalId', 'webAdminRequestHash', 'webAdminVersion',
  'webAdminLastUpdateHash', 'webAdminUpdatedBy', 'webAdminUpdatedAtMs',
]);
const subletFields = ['availableStartDate', 'leaseEndDate', 'deposit', 'roomType', 'housingType',
  'furnished', 'utilitiesIncluded', 'genderPreference', 'roommateCount'] as const;
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  value.length <= 160 && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Decimal dollars to cents without rounding an unsupported extra fraction. */
function cents(value: unknown, allowString: boolean): number | null {
  if (typeof value !== 'number' && !(allowString && typeof value === 'string')) return null;
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || Object.is(value, -0))) return null;
  const label = String(value);
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(label);
  if (!match || label.length > 32) return null;
  const amount = BigInt(match[1]!) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
  return amount <= 10_000_000_000n ? Number(amount) : null;
}

/**
 * Private candidates only. The caller must archive every original document and
 * reject the complete plan on ANY error; this is not a partial-import filter.
 * Never emit a document, identity, source field name or raw value in issues.
 */
export function normalizeMarketListings(documents: unknown, context: Context, issue: IssueReporter): MarketListingRow[] {
  const rows: MarketListingRow[] = [];
  const globalError = (code: string, field = 'market_goods') => issue('other', code, field);
  if (!Array.isArray(documents)) { globalError('INVALID_MARKET_COLLECTION'); return rows; }
  if (!context || !identity(context.appId) || !Array.isArray(context.users) || !Array.isArray(context.adminOwners)) {
    globalError('INVALID_MARKET_CONTEXT'); return rows;
  }
  let invalidContext = false;
  const users = indexMigrationUsers(context.users, context.appId, (collection, code, field, severity) => {
    invalidContext = true; issue(collection, code, field, severity);
  });
  const adminOwners = new Map<string, string>();
  for (const owner of context.adminOwners) {
    if (!object(owner) || !identity(owner.accountId) || !identity(owner.ownerKey) || adminOwners.has(owner.accountId)) {
      invalidContext = true; globalError('INVALID_MARKET_ADMIN_MAPPING', 'market_goods.owner');
    } else adminOwners.set(owner.accountId, owner.ownerKey);
  }
  if (invalidContext) return rows;
  const ids = new Set<string>();
  for (const raw of documents) {
    let valid = true;
    const error = (code: string, field = 'content') => { valid = false; issue('other', code, `market_goods.${field}`); };
    const notice = (code: string, field = 'content') => issue('other', code, `market_goods.${field}`, 'notice');
    try { serializeSource(raw); } catch { error('INVALID_SOURCE_JSON'); continue; }
    if (!object(raw)) { error('INVALID_MARKET_DOCUMENT'); continue; }
    for (const key of Object.keys(raw)) if (!fields.has(key)) error('UNMAPPED_MARKET_FIELD');
    if (typeof raw._id !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(raw._id)) { error('INVALID_MARKET_ID', 'id'); continue; }
    if (ids.has(raw._id)) { error('DUPLICATE_MARKET_ID', 'id'); continue; }
    ids.add(raw._id);

    let ownerUserId: string | null = null;
    let adminOwnerKey: string | null = null;
    let sharedAdminManagement = false;
    if (raw.managedByAdmin !== undefined && typeof raw.managedByAdmin !== 'boolean') error('INVALID_MARKET_OWNER', 'owner');
    if (raw.ownerKey !== undefined) {
      if (raw.managedByAdmin !== true || !identity(raw.ownerKey) || raw.managedByOwnerKey !== raw.ownerKey ||
        !identity(raw.managedByAccountId) || adminOwners.get(raw.managedByAccountId) !== raw.ownerKey ||
        raw._openid !== undefined || raw.managedByOpenid !== undefined) error('INVALID_MARKET_ADMIN_OWNER', 'owner');
      else adminOwnerKey = raw.ownerKey;
    } else {
      const owner = identity(raw._openid) ? users.get(raw._openid) : undefined;
      if (!owner) error('UNKNOWN_MARKET_USER', 'owner');
      else ownerUserId = owner.id;
      if (raw.managedByAccountId !== undefined || raw.managedByOwnerKey !== undefined) error('INVALID_MARKET_ADMIN_OWNER', 'owner');
      if (raw.managedByAdmin === true) {
        if (!owner || raw.managedByOpenid !== raw._openid) error('INVALID_MARKET_SHARED_ADMIN_OWNER', 'owner');
        else { sharedAdminManagement = true; notice('MARKET_SHARED_ADMIN_MANAGEMENT_PRESERVED', 'owner'); }
      } else if (raw.managedByOpenid !== undefined) error('INVALID_MARKET_OWNER', 'owner');
    }
    if ((ownerUserId === null) === (adminOwnerKey === null)) error('INVALID_MARKET_OWNER', 'owner');

    const string = (key: string, optional = false): string => {
      const value = raw[key];
      if (value === undefined && optional) return '';
      if (typeof value !== 'string') { error('INVALID_MARKET_TEXT', 'content'); return ''; }
      return value;
    };
    const checkAlias = (key: string, expected: unknown) => {
      if (raw[key] !== undefined && raw[key] !== expected) error('CONFLICTING_MARKET_ALIASES', 'aliases');
    };
    const title = string('title'), description = string('desc', true), category = string('category');
    const condition = string('condition', true);
    const region = { state: string('regionState'), county: string('regionCounty'), area: string('regionArea') };
    const buildingName = raw.buildingName === undefined ? string('Apartment', true) : string('buildingName');
    checkAlias('Apartment', buildingName);
    checkAlias('region', [region.state, region.county, region.area].join(' / '));
    checkAlias('regionDisplay', [region.state, region.county, region.area].join(' / '));
    const startDate = string('pickupStartDate'), endDate = string('pickupEndDate');
    checkAlias('pickupRangeText', `${startDate} 至 ${endDate}`);
    checkAlias('expiresAtText', endDate);
    const priceCents = cents(raw.price, false);
    if (priceCents === null) error('INVALID_MARKET_PRICE', 'priceCents');

    let location: unknown = null;
    if (raw.location !== undefined) {
      if (!object(raw.location)) error('INVALID_MARKET_LOCATION', 'location');
      else if (Object.keys(raw.location).length) {
        const source = raw.location;
        const known = new Set(['displayName', 'name', 'address', 'lat', 'lng']);
        for (const key of Object.keys(source)) if (!known.has(key)) error('UNMAPPED_MARKET_LOCATION', 'location');
        if (source.name !== undefined && source.name !== source.displayName) error('CONFLICTING_MARKET_ALIASES', 'location');
        location = { displayName: source.displayName, address: source.address, latitude: source.lat, longitude: source.lng };
      }
    }

    const fileList = (arrayKey: 'imageFileIDs' | 'thumbFileIDs', scalarKey: 'imageFileID' | 'thumbFileID'): unknown[] => {
      const array = raw[arrayKey];
      if (array !== undefined && !Array.isArray(array)) { error('INVALID_MARKET_IMAGES', 'images'); return []; }
      const list = array ?? (present(raw[scalarKey]) ? [raw[scalarKey]] : []);
      if (raw[scalarKey] !== undefined && raw[scalarKey] !== (list[0] ?? '')) error('CONFLICTING_MARKET_ALIASES', 'images');
      if (array === undefined && list.length) notice('MARKET_SINGLE_IMAGE_EXPANDED', 'images');
      return list;
    };
    const originals = fileList('imageFileIDs', 'imageFileID');
    const thumbnails = fileList('thumbFileIDs', 'thumbFileID');
    if (thumbnails.length && originals.length !== thumbnails.length) error('AMBIGUOUS_MARKET_IMAGE_PAIRING', 'images');
    checkAlias('hasImage', originals.length > 0);
    const images = originals.map((fileId, index) => ({ fileId, ...(thumbnails[index] !== undefined ? { thumbFileId: thumbnails[index] } : {}) }));

    const contact = { name: string('sellerName', true), wechat: string('sellerWechat', true),
      phone: string('sellerPhone', true), avatar: string('sellerAvatar', true), note: string('sellerNote', true) };
    const sellerContact = Object.values(contact).some(value => value !== '') ? contact : null;
    let sublet: unknown = null;
    if (raw.listingType === 'sublet') {
      checkAlias('availableStartDate', startDate); checkAlias('leaseEndDate', endDate); checkAlias('roomType', category);
      const depositCents = raw.deposit === undefined || raw.deposit === '' ? null : cents(raw.deposit, true);
      if (depositCents === null && raw.deposit !== undefined && raw.deposit !== '') error('INVALID_MARKET_DEPOSIT', 'sublet');
      let roommateCount: number | null = null;
      if (raw.roommateCount !== undefined && raw.roommateCount !== '') {
        if (typeof raw.roommateCount === 'number') roommateCount = raw.roommateCount;
        else if (typeof raw.roommateCount === 'string' && /^\d+$/.test(raw.roommateCount) && raw.roommateCount.length <= 16) roommateCount = Number(raw.roommateCount);
        else error('INVALID_MARKET_ROOMMATE_COUNT', 'sublet');
        if (!Number.isSafeInteger(roommateCount) || roommateCount! < 0) error('INVALID_MARKET_ROOMMATE_COUNT', 'sublet');
      }
      sublet = { housingType: string('housingType', true), depositCents, furnished: raw.furnished,
        utilitiesIncluded: raw.utilitiesIncluded, genderPreference: string('genderPreference', true), roommateCount };
    } else {
      // Goods producers emitted empty housing strings and false checkboxes.
      // A nonempty housing fact on goods cannot safely disappear into archive.
      for (const key of subletFields) {
        const empty = key === 'furnished' || key === 'utilitiesIncluded' ? raw[key] === false || raw[key] === undefined : raw[key] === '' || raw[key] === undefined;
        if (!empty) error('UNMAPPED_MARKET_SUBLET_FACT', 'sublet');
      }
    }

    const normalized = marketListingContentSchema.safeParse({ listingType: raw.listingType, title, description, priceCents,
      category, condition, region, buildingName, location, startDate, endDate, images, sellerContact, sublet });
    if (!normalized.success) error('INVALID_MARKET_CONTENT');
    const status = marketListingStatusSchema.safeParse({ status: raw.status });
    if (!status.success) error('INVALID_MARKET_STATUS', 'status');
    const expiresAt = parseExportTimestamp(raw.expireTime);
    if (!expiresAt) error('INVALID_MARKET_TIMESTAMP', 'expiresAt');
    else notice('MARKET_ORIGINAL_EXPIRY_PRESERVED', 'expiresAt');
    const createdAt = parseExportTimestamp(raw.createTime);
    if (!createdAt) error('INVALID_MARKET_TIMESTAMP', 'createdAt');
    const updatedAt = present(raw.updateTime) ? parseExportTimestamp(raw.updateTime) : null;
    if (!updatedAt) {
      if (present(raw.updateTime)) error('INVALID_MARKET_TIMESTAMP', 'updatedAt');
      else notice('UNKNOWN_MARKET_UPDATED_AT', 'updatedAt');
    }
    if (createdAt && updatedAt && updatedAt < createdAt) error('INVALID_MARKET_TIMESTAMP_ORDER', 'updatedAt');
    const version = raw.webAdminVersion === undefined ? 0 : raw.webAdminVersion;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) error('INVALID_MARKET_VERSION', 'version');
    else if (raw.webAdminVersion === undefined) notice('MARKET_INITIAL_VERSION_APPLIED', 'version');

    for (const key of ['clientRequestId', 'adminBatchId', 'adminExternalId', 'managedSource']) {
      if (raw[key] !== undefined && (typeof raw[key] !== 'string' || raw[key].length > 1000 || /[\u0000-\u001f\u007f-\u009f]/u.test(raw[key]))) error('INVALID_MARKET_METADATA', 'metadata');
    }
    if (raw.webAdminRequestHash !== undefined && !hash(raw.webAdminRequestHash)) error('INVALID_MARKET_METADATA', 'metadata');
    if (raw.ok !== undefined && raw.ok !== true) error('INVALID_MARKET_METADATA', 'metadata');
    if (raw.viewCount !== undefined && (typeof raw.viewCount !== 'number' || !Number.isSafeInteger(raw.viewCount) || raw.viewCount < 0)) error('INVALID_MARKET_VIEW_COUNT', 'views');
    if (raw.wantCount !== undefined && raw.wantCount !== 0) error('UNMAPPED_MARKET_INTEREST_COUNT', 'views');
    if (raw.lastViewAt !== undefined && !parseExportTimestamp(raw.lastViewAt)) error('INVALID_MARKET_TIMESTAMP', 'lastViewAt');
    const updateMetadata = ['webAdminLastUpdateHash', 'webAdminUpdatedBy', 'webAdminUpdatedAtMs'];
    if (updateMetadata.some(key => raw[key] !== undefined)) {
      const at = parseExportTimestamp(raw.webAdminUpdatedAtMs);
      const updaterOwner = typeof raw.webAdminUpdatedBy === 'string' ? adminOwners.get(raw.webAdminUpdatedBy) : undefined;
      const permitted = updaterOwner !== undefined && (adminOwnerKey !== null ? updaterOwner === adminOwnerKey : sharedAdminManagement);
      if (!hash(raw.webAdminLastUpdateHash) || !identity(raw.webAdminUpdatedBy) || !adminOwners.has(raw.webAdminUpdatedBy) || !at ||
        !permitted || typeof version !== 'number' || version < 1 || (createdAt && at < createdAt) || (updatedAt && at > updatedAt)) error('INVALID_MARKET_UPDATE_METADATA', 'metadata');
    }
    notice('MARKET_REDUNDANT_METADATA_ARCHIVED', 'metadata');
    if (valid && normalized.success && status.success && expiresAt && createdAt && typeof version === 'number') {
      rows.push({ ...normalized.data, id: raw._id, appId: context.appId, ownerUserId, adminOwnerKey, sharedAdminManagement,
        status: status.data.status, expiresAt, version, createdAt, updatedAt });
    }
  }
  return rows;
}
