import type { IssueReporter } from './types.ts';
import { serializeSource } from './source.ts';
import { object, parseExportTimestamp } from './values.ts';

/** Password material remains exact lowercase hex in the private JSON plan.
 * The importer decodes it to bytea; it must never enter a public report. */
export type AdminAccountRow = {
  id: string; appId: string; ownerKey: string; enabled: boolean; credentialVersion: number;
  passwordSalt: string; passwordHash: string; createdAt: string; updatedAt: string | null;
};
const fields = new Set(['_id', 'username', 'enabled', 'role', 'ownerKey', 'passwordVersion', 'passwordDigest', 'createdAtMs', 'updatedAtMs']);
const digestFields = new Set(['algorithm', 'salt', 'hash']);
const canonicalUsername = (value: unknown): value is string => typeof value === 'string' &&
  value === value.trim().toLowerCase() && /^[a-z0-9][a-z0-9_-]{2,63}$/.test(value);
const ownerKey = (value: unknown): value is string => typeof value === 'string' &&
  value === value.trim() && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const milliseconds = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  ? parseExportTimestamp(value) : null;

/** Accounts only: historical audit actors and old sessions cannot create access.
 * Any missing/invalid credential blocks conversion, including a safe projection
 * that intentionally omitted passwordDigest. The caller archives full sources. */
export function normalizeAdminAccounts(documents: unknown, appId: string, issue: IssueReporter): AdminAccountRow[] {
  let failed = false;
  const report = (code: string, field = '-', severity: 'error' | 'notice' = 'error') => {
    if (severity === 'error') failed = true;
    issue('other', code, `WebAdminAccounts.${field}`, severity);
  };
  if (typeof appId !== 'string' || !appId || appId !== appId.trim() || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(appId)) {
    report('INVALID_APP_ID', 'appId');
  }
  if (!Array.isArray(documents)) { report('INVALID_COLLECTION'); return []; }
  const rows: AdminAccountRow[] = [];
  const ids = new Set<string>();
  for (const raw of documents) {
    if (!object(raw)) { report('INVALID_DOCUMENT'); continue; }
    try { serializeSource(raw); } catch { report('INVALID_SOURCE_JSON'); continue; }
    for (const field of Object.keys(raw)) if (!fields.has(field)) report('UNMAPPED_FIELD');
    if (!canonicalUsername(raw._id)) report('INVALID_ADMIN_IDENTITY', '_id');
    else if (ids.has(raw._id)) report('DUPLICATE_SOURCE_ID', '_id');
    else ids.add(raw._id);
    if (!canonicalUsername(raw.username)) report('INVALID_ADMIN_IDENTITY', 'username');
    if (raw._id !== raw.username) report('CONFLICTING_ALIASES', 'username');
    if (raw.role !== 'admin') report('INVALID_ADMIN_ROLE', 'role');
    if (typeof raw.enabled !== 'boolean') report('INVALID_ADMIN_ENABLED', 'enabled');
    if (!ownerKey(raw.ownerKey)) report('INVALID_ADMIN_OWNER', 'ownerKey');
    if (typeof raw.passwordVersion !== 'number' || !Number.isInteger(raw.passwordVersion) ||
      raw.passwordVersion < 1 || raw.passwordVersion > 2147483647) report('INVALID_ADMIN_VERSION', 'passwordVersion');

    let passwordSalt: string | null = null, passwordHash: string | null = null;
    if (raw.passwordDigest === undefined) report('MISSING_ADMIN_CREDENTIALS', 'passwordDigest');
    else if (!object(raw.passwordDigest)) report('INVALID_ADMIN_CREDENTIALS', 'passwordDigest');
    else {
      for (const field of Object.keys(raw.passwordDigest)) if (!digestFields.has(field)) report('UNMAPPED_FIELD', 'passwordDigest');
      if (raw.passwordDigest.algorithm !== 'scrypt') report('UNSUPPORTED_ADMIN_PASSWORD_ALGORITHM', 'passwordDigest.algorithm');
      const { salt, hash } = raw.passwordDigest;
      if (typeof salt !== 'string' || salt.length !== 64 || !/^[a-f0-9]{64}$/.test(salt)) report('INVALID_ADMIN_CREDENTIALS', 'passwordDigest.salt');
      else passwordSalt = salt;
      if (typeof hash !== 'string' || hash.length !== 128 || !/^[a-f0-9]{128}$/.test(hash)) report('INVALID_ADMIN_CREDENTIALS', 'passwordDigest.hash');
      else passwordHash = hash;
    }

    const createdAt = milliseconds(raw.createdAtMs);
    if (!createdAt) report('MISSING_OR_INVALID_TIMESTAMP', 'createdAtMs');
    let updatedAt: string | null = null;
    if (raw.updatedAtMs === undefined || raw.updatedAtMs === null) report('UNKNOWN_UPDATED_AT', 'updatedAtMs', 'notice');
    else {
      updatedAt = milliseconds(raw.updatedAtMs);
      if (!updatedAt) report('MISSING_OR_INVALID_TIMESTAMP', 'updatedAtMs');
    }
    if (createdAt && updatedAt && Date.parse(updatedAt) < Date.parse(createdAt)) report('TIMESTAMP_ORDER', 'updatedAtMs');
    if (canonicalUsername(raw._id) && ownerKey(raw.ownerKey) && typeof raw.enabled === 'boolean' &&
      typeof raw.passwordVersion === 'number' && passwordSalt && passwordHash && createdAt) {
      rows.push({ id: raw._id, appId, ownerKey: raw.ownerKey, enabled: raw.enabled, credentialVersion: raw.passwordVersion,
        passwordSalt, passwordHash, createdAt, updatedAt });
    }
  }
  return failed ? [] : rows.sort((left, right) => left.id.localeCompare(right.id));
}
