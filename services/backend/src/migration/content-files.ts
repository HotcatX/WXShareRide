import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AdFileReference } from './ads.ts';
import type { CommunityFileReference } from './community.ts';
import { stableFileId, type FileReferenceRow, type FileRow } from './files.ts';
import { legacyCloudFileIdSchema } from './market-images.ts';
import { serializeSource } from './source.ts';
import type { IssueReporter } from './types.ts';
import { object, parseExportTimestamp } from './values.ts';

type Context = { appId: string; adminOwners: readonly { accountId: string; ownerKey: string }[] };
type Input = {
  market: { files: readonly FileRow[]; references: readonly FileReferenceRow[] };
  adReferences: readonly AdFileReference[];
  communityReferences: readonly CommunityFileReference[];
  uploads: unknown;
};
type Upload = {
  accountId: string; ownerKey: string; purpose: 'market' | 'market_thumb' | 'community';
  locator: string; createdAt: string; updatedAt: string;
};
const uploadFields = new Set(['_id', 'accountId', 'ownerKey', 'purpose', 'contentHash', 'contentType', 'size',
  'cloudPath', 'status', 'createdAtMs', 'fileID', 'updatedAtMs']);
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value);
const ownerKey = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const locator = (value: unknown): value is string => legacyCloudFileIdSchema.safeParse(value).success &&
  Buffer.byteLength(value as string, 'utf8') <= 1024 && !(value as string).includes('%') &&
  !(value as string).split('/').slice(3).some(part => !part || part === '.' || part === '..');
const knownTime = (value: unknown): value is string => typeof value === 'string' && parseExportTimestamp(value) === value;
const communitySlot = (value: string) => {
  if (value === 'group' || value === 'announcement') return true;
  const match = /^history\.([1-9]\d*)\.(?:before|after)\.(?:group|announcement)$/.exec(value);
  return !!match && Number(match[1]) <= 2147483647;
};

/** Merge only the audited market, ad and community slices. Existing references
 * are historical retention evidence, never permission to attach a legacy file
 * elsewhere. Unknown owners/clocks remain null. Upload metadata is archived by
 * the caller, not promoted to verified binary facts; size/type/hash stay null.
 * The complete WebAdminUploads collection is required: its two ready indexes
 * are transactionally identical copies. A partial export or unfinished upload
 * blocks the complete plan. No source is written and no binary is fetched. */
export function normalizeContentFiles(
  input: Input, context: Context, issue: IssueReporter,
): { files: FileRow[]; references: FileReferenceRow[] } {
  let failed = false;
  const report = (code: string, field = 'content', severity: 'error' | 'notice' = 'error') => {
    if (severity === 'error') failed = true;
    issue('other', code, `contentFiles.${field}`, severity);
  };
  const empty = () => ({ files: [] as FileRow[], references: [] as FileReferenceRow[] });
  if (!input || !input.market || !Array.isArray(input.market.files) || !Array.isArray(input.market.references) ||
    !Array.isArray(input.adReferences) || !Array.isArray(input.communityReferences) || !Array.isArray(input.uploads)) {
    report('INVALID_CONTENT_FILES_INPUT'); return empty();
  }
  if (!context || !id(context.appId) || !Array.isArray(context.adminOwners)) { report('INVALID_CONTENT_FILES_CONTEXT'); return empty(); }
  const admins = new Map<string, string>();
  for (const admin of context.adminOwners) {
    if (!object(admin) || !id(admin.accountId) || !ownerKey(admin.ownerKey) || admins.has(admin.accountId)) report('INVALID_CONTENT_FILES_ADMIN_MAPPING', 'owner');
    else admins.set(admin.accountId, admin.ownerKey);
  }
  if (failed) return empty();
  const files = new Map<string, FileRow>();
  const fileIds = new Map<string, FileRow>();
  for (const file of input.market.files) {
    try { serializeSource(file); } catch { report('INVALID_SOURCE_JSON'); continue; }
    if (!file || typeof file !== 'object' || Array.isArray(file) || file.appId !== context.appId || file.provider !== 'cloudbase' || !locator(file.locator) ||
      file.id !== stableFileId(context.appId, file.locator) || files.has(file.locator) || fileIds.has(file.id) ||
      file.legacyReadonly !== true || !['ready', 'pending'].includes(file.status) ||
      file.sizeBytes !== null || file.mediaType !== null || file.sha256 !== null || file.verifiedAt !== null ||
      !knownTime(file.createdAt) || !knownTime(file.updatedAt) || file.createdAt > file.updatedAt) {
      report('INVALID_CONTENT_MARKET_FILE', 'market'); continue;
    }
    const userOwned = uuid(file.ownerUserId) && file.adminOwnerKey === null && file.uploadedByAdminId === null;
    const adminOwned = file.ownerUserId === null && ownerKey(file.adminOwnerKey) && id(file.uploadedByAdminId) && admins.get(file.uploadedByAdminId) === file.adminOwnerKey;
    if (!userOwned && !adminOwned) { report('INVALID_CONTENT_MARKET_OWNER', 'owner'); continue; }
    const copy = { ...file };
    files.set(file.locator, copy); fileIds.set(file.id, copy);
  }

  const references: FileReferenceRow[] = [];
  const slots = new Set<string>();
  const addReference = (reference: FileReferenceRow) => {
    const key = JSON.stringify([reference.appId, reference.resourceKind, reference.resourceId, reference.slot]);
    if (slots.has(key)) { report('DUPLICATE_CONTENT_FILE_SLOT', 'references'); return; }
    slots.add(key); references.push({ ...reference });
  };
  for (const reference of input.market.references) {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference) || reference.appId !== context.appId || reference.resourceKind !== 'listing' ||
      !id(reference.resourceId) || typeof reference.slot !== 'string' || !/^(?:image|thumbnail)\.[0-5]$/.test(reference.slot) ||
      !fileIds.has(reference.fileId) || fileIds.get(reference.fileId)!.status !== 'ready') {
      report('INVALID_CONTENT_MARKET_REFERENCE', 'references'); continue;
    }
    addReference(reference);
  }

  const uploadDocuments = new Map<string, Record<string, unknown>>();
  const readyUploads = new Map<string, Upload>();
  for (const raw of input.uploads) {
    try { serializeSource(raw); } catch { report('INVALID_SOURCE_JSON', 'uploads'); continue; }
    if (!object(raw)) { report('INVALID_WEB_UPLOAD_DOCUMENT', 'uploads'); continue; }
    for (const field of Object.keys(raw)) if (!uploadFields.has(field)) report('UNMAPPED_WEB_UPLOAD_FIELD', 'uploads');
    if (typeof raw._id !== 'string' || !/^(?:file|request)_[a-f0-9]{64}$/.test(raw._id) || uploadDocuments.has(raw._id)) {
      report('INVALID_WEB_UPLOAD_INDEX', 'uploads'); continue;
    }
    uploadDocuments.set(raw._id, raw);
    const accountValid = id(raw.accountId) && ownerKey(raw.ownerKey) && admins.get(raw.accountId) === raw.ownerKey;
    if (!accountValid) report('INVALID_WEB_UPLOAD_OWNER', 'owner');
    if (!['market', 'market_thumb', 'community'].includes(raw.purpose as string)) report('INVALID_WEB_UPLOAD_PURPOSE', 'uploads');
    if (typeof raw.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.contentHash)) report('INVALID_WEB_UPLOAD_HASH', 'uploads');
    const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as Record<string, string>)[raw.contentType as string];
    if (!ext || typeof raw.size !== 'number' || !Number.isSafeInteger(raw.size) || raw.size < 12 || raw.size > 2 * 1024 * 1024) report('INVALID_WEB_UPLOAD_FORMAT', 'uploads');
    const parts = typeof raw.cloudPath === 'string' ? raw.cloudPath.split('/') : [];
    if (parts.length !== 3 || parts[0] !== 'web-admin' || parts[1] !== raw.accountId ||
      !/^[a-f0-9]{32}\.(?:jpg|png|webp)$/.test(parts[2] ?? '') || parts[2]?.split('.')[1] !== ext) report('INVALID_WEB_UPLOAD_PATH', 'uploads');
    const createdAt = typeof raw.createdAtMs === 'number' ? parseExportTimestamp(raw.createdAtMs) : null;
    if (!createdAt) report('INVALID_WEB_UPLOAD_TIMESTAMP', 'uploads');
    const requestId = typeof raw.accountId === 'string' && typeof raw.purpose === 'string' && typeof raw.contentHash === 'string'
      ? 'request_' + hash(`${raw.accountId}:${raw.purpose}:${raw.contentHash}`) : null;
    if (raw._id.startsWith('request_') && raw._id !== requestId) report('WEB_UPLOAD_INDEX_MISMATCH', 'uploads');
    if (raw.status === 'uploading') {
      // The reservation path is not a proven provider locator. Keep its exact
      // source, and stop instead of inventing a file row or silently omitting it.
      report('UNRESOLVED_WEB_UPLOAD', 'uploads'); continue;
    }
    if (raw.status !== 'ready') { report('UNKNOWN_WEB_UPLOAD_STATUS', 'uploads'); continue; }
    if (!locator(raw.fileID) || raw.fileID.split('/').slice(3).join('/') !== raw.cloudPath) { report('INVALID_WEB_UPLOAD_LOCATOR', 'uploads'); continue; }
    const fileKey = 'file_' + hash(raw.fileID);
    if (raw._id.startsWith('file_') && raw._id !== fileKey) report('WEB_UPLOAD_INDEX_MISMATCH', 'uploads');
    const updatedAt = typeof raw.updatedAtMs === 'number' ? parseExportTimestamp(raw.updatedAtMs) : null;
    if (!updatedAt || createdAt && updatedAt < createdAt) report('INVALID_WEB_UPLOAD_TIMESTAMP', 'uploads');
    if (raw._id === fileKey && createdAt && updatedAt && accountValid) {
      if (readyUploads.has(raw.fileID)) report('DUPLICATE_WEB_UPLOAD_FILE', 'uploads');
      readyUploads.set(raw.fileID, { locator: raw.fileID, accountId: raw.accountId as string, ownerKey: raw.ownerKey as string,
        purpose: raw.purpose as Upload['purpose'], createdAt, updatedAt });
    }
  }
  // Equality is over the full producer record, excluding only each index's _id.
  for (const raw of uploadDocuments.values()) {
    if (raw.status !== 'ready' || typeof raw.fileID !== 'string' || typeof raw.accountId !== 'string' ||
      typeof raw.purpose !== 'string' || typeof raw.contentHash !== 'string') continue;
    const key = raw._id === 'file_' + hash(raw.fileID)
      ? 'request_' + hash(`${raw.accountId}:${raw.purpose}:${raw.contentHash}`) : 'file_' + hash(raw.fileID);
    const counterpart = uploadDocuments.get(key);
    if (!counterpart) { report('INCOMPLETE_WEB_UPLOAD_INDEX_PAIR', 'uploads'); continue; }
    const { _id: _sourceId, ...source } = raw;
    const { _id: _targetId, ...target } = counterpart;
    if (!isDeepStrictEqual(source, target)) report('CONFLICTING_WEB_UPLOAD_INDEX_PAIR', 'uploads');
  }
  if (failed) return empty();
  for (const upload of readyUploads.values()) {
    const previous = files.get(upload.locator);
    if (previous) {
      if (previous.ownerUserId !== null || previous.adminOwnerKey !== upload.ownerKey || previous.uploadedByAdminId !== upload.accountId) report('CONTENT_FILE_OWNER_CONFLICT', 'owner');
      if (upload.purpose === 'community' || references.some(ref => ref.fileId === previous.id && ref.slot.startsWith('image.') && upload.purpose !== 'market')) report('CONTENT_FILE_PURPOSE_CONFLICT', 'uploads');
      // MarketFiles clocks represent its own ledger operations. Do not replace
      // them with the independent original upload/reservation clock.
      report('WEB_UPLOAD_DISTINCT_CLOCKS_ARCHIVED', 'uploads', 'notice');
    } else {
      const file: FileRow = { id: stableFileId(context.appId, upload.locator), appId: context.appId,
        provider: 'cloudbase', locator: upload.locator, ownerUserId: null, adminOwnerKey: upload.ownerKey,
        uploadedByAdminId: upload.accountId, legacyReadonly: true, status: 'ready', sizeBytes: null, mediaType: null,
        sha256: null, verifiedAt: null, createdAt: upload.createdAt, updatedAt: upload.updatedAt };
      files.set(file.locator, file); fileIds.set(file.id, file);
    }
    report('WEB_UPLOAD_BINARY_METADATA_UNVERIFIED', 'uploads', 'notice');
  }
  const contentReference = (reference: AdFileReference | CommunityFileReference, kind: 'ad' | 'community') => {
    if (!object(reference) || reference.appId !== context.appId || reference.resourceKind !== kind || !id(reference.resourceId) ||
      typeof reference.slot !== 'string' || reference.slot.length > 64 ||
      (kind === 'ad' ? !['image', 'thumbnail'].includes(reference.slot) : reference.resourceId !== 'main' || !communitySlot(reference.slot)) ||
      !locator(reference.locator)) { report('INVALID_CONTENT_FILE_REFERENCE', 'references'); return; }
    let file = files.get(reference.locator);
    if (!file) {
      file = { id: stableFileId(context.appId, reference.locator), appId: context.appId, provider: 'cloudbase', locator: reference.locator,
        ownerUserId: null, adminOwnerKey: null, uploadedByAdminId: null, legacyReadonly: true, status: 'ready',
        sizeBytes: null, mediaType: null, sha256: null, verifiedAt: null, createdAt: null, updatedAt: null };
      files.set(file.locator, file); fileIds.set(file.id, file);
      report('CONTENT_FILE_UNKNOWN_PROVENANCE', 'files', 'notice');
    }
    if (file.status !== 'ready') { report('CONTENT_FILE_PENDING_REFERENCED', 'references'); return; }
    addReference({ appId: context.appId, resourceKind: kind, resourceId: reference.resourceId, slot: reference.slot, fileId: file.id });
  };
  for (const reference of input.adReferences) contentReference(reference, 'ad');
  for (const reference of input.communityReferences) contentReference(reference, 'community');
  return failed ? empty() : { files: [...files.values()], references };
}
