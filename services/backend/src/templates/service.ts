import type { Pool, PoolClient } from 'pg';
import { withIdempotency } from '../db.ts';
import { AppError } from '../errors.ts';
import { createTemplateSchema, listTemplatesSchema, templateIdSchema, updateTemplateSchema } from './schemas.ts';
import type { TemplateDefinition } from './schemas.ts';
import { nextWeeklyOccurrence } from './time.ts';

export type TemplateRow = {
  id: string; name: string; weekday: number; localTime: string;
  timeZone: 'America/New_York'; definition: TemplateDefinition; createdAt: Date; updatedAt: Date | null;
};
const columns = 'id,name,weekday,local_time AS "localTime",time_zone AS "timeZone",definition,created_at AS "createdAt",updated_at AS "updatedAt"';
export function templateDto(row: TemplateRow) {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt?.toISOString() ?? null };
}
const notFound = () => new AppError(404, 'TEMPLATE_NOT_FOUND', '未找到出行模板');

export async function templateRows(client: Pool | PoolClient, userId: string, page: number, limit: number, order: 'schedule' | 'created' = 'schedule') {
  const ordering = order === 'created' ? 'created_at DESC,id DESC' : '((weekday + 6) % 7),local_time,id';
  return (await client.query<TemplateRow>(`SELECT ${columns} FROM ride_templates WHERE user_id=$1
    ORDER BY ${ordering} LIMIT $2 OFFSET $3`, [userId, limit + 1, (page - 1) * limit])).rows;
}
export async function getTemplate(client: Pool | PoolClient, userId: string, id: string, lock = false) {
  const row = (await client.query<TemplateRow>(`SELECT ${columns} FROM ride_templates WHERE id=$1 AND user_id=$2${lock ? ' FOR UPDATE' : ''}`,
    [templateIdSchema.parse(id), userId])).rows[0];
  if (!row) throw notFound();
  return row;
}
export async function listTemplates(pool: Pool, userId: string, query: unknown, now = Date.now()) {
  const { page, limit } = listTemplatesSchema.parse(query);
  const rows = await templateRows(pool, userId, page, limit);
  return { items: rows.slice(0, limit).map(row => ({ ...templateDto(row), nextOccurrence: nextWeeklyOccurrence(row, row.definition.stops, now) })),
    page, limit, hasMore: rows.length > limit };
}

export async function createTemplateInTransaction(client: PoolClient, userId: string, body: unknown) {
  const input = createTemplateSchema.parse(body);
  const result = await client.query<TemplateRow>(`INSERT INTO ride_templates(user_id,name,weekday,local_time,time_zone,definition)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${columns}`, [userId, input.name, input.weekday, input.localTime, input.timeZone, input.definition]);
  return { status: 201, data: templateDto(result.rows[0]!) };
}
export async function createTemplate(pool: Pool, userId: string, key: unknown, body: unknown) {
  const input = createTemplateSchema.parse(body);
  return withIdempotency(pool, userId, 'templates.create', key, input, client => createTemplateInTransaction(client, userId, input));
}
export async function updateTemplateInTransaction(client: PoolClient, userId: string, id: string, body: unknown) {
  const templateId = templateIdSchema.parse(id), patch = updateTemplateSchema.parse(body);
  const current = await getTemplate(client, userId, templateId, true);
  const next = createTemplateSchema.parse({ name: current.name, weekday: current.weekday, localTime: current.localTime,
    timeZone: current.timeZone, definition: current.definition, ...patch });
  // Clock time follows any lock wait; the complete definition replaces atomically.
  const updated = await client.query<TemplateRow>(`UPDATE ride_templates SET name=$3,weekday=$4,local_time=$5,time_zone=$6,definition=$7,updated_at=clock_timestamp()
    WHERE id=$1 AND user_id=$2 RETURNING ${columns}`, [templateId, userId, next.name, next.weekday, next.localTime, next.timeZone, next.definition]);
  return { status: 200, data: templateDto(updated.rows[0]!) };
}
export async function updateTemplate(pool: Pool, userId: string, key: unknown, id: unknown, body: unknown) {
  const templateId = templateIdSchema.parse(id), patch = updateTemplateSchema.parse(body);
  return withIdempotency(pool, userId, 'templates.update', key, { templateId, patch }, client => updateTemplateInTransaction(client, userId, templateId, patch));
}
export async function deleteTemplateInTransaction(client: PoolClient, userId: string, id: string) {
  const templateId = templateIdSchema.parse(id);
  const result = await client.query('DELETE FROM ride_templates WHERE id=$1 AND user_id=$2 RETURNING id', [templateId, userId]);
  if (!result.rows.length) throw notFound();
  return { status: 200, data: { id: templateId, deleted: true } };
}
export async function deleteTemplate(pool: Pool, userId: string, key: unknown, id: unknown) {
  const templateId = templateIdSchema.parse(id);
  return withIdempotency(pool, userId, 'templates.delete', key, { templateId }, client => deleteTemplateInTransaction(client, userId, templateId));
}
