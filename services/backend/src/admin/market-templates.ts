import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { transaction } from '../db.ts';
import { AppError } from '../errors.ts';
import { marketListingContentSchema, marketListingPatchSchema, marketSellerContactSchema } from '../market/schemas.ts';
import { lockAdmin, withAdminIdempotency } from './service.ts';
import type { AdminIdentity } from './service.ts';

export const marketTemplateIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const marketTemplateNameSchema = z.string().trim().min(1).max(60)
  .refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value), '模板名称不能包含控制字符');
const { images: _images, ...fields } = marketListingPatchSchema.shape;
const seller = marketSellerContactSchema.extend({ avatar: z.literal('') }).superRefine((value, context) => {
  if (!value.name || !(value.wechat || value.phone)) context.addIssue({ code: 'custom', message: '请填写联系人与微信号或电话' });
});

/** A reusable draft uses the same canonical listing fields, with no pictures.
 * A title/dates may be absent: the old save action only required seller/region.
 * Loading a template does not publish it or supply today's dates; publication
 * still validates the complete market listing contract with fresh attachments. */
export const marketTemplateDataSchema = z.strictObject({
  ...fields,
  listingType: fields.listingType.unwrap(),
  priceCents: fields.priceCents.unwrap(),
  region: fields.region.unwrap(),
  sellerContact: seller,
}).superRefine((value, context) => {
  if (value.startDate && value.endDate && value.endDate < value.startDate) {
    context.addIssue({ code: 'custom', path: ['endDate'], message: '结束日期不能早于开始日期' });
  }
  if (value.listingType === 'goods' && value.sublet !== undefined && value.sublet !== null ||
    value.listingType === 'sublet' && value.sublet === null) {
    context.addIssue({ code: 'custom', path: ['sublet'], message: '模板类型与房源内容不一致' });
  }
  if (value.listingType === 'sublet' && value.category !== undefined &&
    !marketListingContentSchema.options[1].shape.category.safeParse(value.category).success) {
    context.addIssue({ code: 'custom', path: ['category'], message: '请选择有效房型' });
  }
});
export type MarketTemplateData = z.infer<typeof marketTemplateDataSchema>;
const saveSchema = z.strictObject({ id: marketTemplateIdSchema.optional(), name: marketTemplateNameSchema, data: marketTemplateDataSchema });
type Row = { id: string; name: string; data: MarketTemplateData };
const notFound = () => new AppError(404, 'MARKET_TEMPLATE_NOT_FOUND', '模板不存在');
const view = (row: Row) => ({ id: row.id, name: row.name, data: marketTemplateDataSchema.parse(row.data) });

export async function listMarketTemplates(pool: Pool, identity: AdminIdentity) {
  return transaction(pool, async client => {
    await lockAdmin(client, identity);
    // All effective administrators share the same library in their app. The
    // original creator/owner is audit provenance, never an access-control list.
    const rows = (await client.query<Row>(`SELECT id,name,data FROM market_templates
      WHERE app_id=$1 AND status='active' ORDER BY updated_at DESC NULLS LAST,id LIMIT 100`, [identity.appId])).rows;
    return { templates: rows.map(view) };
  });
}

export async function saveMarketTemplate(pool: Pool, identity: AdminIdentity, key: unknown, input: unknown) {
  const payload = saveSchema.parse(input);
  return withAdminIdempotency(pool, identity, 'marketTemplate.save', key, payload, async (client, actor) => {
    // Preserve the existing name-to-ID rule, so an id-less save also finds an
    // imported template. The app-scoped primary key provides app isolation.
    const id = payload.id ?? 'web_tpl_' + createHash('sha256')
      .update(`${actor.ownerKey}:${payload.name}`).digest('hex').slice(0, 40);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['market-template', actor.appId, id])]);
    const previous = (await client.query('SELECT id FROM market_templates WHERE app_id=$1 AND id=$2 FOR UPDATE', [actor.appId, id])).rows[0];
    if (payload.id && !previous) throw notFound();
    const row = (await client.query<Row>(`INSERT INTO market_templates(app_id,id,name,data,status,created_by_admin_id,updated_by_admin_id)
      VALUES($1,$2,$3,$4,'active',$5,$5) ON CONFLICT(app_id,id) DO UPDATE SET
      name=EXCLUDED.name,data=EXCLUDED.data,status='active',updated_by_admin_id=EXCLUDED.updated_by_admin_id,updated_at=clock_timestamp()
      RETURNING id,name,data`, [actor.appId, id, payload.name, payload.data, actor.accountId])).rows[0];
    return { status: previous ? 200 : 201, data: { template: view(row) } };
  });
}

export async function deleteMarketTemplate(pool: Pool, identity: AdminIdentity, key: unknown, rawId: unknown) {
  const id = marketTemplateIdSchema.parse(rawId);
  return withAdminIdempotency(pool, identity, 'marketTemplate.delete', key, { id }, async (client, actor) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['market-template', actor.appId, id])]);
    const row = (await client.query(`UPDATE market_templates SET status='deleted',updated_by_admin_id=$3,updated_at=clock_timestamp()
      WHERE app_id=$1 AND id=$2 RETURNING id`, [actor.appId, id, actor.accountId])).rows[0];
    if (!row) throw notFound();
    return { status: 200, data: { id, status: 'deleted' } };
  });
}
