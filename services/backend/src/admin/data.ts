import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { transaction } from '../db.ts';
import { AppError } from '../errors.ts';
import { updateUserInTransaction, updateUserSchema } from '../users/service.ts';
import { lockSuperAdmin, withAdminIdempotency } from './service.ts';
import type { AdminIdentity } from './service.ts';

const owner = (field: string) => `EXISTS(SELECT 1 FROM users u WHERE u.id=t.${field} AND u.app_id=$1)`;
const ride = `EXISTS(SELECT 1 FROM rides r JOIN users u ON u.id=r.creator_id WHERE r.id=t.ride_id AND u.app_id=$1)`;
const scopes: Record<string, string> = {
  users: 't.app_id=$1', rides: owner('creator_id'),
  ride_members: `${ride} AND ${owner('user_id')}`, ride_stops: ride,
  ride_templates: owner('user_id'), notifications: owner('user_id'),
  user_blocks: `${owner('blocker_id')} AND ${owner('target_id')}`,
  ride_ratings: `${ride} AND ${owner('rater_id')} AND ${owner('target_id')}`,
  ride_completions: `${ride} AND ${owner('user_id')}`, business_events: ride,
  public_statistics: 't.app_id=$1', referral_codes: owner('user_id'),
  referral_bindings: `${owner('referred_user_id')} AND ${owner('referrer_user_id')}`,
  files: 't.app_id=$1', file_references: 't.app_id=$1', market_listings: 't.app_id=$1',
  market_views: 't.app_id=$1', market_import_batches: 't.app_id=$1', market_templates: 't.app_id=$1',
  ads: 't.app_id=$1', ad_clicks: 't.app_id=$1', community_configs: 't.app_id=$1',
  community_revisions: 't.app_id=$1', city_requests: owner('user_id'),
  admin_audit: 't.app_id=$1', admin_accounts: 't.app_id=$1', migration_batches: 't.app_id=$1',
  migration_sources: `EXISTS(SELECT 1 FROM migration_batches b WHERE b.id=t.batch_id AND b.app_id=$1)
    AND t.collection IN ('User','Users','user','users','Carpool','CarpoolRequest','CarpoolTemplate','CarpoolRating',
      'CarpoolNotification','MarketGoods','MarketSublet','houseShare')`,
};
const hidden = new Set(['password_hash', 'password_salt']);
const querySchema = z.strictObject({ table: z.string(), limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(4096).optional(), search: z.string().trim().min(1).max(160).optional() });
const editSchema = z.strictObject({ expectedVersion: z.string().regex(/^[a-f0-9]{64}$/), patch: updateUserSchema });
type Column = { name: string; type: string; nullable: boolean };
type Table = { key: string; primaryKey: string[]; columns: Column[]; editableFields: string[] };
const catalogs = new WeakMap<Pool, { until: number; tables: Table[] }>();
const readers = new WeakMap<Pool, number>();
const hash = (row: object) => createHash('sha256').update(JSON.stringify(row)).digest('hex');
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const invalid = () => new AppError(400, 'CONSOLE_INVALID_KEY', '记录编号或分页已失效，请重新查询');
function decode(value: string): unknown {
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(value)) throw invalid();
  try { const result = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (encode(result) !== value) throw invalid(); return result;
  } catch { throw invalid(); }
}
function keyValues(table: Table, raw: unknown): Array<string | number> {
  if (!Array.isArray(raw) || raw.length !== table.primaryKey.length ||
    raw.some(value => !['string', 'number'].includes(typeof value) || String(value).length > 512)) throw invalid();
  raw.forEach((value, index) => {
    const type = table.columns.find(column => column.name === table.primaryKey[index])?.type;
    if (type === 'uuid' && !z.uuid().safeParse(value).success ||
      ['integer', 'bigint', 'smallint'].includes(type ?? '') && !/^-?\d{1,15}$/.test(String(value))) throw invalid();
  });
  return raw;
}
function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > 1_048_576) throw new AppError(413, 'CONSOLE_RESULT_TOO_LARGE', '数据过大，请缩小查询或单独查看记录');
  return value;
}

async function catalog(pool: Pool): Promise<Table[]> {
  const cached = catalogs.get(pool);
  if (cached && cached.until > Date.now()) return cached.tables;
  const rows = (await pool.query<{ table_name: string; column_name: string; data_type: string; is_nullable: string; primary: boolean }>(`
    SELECT c.table_name,c.column_name,c.data_type,c.is_nullable,
      EXISTS(SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage k ON k.constraint_name=tc.constraint_name AND k.constraint_schema=tc.constraint_schema
        WHERE tc.table_schema=c.table_schema AND tc.table_name=c.table_name AND tc.constraint_type='PRIMARY KEY'
          AND k.column_name=c.column_name) AS primary
    FROM information_schema.columns c WHERE c.table_schema=current_schema() AND c.table_name=ANY($1::text[])
    ORDER BY c.table_name,c.ordinal_position`, [Object.keys(scopes)])).rows;
  const tables = Object.keys(scopes).map(key => ({ key,
    primaryKey: rows.filter(row => row.table_name === key && row.primary).map(row => row.column_name),
    columns: rows.filter(row => row.table_name === key && !hidden.has(row.column_name))
      .map(row => ({ name: row.column_name, type: row.data_type, nullable: row.is_nullable === 'YES' })),
    editableFields: key === 'users' ? ['name', 'profile'] : [] })).filter(table => table.primaryKey.length > 0);
  catalogs.set(pool, { until: Date.now() + 300_000, tables });
  return tables;
}
async function tableInfo(pool: Pool, key: string): Promise<Table> {
  const table = (await catalog(pool)).find(table => table.key === key);
  if (!table) throw new AppError(404, 'CONSOLE_TABLE_NOT_FOUND', '请选择有效的数据表');
  return table;
}
function columns(table: Table) { return table.columns.map(column => `t.${quote(column.name)}`).join(','); }
function item(table: Table, row: Record<string, unknown>) {
  return { key: encode(table.primaryKey.map(key => row[key])), row: JSON.parse(JSON.stringify(row)) as Record<string, unknown>, version: hash(row) };
}
async function admitted<T>(pool: Pool, actor: AdminIdentity, work: (client: PoolClient) => Promise<T>): Promise<T> {
  if ((readers.get(pool) ?? 0) >= 2) throw new AppError(503, 'CONSOLE_BUSY', '控制台查询较多，请稍后刷新');
  readers.set(pool, (readers.get(pool) ?? 0) + 1);
  try {
    return await transaction(pool, async client => {
      await client.query("SET LOCAL statement_timeout='2000ms'");
      await lockSuperAdmin(client, actor);
      return bounded(await work(client));
    });
  } finally { readers.set(pool, (readers.get(pool) ?? 1) - 1); }
}
export async function listConsoleTables(pool: Pool, actor: AdminIdentity) {
  const tables = await catalog(pool);
  return admitted(pool, actor, async () => ({ tables }));
}
export async function listConsoleRows(pool: Pool, actor: AdminIdentity, raw: unknown) {
  const input = querySchema.parse(raw), table = await tableInfo(pool, input.table);
  const primary = table.primaryKey.map(quote);
  return admitted(pool, actor, async client => {
    const values: unknown[] = [actor.appId], where = [scopes[table.key]!];
    if (input.cursor) {
      const cursor = decode(input.cursor) as Record<string, unknown>;
      if (!cursor || cursor.table !== table.key || cursor.search !== (input.search ?? null)) throw invalid();
      const after = keyValues(table, cursor.after);
      where.push(`(${primary.map(key => `t.${key}`).join(',')}) > (${after.map(value => { values.push(value); return `$${values.length}`; }).join(',')})`);
    }
    if (input.search) {
      const user = (await client.query<{ id: string }>('SELECT id FROM users WHERE app_id=$1 AND (id::text=$2 OR openid=$2) LIMIT 1', [actor.appId, input.search])).rows[0];
      values.push(input.search); const text = `$${values.length}`;
      if (user) values.push(user.id);
      const match = user ? `$${values.length}` : text;
      const searchable = table.columns.filter(column => table.primaryKey.includes(column.name) ||
        ['openid', 'user_id', 'creator_id', 'owner_user_id', 'actor_id', 'actor_user_id', 'rater_id', 'target_id', 'blocker_id', 'referrer_user_id', 'referred_user_id', 'ride_id', 'listing_id', 'resource_id', 'source_id'].includes(column.name));
      where.push(`(${searchable.map(column => `t.${quote(column.name)}::text IN (${text},${match})`).join(' OR ')})`);
    }
    values.push(input.limit + 1);
    const rows = (await client.query<Record<string, unknown>>(`SELECT ${columns(table)} FROM ${quote(table.key)} t
      WHERE ${where.join(' AND ')} ORDER BY ${primary.map(key => `t.${key}`).join(',')} LIMIT $${values.length}`, values)).rows;
    const page = rows.slice(0, input.limit), last = page.at(-1);
    return { items: page.map(row => item(table, row)), nextCursor: rows.length > input.limit && last
      ? encode({ table: table.key, search: input.search ?? null, after: table.primaryKey.map(key => last[key]) }) : null };
  });
}
async function rowInTransaction(client: PoolClient, actor: AdminIdentity, table: Table, rawKey: string, lock = false) {
  const keys = keyValues(table, decode(rawKey));
  const row = (await client.query<Record<string, unknown>>(`SELECT ${columns(table)} FROM ${quote(table.key)} t
    WHERE ${scopes[table.key]} AND ${table.primaryKey.map((key, index) => `t.${quote(key)}=$${index + 2}`).join(' AND ')} ${lock ? 'FOR UPDATE OF t' : ''}`,
  [actor.appId, ...keys])).rows[0];
  if (!row) throw new AppError(404, 'CONSOLE_ROW_NOT_FOUND', '记录不存在');
  return { ...item(table, row), editableFields: table.editableFields };
}
export async function getConsoleRow(pool: Pool, actor: AdminIdentity, key: string, rowKey: string) {
  const table = await tableInfo(pool, key);
  return admitted(pool, actor, client => rowInTransaction(client, actor, table, rowKey));
}
export async function editConsoleRow(pool: Pool, actor: AdminIdentity, key: string, rowKey: string, requestKey: unknown, raw: unknown) {
  const table = await tableInfo(pool, key);
  if (table.key !== 'users') throw new AppError(403, 'CONSOLE_ROW_READ_ONLY', '该表只读，请使用对应运营功能修改');
  const input = editSchema.parse(raw);
  if (Object.keys(input.patch).some(field => !table.editableFields.includes(field))) throw new AppError(400, 'CONSOLE_FIELD_READ_ONLY', '该字段不可修改');
  return withAdminIdempotency(pool, actor, 'console.edit', requestKey, { table: key, key: rowKey, ...input }, async (client, current) => {
    await client.query("SET LOCAL statement_timeout='2000ms'");
    const previous = await rowInTransaction(client, current, table, rowKey, true);
    if (previous.version !== input.expectedVersion) throw new AppError(409, 'CONSOLE_VERSION_CONFLICT', '记录已更新，请刷新后再保存');
    await updateUserInTransaction(client, String(previous.row.id), input.patch);
    await client.query('INSERT INTO admin_audit(app_id,account_id,action,details) VALUES($1,$2,$3,$4)',
      [current.appId, current.accountId, 'console.user.edit', { table: key, id: previous.row.id, fields: Object.keys(input.patch), beforeVersion: previous.version }]);
    return { status: 200, data: bounded(await rowInTransaction(client, current, table, rowKey)) };
  }, 'superadmin');
}
