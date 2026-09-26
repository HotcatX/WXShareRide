import type { Pool } from 'pg';
import { z } from 'zod';
import type { AdminIdentity } from '../admin/service.ts';
import { lockAdmin } from '../admin/service.ts';
import { transaction } from '../db.ts';
import { AppError } from '../errors.ts';
import type { FileRecord } from './service.ts';

export type FileReadViewer = { userId: string } | { admin: AdminIdentity };
// Internal provider input only. Never return this projection in an HTTP DTO.
export type ReadableFile = Pick<FileRecord, 'id' | 'provider' | 'locator'>;
const idsSchema = z.array(z.uuid().transform(value => value.toLowerCase())).min(1).max(50);
const appSchema = z.string().min(1).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value));
const unavailable = () => new AppError(404, 'FILE_NOT_FOUND', '图片不存在或不可访问');

/** Resolve a whole bounded batch, using trusted server-side viewer identities.
 * User routes must run requireUser before passing userId; admin identities are
 * rechecked under account/session locks here. Invalid supplied authentication
 * must never be silently downgraded to guest access by a route.
 *
 * All content/ref/status/expiry decisions share one statement snapshot and DB
 * clock. This grants read access at that instant; a subsequently signed URL
 * needs a short provider TTL, not a claim of perpetual authorization. No file
 * UUID, same-owner admin account, or old source archive alone grants access.
 */
export async function authorizeFileReads(pool: Pool, appId: string, fileIds: unknown,
  viewer?: FileReadViewer): Promise<ReadableFile[]> {
  appSchema.parse(appId);
  const ids = [...new Set(idsSchema.parse(fileIds))];
  return transaction(pool, async client => {
    let userId: string | null = null, ownerKey: string | null = null, accountId: string | null = null;
    if (viewer && 'admin' in viewer) {
      if (viewer.admin.appId !== appId) throw new AppError(401, 'ADMIN_UNAUTHORIZED', '管理员登录已失效，请重新登录');
      const admin = await lockAdmin(client, viewer.admin);
      ownerKey = admin.ownerKey; accountId = admin.accountId;
    } else if (viewer) {
      userId = z.uuid().transform(value => value.toLowerCase()).parse(viewer.userId);
      if (!(await client.query('SELECT 1 FROM users WHERE app_id=$1 AND id=$2', [appId, userId])).rowCount) {
        throw new AppError(401, 'UNAUTHORIZED', '请先登录');
      }
    }
    // Public community permission follows getCommunity(): enabled controls the
    // group, but a manual announcement remains available with enabled=false.
    // showGroupImage hides the separate announcement image; the group branch
    // already grants its actual displayed image while its own expiry is valid.
    // Keep this formula aligned if community availability is later extracted.
    const rows = (await client.query<ReadableFile>(`
      WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
      SELECT f.id,f.provider,f.locator FROM files f CROSS JOIN clock
      WHERE f.app_id=$1 AND f.id=ANY($2::uuid[]) AND f.status='ready' AND (
        f.owner_user_id=$3::uuid OR
        (f.admin_owner_key=$4::text AND f.uploaded_by_admin_id=$5::text) OR
        EXISTS (
          SELECT 1 FROM file_references r
          JOIN market_listings l ON l.app_id=r.app_id AND l.id=r.resource_id
          WHERE r.app_id=f.app_id AND r.file_id=f.id AND r.resource_kind='listing'
            AND r.slot ~ '^(image|thumbnail)[.][0-5]$' AND l.status!='deleted'
            AND ((l.status='online' AND l.expires_at>clock.at) OR l.owner_user_id=$3::uuid OR
              ($5::text IS NOT NULL AND (l.admin_owner_key=$4::text OR l.shared_admin_management)))
        ) OR EXISTS (
          SELECT 1 FROM file_references r JOIN ads a ON a.app_id=r.app_id AND a.id=r.resource_id
          WHERE r.app_id=f.app_id AND r.file_id=f.id AND r.resource_kind='ad' AND r.slot IN ('image','thumbnail')
            AND a.status='online' AND (a.start_at IS NULL OR a.start_at<=clock.at)
            AND (a.end_at IS NULL OR a.end_at>=clock.at)
        ) OR EXISTS (
          SELECT 1 FROM file_references r JOIN community_configs c ON c.app_id=r.app_id
          WHERE r.app_id=f.app_id AND r.file_id=f.id AND r.resource_kind='community' AND r.resource_id='main' AND (
            ($5::text IS NOT NULL AND (
              r.slot IN ('group','announcement') OR
              (r.slot ~ '^history[.][1-9][0-9]*[.](before|after)[.](group|announcement)$' AND EXISTS (
                SELECT 1 FROM community_revisions h WHERE h.app_id=c.app_id AND h.version::text=split_part(r.slot,'.',2)
              ))
            )) OR
            (r.slot='group' AND c.content#>>'{group,enabled}'='true'
              AND (c.content#>>'{group,expiresAt}')::timestamptz>clock.at) OR
            (r.slot='announcement' AND c.content#>>'{announcement,showGroupImage}'='false'
              AND c.content#>>'{announcement,id}'!=''
              AND ((c.content#>>'{announcement,startAt}') IS NULL OR (c.content#>>'{announcement,startAt}')::timestamptz<=clock.at)
              AND ((c.content#>>'{announcement,endAt}') IS NULL OR (c.content#>>'{announcement,endAt}')::timestamptz>clock.at))
          )
        )
      ) ORDER BY array_position($2::uuid[],f.id)`, [appId, ids, userId, ownerKey, accountId])).rows;
    // Unknown, other-app, unavailable and private UUIDs have the same response.
    // A mixed batch must not return any provider locators on partial success.
    if (rows.length !== ids.length) throw unavailable();
    return rows;
  });
}
