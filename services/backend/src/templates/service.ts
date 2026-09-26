import type { Pool } from 'pg';
import { withIdempotency } from '../db.ts';
import { AppError } from '../errors.ts';
import { createTemplateSchema, listTemplatesSchema, templateIdSchema, updateTemplateSchema } from './schemas.ts';
import type { TemplateDefinition } from './schemas.ts';
import { nextWeeklyOccurrence } from './time.ts';

type TemplateRow = {
  id: string; name: string; weekday: number; localTime: string;
  timeZone: 'America/New_York'; definition: TemplateDefinition; createdAt: Date; updatedAt: Date;
};
const columns = 'id,name,weekday,local_time AS "localTime",time_zone AS "timeZone",definition,created_at AS "createdAt",updated_at AS "updatedAt"';
function asDto(row: TemplateRow) {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
const notFound = () => new AppError(404, 'TEMPLATE_NOT_FOUND', '未找到出行模板');

export async function listTemplates(pool: Pool, userId: string, query: unknown, now = Date.now()) {
  const { page, limit } = listTemplatesSchema.parse(query);
  const result = await pool.query<TemplateRow>(`SELECT ${columns} FROM ride_templates WHERE user_id=$1
    ORDER BY ((weekday + 6) % 7), local_time, id LIMIT $2 OFFSET $3`, [userId, limit + 1, (page - 1) * limit]);
  return {
    items: result.rows.slice(0, limit).map(row => ({ ...asDto(row), nextOccurrence: nextWeeklyOccurrence(row, row.definition.stops, now) })),
    page, limit, hasMore: result.rows.length > limit,
  };
}

export async function createTemplate(pool: Pool, userId: string, key: unknown, body: unknown) {
  const input = createTemplateSchema.parse(body);
  return withIdempotency(pool, userId, 'templates.create', key, input, async client => {
    const result = await client.query<TemplateRow>(`INSERT INTO ride_templates(user_id,name,weekday,local_time,time_zone,definition)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${columns}`, [userId, input.name, input.weekday, input.localTime, input.timeZone, input.definition]);
    return { status: 201, data: asDto(result.rows[0]) };
  });
}

export async function updateTemplate(pool: Pool, userId: string, key: unknown, id: unknown, body: unknown) {
  const templateId = templateIdSchema.parse(id);
  const patch = updateTemplateSchema.parse(body);
  return withIdempotency(pool, userId, 'templates.update', key, { templateId, patch }, async client => {
    const previous = await client.query<TemplateRow>(`SELECT ${columns} FROM ride_templates WHERE id=$1 AND user_id=$2 FOR UPDATE`, [templateId, userId]);
    if (!previous.rows.length) throw notFound();
    const current = previous.rows[0];
    const next = createTemplateSchema.parse({ name: current.name, weekday: current.weekday, localTime: current.localTime,
      timeZone: current.timeZone, definition: current.definition, ...patch });
    // Definition replaces as one validated value; no nested partial merge or old aliases.
    // The transaction may have waited for an earlier edit; now() would record
    // its older start time instead of the time this edit actually takes effect.
    const updated = await client.query<TemplateRow>(`UPDATE ride_templates SET name=$3,weekday=$4,local_time=$5,time_zone=$6,definition=$7,updated_at=clock_timestamp()
      WHERE id=$1 AND user_id=$2 RETURNING ${columns}`, [templateId, userId, next.name, next.weekday, next.localTime, next.timeZone, next.definition]);
    return { status: 200, data: asDto(updated.rows[0]) };
  });
}

export async function deleteTemplate(pool: Pool, userId: string, key: unknown, id: unknown) {
  const templateId = templateIdSchema.parse(id);
  return withIdempotency(pool, userId, 'templates.delete', key, { templateId }, async client => {
    const result = await client.query('DELETE FROM ride_templates WHERE id=$1 AND user_id=$2 RETURNING id', [templateId, userId]);
    if (!result.rows.length) throw notFound();
    return { status: 200, data: { id: templateId, deleted: true } };
  });
}
