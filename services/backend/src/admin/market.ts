import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z, ZodError } from 'zod';
import { idempotencyInput, transaction } from '../db.ts';
import { AppError } from '../errors.ts';
import { replaceFileReferences } from '../files/service.ts';
import { marketListingContentSchema, marketListingCreateSchema, marketListingPatchSchema } from '../market/schemas.ts';
import type { MarketImage, MarketListingContent } from '../market/schemas.ts';
import { marketListingExpiresAt, validateMarketListingDateWindow } from '../market/time.ts';
import { lockAdmin, withAdminIdempotency } from './service.ts';
import type { AdminIdentity } from './service.ts';

const idSchema = z.string().regex(/^[a-zA-Z0-9:_-]{1,160}$/);
const batchIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const updateSchema = z.strictObject({ expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), patch: marketListingPatchSchema });
const batchSchema = z.strictObject({ batchId: batchIdSchema, items: z.array(z.unknown()).min(1).max(50) });
const batchItemSchema = z.strictObject({ clientRequestId: batchIdSchema.optional(), externalId: batchIdSchema.optional(), item: marketListingCreateSchema });
type Listing = { id: string; status: 'online' | 'offline' | 'sold'; version: string;
  content: MarketListingContent; expires_at: Date; created_at: Date; updated_at: Date | null };
type BatchSuccess = { index: number; id: string; externalId: string };
type BatchFailure = { index: number; error: string };
type Batch = { id: string; payload_hash: string; payload_format: string; total: number;
  status: 'running' | 'partial' | 'failed' | 'done'; results: BatchSuccess[]; failures: BatchFailure[] };
const notFound = () => new AppError(404, 'LISTING_NOT_FOUND', '商品不存在');

/** This matches the deployed web identity algorithm, including row-key
 * precedence. Plaintext old keys were not persisted and cannot be recovered.
 * Legacy hashes are never manufactured from canonical content here. */
export function adminMarketListingId(ownerKey: string, requestKey: string): string {
  return `web_${createHash('sha256').update(`${ownerKey}:${requestKey}`).digest('hex').slice(0, 48)}`;
}

async function managedListing(client: PoolClient, actor: AdminIdentity, id: string, edit: boolean): Promise<Listing> {
  const row = (await client.query<Listing>(`SELECT id,status,version,content,expires_at,created_at,updated_at
    FROM market_listings WHERE app_id=$1 AND id=$2 AND status<>'deleted'
    AND (admin_owner_key=$3 OR shared_admin_management) FOR ${edit ? 'UPDATE' : 'SHARE'}`,
  [actor.appId, id, actor.ownerKey])).rows[0];
  if (!row) throw notFound();
  return row;
}
async function images(client: PoolClient, appId: string, id: string): Promise<MarketImage[]> {
  const refs = (await client.query<{ slot: string; file_id: string }>(`SELECT r.slot,r.file_id FROM file_references r
    JOIN files f ON f.app_id=r.app_id AND f.id=r.file_id AND f.status='ready'
    WHERE r.app_id=$1 AND r.resource_kind='listing' AND r.resource_id=$2
      AND r.slot ~ '^(image|thumbnail)[.][0-5]$' ORDER BY r.slot`, [appId, id])).rows;
  const bySlot = new Map(refs.map(ref => [ref.slot, ref.file_id]));
  return refs.filter(ref => ref.slot.startsWith('image.')).map(ref => {
    const thumbFileId = bySlot.get(`thumbnail.${ref.slot.split('.')[1]}`);
    return { fileId: ref.file_id, ...(thumbFileId ? { thumbFileId } : {}) };
  });
}
async function replaceImages(client: PoolClient, actor: AdminIdentity, id: string, values: MarketImage[]) {
  await replaceFileReferences(client, { appId: actor.appId, kind: 'listing', id }, values.flatMap((image, index) => [
    { slot: `image.${index}`, fileId: image.fileId },
    ...(image.thumbFileId ? [{ slot: `thumbnail.${index}`, fileId: image.thumbFileId }] : []),
  ]), { adminOwnerKey: actor.ownerKey, adminAccountId: actor.accountId });
}

/** The HTTP caller supplies its normal idempotency header. Bulk uses this same
 * permanent receipt with its old effective row key; no second row ledger. */
async function createWithRequestKey(pool: Pool, actor: AdminIdentity, requestKey: string, raw: unknown) {
  const input = marketListingCreateSchema.parse(raw);
  const id = adminMarketListingId(actor.ownerKey, requestKey);
  return withAdminIdempotency(pool, actor, 'market.create', id, input, async client => {
    if ((await client.query('SELECT 1 FROM market_listings WHERE app_id=$1 AND id=$2', [actor.appId, id])).rowCount) {
      throw new AppError(409, 'LISTING_ID_CONFLICT', '该发布编号已有商品，请查看原商品');
    }
    const { images: attachments, ...content } = input;
    const at: Date = (await client.query('SELECT clock_timestamp() AS at')).rows[0].at;
    validateMarketListingDateWindow(content, at);
    await client.query(`INSERT INTO market_listings(app_id,id,admin_owner_key,content,expires_at)
      VALUES($1,$2,$3,$4,$5)`, [actor.appId, id, actor.ownerKey, content, marketListingExpiresAt(content.endDate)]);
    await replaceImages(client, actor, id, attachments);
    // Only the immutable identity is acknowledged. A replay must not claim the
    // listing still has its original title, status or version after later edits.
    return { status: 201, data: { id } };
  });
}
export async function createAdminMarketListing(pool: Pool, actor: AdminIdentity, key: unknown, body: unknown) {
  const request = idempotencyInput(key, null);
  return createWithRequestKey(pool, actor, request.key, body);
}

export async function getAdminMarketListing(pool: Pool, actor: AdminIdentity, rawId: unknown) {
  const id = idSchema.parse(rawId);
  return transaction(pool, async client => {
    await lockAdmin(client, actor);
    const row = await managedListing(client, actor, id, false);
    return { id, content: marketListingContentSchema.parse(row.content), images: await images(client, actor.appId, id),
      status: row.status, version: Number(row.version), expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at };
  });
}

export async function updateAdminMarketListing(pool: Pool, actor: AdminIdentity, key: unknown, rawId: unknown, body: unknown) {
  const id = idSchema.parse(rawId);
  const input = updateSchema.parse(body);
  return withAdminIdempotency(pool, actor, 'market.update', key, { id, ...input }, async client => {
    const row = await managedListing(client, actor, id, true);
    const previous = Number(row.version);
    if (previous !== input.expectedVersion) throw new AppError(409, 'LISTING_VERSION_CONFLICT', '商品已更新，请刷新后重试');
    if (previous >= Number.MAX_SAFE_INTEGER) throw new AppError(409, 'LISTING_VERSION_LIMIT', '商品版本已达到上限');
    const { images: attachments, ...patch } = input.patch;
    const content = marketListingContentSchema.parse({ ...row.content, ...patch });
    let expiresAt = row.expires_at;
    if (content.startDate !== row.content.startDate || content.endDate !== row.content.endDate || content.listingType !== row.content.listingType) {
      const at: Date = (await client.query('SELECT clock_timestamp() AS at')).rows[0].at;
      validateMarketListingDateWindow(content, at);
      expiresAt = marketListingExpiresAt(content.endDate);
    }
    if (attachments !== undefined) await replaceImages(client, actor, id, attachments);
    await client.query(`UPDATE market_listings SET content=$3,expires_at=$4,version=$5,updated_at=clock_timestamp()
      WHERE app_id=$1 AND id=$2`, [actor.appId, id, content, expiresAt, previous + 1]);
    return { status: 200, data: { id, version: previous + 1, status: row.status } };
  });
}

async function lockBatch(client: PoolClient, actor: AdminIdentity, id: string, hash: string): Promise<Batch | undefined> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['admin-market-batch', actor.appId, actor.ownerKey, id])]);
  await lockAdmin(client, actor);
  const row = (await client.query<Batch>(`SELECT id,payload_hash,payload_format,total,status,results,failures
    FROM market_import_batches WHERE app_id=$1 AND owner_key=$2 AND id=$3 FOR UPDATE`, [actor.appId, actor.ownerKey, id])).rows[0];
  if (row?.payload_format !== undefined && row.payload_format !== 'canonical-v1') {
    throw new AppError(409, 'LEGACY_REQUEST_CONFLICT', '该批次来自旧版发布，请查看原批次');
  }
  if (row && row.payload_hash !== hash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '该批次编号已用于其他内容');
  return row;
}
function batchResult(row: Batch) {
  return { batchId: row.id, total: row.total, status: row.status, success: row.results.length, failed: row.failures.length,
    results: row.results, failures: row.failures };
}
function failureCode(error: unknown): string {
  if (error instanceof ZodError) return 'INVALID_INPUT';
  if (error instanceof AppError) return error.code;
  // Database and internal errors must not expose SQL, field values or file IDs.
  return 'ITEM_SAVE_FAILED';
}

/** Batches deliberately do not use a permanent final-response receipt: failed
 * rows must be retryable. Each successful row has its own atomic permanent
 * admin_requests receipt. Batch locks are released between row transactions. */
export async function bulkCreateAdminMarketListings(pool: Pool, actor: AdminIdentity, body: unknown) {
  const input = batchSchema.parse(body);
  const { hash } = idempotencyInput('market-batch', input);
  const previous = await transaction(pool, async client => {
    const row = await lockBatch(client, actor, input.batchId, hash);
    if (row) return row;
    await client.query(`INSERT INTO market_import_batches(app_id,owner_key,id,payload_hash,payload_format,total,status)
      VALUES($1,$2,$3,$4,'canonical-v1',$5,'running')`, [actor.appId, actor.ownerKey, input.batchId, hash, input.items.length]);
    await client.query(`INSERT INTO admin_audit(app_id,account_id,action,details) VALUES($1,$2,'market.bulkCreate',$3)`,
      [actor.appId, actor.accountId, { batchId: input.batchId, total: input.items.length }]);
    return undefined;
  });
  if (previous?.status === 'done') return batchResult(previous);
  const successes: BatchSuccess[] = [];
  const failures: BatchFailure[] = [];
  for (const [index, raw] of input.items.entries()) {
    const already = previous?.results.find(row => row.index === index);
    if (already) { successes.push(already); continue; }
    try {
      const parsed = batchItemSchema.parse(raw);
      const externalId = parsed.externalId ?? `row_${index + 1}`;
      const key = parsed.clientRequestId ?? (parsed.externalId ? `external_${parsed.externalId}` : `${input.batchId}_${externalId}`);
      const result = await createWithRequestKey(pool, actor, key, parsed.item);
      successes.push({ index, id: result.data.id as string, externalId });
    } catch (error) {
      // Revocation terminates the request, leaving committed rows recoverable on
      // the next authenticated retry rather than pretending a permission error
      // is an ordinary invalid item.
      if (error instanceof AppError && error.status === 401) throw error;
      failures.push({ index, error: failureCode(error) });
    }
  }
  return transaction(pool, async client => {
    const current = await lockBatch(client, actor, input.batchId, hash);
    if (!current) throw new AppError(500, 'BATCH_NOT_FOUND', '批次状态暂不可用');
    if (current.status === 'done') return batchResult(current);
    // A concurrent attempt may already have committed a formerly failed row.
    // Never replace that success with this attempt's earlier failure.
    const merged = new Map(current.results.map(row => [row.index, row]));
    for (const row of successes) merged.set(row.index, row);
    const results = [...merged.values()].sort((a, b) => a.index - b.index);
    const remaining = failures.filter(row => !merged.has(row.index));
    const status = results.length === input.items.length ? 'done' : results.length ? 'partial' : 'failed';
    await client.query(`UPDATE market_import_batches SET status=$4,results=$5,failures=$6,updated_at=clock_timestamp()
      WHERE app_id=$1 AND owner_key=$2 AND id=$3`, [actor.appId, actor.ownerKey, input.batchId, status, JSON.stringify(results), JSON.stringify(remaining)]);
    return batchResult({ ...current, status, results, failures: remaining });
  });
}
