import { createHash } from 'node:crypto';
import type { AdminAccountRow } from './admin.ts';
import { serializeSource } from './source.ts';
import type { IssueReporter } from './types.ts';
import { object, parseExportTimestamp } from './values.ts';

export type AdminMarketBatchRow = {
  appId: string; ownerKey: string; id: string; payloadHash: string; payloadFormat: 'legacy-web-v1';
  total: number; status: 'running' | 'partial' | 'failed' | 'done';
  results: { index: number; id: string; externalId: string }[];
  failures: { index: number; error: string }[];
  createdAt: string; updatedAt: string | null;
};
export type AdminMarketRequestRow = {
  appId: string; ownerKey: string; operation: 'market.create'; requestKey: string;
  payloadHash: string; payloadFormat: 'legacy-web-v1'; responseStatus: 201;
  responseBody: { id: string }; createdAt: string;
};
type Context = { appId: string; adminAccounts: readonly Pick<AdminAccountRow, 'appId' | 'id' | 'ownerKey'>[] };
const batchFields = new Set(['_id', 'accountId', 'batchId', 'ownerKey', 'type', 'source', 'requestHash',
  'total', 'status', 'createdAtMs', 'success', 'failed', 'results', 'failures', 'updatedAtMs']);
const completionFields = ['success', 'failed', 'results', 'failures', 'updatedAtMs'];
const key = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const accountId = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && /^[a-z0-9][a-z0-9_-]{2,63}$/.test(value);
const itemId = (value: unknown): value is string => typeof value === 'string' && value.length === 52 && /^web_[a-f0-9]{48}$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
const count = (value: unknown, maximum = 50): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const milliseconds = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? parseExportTimestamp(value) : null;
const identity = (owner: string, request: string) => `web_${createHash('sha256').update(`${owner}:${request}`).digest('hex').slice(0, 48)}`;
const scope = (owner: string, batch: string) => JSON.stringify([owner, batch]);

/** Preserve the two permanent identities used by webAdminBusiness, without
 * pretending its hashes describe the new canonical DTO. The old payload()
 * dropped clientRequestId before saving: the stable web_ listing ID is the
 * surviving row receipt key, not a reversible encoding of that request key.
 *
 * The full market listing converter must also validate business fields. This
 * converter validates its creation-receipt metadata only; it never recreates
 * deleted listings or imports an old OpenID administrator as a web account.
 * All source documents are archived centrally. Any error rejects both groups.
 */
export function normalizeAdminMarket(documents: { batches: unknown; listings: unknown }, context: Context,
  issue: IssueReporter): { batches: AdminMarketBatchRow[]; requests: AdminMarketRequestRow[] } {
  let failed = false;
  const report = (code: string, field = 'MarketImportBatches', severity: 'error' | 'notice' = 'error') => {
    if (severity === 'error') failed = true;
    issue('other', code, field, severity);
  };
  const empty = () => ({ batches: [], requests: [] });
  if (!context || typeof context.appId !== 'string' || !context.appId || context.appId.trim() !== context.appId ||
    /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(context.appId) || !Array.isArray(context.adminAccounts)) {
    report('INVALID_ADMIN_MARKET_CONTEXT'); return empty();
  }
  if (!object(documents) || !Array.isArray(documents.batches) || !Array.isArray(documents.listings)) {
    report('INVALID_ADMIN_MARKET_COLLECTIONS'); return empty();
  }
  const accounts = new Map<string, string>();
  for (const account of context.adminAccounts) {
    if (!object(account) || account.appId !== context.appId || !accountId(account.id) || !key(account.ownerKey) || accounts.has(account.id)) {
      report('INVALID_ADMIN_MARKET_ACCOUNT_MAPPING');
    } else accounts.set(account.id, account.ownerKey);
  }
  if (failed) return empty();

  const batches: AdminMarketBatchRow[] = [], requests: AdminMarketRequestRow[] = [];
  const batchScopes = new Set<string>(), batchIds = new Set<string>();
  for (const raw of documents.batches) {
    try { serializeSource(raw); } catch { report('INVALID_SOURCE_JSON'); continue; }
    if (!object(raw)) { report('INVALID_ADMIN_MARKET_BATCH'); continue; }
    for (const field of Object.keys(raw)) if (!batchFields.has(field)) report('UNMAPPED_ADMIN_MARKET_BATCH_FIELD');
    if (!key(raw.ownerKey) || !key(raw.batchId) || !accountId(raw.accountId) || accounts.get(raw.accountId) !== raw.ownerKey) {
      report('INVALID_ADMIN_MARKET_BATCH_OWNER'); continue;
    }
    if (!itemId(raw._id) || raw._id !== identity(raw.ownerKey, raw.batchId) ||
      batchScopes.has(scope(raw.ownerKey, raw.batchId)) || batchIds.has(raw._id)) report('INVALID_ADMIN_MARKET_BATCH_ID');
    batchScopes.add(scope(raw.ownerKey, raw.batchId)); batchIds.add(raw._id as string);
    if (raw.type !== 'market_admin_bulk' || raw.source !== 'web_admin' || !hash(raw.requestHash)) report('INVALID_ADMIN_MARKET_BATCH_METADATA');
    if (!count(raw.total) || raw.total < 1 || !['running', 'partial', 'failed', 'done'].includes(raw.status as string)) {
      report('INVALID_ADMIN_MARKET_BATCH_STATE'); continue;
    }
    const createdAt = milliseconds(raw.createdAtMs);
    const updatedAt = raw.updatedAtMs === undefined ? null : milliseconds(raw.updatedAtMs);
    if (!createdAt || (raw.updatedAtMs !== undefined && !updatedAt) || (createdAt && updatedAt && updatedAt < createdAt)) {
      report('INVALID_ADMIN_MARKET_BATCH_TIMESTAMP');
    }
    const results: AdminMarketBatchRow['results'] = [], failures: AdminMarketBatchRow['failures'] = [];
    if (raw.status === 'running') {
      // The initial batch write has no completion fields. Rows may already be
      // committed before a crashed invocation updates that initial batch.
      if (completionFields.some(field => raw[field] !== undefined)) report('INVALID_ADMIN_MARKET_BATCH_STATE');
    } else {
      if (!Array.isArray(raw.results) || !Array.isArray(raw.failures) || !count(raw.success) || !count(raw.failed) || !updatedAt) {
        report('INVALID_ADMIN_MARKET_BATCH_COMPLETION'); continue;
      }
      const indexes = new Set<number>();
      const acceptIndex = (index: unknown) => {
        if (!count(index, raw.total as number - 1) || indexes.has(index)) { report('INVALID_ADMIN_MARKET_BATCH_INDEX'); return false; }
        indexes.add(index); return true;
      };
      for (const result of raw.results) {
        if (!object(result) || Object.keys(result).some(field => !['index', 'id', 'externalId'].includes(field)) ||
          !itemId(result.id) || !key(result.externalId)) { report('INVALID_ADMIN_MARKET_BATCH_RESULT'); continue; }
        if (acceptIndex(result.index)) results.push({ index: result.index as number, id: result.id, externalId: result.externalId });
      }
      for (const failure of raw.failures) {
        if (!object(failure) || Object.keys(failure).some(field => !['index', 'error'].includes(field)) ||
          typeof failure.error !== 'string' || failure.error.trim() !== failure.error || !/^[a-z_]+$/.test(failure.error)) {
          report('INVALID_ADMIN_MARKET_BATCH_FAILURE'); continue;
        }
        if (acceptIndex(failure.index)) failures.push({ index: failure.index as number, error: failure.error });
      }
      if (indexes.size !== raw.total || raw.success !== results.length || raw.failed !== failures.length ||
        (raw.status === 'done' && failures.length !== 0) || (raw.status === 'failed' && results.length !== 0) ||
        (raw.status === 'partial' && (!results.length || !failures.length))) report('INVALID_ADMIN_MARKET_BATCH_COMPLETION');
    }
    if (createdAt && hash(raw.requestHash)) batches.push({ appId: context.appId, ownerKey: raw.ownerKey, id: raw.batchId,
      payloadHash: raw.requestHash, payloadFormat: 'legacy-web-v1', total: raw.total, status: raw.status as AdminMarketBatchRow['status'],
      results, failures, createdAt, updatedAt });
  }

  const listingIds = new Set<string>(), requestOwners = new Map<string, string>();
  for (const raw of documents.listings) {
    const field = 'market_goods.creationReceipt';
    try { serializeSource(raw); } catch { report('INVALID_SOURCE_JSON', field); continue; }
    if (!object(raw) || typeof raw._id !== 'string' || !raw._id || listingIds.has(raw._id)) {
      report('INVALID_ADMIN_MARKET_LISTING_ID', field); continue;
    }
    listingIds.add(raw._id);
    // Legacy mini-program admin publications still belong to their OpenID.
    if (raw.ownerKey === undefined && raw.webAdminRequestHash === undefined && raw.managedSource !== 'web_admin') continue;
    if (!key(raw.ownerKey) || raw.managedByOwnerKey !== raw.ownerKey || !accountId(raw.managedByAccountId) ||
      accounts.get(raw.managedByAccountId) !== raw.ownerKey || raw.managedByAdmin !== true || raw.managedSource !== 'web_admin' ||
      raw._openid !== undefined || raw.managedByOpenid !== undefined) {
      report('INVALID_ADMIN_MARKET_REQUEST_OWNER', field); continue;
    }
    if (!itemId(raw._id) || !hash(raw.webAdminRequestHash) || !key(raw.adminBatchId) || !key(raw.adminExternalId)) {
      report('INVALID_ADMIN_MARKET_REQUEST_METADATA', field); continue;
    }
    if (!batchScopes.has(scope(raw.ownerKey, raw.adminBatchId))) report('MISSING_ADMIN_MARKET_CREATION_BATCH', field);
    if (typeof raw.clientRequestId !== 'string' || (raw.clientRequestId !== '' &&
      (!key(raw.clientRequestId) || raw._id !== identity(raw.ownerKey, raw.clientRequestId)))) report('INVALID_ADMIN_MARKET_REQUEST_KEY', field);
    const createdAt = parseExportTimestamp(raw.createTime);
    if (!createdAt) { report('INVALID_ADMIN_MARKET_REQUEST_TIMESTAMP', field); continue; }
    requestOwners.set(raw._id, raw.ownerKey);
    // This is the new internal identity acknowledgement, not a reconstruction
    // of the old HTTP response or a snapshot of the listing's current content.
    requests.push({ appId: context.appId, ownerKey: raw.ownerKey, operation: 'market.create', requestKey: raw._id,
      payloadHash: raw.webAdminRequestHash, payloadFormat: 'legacy-web-v1', responseStatus: 201,
      responseBody: { id: raw._id }, createdAt });
  }
  for (const batch of batches) for (const result of batch.results) {
    if (listingIds.has(result.id) && requestOwners.get(result.id) !== batch.ownerKey) report('ADMIN_MARKET_BATCH_RESULT_OWNER_MISMATCH');
    else if (!listingIds.has(result.id)) report('ADMIN_MARKET_DELETED_RESULT_PRESERVED', 'MarketImportBatches.results', 'notice');
    // External ID and the original batch may differ on a valid cross-batch
    // replay using the same explicit clientRequestId. Neither is an owner key.
  }
  return failed ? empty() : { batches, requests };
}
