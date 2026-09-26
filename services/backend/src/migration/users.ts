import { createHash } from 'node:crypto';
import type { Document, UserRow, IssueReporter } from './types.ts';
import { object, text, present, migrationReaders } from './values.ts';
import { normalizeProfile, profileSourceFields } from './profile.ts';

export const indexFields = ['tripDriver', 'tripDriverHistory', 'tripDriverJoin', 'tripDriverJoinHistory', 'tripPassenger', 'tripPassengerHistory', 'tripPassengerCreate', 'tripPassengerCreateHistory'];
const userFields = new Set([
  '_id', '_openid', 'openid', 'name', 'nickName', 'nickname', 'avatarUrl', 'createdAt', 'createdTime', 'createTime',
  'updatedAt', 'updateTime', 'bigregionUpdatedAt', 'status', 'role', 'userInfo', ...indexFields, ...profileSourceFields,
]);
/** Deterministic UUID for a verified app/OpenID pair; not an authentication mechanism. */
export function migrationUserId(appId: string, openid: string): string {
  const bytes = createHash('sha256').update(JSON.stringify(['linkx-user-v1', appId, openid])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeUsers(documents: unknown[], appId: string, issue: IssueReporter): UserRow[] {
  const { unknownFields, alias, stamp, recordedUpdate } = migrationReaders(issue);
  const users: UserRow[] = [];
  const groups = new Map<string, Document[]>();
  const sourceOnlyFields = new Set(['_id', 'openid', 'role', 'createdAt', 'createdTime', 'createTime', 'updatedAt', 'updateTime', ...indexFields]);
  // Group before selecting a canonical row: export order is not authority.
  for (const raw of documents) {
    if (!object(raw)) { issue('userInfo', 'INVALID_DOCUMENT'); continue; }
    unknownFields(raw, userFields, 'userInfo');
    const openid = alias(raw, ['_openid', 'openid'], 'userInfo', 'openid');
    if (!text(openid) || openid.trim() !== openid) {
      if (!present(raw._openid) && !present(raw.openid) && Object.keys(raw).every(key => sourceOnlyFields.has(key))) {
        issue('userInfo', 'UNATTRIBUTED_SOURCE_ARCHIVED', 'openid', 'notice');
      } else issue('userInfo', 'MISSING_OR_INVALID_IDENTITY', 'openid');
      continue;
    }
    const group = groups.get(openid) ?? [];
    group.push(raw); groups.set(openid, group);
  }
  for (const [openid, group] of groups) {
    const primary = group.filter(raw => raw._openid === openid);
    if (primary.length !== 1) { issue('userInfo', primary.length ? 'DUPLICATE_OPENID' : 'UNVERIFIED_ALIAS_IDENTITY', 'openid'); continue; }
    const raw = primary[0]!;
    for (const duplicate of group.filter(doc => doc !== raw)) {
      if (Object.keys(duplicate).some(key => !sourceOnlyFields.has(key))) issue('userInfo', 'UNVERIFIED_ALIAS_PROFILE', 'openid');
      else issue('userInfo', 'ALIAS_SOURCE_ARCHIVED', 'openid', 'notice');
    }
    if (raw.userInfo !== undefined && (!object(raw.userInfo) ||
      Object.keys(raw.userInfo).some(key => key !== 'appId' && key !== 'openId') ||
      raw.userInfo.appId !== appId || raw.userInfo.openId !== openid)) {
      issue('userInfo', 'CONFLICTING_IDENTITY_CONTEXT', 'userInfo');
    }
    const profile = normalizeProfile(raw, issue);
    if (present(raw.status) && raw.status !== 'normal') issue('userInfo', 'UNMAPPED_ACCOUNT_STATUS', 'status');
    if (present(raw.role)) issue('userInfo', 'LEGACY_ROLE_NOT_MEMBERSHIP', 'role', 'notice');
    const name = alias(raw, ['name', 'nickName', 'nickname'], 'userInfo', 'name');
    if (name !== undefined && typeof name !== 'string') issue('userInfo', 'INVALID_PROFILE_VALUE', 'name');
    if (raw.avatarUrl !== undefined && typeof raw.avatarUrl !== 'string') issue('userInfo', 'INVALID_PROFILE_VALUE', 'avatarUrl');
    const user: UserRow = { id: migrationUserId(appId, openid), appId, openid, name: typeof name === 'string' ? name : '', avatarUrl: typeof raw.avatarUrl === 'string' ? raw.avatarUrl : '', profile, createdAt: stamp(raw, ['createdAt', 'createdTime', 'createTime'], 'userInfo', 'createdAt'), updatedAt: recordedUpdate(raw, ['updatedAt', 'updateTime', 'bigregionUpdatedAt'], 'userInfo') };
    if (user.createdAt && user.updatedAt && user.updatedAt < user.createdAt) issue('userInfo', 'INVALID_TIMESTAMP_ORDER');
    users.push(user);
  }
  return users;
}
