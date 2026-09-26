import type { Pool } from 'pg';
import { transaction } from '../db.ts';
import { AppError } from '../errors.ts';
import { fileTargetSchema } from './schemas.ts';
import { assertFileTransactionIsolation } from './service.ts';

export type StorageObject = { provider: 'cloudbase' | 'cos'; locator: string };
export type StorageDeleteAdapter = {
  /** Must be idempotent: a provider NotFound result is success. Never use a
   * caller-supplied alternate locator, and do not overwrite/reuse deleted keys. */
  delete(object: StorageObject): Promise<void>;
};

/** No timer or real storage client is installed by this module. Multiple workers
 * may retry the same immutable locator, including after lost storage/DB ACKs.
 * The committed deleting status prevents attachments throughout those retries. */
export async function deleteQueuedFile(pool: Pool, body: unknown, adapter: StorageDeleteAdapter): Promise<'deleted'> {
  const input = fileTargetSchema.parse(body);
  const object = await transaction(pool, async client => {
    await assertFileTransactionIsolation(client);
    const row = (await client.query<StorageObject & { status: string; legacy_readonly: boolean }>(`SELECT provider,locator,status,legacy_readonly
      FROM files WHERE app_id=$1 AND id=$2 FOR UPDATE`, [input.appId, input.fileId])).rows[0];
    if (!row) throw new AppError(404, 'FILE_NOT_FOUND', '文件不存在');
    if (row.legacy_readonly) throw new AppError(409, 'FILE_READONLY', '历史文件尚未完成引用核对');
    if (row.status !== 'deleting' && row.status !== 'deleted') throw new AppError(409, 'FILE_NOT_QUEUED', '文件未进入删除流程');
    const used = await client.query('SELECT 1 FROM file_references WHERE app_id=$1 AND file_id=$2 LIMIT 1', [input.appId, input.fileId]);
    if (used.rowCount) throw new AppError(409, 'FILE_REFERENCED', '文件仍被引用');
    return row.status === 'deleted' ? null : { provider: row.provider, locator: row.locator };
  });
  if (!object) return 'deleted';
  // Provider failure or an ambiguous ACK leaves the durable retry state intact.
  await adapter.delete(object);
  await transaction(pool, async client => {
    await client.query(`UPDATE files SET status='deleted',updated_at=clock_timestamp()
      WHERE app_id=$1 AND id=$2 AND status='deleting'`, [input.appId, input.fileId]);
  });
  return 'deleted';
}
