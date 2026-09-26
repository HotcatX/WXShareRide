import type { Pool, PoolClient } from 'pg';
import { AppError } from '../errors.ts';
import { transaction } from '../db.ts';
import { lockAdmin, withAdminIdempotency } from '../admin/service.ts';
import type { AdminIdentity } from '../admin/service.ts';
import { replaceFileReferences } from '../files/service.ts';
import type { FileReference } from '../files/schemas.ts';
import { emptyCommunity, updateCommunitySchema } from './schemas.ts';
import type { CommunityConfig, CommunityContent } from './schemas.ts';

type Row = { version: number; content: CommunityContent; updated_at: Date | null };
type Reference = { slot: string; file_id: string; status: string };
function config(content: CommunityContent, references: readonly Reference[]): CommunityConfig {
  return { group: { ...content.group, imageFileId: references.find(row => row.slot === 'group')?.file_id ?? null },
    announcement: { ...content.announcement, imageFileId: references.find(row => row.slot === 'announcement')?.file_id ?? null } };
}
async function read(client: Pool | PoolClient, appId: string) {
  // Current content, attachments and clock come from the same statement snapshot.
  return (await client.query<{ version: number; content: CommunityContent | null; updated_at: Date | null; at: Date; references: Reference[] }>(`
    SELECT c.version,c.content,c.updated_at,clock_timestamp() AS at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('slot',r.slot,'file_id',r.file_id,'status',f.status) ORDER BY r.slot)
        FROM file_references r JOIN files f ON f.app_id=r.app_id AND f.id=r.file_id
        WHERE r.app_id=$1 AND r.resource_kind='community' AND r.resource_id='main'
          AND r.slot IN ('group','announcement')), '[]'::jsonb) AS references
    FROM (SELECT 1) seed LEFT JOIN community_configs c ON c.app_id=$1`, [appId])).rows[0];
}

export async function getAdminCommunity(pool: Pool, identity: AdminIdentity) {
  return transaction(pool, async client => {
    await lockAdmin(client, identity);
    const row = await read(client, identity.appId);
    return { config: config(row.content ?? emptyCommunity(), row.references), version: row.version ?? 0,
      updatedAt: row.updated_at?.toISOString() ?? null };
  });
}

export async function updateCommunity(pool: Pool, identity: AdminIdentity, key: unknown, body: unknown) {
  const input = updateCommunitySchema.parse(body);
  return withAdminIdempotency(pool, identity, 'community.update', key, input, async client => {
    // Covers an absent singleton too. All writers take this lock before touching
    // current content, its immutable revisions, or its attachment references.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['community', identity.appId])]);
    const previous = (await client.query<Row>('SELECT version,content,updated_at FROM community_configs WHERE app_id=$1 FOR UPDATE', [identity.appId])).rows[0];
    const version = previous?.version ?? 0;
    if (version !== input.expectedVersion) throw new AppError(409, 'COMMUNITY_VERSION_CONFLICT', '社群信息已更新，请刷新后重试');
    const at: Date = (await client.query('SELECT clock_timestamp() AS at')).rows[0].at;
    const { group, announcement } = input.config;
    // Check wall-clock only on a new write, after waits. A retry of an accepted
    // request still replays its receipt even if its content has since expired.
    if (group.enabled && Date.parse(group.expiresAt!) <= at.getTime() ||
      announcement.enabled && announcement.endAt && Date.parse(announcement.endAt) <= at.getTime()) {
      throw new AppError(400, 'COMMUNITY_EXPIRED', '启用内容的有效期已过');
    }
    const { imageFileId: groupImage, ...groupContent } = group;
    const { imageFileId: announcementImage, ...announcementContent } = announcement;
    const after: CommunityContent = { group: groupContent, announcement: announcementContent };
    const before = previous?.content ?? emptyCommunity();
    const nextVersion = version + 1;
    const oldReferences = (await client.query<{ slot: string; file_id: string }>(`SELECT slot,file_id FROM file_references
      WHERE app_id=$1 AND resource_kind='community' AND resource_id='main'`, [identity.appId])).rows;
    const references: FileReference[] = oldReferences.filter(row => row.slot.startsWith('history.')).map(row => ({ slot: row.slot, fileId: row.file_id }));
    for (const row of oldReferences.filter(row => ['group', 'announcement'].includes(row.slot))) {
      references.push({ slot: `history.${nextVersion}.before.${row.slot}`, fileId: row.file_id });
    }
    for (const [slot, fileId] of [['group', groupImage], ['announcement', announcementImage]] as const) {
      if (fileId) references.push({ slot, fileId }, { slot: `history.${nextVersion}.after.${slot}`, fileId });
    }
    await replaceFileReferences(client, { appId: identity.appId, kind: 'community', id: 'main' }, references,
      { adminOwnerKey: identity.ownerKey, adminAccountId: identity.accountId });
    await client.query(`INSERT INTO community_configs(app_id,version,content,updated_by_admin_id,updated_at) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(app_id) DO UPDATE SET version=EXCLUDED.version,content=EXCLUDED.content,
      updated_by_admin_id=EXCLUDED.updated_by_admin_id,updated_at=EXCLUDED.updated_at`, [identity.appId, nextVersion, after, identity.accountId, at]);
    await client.query(`INSERT INTO community_revisions(app_id,id,version,previous_version,before_content,after_content,updated_by_admin_id,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [identity.appId, `v_${nextVersion}`, nextVersion, version, before, after, identity.accountId, at]);
    return { status: 200, data: { config: input.config, version: nextVersion, updatedAt: at.toISOString() } };
  });
}

const cleanDisplayText = (value: string, multiline = false) => {
  const normalized = value.replace(/\r\n?/g, '\n');
  return (multiline ? normalized.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : normalized.replace(/\s+/g, ' ')).trim();
};
export async function getCommunity(pool: Pool, appId: string) {
  const row = await read(pool, appId);
  const { group: g, announcement: a } = config(row.content ?? emptyCommunity(), row.references);
  const now = row.at.getTime();
  const groupEnabled = g.enabled && !!g.imageFileId && !!g.expiresAt && Date.parse(g.expiresAt) > now;
  const endAt = a.showGroupImage && g.expiresAt && (!a.endAt || g.expiresAt < a.endAt) ? g.expiresAt : a.endAt;
  const image = a.showGroupImage ? groupEnabled ? g.imageFileId : null : a.imageFileId;
  const body = cleanDisplayText(a.body, true);
  // Manual viewing remains available while automatic display is disabled.
  const available = !!a.id && !!(body || image) && (!a.startAt || Date.parse(a.startAt) <= now) &&
    (!endAt || now < Date.parse(endAt)) && (!a.showGroupImage || groupEnabled);
  for (const fileId of [groupEnabled ? g.imageFileId : null, available ? image : null]) {
    if (fileId && !row.references.some(reference => reference.file_id === fileId && reference.status === 'ready')) {
      throw new AppError(503, 'COMMUNITY_IMAGE_UNAVAILABLE', '暂时无法加载社群图片，请稍后重试');
    }
  }
  return { serverTime: row.at.toISOString(), group: { enabled: groupEnabled, title: cleanDisplayText(g.title),
    imageFileId: groupEnabled ? g.imageFileId : null, expiresAt: g.expiresAt },
    announcement: { available, enabled: available && a.enabled, id: a.id, title: cleanDisplayText(a.title), body,
      imageFileId: available ? image : null, maxShows: a.maxShows, intervalHours: a.intervalHours, startAt: a.startAt, endAt } };
}
