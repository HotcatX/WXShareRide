import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { legacyCloudFileIdSchema } from './market-images.ts';
import { serializeSource } from './source.ts';
import type { IssueReporter } from './types.ts';
import { object, parseExportTimestamp } from './values.ts';

export type CommunityContent = {
  group: { enabled: boolean; title: string; expiresAt: string | null };
  announcement: { enabled: boolean; id: string; title: string; body: string; showGroupImage: boolean;
    maxShows: number; intervalHours: number; startAt: string | null; endAt: string | null };
};
export type CommunityRow = CommunityContent & {
  id: 'main'; appId: string; version: number; updatedByAdminId: string | null; updatedAt: string | null;
};
export type CommunityRevisionRow = {
  id: string; appId: string; version: number; previousVersion: number;
  before: CommunityContent; after: CommunityContent; updatedByAdminId: string | null; updatedAt: string | null;
};
export type CommunityFileReference = {
  appId: string; resourceKind: 'community'; resourceId: 'main'; slot: string; locator: string;
};
type Context = { appId: string; adminOwners: readonly { accountId: string; ownerKey: string }[] };
type LegacyContent = {
  group: { enabled: boolean; title: string; imageFileID: string; expiresAt: number };
  announcement: { enabled: boolean; id: string; title: string; body: string; imageFileID: string; showGroupImage: boolean;
    maxShows: number; intervalHours: number; startAt: number; endAt: number };
};
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160 &&
  value.trim() === value && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value);
const version = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2147483647;
const configFields = new Set(['_id', 'group', 'announcement', 'version', 'updatedBy', 'updatedAtMs', 'lastRequestHash']);
const revisionFields = new Set(['_id', 'version', 'previousVersion', 'before', 'after', 'updatedBy', 'updatedAtMs']);
const groupFields = new Set(['enabled', 'title', 'imageFileID', 'expiresAt']);
const noticeFields = new Set(['enabled', 'id', 'title', 'body', 'imageFileID', 'showGroupImage', 'maxShows', 'intervalHours', 'startAt', 'endAt']);
const timestamp = (milliseconds: number) => milliseconds ? new Date(milliseconds).toISOString() : null;
function content(value: LegacyContent): CommunityContent {
  const { imageFileID: _groupImage, expiresAt, ...group } = value.group;
  const { imageFileID: _noticeImage, startAt, endAt, ...announcement } = value.announcement;
  return { group: { ...group, expiresAt: timestamp(expiresAt) }, announcement: { ...announcement, startAt: timestamp(startAt), endAt: timestamp(endAt) } };
}

/** Pure singleton/revision conversion. Historical revisions never publish
 * themselves. The caller archives all original documents, including unknown
 * historical actor identities; no actor grants file ownership or authority. */
export function normalizeCommunity(
  input: { configs: unknown; history: unknown }, context: Context, issue: IssueReporter,
): { configs: CommunityRow[]; revisions: CommunityRevisionRow[]; references: CommunityFileReference[] } {
  let failed = false;
  const report = (code: string, field = 'content', severity: 'error' | 'notice' = 'error') => {
    if (severity === 'error') failed = true;
    issue('other', code, `community_config.${field}`, severity);
  };
  const empty = () => ({ configs: [] as CommunityRow[], revisions: [] as CommunityRevisionRow[], references: [] as CommunityFileReference[] });
  if (!input || !Array.isArray(input.configs) || !Array.isArray(input.history)) { report('INVALID_COMMUNITY_COLLECTION'); return empty(); }
  if (!context || !identity(context.appId) || !Array.isArray(context.adminOwners)) { report('INVALID_COMMUNITY_CONTEXT'); return empty(); }
  const admins = new Set<string>();
  for (const admin of context.adminOwners) {
    if (!object(admin) || !id(admin.accountId) || typeof admin.ownerKey !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(admin.ownerKey) || admins.has(admin.accountId)) report('INVALID_COMMUNITY_ADMIN_MAPPING', 'actor');
    else admins.add(admin.accountId);
  }
  if (failed) return empty();
  const unknownFields = (value: Record<string, unknown>, fields: Set<string>) => {
    for (const key of Object.keys(value)) if (!fields.has(key)) report('UNMAPPED_COMMUNITY_FIELD');
  };
  const actor = (value: unknown) => {
    if (value === undefined || value === null) { report('UNKNOWN_COMMUNITY_ACTOR', 'actor', 'notice'); return null; }
    if (!identity(value)) { report('INVALID_COMMUNITY_ACTOR', 'actor'); return null; }
    if (!admins.has(value)) { report('UNKNOWN_COMMUNITY_ACTOR', 'actor', 'notice'); return null; }
    return value;
  };
  const updated = (value: unknown) => {
    if (value === undefined || value === null) { report('UNKNOWN_COMMUNITY_UPDATED_AT', 'updatedAt', 'notice'); return null; }
    const result = typeof value === 'number' ? parseExportTimestamp(value) : null;
    if (!result) report('INVALID_COMMUNITY_TIMESTAMP', 'updatedAt');
    return result;
  };
  const optionalTime = (value: unknown): number => {
    if (value === undefined || value === null || value === '' || value === 0) return 0;
    const result = parseExportTimestamp(value);
    if (!result) { report('INVALID_COMMUNITY_TIMESTAMP', 'window'); return 0; }
    return Date.parse(result);
  };
  const parseContent = (raw: unknown): LegacyContent | null => {
    if (!object(raw) || !object(raw.group) || !object(raw.announcement)) { report('INVALID_COMMUNITY_CONTENT'); return null; }
    unknownFields(raw, new Set(['group', 'announcement']));
    const g = raw.group, a = raw.announcement;
    unknownFields(g, groupFields); unknownFields(a, noticeFields);
    const text = (value: unknown, limit: number, fallback = ''): string => {
      if (typeof value !== 'string') { report('INVALID_COMMUNITY_TEXT'); return ''; }
      // Validate the exact old producer's normalized string rather than losing
      // controls, whitespace or overlong content in a silent conversion.
      const cleaned = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, limit);
      if (cleaned !== value) report('NONCANONICAL_COMMUNITY_TEXT');
      return cleaned || fallback;
    };
    const bool = (value: unknown) => { if (typeof value !== 'boolean') report('INVALID_COMMUNITY_BOOLEAN'); return value === true; };
    const image = (value: unknown) => {
      if (value === '' || value === undefined) return '';
      const parsed = legacyCloudFileIdSchema.safeParse(value);
      if (!parsed.success || Buffer.byteLength(parsed.data, 'utf8') > 1024 || /[%]/.test(parsed.data) ||
        parsed.data.split('/').slice(3).some(part => !part || part === '.' || part === '..')) {
        report('INVALID_COMMUNITY_IMAGE', 'references'); return '';
      }
      return parsed.data;
    };
    // Fixed field order is also the exact old producer's idempotency hash input.
    const group = { enabled: bool(g.enabled), title: text(g.title, 80, '加入拼车群'), imageFileID: image(g.imageFileID), expiresAt: optionalTime(g.expiresAt) };
    const announcement = { enabled: bool(a.enabled), id: text(a.id, 128), title: text(a.title, 80, '最新消息'), body: text(a.body, 2000),
      imageFileID: image(a.imageFileID), showGroupImage: bool(a.showGroupImage), maxShows: a.maxShows as number,
      intervalHours: a.intervalHours as number, startAt: optionalTime(a.startAt), endAt: optionalTime(a.endAt) };
    if (announcement.id && !/^[a-zA-Z0-9_-]{1,128}$/.test(announcement.id)) report('INVALID_COMMUNITY_ANNOUNCEMENT_ID');
    if (!Number.isInteger(announcement.maxShows) || announcement.maxShows < 1 || announcement.maxShows > 100 ||
      typeof announcement.intervalHours !== 'number' || !Number.isFinite(announcement.intervalHours) || announcement.intervalHours < 0 || announcement.intervalHours > 8760) report('INVALID_COMMUNITY_FREQUENCY');
    if (announcement.startAt && announcement.endAt && announcement.startAt >= announcement.endAt) report('INVALID_COMMUNITY_WINDOW');
    if (group.enabled && (!group.imageFileID || !group.expiresAt)) report('INVALID_COMMUNITY_GROUP');
    if (announcement.enabled && (!announcement.id || !(announcement.body || announcement.imageFileID || announcement.showGroupImage && group.enabled) ||
      announcement.showGroupImage && !group.enabled)) report('INVALID_COMMUNITY_ANNOUNCEMENT');
    // Never compare against today's clock: expired historical configurations
    // remain history, and availability is derived at request time by the reader.
    return { group, announcement };
  };
  const references: CommunityFileReference[] = [];
  const appendReferences = (value: LegacyContent, prefix: string) => {
    for (const section of ['group', 'announcement'] as const) {
      const locator = value[section].imageFileID;
      if (!locator) continue;
      const slot = `${prefix}${section}`;
      if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(slot)) { report('INVALID_COMMUNITY_FILE_SLOT', 'references'); continue; }
      references.push({ appId: context.appId, resourceKind: 'community', resourceId: 'main', slot, locator });
    }
  };
  const revisions: CommunityRevisionRow[] = [];
  const fullRevisions = new Map<number, { before: LegacyContent; after: LegacyContent }>();
  const revisionActors = new Map<number, unknown>();
  const sourceIds = new Set<string>();
  for (const raw of input.history) {
    try { serializeSource(raw); } catch { report('INVALID_SOURCE_JSON'); continue; }
    if (!object(raw)) { report('INVALID_COMMUNITY_REVISION'); continue; }
    unknownFields(raw, revisionFields);
    if (!id(raw._id) || sourceIds.has(raw._id) || !version(raw.version) || !raw.version || fullRevisions.has(raw.version) ||
      !version(raw.previousVersion) || raw.version !== raw.previousVersion + 1) { report('INVALID_COMMUNITY_REVISION'); continue; }
    sourceIds.add(raw._id);
    const before = parseContent(raw.before), after = parseContent(raw.after);
    if (!before || !after) continue;
    fullRevisions.set(raw.version, { before, after });
    revisionActors.set(raw.version, raw.updatedBy);
    revisions.push({ id: raw._id, appId: context.appId, version: raw.version, previousVersion: raw.previousVersion,
      before: content(before), after: content(after), updatedByAdminId: actor(raw.updatedBy), updatedAt: updated(raw.updatedAtMs) });
    appendReferences(before, `history.${raw.version}.before.`); appendReferences(after, `history.${raw.version}.after.`);
  }
  revisions.sort((left, right) => left.version - right.version);
  for (let index = 0; index < revisions.length; index++) {
    const row = revisions[index]!, previous = revisions[index - 1];
    if (row.version !== index + 1) report('INCOMPLETE_COMMUNITY_HISTORY', 'history');
    if (previous && !isDeepStrictEqual(fullRevisions.get(previous.version)!.after, fullRevisions.get(row.version)!.before)) report('CONFLICTING_COMMUNITY_HISTORY', 'history');
    if (previous?.updatedAt && row.updatedAt && previous.updatedAt > row.updatedAt) report('INVALID_COMMUNITY_TIMESTAMP_ORDER', 'history');
  }

  const configs: CommunityRow[] = [];
  if (input.configs.length > 1 || !input.configs.length && input.history.length) report('INVALID_COMMUNITY_SINGLETON');
  for (const raw of input.configs) {
    try { serializeSource(raw); } catch { report('INVALID_SOURCE_JSON'); continue; }
    if (!object(raw)) { report('INVALID_COMMUNITY_DOCUMENT'); continue; }
    unknownFields(raw, configFields);
    if (raw._id !== 'main' || !version(raw.version)) { report('INVALID_COMMUNITY_SINGLETON'); continue; }
    const full = parseContent({ group: raw.group, announcement: raw.announcement });
    if (!full) continue;
    if (raw.version > 0 || raw.lastRequestHash !== undefined) {
      const expected = createHash('sha256').update(JSON.stringify(full)).digest('hex');
      if (typeof raw.lastRequestHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.lastRequestHash) || raw.lastRequestHash !== expected) report('COMMUNITY_REQUEST_HASH_MISMATCH', 'lastRequestHash');
    }
    const latest = revisions.at(-1);
    if (raw.version !== (latest?.version ?? 0) || latest && !isDeepStrictEqual(fullRevisions.get(latest.version)!.after, full)) report('COMMUNITY_CURRENT_HISTORY_MISMATCH', 'history');
    const updatedAt = updated(raw.updatedAtMs), updatedByAdminId = actor(raw.updatedBy);
    if (latest?.updatedAt && updatedAt && latest.updatedAt > updatedAt) report('INVALID_COMMUNITY_TIMESTAMP_ORDER', 'updatedAt');
    if (latest && raw.updatedBy !== revisionActors.get(latest.version)) report('COMMUNITY_CURRENT_ACTOR_MISMATCH', 'actor');
    configs.push({ id: 'main', appId: context.appId, version: raw.version, ...content(full), updatedByAdminId, updatedAt });
    appendReferences(full, '');
  }
  return failed ? empty() : { configs, revisions, references };
}
