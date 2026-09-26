import type { PoolClient } from 'pg';
import { AppError } from '../errors.ts';
import { confirmFileSchema, fileOwnerSchema, fileReferencesSchema, fileResourceSchema, fileTargetSchema, reserveFileSchema } from './schemas.ts';
import type { FileOwner, FileResource, FileReference } from './schemas.ts';

type FileRow = {
  id: string; app_id: string; provider: 'cloudbase' | 'cos'; locator: string;
  owner_user_id: string | null; admin_owner_key: string | null; uploaded_by_admin_id: string | null; legacy_readonly: boolean;
  status: 'pending' | 'ready' | 'deleting' | 'deleted';
  size_bytes: string | null; media_type: string | null; sha256: string | null;
  verified_at: Date | null; created_at: Date | null; updated_at: Date | null;
};
export type FileRecord = {
  id: string; appId: string; provider: FileRow['provider']; locator: string;
  owner: { userId: string } | { adminOwnerKey: string } | null; uploadedByAdminId: string | null;
  legacyReadonly: boolean; status: FileRow['status'];
  sizeBytes: number | null; mediaType: string | null; sha256: string | null;
  verifiedAt: Date | null; createdAt: Date | null; updatedAt: Date | null;
};
function record(row: FileRow): FileRecord {
  return { id: row.id, appId: row.app_id, provider: row.provider, locator: row.locator,
    owner: row.owner_user_id ? { userId: row.owner_user_id } : row.admin_owner_key ? { adminOwnerKey: row.admin_owner_key } : null,
    uploadedByAdminId: row.uploaded_by_admin_id,
    legacyReadonly: row.legacy_readonly, status: row.status,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes), mediaType: row.media_type, sha256: row.sha256,
    verifiedAt: row.verified_at, createdAt: row.created_at, updatedAt: row.updated_at };
}
function owns(row: FileRow, owner: FileOwner) {
  return 'userId' in owner ? row.owner_user_id === owner.userId : row.admin_owner_key === owner.adminOwnerKey;
}
async function assertOwner(client: PoolClient, appId: string, owner: FileOwner) {
  const result = 'userId' in owner
    ? await client.query('SELECT id FROM users WHERE app_id=$1 AND id=$2 FOR KEY SHARE', [appId, owner.userId])
    : await client.query('SELECT id FROM admin_accounts WHERE app_id=$1 AND id=$2 AND owner_key=$3 AND enabled FOR SHARE',
      [appId, owner.adminAccountId, owner.adminOwnerKey]);
  if (!result.rowCount) throw new AppError(403, 'INVALID_FILE_OWNER', '文件归属无效');
}
async function lockedFile(client: PoolClient, appId: string, fileId: string) {
  const row = (await client.query<FileRow>('SELECT * FROM files WHERE app_id=$1 AND id=$2 FOR UPDATE', [appId, fileId])).rows[0];
  if (!row) throw new AppError(404, 'FILE_NOT_FOUND', '文件不存在');
  return row;
}

/** Lock waits must be followed by a fresh reference snapshot. In REPEATABLE
 * READ, the file row can be unchanged while a new reference was committed by
 * its previous lock holder, so a transaction-wide old snapshot is unsafe. */
export async function assertFileTransactionIsolation(client: PoolClient): Promise<void> {
  const row = (await client.query<{ isolation: string }>("SELECT current_setting('transaction_isolation') AS isolation")).rows[0];
  if (row.isolation !== 'read committed') throw new AppError(500, 'FILE_TRANSACTION_ISOLATION', '文件事务配置无效');
}

/** Trusted upload reservation only, within the caller's transaction. A client
 * supplied locator is never evidence that the caller owns an uploaded object. */
export async function reserveFile(client: PoolClient, body: unknown): Promise<FileRecord> {
  const input = reserveFileSchema.parse(body);
  await assertFileTransactionIsolation(client);
  await assertOwner(client, input.appId, input.owner);
  const row = (await client.query<FileRow>(`INSERT INTO files(app_id,provider,locator,owner_user_id,admin_owner_key,uploaded_by_admin_id)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(provider,locator) DO NOTHING RETURNING *`,
  [input.appId, input.provider, input.locator, 'userId' in input.owner ? input.owner.userId : null,
    'adminOwnerKey' in input.owner ? input.owner.adminOwnerKey : null,
    'adminAccountId' in input.owner ? input.owner.adminAccountId : null])).rows[0];
  if (!row) throw new AppError(409, 'FILE_LOCATOR_EXISTS', '文件位置已被使用');
  return record(row);
}

/** Call only after a trusted provider read verifies the reserved object. This
 * is not an upload endpoint and cannot make arbitrary client metadata trusted. */
export async function confirmFile(client: PoolClient, body: unknown): Promise<FileRecord> {
  const input = confirmFileSchema.parse(body);
  await assertFileTransactionIsolation(client);
  const file = await lockedFile(client, input.appId, input.fileId);
  if (!owns(file, input.owner)) throw new AppError(403, 'FILE_OWNER_MISMATCH', '文件归属不匹配');
  if (file.legacy_readonly) throw new AppError(409, 'FILE_READONLY', '历史文件只允许保留原引用');
  if ('adminAccountId' in input.owner && file.uploaded_by_admin_id !== input.owner.adminAccountId) {
    throw new AppError(403, 'FILE_UPLOADER_MISMATCH', '仅上传账号可确认文件');
  }
  if (file.status !== 'pending' && file.status !== 'ready') throw new AppError(409, 'FILE_NOT_PENDING', '文件已进入删除流程');
  const metadata = input.metadata;
  if (file.status === 'ready') {
    if (Number(file.size_bytes) !== metadata.sizeBytes || file.media_type !== metadata.mediaType || file.sha256 !== metadata.sha256) {
      throw new AppError(409, 'FILE_METADATA_CONFLICT', '文件确认内容不一致');
    }
    return record(file);
  }
  return record((await client.query<FileRow>(`UPDATE files SET status='ready',size_bytes=$3,media_type=$4,sha256=$5,
    verified_at=clock_timestamp(),updated_at=clock_timestamp() WHERE app_id=$1 AND id=$2 RETURNING *`,
  [input.appId, input.fileId, metadata.sizeBytes, metadata.mediaType, metadata.sha256])).rows[0]);
}

/** The business caller must lock and authorize the resource first, in the same
 * transaction. Never expose arbitrary resource IDs or owner contexts to clients.
 * Existing references may retain their files (including reorder), but never
 * authorize a new resource or revive a file already being deleted. */
export async function replaceFileReferences(
  client: PoolClient, resource: FileResource, references: readonly FileReference[], owner: FileOwner,
): Promise<void> {
  const input = fileResourceSchema.parse(resource);
  const next = fileReferencesSchema.parse(references);
  const actor = fileOwnerSchema.parse(owner);
  await assertFileTransactionIsolation(client);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [JSON.stringify(['files.references', input.appId, input.kind, input.id])]);
  const previous = (await client.query<{ file_id: string }>(`SELECT file_id FROM file_references
    WHERE app_id=$1 AND resource_kind=$2 AND resource_id=$3`, [input.appId, input.kind, input.id])).rows;
  const retained = new Set(previous.map(reference => reference.file_id));
  const ids = [...new Set([...retained, ...next.map(reference => reference.fileId)])].sort();
  // Every reference mutation and deletion locks the file. Consistent ordering
  // also prevents two resources swapping files from deadlocking each other.
  const files = (await client.query<FileRow>(`SELECT * FROM files WHERE app_id=$1 AND id=ANY($2::uuid[])
    ORDER BY id FOR UPDATE`, [input.appId, ids])).rows;
  const byId = new Map(files.map(file => [file.id, file]));
  if (files.length !== ids.length) throw new AppError(404, 'FILE_NOT_FOUND', '文件不存在');
  for (const fileId of new Set(next.map(reference => reference.fileId))) {
    const file = byId.get(fileId)!;
    if (file.status !== 'ready') throw new AppError(409, 'FILE_NOT_READY', '文件尚未就绪或已进入删除流程');
    if (!retained.has(file.id)) {
      if (file.legacy_readonly) throw new AppError(409, 'FILE_READONLY', '历史文件只允许保留原引用');
      if (!owns(file, actor)) throw new AppError(403, 'FILE_OWNER_MISMATCH', '文件归属不匹配');
      if ('adminAccountId' in actor && file.uploaded_by_admin_id !== actor.adminAccountId) {
        // Only a current listing proves group sharing. Advertisements,
        // community posts and archived source documents cannot grant it.
        // The file lock makes the fresh read observe any preceding removal
        // of the last reference before deciding whether another may be added.
        const shared = await client.query(`SELECT 1 FROM file_references r
          JOIN market_listings l ON l.app_id=r.app_id AND l.id=r.resource_id
          WHERE r.app_id=$1 AND r.file_id=$2 AND r.resource_kind='listing'
            AND l.status!='deleted' AND (l.admin_owner_key=$3 OR l.shared_admin_management)
          LIMIT 1`, [input.appId, file.id, actor.adminOwnerKey]);
        if (!shared.rowCount) throw new AppError(403, 'FILE_UPLOADER_MISMATCH', '文件尚未由上传账号用于商品');
      }
    }
  }
  await client.query('DELETE FROM file_references WHERE app_id=$1 AND resource_kind=$2 AND resource_id=$3', [input.appId, input.kind, input.id]);
  if (next.length) await client.query(`INSERT INTO file_references(app_id,resource_kind,resource_id,slot,file_id)
    SELECT $1,$2,$3,item->>'slot',(item->>'fileId')::uuid FROM jsonb_array_elements($4::jsonb) AS item`,
  [input.appId, input.kind, input.id, JSON.stringify(next)]);
}

/** Internal deletion admission, not a user deletion API. A failed upload is
 * deliberately not cleaned here: pending uploads need a separate lease/close
 * protocol before storage deletion can be safe. */
export async function queueFileDeletion(client: PoolClient, body: unknown): Promise<'deleting' | 'deleted'> {
  const input = fileTargetSchema.parse(body);
  await assertFileTransactionIsolation(client);
  const file = await lockedFile(client, input.appId, input.fileId);
  if (file.legacy_readonly) throw new AppError(409, 'FILE_READONLY', '历史文件尚未完成引用核对');
  if (file.status === 'pending') throw new AppError(409, 'FILE_UPLOAD_PENDING', '上传尚未关闭');
  const used = await client.query('SELECT 1 FROM file_references WHERE app_id=$1 AND file_id=$2 LIMIT 1', [input.appId, input.fileId]);
  if (used.rowCount) throw new AppError(409, 'FILE_REFERENCED', '文件仍被引用');
  if (file.status === 'deleted') return 'deleted';
  if (file.status === 'ready') await client.query(`UPDATE files SET status='deleting',updated_at=clock_timestamp() WHERE app_id=$1 AND id=$2`, [input.appId, input.fileId]);
  return 'deleting';
}
