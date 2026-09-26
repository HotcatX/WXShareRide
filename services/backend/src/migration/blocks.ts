import type { MigrationIssue, UserRow } from './types.ts';
import { indexMigrationUsers, object, parseExportTimestamp, text } from './values.ts';
import { serializeSource } from './source.ts';

export type BlockRow = { blockerId: string; targetId: string; active: boolean; reason: string; blockedAt: string; updatedAt: string };
const fields = new Set(['_id', '_openid', 'blockerOpenid', 'targetOpenid', 'active', 'reason', 'createdAt', 'updatedAt', 'dedupedAt']);

/** Convert the independent block collection, never userInfo.blockedUsers. */
export function normalizeLegacyBlocks(documents: unknown, users: readonly Pick<UserRow, 'id' | 'openid' | 'appId'>[], appId: string) {
  const issues: MigrationIssue[] = [];
  const issue = (code: string, field: string, severity: 'error' | 'notice' = 'error') => {
    const existing = issues.find(item => item.code === code && item.field === `UserBlocks.${field}` && item.severity === severity);
    if (existing) existing.count++;
    else issues.push({ collection: 'other', code, field: `UserBlocks.${field}`, severity, count: 1 });
  };
  const userMap = indexMigrationUsers(users, appId, (_collection, code, field = '-', severity = 'error') => issue(code, field, severity));
  if (!Array.isArray(documents)) { issue('INVALID_COLLECTION', '-'); return { rows: null, issues }; }
  const groups = new Map<string, BlockRow[]>();
  const ids = new Set<string>();
  for (const raw of documents) {
    if (!object(raw)) { issue('INVALID_DOCUMENT', '-'); continue; }
    try { serializeSource(raw); } catch { issue('INVALID_SOURCE_JSON', '-'); continue; }
    for (const key of Object.keys(raw)) if (!fields.has(key)) issue('UNMAPPED_FIELD', '-');
    if (!text(raw._id) || raw._id.trim() !== raw._id) issue('MISSING_SOURCE_ID', '_id');
    else if (ids.has(raw._id)) issue('DUPLICATE_SOURCE_ID', '_id');
    else ids.add(raw._id);
    const blockerId = typeof raw._openid === 'string' ? userMap.get(raw._openid)?.id : undefined;
    const targetId = typeof raw.targetOpenid === 'string' ? userMap.get(raw.targetOpenid)?.id : undefined;
    if (!text(raw._openid) || raw._openid.trim() !== raw._openid || !blockerId) issue('MISSING_OR_INVALID_IDENTITY', '_openid');
    if (!text(raw.blockerOpenid) || raw.blockerOpenid !== raw._openid) issue('CONFLICTING_ALIASES', 'blockerOpenid');
    if (!text(raw.targetOpenid) || raw.targetOpenid.trim() !== raw.targetOpenid || !targetId) issue('MISSING_OR_INVALID_IDENTITY', 'targetOpenid');
    if (blockerId && blockerId === targetId) issue('SELF_BLOCK', 'targetOpenid');
    if (typeof raw.active !== 'boolean') issue('INVALID_BLOCK_VALUE', 'active');
    if (typeof raw.reason !== 'string' || [...raw.reason].length > 180) issue('INVALID_BLOCK_VALUE', 'reason');
    const blockedAt = parseExportTimestamp(raw.createdAt), updatedAt = parseExportTimestamp(raw.updatedAt);
    if (!blockedAt) issue('MISSING_OR_INVALID_TIMESTAMP', 'createdAt');
    if (!updatedAt) issue('MISSING_OR_INVALID_TIMESTAMP', 'updatedAt');
    if (blockedAt && updatedAt && Date.parse(updatedAt) < Date.parse(blockedAt)) issue('TIMESTAMP_ORDER', 'updatedAt');
    if (raw.dedupedAt !== undefined) {
      if (!parseExportTimestamp(raw.dedupedAt)) issue('MISSING_OR_INVALID_TIMESTAMP', 'dedupedAt');
      else issue('LEGACY_METADATA_ARCHIVED', 'dedupedAt', 'notice');
    }
    if (!blockerId || !targetId || !blockedAt || !updatedAt || typeof raw.active !== 'boolean' || typeof raw.reason !== 'string') continue;
    const row = { blockerId, targetId, active: raw.active, reason: raw.reason, blockedAt, updatedAt };
    const key = JSON.stringify([blockerId, targetId]);
    const group = groups.get(key) ?? [];
    group.push(row); groups.set(key, group);
  }
  const rows: BlockRow[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) { rows.push(group[0]!); continue; }
    const active = group.filter(row => row.active), inactive = group.filter(row => !row.active);
    if (active.length > 1) { issue('MULTIPLE_ACTIVE_BLOCKS', 'pair'); continue; }
    if (active.length === 1) {
      // Old unblock updates every active record; re-block after that creates a
      // new record. A still-active older episode contradicts a later unblock.
      const current = active[0]!;
      if (inactive.some(row => Date.parse(row.updatedAt) > Date.parse(current.blockedAt))) {
        issue('CONFLICTING_BLOCK_HISTORY', 'pair'); continue;
      }
      rows.push(current);
    } else {
      const ordered = [...inactive].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const current = ordered[0]!;
      const tied = ordered.filter(row => row.updatedAt === current.updatedAt);
      if (tied.some(row => row.blockedAt !== current.blockedAt || row.reason !== current.reason)) {
        issue('CONFLICTING_BLOCK_HISTORY', 'pair'); continue;
      }
      rows.push(current);
    }
    issue('BLOCK_HISTORY_COLLAPSED', 'pair', 'notice');
  }
  rows.sort((a, b) => a.blockerId.localeCompare(b.blockerId) || a.targetId.localeCompare(b.targetId));
  return { rows: issues.some(item => item.severity === 'error') ? null : rows, issues };
}
