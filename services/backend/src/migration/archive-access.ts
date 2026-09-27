import { z } from 'zod';
import type { IssueReporter } from './types.ts';
import { parseExportTimestamp } from './values.ts';

const expectedEmpty = ['sys_user-preview', 'sys_department', 'sys_department-preview',
  'relation_data_depart', 'relation_data_depart-preview'] as const;
export const archivedAccessCollections: readonly string[] = ['MarketAdminSessions', 'WebAdminSessions',
  'WebAdminLoginAttempts', 'sys_user', ...expectedEmpty];

const milliseconds = z.number().int().positive().refine(value => !!parseExportTimestamp(value));
const databaseTime = z.strictObject({ $date: milliseconds });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const openid = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const decimalId = z.string().regex(/^[1-9][0-9]{0,31}$/);
const safeText = z.string().max(2000).regex(/^[^\u0000-\u001f\u007f-\u009f]*$/u);

// Exact retired producer: 9725766^ cloudfunctions/marketApi/index.js,
// createAdminSession/verifyAdminSession. These IDs never become auth receipts.
const marketSession = z.strictObject({
  _id: z.string().regex(/^sess_[a-f0-9]{48}$/), _openid: openid, adminOpenid: openid,
  tokenHash: hash, status: z.literal('active'), createTime: databaseTime, createTimeMs: milliseconds,
  updateTime: databaseTime, updateTimeMs: milliseconds, expiresAtMs: milliseconds,
}).refine(row => row._id === `sess_${row.tokenHash.slice(0, 48)}` && row._openid === row.adminOpenid &&
  row.expiresAtMs - row.createTimeMs === 12 * 60 * 60 * 1000 && row.updateTimeMs >= row.createTimeMs &&
  row.updateTime.$date >= row.createTime.$date);

// webAdminSecurity.js computes expiry before the transaction calls now() for
// createdAtMs, so the observed lifetime is slightly shorter than eight hours.
const webSession = z.strictObject({
  _id: hash, tokenHash: hash, accountId: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/),
  passwordVersion: z.number().int().positive(), status: z.enum(['active', 'revoked']),
  createdAtMs: milliseconds, expiresAtMs: milliseconds, revokedAtMs: milliseconds.optional(),
}).refine(row => row._id === row.tokenHash && row.expiresAtMs > row.createdAtMs &&
  row.expiresAtMs - row.createdAtMs <= 8 * 60 * 60 * 1000 &&
  (row.status === 'active' ? row.revokedAtMs === undefined :
    row.revokedAtMs !== undefined && row.revokedAtMs >= row.createdAtMs));

const webAttempts = z.strictObject({
  _id: z.union([z.literal('global'), hash]), count: z.number().int().min(0),
  windowStartMs: milliseconds, expiresAtMs: milliseconds,
}).refine(row => row.expiresAtMs - row.windowStartMs === 15 * 60 * 1000 &&
  row.count <= (row._id === 'global' ? 120 : 10));

// Tencent's WdMember identifies sys_user as the organization-user model;
// product/1301/82206 documents the administrator's uin/sub_uin/uuid fields.
// This explicitly reviewed default platform administrator is NOT a mini-program
// OpenID, backend user, or website administrator. Other platform roles/fields
// require a new audit rather than silently receiving new application privileges.
const platformAdministrator = z.strictObject({
  _id: decimalId, uuid: decimalId, uin: decimalId, sub_uin: decimalId, app_id: decimalId,
  env_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  name: z.literal('administrator'), createBy: z.literal('administrator'), updateBy: z.literal('administrator'),
  parent_user_id: z.literal(''), type: z.literal(0), source: z.literal(1), internal_user_type: z.literal(1),
  createdAt: milliseconds, updatedAt: milliseconds, user_desc: safeText,
}).refine(row => row._id === row.uuid && row.updatedAt >= row.createdAt);

const schemas = { MarketAdminSessions: marketSession, WebAdminSessions: webSession,
  WebAdminLoginAttempts: webAttempts, sys_user: platformAdministrator } as const;

/** Validate private source evidence only. The central importer preserves its
 * exact JSON/hash in migration_sources; nothing here creates an identity,
 * privilege, session or rate-limit record. No wall-clock expiry assumption:
 * even an active/future old session stays archived. Retiring the old management
 * entry points and requiring new login remains a separate cutover prerequisite. */
export function validateArchivedAccess(name: string, rows: unknown[], issue: IssueReporter): void {
  const reject = (code: string) => issue('other', code, name);
  if (!archivedAccessCollections.includes(name)) { reject('UNSUPPORTED_ACCESS_ARCHIVE'); return; }
  if (!Array.isArray(rows)) { reject('INVALID_ACCESS_ARCHIVE_COLLECTION'); return; }
  if ((expectedEmpty as readonly string[]).includes(name)) {
    if (rows.length) reject('EXPECTED_EMPTY_COLLECTION');
    else issue('other', 'EMPTY_PLATFORM_COLLECTION', name, 'notice');
    return;
  }
  const schema = schemas[name as keyof typeof schemas], ids = new Set<string>();
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (!parsed.success) { reject('INVALID_ACCESS_ARCHIVE_DOCUMENT'); continue; }
    if (ids.has(parsed.data._id)) { reject('DUPLICATE_ACCESS_ARCHIVE_ID'); continue; }
    ids.add(parsed.data._id);
    issue('other', name === 'sys_user' ? 'PLATFORM_ACCOUNT_ARCHIVED' : 'RETIRED_ACCESS_STATE_ARCHIVED', name, 'notice');
  }
}
