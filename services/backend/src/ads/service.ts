import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withIdempotency } from '../db.ts';
import { AppError } from '../errors.ts';

const adIdSchema = z.string().regex(/^[a-zA-Z0-9:_-]{1,160}$/);
const placementSchema = z.string().trim().min(1).max(80).refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const limitSchema = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().min(1).max(50));
const querySchema = z.strictObject({ placement: placementSchema.default('market_feed'), limit: limitSchema.default(20) });
const clickSchema = z.strictObject({ placement: placementSchema.default('market_feed'), listingType: z.enum(['goods', 'sublet']).default('goods') });

type ContactTarget = { kind: 'contact'; sessionFrom: string; messageCard: { enabled: boolean; title: string; path: string } };
type AdRow = { id: string; placement: string; title: string; subtitle: string; badge_text: string; cta_text: string;
  weight: number; priority: number; target: ContactTarget; image_file_id: string | null; thumb_file_id: string | null };

/** Public display fields only. The client resolves these UUID attachments in
 * a separate step; neither provider locators nor identity records are exposed. */
export async function listAds(pool: Pick<Pool, 'query'>, appId: string, raw: unknown) {
  const query = querySchema.parse(raw);
  const rows = (await pool.query<AdRow>(`SELECT a.id,a.placement,a.title,a.subtitle,a.badge_text,a.cta_text,a.weight,a.priority,a.target,
    (SELECT f.id FROM file_references r JOIN files f ON f.app_id=r.app_id AND f.id=r.file_id AND f.status='ready'
      WHERE r.app_id=a.app_id AND r.resource_kind='ad' AND r.resource_id=a.id AND r.slot='image') AS image_file_id,
    (SELECT f.id FROM file_references r JOIN files f ON f.app_id=r.app_id AND f.id=r.file_id AND f.status='ready'
      WHERE r.app_id=a.app_id AND r.resource_kind='ad' AND r.resource_id=a.id AND r.slot='thumbnail') AS thumb_file_id
    FROM ads a WHERE a.app_id=$1 AND a.placement=$2 AND a.status='online'
      AND (a.start_at IS NULL OR a.start_at<=statement_timestamp())
      AND (a.end_at IS NULL OR a.end_at>=statement_timestamp())
    ORDER BY a.priority DESC,COALESCE(a.updated_at,a.created_at) DESC NULLS LAST,a.id
    LIMIT $3`, [appId, query.placement, query.limit])).rows;
  return { placement: query.placement, items: rows.map(row => ({ id: row.id, placement: row.placement,
    title: row.title, subtitle: row.subtitle, badgeText: row.badge_text, ctaText: row.cta_text,
    weight: row.weight, priority: row.priority, imageFileId: row.image_file_id, thumbFileId: row.thumb_file_id,
    target: { kind: row.target.kind, sessionFrom: row.target.sessionFrom,
      messageCard: { enabled: row.target.messageCard.enabled, title: row.target.messageCard.title, path: row.target.messageCard.path } } })) };
}

/** A tap is not an impression or a successful contact. Cached advertisements
 * may be clicked after removal, so the observation survives a missing ad; it
 * does not create/revive an advertisement or grant any resource permissions.
 * A new tap uses a new key; retrying that tap replays its permanent receipt. */
export async function recordAdClick(pool: Pool, userId: string, key: unknown, id: unknown, body: unknown) {
  const adId = adIdSchema.parse(id);
  const input = clickSchema.parse(body);
  return withIdempotency(pool, userId, 'ads.click', key, { adId, ...input }, async client => {
    const user = (await client.query<{ app_id: string }>('SELECT app_id FROM users WHERE id=$1 FOR KEY SHARE', [userId])).rows[0];
    if (!user) throw new AppError(401, 'UNAUTHORIZED', '请先登录');
    const clickId = randomUUID();
    await client.query(`INSERT INTO ad_clicks(app_id,id,ad_id,placement,listing_type,actor_user_id)
      VALUES($1,$2,$3,$4,$5,$6)`, [user.app_id, clickId, adId, input.placement, input.listingType, userId]);
    return { status: 201, data: { clickId, adId, recorded: true } };
  });
}
