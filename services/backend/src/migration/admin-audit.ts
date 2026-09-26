import { createHash } from 'node:crypto';
import { legacyCloudFileIdSchema } from './market-images.ts';
import { serializeSource } from './source.ts';
import type { Document, IssueReporter } from './types.ts';
import { object, parseExportTimestamp } from './values.ts';

export type AdminAuditRow = {
  id: string; appId: string; accountId: string; action: string; details: Document; createdAt: string;
};
const actionFields = {
  login: [], logout: [],
  createItem: ['itemId', 'batchId', 'externalId', 'requestHash'],
  bulkCreate: ['batchId', 'total', 'requestHash'],
  updateItem: ['itemId', 'fields', 'requestHash', 'version'],
  saveTemplate: ['templateId'], deleteTemplate: ['templateId'],
  uploadImage: ['fileID', 'purpose', 'size', 'contentHash'],
  updateCommunity: ['version', 'previousVersion', 'requestHash'],
} as const;
type Action = keyof typeof actionFields;
// Exact keys produced by the old webAdminBusiness.payload partial update.
const editableFields = new Set(['title', 'category', 'condition', 'region', 'regionState', 'regionCounty', 'regionArea',
  'Apartment', 'regionDisplay', 'buildingName', 'sellerName', 'sellerWechat', 'sellerPhone', 'sellerNote',
  'pickupStartDate', 'pickupEndDate', 'availableStartDate', 'leaseEndDate', 'deposit', 'roomType', 'housingType',
  'genderPreference', 'roommateCount', 'desc', 'listingType', 'price', 'furnished', 'utilitiesIncluded', 'location',
  'imageFileID', 'imageFileIDs', 'thumbFileID', 'thumbFileIDs']);
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  value.length <= 160 && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const accountId = (value: unknown): value is string => typeof value === 'string' && value.trim() === value &&
  /^[a-z0-9][a-z0-9_-]{2,63}$/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
const count = (value: unknown, minimum = 1): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const milliseconds = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  ? parseExportTimestamp(value) : null;

function auditId(appId: string, sourceId: string): string {
  const bytes = createHash('sha256').update('linkx-admin-audit-v1\0').update(JSON.stringify([appId, sourceId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Only historical writeAudit facts. No account lookup, creation, permission
 * grant or replay receipt is derived from a log. The caller archives original
 * IDs/documents; request_ upload audit IDs map to UUIDs just like random IDs.
 * Any invalid record rejects the entire candidate collection. */
export function normalizeAdminAudit(documents: unknown, appId: string, issue: IssueReporter): AdminAuditRow[] {
  let failed = false;
  const report = (code: string, field = 'content') => { failed = true; issue('other', code, `WebAdminAuditLogs.${field}`); };
  if (!identity(appId)) report('INVALID_ADMIN_AUDIT_APP');
  if (!Array.isArray(documents)) { report('INVALID_ADMIN_AUDIT_COLLECTION'); return []; }
  const rows: AdminAuditRow[] = [], sourceIds = new Set<string>();
  for (const raw of documents) {
    try { serializeSource(raw); } catch { report('INVALID_SOURCE_JSON'); continue; }
    if (!object(raw)) { report('INVALID_ADMIN_AUDIT_DOCUMENT'); continue; }
    if (typeof raw.action !== 'string' || !Object.hasOwn(actionFields, raw.action)) {
      report('UNKNOWN_ADMIN_AUDIT_ACTION', 'action'); continue;
    }
    const action = raw.action as Action;
    const required: readonly string[] = actionFields[action];
    const allowed = new Set<string>(['_id', 'accountId', 'action', 'createdAtMs', ...required]);
    for (const key of Object.keys(raw)) if (!allowed.has(key)) report('UNMAPPED_ADMIN_AUDIT_FIELD');
    if (typeof raw._id !== 'string' || raw._id.trim() !== raw._id ||
      !(action === 'uploadImage' ? /^request_[a-f0-9]{64}$/.test(raw._id) : /^[a-f0-9]{32}$/.test(raw._id)) || sourceIds.has(raw._id)) {
      report('INVALID_ADMIN_AUDIT_ID', 'id'); continue;
    }
    sourceIds.add(raw._id);
    if (!accountId(raw.accountId)) report('INVALID_ADMIN_AUDIT_ACTOR', 'actor');
    const createdAt = milliseconds(raw.createdAtMs);
    if (!createdAt) report('INVALID_ADMIN_AUDIT_TIMESTAMP', 'createdAt');
    const detail = (valid: boolean) => { if (!valid) report('INVALID_ADMIN_AUDIT_DETAILS', 'details'); };
    if (required.includes('requestHash')) detail(hash(raw.requestHash));
    if (action === 'createItem') {
      detail(typeof raw.itemId === 'string' && raw.itemId.length === 52 && /^web_[a-f0-9]{48}$/.test(raw.itemId));
      detail(id(raw.batchId) && id(raw.externalId));
    } else if (action === 'bulkCreate') {
      detail(id(raw.batchId) && count(raw.total) && raw.total <= 50);
    } else if (action === 'updateItem') {
      detail(id(raw.itemId) && count(raw.version));
      detail(Array.isArray(raw.fields) && raw.fields.length > 0 && new Set(raw.fields).size === raw.fields.length &&
        raw.fields.every(field => typeof field === 'string' && editableFields.has(field)));
    } else if (action === 'saveTemplate' || action === 'deleteTemplate') {
      detail(id(raw.templateId));
    } else if (action === 'updateCommunity') {
      detail(count(raw.version) && count(raw.previousVersion, 0) && raw.version === raw.previousVersion + 1);
    } else if (action === 'uploadImage') {
      const file = legacyCloudFileIdSchema.safeParse(raw.fileID);
      const path = file.success ? file.data.split('/').slice(3) : [];
      detail(file.success && !file.data.includes('%') && path.length === 3 && path[0] === 'web-admin' &&
        path[1] === raw.accountId && /^[a-f0-9]{32}\.(jpg|png|webp)$/.test(path[2]!));
      detail(['market', 'market_thumb', 'community'].includes(raw.purpose as string));
      detail(count(raw.size) && raw.size >= 12 && raw.size <= 2 * 1024 * 1024);
      detail(hash(raw.contentHash));
      const expected = `request_${createHash('sha256').update(`${raw.accountId}:${raw.purpose}:${raw.contentHash}`).digest('hex')}`;
      if (raw._id !== expected) report('ADMIN_UPLOAD_AUDIT_ID_MISMATCH', 'id');
    }
    const details: Document = {};
    for (const key of required) details[key] = Array.isArray(raw[key]) ? [...raw[key] as unknown[]] : raw[key];
    if (accountId(raw.accountId) && createdAt) rows.push({ id: auditId(appId, raw._id), appId,
      accountId: raw.accountId, action, details, createdAt });
  }
  return failed ? [] : rows;
}

/** Removed from the current market runtime; historical OpenID authorization
 * is validated for source archiving only, never mapped to website accounts. */
export function validateLegacyMarketAdmins(documents: unknown, issue: IssueReporter): void {
  const report = (code: string, field = 'content') => issue('other', code, `market_admins.${field}`);
  if (!Array.isArray(documents)) { report('INVALID_LEGACY_MARKET_ADMIN_COLLECTION'); return; }
  const ids = new Set<string>();
  const allowed = new Set(['_id', 'openid', 'role', 'status', 'note', 'createdAtMs', 'updatedAtMs']);
  for (const raw of documents) {
    try { serializeSource(raw); } catch { report('INVALID_SOURCE_JSON'); continue; }
    if (!object(raw)) { report('INVALID_LEGACY_MARKET_ADMIN_DOCUMENT'); continue; }
    for (const key of Object.keys(raw)) if (!allowed.has(key)) report('UNMAPPED_LEGACY_MARKET_ADMIN_FIELD');
    if (!identity(raw._id) || raw._id !== raw.openid || ids.has(raw._id)) report('INVALID_LEGACY_MARKET_ADMIN_IDENTITY', 'identity');
    else ids.add(raw._id);
    if (raw.role !== 'market_admin' || !['active', 'disabled', 'inactive'].includes(raw.status as string)) report('INVALID_LEGACY_MARKET_ADMIN_STATE', 'state');
    if (typeof raw.note !== 'string' || raw.note.length > 2000 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(raw.note)) report('INVALID_LEGACY_MARKET_ADMIN_NOTE', 'note');
    const createdAt = milliseconds(raw.createdAtMs), updatedAt = milliseconds(raw.updatedAtMs);
    if (!createdAt || !updatedAt) report('INVALID_LEGACY_MARKET_ADMIN_TIMESTAMP', 'timestamps');
    else if (Date.parse(updatedAt) < Date.parse(createdAt)) report('INVALID_LEGACY_MARKET_ADMIN_TIMESTAMP_ORDER', 'timestamps');
  }
}

/** The old six-digit code is never copied into new authentication. Its source
 * remains private. The old reader ignored mode and both metadata clocks, so
 * they are validated and archived, not treated as aliases or new permissions. */
export function validateLegacyMarketAdminSettings(documents: unknown, issue: IssueReporter): void {
  const report = (code: string, field = 'content', severity: 'error' | 'notice' = 'error') =>
    issue('other', code, `MarketAdminSettings.${field}`, severity);
  if (!Array.isArray(documents) || documents.length > 1) { report('INVALID_LEGACY_MARKET_ADMIN_SETTINGS'); return; }
  const allowed = new Set(['_id', 'code', 'mode', 'status', 'updateTimeMs', 'updatedAtMs']);
  for (const raw of documents) {
    try { serializeSource(raw); } catch { report('INVALID_SOURCE_JSON'); continue; }
    if (!object(raw)) { report('INVALID_LEGACY_MARKET_ADMIN_SETTINGS'); continue; }
    for (const key of Object.keys(raw)) if (!allowed.has(key)) report('UNMAPPED_LEGACY_MARKET_ADMIN_SETTINGS_FIELD');
    if (raw._id !== 'bulk_publish_password') report('INVALID_LEGACY_MARKET_ADMIN_SETTINGS_ID', 'id');
    if (typeof raw.code !== 'string' || raw.code.length !== 6 || !/^\d{6}$/.test(raw.code)) report('INVALID_LEGACY_MARKET_ADMIN_CODE', 'code');
    if (typeof raw.mode !== 'string' || raw.mode.trim() !== raw.mode || !/^[a-z][a-z0-9_]{0,63}$/.test(raw.mode) ||
      !['active', 'disabled', 'inactive'].includes(raw.status as string)) report('INVALID_LEGACY_MARKET_ADMIN_SETTINGS_STATE', 'state');
    const first = milliseconds(raw.updateTimeMs), second = milliseconds(raw.updatedAtMs);
    if (!first || !second) report('INVALID_LEGACY_MARKET_ADMIN_SETTINGS_TIMESTAMP', 'timestamps');
    else if (first !== second) report('LEGACY_MARKET_ADMIN_SETTINGS_DISTINCT_CLOCKS_ARCHIVED', 'timestamps', 'notice');
  }
}
