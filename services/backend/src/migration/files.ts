import { createHash } from 'node:crypto';
import { legacyCloudFileIdSchema, legacyMarketImagesSchema } from './market-images.ts';
import type { MarketListingRow } from './market.ts';
import { serializeSource } from './source.ts';
import type { IssueReporter, UserRow } from './types.ts';
import { indexMigrationUsers, object, parseExportTimestamp } from './values.ts';

export type FileRow = {
  id: string; appId: string; provider: 'cloudbase'; locator: string;
  ownerUserId: string | null; adminOwnerKey: string | null; uploadedByAdminId: string | null; legacyReadonly: true;
  status: 'pending' | 'ready'; sizeBytes: null; mediaType: null; sha256: null; verifiedAt: null;
  createdAt: string | null; updatedAt: string | null;
};
export type FileReferenceRow = {
  appId: string; resourceKind: 'listing' | 'ad' | 'community'; resourceId: string;
  slot: string; fileId: string;
};
type Context = {
  appId: string; users: readonly UserRow[];
  adminOwners: readonly { accountId: string; ownerKey: string }[];
};
type Ledger = { file: FileRow; type: 'image' | 'thumb'; goodsId: string | null; deletionIntent: boolean };
const fields = new Set(['_id', 'fileID', '_openid', 'ownerKey', 'adminAccountId', 'folder', 'type', 'status',
  'createdAtMs', 'updatedAtMs', 'goodsId', 'attachedAt', 'updatedAt', 'deletedGoodsId', 'deletedAt']);
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  value.length <= 160 && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const resourceId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value);
const ownerKey = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

export function stableFileId(appId: string, locator: string): string {
  // UUIDv8: file-only namespace and unambiguous components. The exact provider
  // locator is identity; never decode, trim, normalize or use only its basename.
  const bytes = createHash('sha256').update('linkx-file-v1\0').update(JSON.stringify([appId, 'cloudbase', locator])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * MarketFiles + already normalized market listing images only. This does not
 * establish complete ad/community references, binary existence, upload times or
 * upload ownership. The caller must archive the original ledger documents.
 * All legacy rows are read-only; their owner is historical evidence, not a grant
 * to attach them to new resources. Any error returns no candidates, and must
 * also reject the caller's complete import plan, never permit a partial import.
 */
export function normalizeMarketFiles(
  documents: unknown, listings: readonly MarketListingRow[], context: Context, issue: IssueReporter,
): { files: FileRow[]; references: FileReferenceRow[] } {
  let failed = false;
  const error = (code: string, field = 'content') => { failed = true; issue('other', code, `MarketFiles.${field}`); };
  const notice = (code: string, field = 'content') => issue('other', code, `MarketFiles.${field}`, 'notice');
  const empty = () => ({ files: [] as FileRow[], references: [] as FileReferenceRow[] });
  if (!Array.isArray(documents) || !Array.isArray(listings)) { error('INVALID_MARKET_FILES_COLLECTION'); return empty(); }
  if (!context || !identity(context.appId) || !Array.isArray(context.users) || !Array.isArray(context.adminOwners)) {
    error('INVALID_MARKET_FILES_CONTEXT'); return empty();
  }
  const users = indexMigrationUsers(context.users, context.appId, (collection, code, field, severity) => {
    failed = true; issue(collection, code, field, severity);
  });
  const userIds = new Set([...users.values()].map(user => user.id));
  const adminOwners = new Map<string, string>();
  for (const admin of context.adminOwners) {
    if (!object(admin) || !resourceId(admin.accountId) || !ownerKey(admin.ownerKey) || adminOwners.has(admin.accountId)) {
      error('INVALID_MARKET_FILES_ADMIN_MAPPING', 'owner');
    } else adminOwners.set(admin.accountId, admin.ownerKey);
  }
  if (failed) return empty();
  const adminKeys = new Set(adminOwners.values());

  const ledger = new Map<string, Ledger>();
  for (const raw of documents) {
    let valid = true;
    const invalid = (code: string, field = 'content') => { valid = false; error(code, field); };
    try { serializeSource(raw); } catch { invalid('INVALID_SOURCE_JSON'); continue; }
    if (!object(raw)) { invalid('INVALID_MARKET_FILE_DOCUMENT'); continue; }
    for (const key of Object.keys(raw)) if (!fields.has(key)) invalid('UNMAPPED_MARKET_FILE_FIELD');
    const parsedLocator = legacyCloudFileIdSchema.safeParse(raw.fileID);
    if (!parsedLocator.success || Buffer.byteLength(parsedLocator.data, 'utf8') > 1024) {
      invalid('INVALID_MARKET_FILE_LOCATOR', 'locator'); continue;
    }
    const locator = parsedLocator.data;
    if (raw._id !== createHash('sha1').update(locator).digest('hex')) invalid('MARKET_FILE_ID_MISMATCH', 'id');
    if (ledger.has(locator)) { invalid('DUPLICATE_MARKET_FILE', 'locator'); continue; }

    let ownerUserId: string | null = null;
    let adminOwnerKey: string | null = null;
    if (raw.ownerKey !== undefined || raw.adminAccountId !== undefined) {
      if (!ownerKey(raw.ownerKey) || !resourceId(raw.adminAccountId) ||
        adminOwners.get(raw.adminAccountId) !== raw.ownerKey || raw._openid !== undefined) invalid('INVALID_MARKET_FILE_ADMIN_OWNER', 'owner');
      else adminOwnerKey = raw.ownerKey;
    } else {
      const user = identity(raw._openid) ? users.get(raw._openid) : undefined;
      if (!user) invalid('UNKNOWN_MARKET_FILE_USER', 'owner');
      else ownerUserId = user.id;
    }

    const type = raw.type;
    const folder = type === 'image' ? 'market' : type === 'thumb' ? 'market_thumb' : null;
    if (!folder || raw.folder !== folder) invalid('INVALID_MARKET_FILE_TYPE', 'type');
    const path = locator.split('/').slice(3);
    // Mini-program uploads use purpose folders. Web uploads instead use the
    // authenticated account path; their folder field records purpose, not path.
    if (path[0] === 'web-admin') {
      if (!adminOwnerKey || path.length !== 3 || path[1] !== raw.adminAccountId ||
        !/^[a-f0-9]{32}\.(?:jpg|png|webp)$/.test(path[2]!)) invalid('INVALID_MARKET_FILE_PATH', 'locator');
    } else if (adminOwnerKey || path[0] !== folder || path.length < 2 || path.some(part => !part || part === '.' || part === '..')) {
      invalid('INVALID_MARKET_FILE_PATH', 'locator');
    }

    const deletionIntent = raw.status === 'deleted' || raw.status === 'removed' || raw.status === 'cleanup';
    const status = raw.status === 'pending' ? 'pending' : raw.status === 'attached' || deletionIntent ? 'ready' : null;
    if (!status) invalid('UNKNOWN_MARKET_FILE_STATUS', 'status');
    if (deletionIntent) notice('MARKET_FILE_DELETION_INTENT_UNVERIFIED', 'status');

    // These are ledger clocks. attachMarketFiles rewrites both on attachment;
    // server timestamps are separate facts, not fallback aliases or upload time.
    const createdAt = typeof raw.createdAtMs === 'number' ? parseExportTimestamp(raw.createdAtMs) : null;
    const updatedAt = typeof raw.updatedAtMs === 'number' ? parseExportTimestamp(raw.updatedAtMs) : null;
    if (!createdAt || !updatedAt) invalid('INVALID_MARKET_FILE_TIMESTAMP', 'timestamps');
    else if (updatedAt < createdAt) invalid('INVALID_MARKET_FILE_TIMESTAMP_ORDER', 'timestamps');
    const serverTimes: Record<string, string> = {};
    for (const field of ['attachedAt', 'updatedAt', 'deletedAt'] as const) {
      if (raw[field] === undefined) continue;
      const timestamp = parseExportTimestamp(raw[field]);
      if (!timestamp) invalid('INVALID_MARKET_FILE_TIMESTAMP', 'timestamps');
      else serverTimes[field] = timestamp;
    }
    if (serverTimes.attachedAt && serverTimes.updatedAt && serverTimes.attachedAt > serverTimes.updatedAt ||
      serverTimes.deletedAt && serverTimes.updatedAt && serverTimes.deletedAt > serverTimes.updatedAt) {
      invalid('INVALID_MARKET_FILE_TIMESTAMP_ORDER', 'timestamps');
    }
    if (Object.keys(serverTimes).length) notice('MARKET_FILE_SERVER_TIMESTAMPS_ARCHIVED', 'timestamps');
    if (serverTimes.attachedAt && serverTimes.attachedAt !== createdAt || serverTimes.updatedAt && serverTimes.updatedAt !== updatedAt ||
      serverTimes.deletedAt && serverTimes.deletedAt !== updatedAt) notice('MARKET_FILE_DISTINCT_CLOCKS_PRESERVED', 'timestamps');

    for (const field of ['goodsId', 'deletedGoodsId'] as const) {
      if (raw[field] !== undefined && !resourceId(raw[field])) invalid('INVALID_MARKET_FILE_RESOURCE_INDEX', 'metadata');
    }
    if (raw.status === 'attached' && (!resourceId(raw.goodsId) || !serverTimes.attachedAt || !serverTimes.updatedAt)) {
      invalid('INCOMPLETE_MARKET_FILE_ATTACHMENT', 'metadata');
    }
    if (raw.goodsId !== undefined || raw.deletedGoodsId !== undefined) notice('MARKET_FILE_LAST_ATTACHMENT_INDEX_ARCHIVED', 'metadata');
    if (valid && createdAt && updatedAt && status && (type === 'image' || type === 'thumb')) {
      const file: FileRow = { id: stableFileId(context.appId, locator), appId: context.appId, provider: 'cloudbase', locator,
        ownerUserId, adminOwnerKey, uploadedByAdminId: adminOwnerKey ? raw.adminAccountId as string : null,
        legacyReadonly: true, status, sizeBytes: null, mediaType: null, sha256: null, verifiedAt: null,
        createdAt, updatedAt };
      ledger.set(locator, { file, type, goodsId: typeof raw.goodsId === 'string' ? raw.goodsId : null, deletionIntent });
    }
  }

  const references: FileReferenceRow[] = [];
  const listingIds = new Set<string>();
  for (const listing of listings) {
    try { serializeSource(listing); } catch { error('INVALID_MARKET_FILE_LISTING', 'references'); continue; }
    if (!object(listing) || listing.appId !== context.appId || !resourceId(listing.id) || listingIds.has(listing.id)) {
      error('INVALID_MARKET_FILE_LISTING', 'references'); continue;
    }
    const listingId = listing.id;
    listingIds.add(listingId);
    const userOwned = typeof listing.ownerUserId === 'string' && userIds.has(listing.ownerUserId) && listing.adminOwnerKey === null;
    const adminOwned = listing.ownerUserId === null && typeof listing.adminOwnerKey === 'string' && adminKeys.has(listing.adminOwnerKey);
    if ((!userOwned && !adminOwned) || typeof listing.sharedAdminManagement !== 'boolean' || adminOwned && listing.sharedAdminManagement) {
      error('INVALID_MARKET_FILE_LISTING_OWNER', 'references'); continue;
    }
    const images = legacyMarketImagesSchema.safeParse(listing.images);
    if (!images.success) { error('INVALID_MARKET_FILE_LISTING_IMAGES', 'references'); continue; }
    images.data.forEach((image, index) => {
      const attach = (locator: string, type: 'image' | 'thumb', slot: FileReferenceRow['slot']) => {
        const entry = ledger.get(locator);
        if (!entry) { error('MISSING_MARKET_FILE_LEDGER', 'references'); return; }
        if (entry.type !== type) { error('MARKET_FILE_REFERENCE_TYPE_MISMATCH', 'references'); return; }
        const sameOwner = entry.file.ownerUserId === listing.ownerUserId && entry.file.adminOwnerKey === listing.adminOwnerKey;
        // The old administrator editor may attach its own uploaded file to a
        // shared, user-owned listing. Retain only this existing reference; do
        // not transfer ownership or extend the rule to another user's file.
        const sharedAdminFile = listing.sharedAdminManagement && listing.ownerUserId !== null &&
          entry.file.adminOwnerKey !== null && adminKeys.has(entry.file.adminOwnerKey);
        if (!sameOwner && !sharedAdminFile) {
          error('MARKET_FILE_REFERENCE_OWNER_MISMATCH', 'references'); return;
        }
        if (entry.file.status !== 'ready') { error('MARKET_FILE_PENDING_REFERENCED', 'references'); return; }
        if (entry.goodsId !== listingId) notice('MARKET_FILE_REFERENCE_DIFFERS_FROM_LAST_INDEX', 'references');
        if (entry.deletionIntent) notice('MARKET_FILE_REFERENCED_DELETION_INTENT_PROTECTED', 'references');
        references.push({ appId: context.appId, resourceKind: 'listing', resourceId: listingId, slot, fileId: entry.file.id });
      };
      attach(image.fileId, 'image', `image.${index}`);
      if (image.thumbFileId !== undefined) attach(image.thumbFileId, 'thumb', `thumbnail.${index}`);
    });
  }
  return failed ? empty() : { files: [...ledger.values()].map(entry => entry.file), references };
}
