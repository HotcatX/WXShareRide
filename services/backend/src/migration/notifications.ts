import type { MigrationIssue, UserRow } from './types.ts';
import { indexMigrationUsers, object, parseExportTimestamp, text } from './values.ts';
import { serializeSource } from './source.ts';

export type NotificationRow = {
  id: string; userId: string; eventId: null; rideId: string | null;
  type: string; title: string; content: string; read: boolean; createdAt: string;
};
const fields = new Set(['_id', '_openid', 'carpoolId', 'content', 'createdAt', 'extra', 'read', 'title', 'type']);
const extraFields = new Set(['passengerOpenid', 'role', 'action', 'tripId', 'driverOpenid', 'requestId', 'by',
  'reason', 'raterOpenid', 'raterRole', 'score', 'targetRole', 'type']);
const identityFields = new Set(['passengerOpenid', 'driverOpenid', 'by', 'raterOpenid']);
const navigationId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value);

/** Pure conversion. Rows are private; only aggregated issues are safe to print. */
export function normalizeLegacyNotifications(documents: unknown, users: readonly Pick<UserRow, 'id' | 'openid' | 'appId'>[], appId: string) {
  const issues: MigrationIssue[] = [];
  const issue = (code: string, field: string, severity: 'error' | 'notice' = 'error') => {
    const existing = issues.find(item => item.code === code && item.field === `Notifications.${field}` && item.severity === severity);
    if (existing) existing.count++;
    else issues.push({ collection: 'other', code, field: `Notifications.${field}`, severity, count: 1 });
  };
  const userMap = indexMigrationUsers(users, appId, (_collection, code, field = '-', severity = 'error') => issue(code, field, severity));
  const rows: NotificationRow[] = [];
  if (!Array.isArray(documents)) { issue('INVALID_COLLECTION', '-'); return { rows: null, issues }; }
  const ids = new Set<string>();
  for (const raw of documents) {
    if (!object(raw)) { issue('INVALID_DOCUMENT', '-'); continue; }
    try { serializeSource(raw); } catch { issue('INVALID_SOURCE_JSON', '-'); continue; }
    for (const key of Object.keys(raw)) if (!fields.has(key)) issue('UNMAPPED_FIELD', '-');
    if (!navigationId(raw._id)) { issue('MISSING_SOURCE_ID', '_id'); continue; }
    if (ids.has(raw._id)) issue('DUPLICATE_SOURCE_ID', '_id');
    ids.add(raw._id);
    const userId = typeof raw._openid === 'string' ? userMap.get(raw._openid)?.id : undefined;
    if (!text(raw._openid) || raw._openid.trim() !== raw._openid || !userId) issue('MISSING_OR_INVALID_IDENTITY', '_openid');
    const createdAt = parseExportTimestamp(raw.createdAt);
    if (!createdAt) issue('MISSING_OR_INVALID_TIMESTAMP', 'createdAt');
    if (!text(raw.type)) issue('INVALID_NOTIFICATION_VALUE', 'type');
    if (typeof raw.title !== 'string') issue('INVALID_NOTIFICATION_VALUE', 'title');
    if (typeof raw.content !== 'string') issue('INVALID_NOTIFICATION_VALUE', 'content');
    if (typeof raw.read !== 'boolean') issue('INVALID_NOTIFICATION_VALUE', 'read');
    const extra = raw.extra === undefined ? {} : raw.extra;
    if (!object(extra)) { issue('INVALID_NOTIFICATION_VALUE', 'extra'); continue; }
    for (const [key, value] of Object.entries(extra)) {
      if (!extraFields.has(key)) { issue('UNMAPPED_FIELD', 'extra'); continue; }
      if (key === 'score') {
        if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 5) issue('INVALID_NOTIFICATION_VALUE', 'extra.score');
      } else if (typeof value !== 'string' || (identityFields.has(key) && (!text(value) || value.trim() !== value)) ||
        (['role', 'raterRole', 'targetRole'].includes(key) && !['driver', 'passenger'].includes(value)) ||
        (key === 'type' && !['carpool', 'request'].includes(value))) issue('INVALID_NOTIFICATION_VALUE', `extra.${key}`);
    }
    if (Object.keys(extra).length) issue('LEGACY_METADATA_ARCHIVED', 'extra', 'notice');
    // These are documented navigation aliases, not evidence that a ride still
    // exists or the recipient may access its members. Never rebuild an event.
    const targets: string[] = [];
    for (const [field, value] of [['carpoolId', raw.carpoolId], ['extra.tripId', extra.tripId], ['extra.requestId', extra.requestId]] as const) {
      if (value === undefined || value === '') continue;
      if (!navigationId(value)) issue('INVALID_NAVIGATION_ID', field);
      else targets.push(value);
    }
    if (new Set(targets).size > 1) issue('CONFLICTING_ALIASES', 'rideId');
    if (userId && createdAt && text(raw.type) && typeof raw.title === 'string' && typeof raw.content === 'string' && typeof raw.read === 'boolean') {
      rows.push({ id: raw._id, userId, eventId: null, rideId: targets[0] ?? null,
        type: raw.type, title: raw.title, content: raw.content, read: raw.read, createdAt });
    }
  }
  return { rows: issues.some(item => item.severity === 'error') ? null : rows, issues };
}
