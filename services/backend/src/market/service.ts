import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { withIdempotency } from '../db.ts';
import { AppError } from '../errors.ts';
import { replaceFileReferences } from '../files/service.ts';
import { marketListingContentSchema, marketListingCreateSchema, marketListingPatchSchema, marketListingStatusSchema } from './schemas.ts';
import type { MarketImage, MarketListingContent } from './schemas.ts';
import { marketListingExpiresAt, validateMarketListingDateWindow } from './time.ts';

const listingIdSchema = z.string().regex(/^[a-zA-Z0-9:_-]{1,160}$/);
const versionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const updateSchema = z.strictObject({ expectedVersion: versionSchema, patch: marketListingPatchSchema });
const statusSchema = marketListingStatusSchema.extend({ expectedVersion: versionSchema });
const deleteSchema = z.strictObject({ expectedVersion: versionSchema });
type Listing = { id: string; app_id: string; status: 'online' | 'offline' | 'sold' | 'deleted';
  version: string; content: MarketListingContent; expires_at: Date };
const notFound = () => new AppError(404, 'LISTING_NOT_FOUND', '商品不存在');

async function lockOwnedListing(client: PoolClient, userId: string, id: string): Promise<Listing> {
  const row = (await client.query<Listing>(`SELECT l.id,l.app_id,l.status,l.version,l.content,l.expires_at
    FROM market_listings l JOIN users u ON u.id=l.owner_user_id AND u.app_id=l.app_id
    WHERE l.id=$1 AND u.id=$2 AND l.status<>'deleted' FOR UPDATE OF l`, [id, userId])).rows[0];
  if (!row) throw notFound();
  return row;
}
function nextVersion(row: Listing, expected: number): number {
  const previous = Number(row.version);
  if (previous !== expected) throw new AppError(409, 'LISTING_VERSION_CONFLICT', '商品已更新，请刷新后重试');
  if (previous >= Number.MAX_SAFE_INTEGER) throw new AppError(409, 'LISTING_VERSION_LIMIT', '商品版本已达到上限');
  return previous + 1;
}
async function replaceImages(client: PoolClient, appId: string, id: string, userId: string, images: MarketImage[]) {
  const references = images.flatMap((image, index) => [
    { slot: `image.${index}`, fileId: image.fileId },
    ...(image.thumbFileId ? [{ slot: `thumbnail.${index}`, fileId: image.thumbFileId }] : []),
  ]);
  await replaceFileReferences(client, { appId, kind: 'listing', id }, references, { userId });
}
const receipt = (id: string, version: number, status: Listing['status']) => ({ id, version, status });

/** User writes only. Website admin operations have separate authorization and
 * receipts; an admin owner key cannot be passed here as a fabricated user. */
export async function createListing(pool: Pool, userId: string, key: unknown, body: unknown) {
  const input = marketListingCreateSchema.parse(body);
  return withIdempotency(pool, userId, 'market.create', key, input, async client => {
    const user = (await client.query<{ app_id: string }>('SELECT app_id FROM users WHERE id=$1 FOR KEY SHARE', [userId])).rows[0];
    if (!user) throw new AppError(401, 'UNAUTHORIZED', '请先登录');
    const { images, ...content } = input;
    const now: Date = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now;
    validateMarketListingDateWindow(content, now);
    const id = randomUUID();
    await client.query(`INSERT INTO market_listings(app_id,id,owner_user_id,content,expires_at)
      VALUES($1,$2,$3,$4,$5)`, [user.app_id, id, userId, content, marketListingExpiresAt(content.endDate)]);
    await replaceImages(client, user.app_id, id, userId, images);
    return { status: 201, data: receipt(id, 0, 'online') };
  });
}

export async function updateListing(pool: Pool, userId: string, key: unknown, id: unknown, body: unknown) {
  const listingId = listingIdSchema.parse(id);
  const input = updateSchema.parse(body);
  return withIdempotency(pool, userId, 'market.update', key, { listingId, ...input }, async client => {
    const row = await lockOwnedListing(client, userId, listingId);
    const version = nextVersion(row, input.expectedVersion);
    const { images, ...patch } = input.patch;
    const content = marketListingContentSchema.parse({ ...row.content, ...patch });
    let expiresAt = row.expires_at;
    // Historical expiry remains exact unless a date/type is explicitly changed.
    // Content, image and status edits must never renew an expired listing.
    if (content.startDate !== row.content.startDate || content.endDate !== row.content.endDate || content.listingType !== row.content.listingType) {
      const now: Date = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now;
      validateMarketListingDateWindow(content, now);
      expiresAt = marketListingExpiresAt(content.endDate);
    }
    if (images !== undefined) await replaceImages(client, row.app_id, listingId, userId, images);
    await client.query(`UPDATE market_listings SET content=$3,expires_at=$4,version=$5,updated_at=clock_timestamp()
      WHERE app_id=$1 AND id=$2`, [row.app_id, listingId, content, expiresAt, version]);
    return { status: 200, data: receipt(listingId, version, row.status) };
  });
}

export async function setListingStatus(pool: Pool, userId: string, key: unknown, id: unknown, body: unknown) {
  const listingId = listingIdSchema.parse(id);
  const input = statusSchema.parse(body);
  return withIdempotency(pool, userId, 'market.status', key, { listingId, ...input }, async client => {
    const row = await lockOwnedListing(client, userId, listingId);
    const version = nextVersion(row, input.expectedVersion);
    if (row.status === input.status) return { status: 200, data: receipt(listingId, Number(row.version), row.status) };
    await client.query(`UPDATE market_listings SET status=$3,version=$4,updated_at=clock_timestamp()
      WHERE app_id=$1 AND id=$2`, [row.app_id, listingId, input.status, version]);
    return { status: 200, data: receipt(listingId, version, input.status) };
  });
}

export async function deleteListing(pool: Pool, userId: string, key: unknown, id: unknown, body: unknown) {
  const listingId = listingIdSchema.parse(id);
  const input = deleteSchema.parse(body);
  return withIdempotency(pool, userId, 'market.delete', key, { listingId, ...input }, async client => {
    const row = await lockOwnedListing(client, userId, listingId);
    const version = nextVersion(row, input.expectedVersion);
    await replaceImages(client, row.app_id, listingId, userId, []);
    await client.query(`UPDATE market_listings SET status='deleted',version=$3,updated_at=clock_timestamp()
      WHERE app_id=$1 AND id=$2`, [row.app_id, listingId, version]);
    // Tombstone and permanent create/delete receipts prevent old retries from
    // recreating a deleted listing. Storage deletion is a separate safe worker.
    return { status: 200, data: receipt(listingId, version, 'deleted') };
  });
}
