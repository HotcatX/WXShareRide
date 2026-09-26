import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import sharp from 'sharp';
import { z } from 'zod';
import { AppError } from '../errors.ts';
import { idempotencyInput } from '../db.ts';
import { lockAdmin } from '../admin/service.ts';
import type { AdminIdentity } from '../admin/service.ts';
import { confirmFile, reserveFile } from './service.ts';
import type { FileMetadata, FileOwner } from './schemas.ts';

/** A definite missing object is null; timeouts, denied reads and size-limit
 * failures must throw. PUT is create-only, without detached/background retries.
 * An already-existing object may return normally and is always read/verified.
 * The adapter must never resolve PUT while it is still transmitting bytes. */
export type UploadObjectStore = {
  put(locator: string, bytes: Buffer, mediaType: string): Promise<void>;
  read(locator: string, maxBytes: number): Promise<{ body: Buffer; mediaType: string } | null>;
};
export type ImageUploadStorage = { bucket: string; objects: UploadObjectStore };
export const MAX_IMAGE_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 12_000_000;
type UploadResult = { fileId: string; sizeBytes: number; mediaType: string; sha256: string };
type Reservation = { id: string; locator: string; owner_user_id: string | null; admin_owner_key: string | null;
  uploaded_by_admin_id: string | null; size_bytes: string; media_type: string; sha256: string;
  legacy_readonly: boolean; status: 'pending' | 'ready' | 'deleting' | 'deleted' };

const digest = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const conflict = () => new AppError(409, 'UPLOAD_CONTENT_CONFLICT', '该上传编号已用于其他图片');
const invalid = () => new AppError(400, 'INVALID_IMAGE', '请上传不超过 2MB 的有效 JPEG、PNG 或 WebP 图片');

async function inspect(raw: unknown): Promise<{ bytes: Buffer; metadata: FileMetadata; extension: string }> {
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > MAX_IMAGE_UPLOAD_BYTES) throw invalid();
  // Copy before awaits: callers cannot mutate the bytes after their hash has
  // been bound to the durable reservation.
  const bytes = Buffer.from(raw);
  try {
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_IMAGE_PIXELS, animated: true });
    const info = await image.metadata();
    const formats = { jpeg: ['image/jpeg', 'jpg'], png: ['image/png', 'png'], webp: ['image/webp', 'webp'] } as const;
    const format = info.format && formats[info.format as keyof typeof formats];
    if (!format || !info.width || !info.height || info.width * info.height > MAX_IMAGE_PIXELS) throw invalid();
    // metadata alone is just a header check. stats forces a full, bounded
    // decode, including every frame, without retaining a raw pixel buffer.
    await image.stats();
    return { bytes, metadata: { sizeBytes: bytes.length, mediaType: format[0], sha256: digest(bytes) }, extension: format[1] };
  } catch { throw invalid(); }
}

async function shortTransaction<T>(client: PoolClient, work: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try { const result = await work(); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}
function matches(row: Reservation, owner: FileOwner, metadata: FileMetadata) {
  if ('userId' in owner ? row.owner_user_id !== owner.userId :
    row.admin_owner_key !== owner.adminOwnerKey || row.uploaded_by_admin_id !== owner.adminAccountId) {
    throw new AppError(403, 'FILE_OWNER_MISMATCH', '文件归属不匹配');
  }
  if (row.legacy_readonly) throw new AppError(409, 'FILE_READONLY', '历史文件不接受重新上传');
  if (Number(row.size_bytes) !== metadata.sizeBytes || row.media_type !== metadata.mediaType || row.sha256 !== metadata.sha256) throw conflict();
  if (row.status !== 'pending' && row.status !== 'ready') throw new AppError(409, 'FILE_NOT_PENDING', '文件已进入删除流程');
}

async function upload(pool: Pool, appId: string, owner: FileOwner, key: unknown, raw: unknown, storage: ImageUploadStorage,
  authorize: (client: PoolClient) => Promise<void>): Promise<UploadResult> {
  const requestKey = idempotencyInput(key, null).key;
  const bucket = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/).parse(storage.bucket);
  const { bytes, metadata, extension } = await inspect(raw);
  const actor = 'userId' in owner ? ['user', owner.userId] : ['admin', owner.adminAccountId];
  const lock = JSON.stringify(['file-upload', appId, ...actor, requestKey]);
  const client = await pool.connect();
  let discard = false;
  try {
    // Only a connection-level lock spans storage I/O. Both short transactions
    // use THIS connection, avoiding pool exhaustion from nested acquisitions.
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [lock]);
    const file = await shortTransaction(client, async () => {
      await authorize(client);
      const previous = (await client.query<Reservation>(`SELECT id,locator,owner_user_id,admin_owner_key,uploaded_by_admin_id,
        size_bytes,media_type,sha256,legacy_readonly,status FROM files
        WHERE app_id=$1 AND upload_request_key=$2 AND ${'userId' in owner ? 'owner_user_id=$3' : 'uploaded_by_admin_id=$3'} FOR UPDATE`,
      [appId, requestKey, 'userId' in owner ? owner.userId : owner.adminAccountId])).rows[0];
      if (previous) { matches(previous, owner, metadata); return previous; }
      const appPath = createHash('sha256').update(appId).digest('hex').slice(0, 16);
      const locator = `cos://${bucket}/linkx/images/${appPath}/${randomUUID()}.${extension}`;
      const reserved = await reserveFile(client, { appId, owner, provider: 'cos', locator });
      return (await client.query<Reservation>(`UPDATE files SET upload_request_key=$3,size_bytes=$4,media_type=$5,sha256=$6
        WHERE app_id=$1 AND id=$2 RETURNING id,locator,owner_user_id,admin_owner_key,uploaded_by_admin_id,
        size_bytes,media_type,sha256,legacy_readonly,status`, [appId, reserved.id, requestKey, metadata.sizeBytes, metadata.mediaType, metadata.sha256])).rows[0];
    });
    const result = { fileId: file.id, ...metadata };
    if (file.status === 'ready') return result;

    // An earlier PUT may have succeeded while its ACK or our COMMIT was lost.
    // Read first, and do not overwrite even an unexpected object at this key.
    let stored = await storage.objects.read(file.locator, MAX_IMAGE_UPLOAD_BYTES);
    if (!stored) {
      await storage.objects.put(file.locator, bytes, metadata.mediaType);
      stored = await storage.objects.read(file.locator, MAX_IMAGE_UPLOAD_BYTES);
    }
    if (!stored || !Buffer.isBuffer(stored.body) || stored.body.length !== metadata.sizeBytes ||
      stored.mediaType !== metadata.mediaType || digest(stored.body) !== metadata.sha256) {
      throw new AppError(502, 'UPLOAD_VERIFICATION_FAILED', '图片存储校验失败，请重试');
    }
    await shortTransaction(client, async () => {
      await authorize(client);
      await confirmFile(client, { appId, fileId: file.id, owner, metadata });
      if ('adminAccountId' in owner) await client.query(`INSERT INTO admin_audit(app_id,account_id,action,details)
        VALUES($1,$2,'files.upload',$3)`, [appId, owner.adminAccountId, { fileId: file.id, ...metadata }]);
    });
    return result;
  } finally {
    // Also attempt unlock after an ambiguous lock-acquisition ACK. Discard a
    // broken connection instead of returning a session lock to the pool.
    try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lock]); }
    catch { discard = true; }
    client.release(discard);
  }
}

/** The HTTP boundary must pass its verified session user, never a caller ID.
 * Like the other user mutations, the stored app membership is checked again
 * within each transaction. No upload token or OpenID is accepted in the body. */
export function uploadUserImage(pool: Pool, appId: string, userId: string, key: unknown, bytes: unknown, storage: ImageUploadStorage) {
  return upload(pool, appId, { userId }, key, bytes, storage, async client => {
    if (!(await client.query('SELECT 1 FROM users WHERE app_id=$1 AND id=$2 FOR KEY SHARE', [appId, userId])).rowCount) {
      throw new AppError(401, 'UNAUTHORIZED', '请先登录');
    }
  });
}
export function uploadAdminImage(pool: Pool, identity: AdminIdentity, key: unknown, bytes: unknown, storage: ImageUploadStorage) {
  return upload(pool, identity.appId, { adminOwnerKey: identity.ownerKey, adminAccountId: identity.accountId }, key, bytes, storage,
    async client => { await lockAdmin(client, identity); });
}
