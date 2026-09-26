import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { transaction } from '../src/db.ts';
import { confirmFile, queueFileDeletion, replaceFileReferences, reserveFile } from '../src/files/service.ts';
import { deleteQueuedFile } from '../src/files/worker.ts';
import type { FileOwner, FileResource } from '../src/files/schemas.ts';
import type { StorageObject } from '../src/files/worker.ts';
import { createTestDatabase } from './helpers/database.ts';

const appId = 'files-fixture';
const metadata = { sizeBytes: 1200, mediaType: 'image/jpeg', sha256: 'a'.repeat(64) };
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
const target = (fileId: string) => ({ appId, fileId });
const resource = (kind: FileResource['kind'] = 'listing'): FileResource => ({ appId, kind, id: randomUUID() });
async function user(pool: Pool, application = appId): Promise<FileOwner> {
  const row = (await pool.query<{ id: string }>('INSERT INTO users(app_id,openid) VALUES($1,$2) RETURNING id', [application, randomUUID()])).rows[0];
  return { userId: row.id };
}
async function ready(pool: Pool, owner: FileOwner, provider: 'cloudbase' | 'cos' = 'cloudbase') {
  return transaction(pool, async client => {
    const file = await reserveFile(client, { appId, owner, provider, locator: `${provider}://fixture/${randomUUID()}.jpg` });
    return confirmFile(client, { ...target(file.id), owner, metadata });
  });
}
async function state(pool: Pool, fileId: string) {
  return (await pool.query('SELECT status,locator,verified_at FROM files WHERE id=$1', [fileId])).rows[0];
}
async function references(pool: Pool, item: FileResource) {
  return (await pool.query('SELECT slot,file_id FROM file_references WHERE app_id=$1 AND resource_kind=$2 AND resource_id=$3 ORDER BY slot',
    [item.appId, item.kind, item.id])).rows;
}
async function waitForLock(pool: Pool, pid: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const row = (await pool.query<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])).rows[0];
    if (row.blocked) return;
    await setTimeout(5);
  }
  assert.fail('Expected a real PostgreSQL lock wait');
}
function competing<T>(pool: Pool, work: (client: PoolClient) => Promise<T>) {
  let entered!: (pid: number) => void;
  const pid = new Promise<number>(resolve => { entered = resolve; });
  // Observe rejection immediately so the lock scheduler cannot leave an
  // unhandled promise while it asserts the database's actual waiting state.
  const result = transaction(pool, async client => {
    entered((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    return work(client);
  }).then(value => ({ value, error: null }), error => ({ value: null, error }));
  return { pid, result };
}

test('file ownership, references and deletion use real PostgreSQL transactions',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL, timeout: 30000 }, async t => {
    const db = await createTestDatabase();
    t.after(db.close);
    const { pool } = db;
    const owner = await user(pool);

    await t.test('reserve is pending; only trusted confirmation makes it attachable; retries preserve verification time', async () => {
      const file = await transaction(pool, client => reserveFile(client, { appId, owner, provider: 'cos', locator: `bucket/key-${randomUUID()}` }));
      assert.equal(file.status, 'pending'); assert.equal(file.verifiedAt, null); assert.deepEqual(file.owner, owner);
      const item = resource();
      await assert.rejects(transaction(pool, client => replaceFileReferences(client, item, [{ slot: 'image.0', fileId: file.id }], owner)), code('FILE_NOT_READY'));
      await assert.rejects(transaction(pool, client => queueFileDeletion(client, target(file.id))), code('FILE_UPLOAD_PENDING'));
      await assert.rejects(deleteQueuedFile(pool, target(file.id), { async delete() { assert.fail('pending storage must not be touched'); } }), code('FILE_NOT_QUEUED'));
      const first = await transaction(pool, client => confirmFile(client, { ...target(file.id), owner, metadata }));
      const second = await transaction(pool, client => confirmFile(client, { ...target(file.id), owner, metadata }));
      assert.equal(first.status, 'ready'); assert.deepEqual(first, second); assert.ok(first.verifiedAt instanceof Date);
      await assert.rejects(transaction(pool, client => confirmFile(client, { ...target(file.id), owner, metadata: { ...metadata, sizeBytes: 1201 } })), code('FILE_METADATA_CONFLICT'));
      await assert.rejects(transaction(pool, client => reserveFile(client, { appId, owner, provider: 'cos', locator: file.locator })), code('FILE_LOCATOR_EXISTS'));
    });

    await t.test('new ownership is app-scoped and administrators must belong to an enabled owner range', async () => {
      const foreign = await user(pool, 'other-app');
      await assert.rejects(transaction(pool, client => reserveFile(client, { appId, owner: foreign, provider: 'cos', locator: 'foreign-key' })), code('INVALID_FILE_OWNER'));
      await assert.rejects(transaction(pool, client => reserveFile(client, { appId, owner: { userId: randomUUID() }, provider: 'cos', locator: 'missing-key' })), code('INVALID_FILE_OWNER'));
      const admin = { adminOwnerKey: 'shared-fixture-owner' };
      await assert.rejects(transaction(pool, client => reserveFile(client, { appId, owner: admin, provider: 'cos', locator: 'missing-admin' })), code('INVALID_FILE_OWNER'));
      await pool.query(`INSERT INTO admin_accounts(app_id,id,owner_key,enabled,credential_version) VALUES
        ($1,'admin-one',$2,false,1),($1,'admin-two',$2,false,1)`, [appId, admin.adminOwnerKey]);
      await assert.rejects(transaction(pool, client => reserveFile(client, { appId, owner: admin, provider: 'cos', locator: 'disabled-admin' })), code('INVALID_FILE_OWNER'));
      await pool.query("UPDATE admin_accounts SET enabled=true WHERE app_id=$1 AND id='admin-two'", [appId]);
      const file = await ready(pool, admin);
      assert.deepEqual(file.owner, admin);
      const other = await user(pool);
      await assert.rejects(transaction(pool, client => confirmFile(client, { ...target(file.id), owner: other, metadata })), code('FILE_OWNER_MISMATCH'));
      await assert.rejects(transaction(pool, client => replaceFileReferences(client, resource(), [{ slot: 'image.0', fileId: file.id }], other)), code('FILE_OWNER_MISMATCH'));
      await assert.rejects(transaction(pool, client => replaceFileReferences(client, { ...resource(), appId: 'other-app' }, [{ slot: 'image.0', fileId: file.id }], admin)), code('FILE_NOT_FOUND'));
      await assert.rejects(transaction(pool, client => queueFileDeletion(client, { appId: 'other-app', fileId: file.id })), code('FILE_NOT_FOUND'));
    });

    await t.test('shared originals and thumbnails remain protected until the final resource releases them', async () => {
      const file = await ready(pool, owner);
      const a = resource(), b = resource(), ad = resource('ad');
      for (const item of [a, b, ad]) await transaction(pool, client => replaceFileReferences(client, item,
        [{ slot: 'image.0', fileId: file.id }, { slot: 'thumbnail.0', fileId: file.id }], owner));
      await transaction(pool, client => replaceFileReferences(client, a, [], owner));
      await assert.rejects(transaction(pool, client => queueFileDeletion(client, target(file.id))), code('FILE_REFERENCED'));
      await transaction(pool, client => replaceFileReferences(client, b, [], owner));
      await assert.rejects(transaction(pool, client => queueFileDeletion(client, target(file.id))), code('FILE_REFERENCED'));
      await transaction(pool, client => replaceFileReferences(client, ad, [], owner));
      assert.equal(await transaction(pool, client => queueFileDeletion(client, target(file.id))), 'deleting');
      assert.equal(await transaction(pool, client => queueFileDeletion(client, target(file.id))), 'deleting');
    });

    await t.test('one physical object cannot be reserved again under another app or owner', async () => {
      const file = await ready(pool, owner), item = resource();
      await transaction(pool, client => replaceFileReferences(client, item, [{ slot: 'image.0', fileId: file.id }], owner));
      const before = (await pool.query('SELECT * FROM files WHERE id=$1', [file.id])).rows[0];
      const priorReferences = await references(pool, item);
      const foreign = await user(pool, 'physical-other-app');
      await assert.rejects(transaction(pool, client => reserveFile(client, {
        appId: 'physical-other-app', owner: foreign, provider: file.provider, locator: file.locator,
      })), code('FILE_LOCATOR_EXISTS'));
      const differentOwner = await user(pool);
      await assert.rejects(transaction(pool, client => reserveFile(client, {
        appId, owner: differentOwner, provider: file.provider, locator: file.locator,
      })), code('FILE_LOCATOR_EXISTS'));
      assert.deepEqual((await pool.query('SELECT * FROM files WHERE id=$1', [file.id])).rows[0], before);
      assert.deepEqual(await references(pool, item), priorReferences);
      await assert.rejects(transaction(pool, client => queueFileDeletion(client, target(file.id))), code('FILE_REFERENCED'));
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM files WHERE provider=$1 AND locator=$2', [file.provider, file.locator])).rows[0].count, 1);
      // Direct imports are subject to the same physical uniqueness constraint.
      await assert.rejects(pool.query(`INSERT INTO files(app_id,provider,locator,legacy_readonly,status)
        VALUES('physical-other-app',$1,$2,true,'ready')`, [file.provider, file.locator]), code('23505'));
    });

    await t.test('business rollback preserves the complete old references and validation never partially replaces them', async () => {
      const first = await ready(pool, owner), next = await ready(pool, owner);
      const item = resource('community');
      await transaction(pool, client => replaceFileReferences(client, item, [{ slot: 'image.0', fileId: first.id }], owner));
      const before = await references(pool, item);
      await assert.rejects(transaction(pool, async client => {
        await replaceFileReferences(client, item, [{ slot: 'image.0', fileId: next.id }], owner);
        throw new Error('synthetic business transaction failed');
      }), /synthetic business/);
      assert.deepEqual(await references(pool, item), before);
      await assert.rejects(transaction(pool, client => replaceFileReferences(client, item,
        [{ slot: 'image.0', fileId: first.id }, { slot: 'image.1', fileId: randomUUID() }], owner)), code('FILE_NOT_FOUND'));
      assert.deepEqual(await references(pool, item), before);
    });

    await t.test('legacy files preserve only their existing resource references and cannot be confirmed or automatically deleted', async () => {
      const fileId = randomUUID(), item = resource('ad');
      await pool.query(`INSERT INTO files(id,app_id,provider,locator,legacy_readonly,status)
        VALUES($1,$2,'cloudbase',$3,true,'ready')`, [fileId, appId, `cloud://fixture/legacy/${randomUUID()}`]);
      // Historical import, not the attachment API, installs the proven edges.
      await pool.query(`INSERT INTO file_references(app_id,resource_kind,resource_id,slot,file_id) VALUES($1,$2,$3,'image.0',$4)`,
        [appId, item.kind, item.id, fileId]);
      await transaction(pool, client => replaceFileReferences(client, item, [{ slot: 'image.1', fileId }], owner));
      assert.deepEqual(await references(pool, item), [{ slot: 'image.1', file_id: fileId }]);
      await assert.rejects(transaction(pool, client => replaceFileReferences(client, resource('ad'), [{ slot: 'image.0', fileId }], owner)), code('FILE_READONLY'));
      // Even an old ledger user claim is not trusted upload proof.
      await pool.query('UPDATE files SET owner_user_id=$2 WHERE id=$1', [fileId, 'userId' in owner ? owner.userId : null]);
      await assert.rejects(transaction(pool, client => confirmFile(client, { ...target(fileId), owner, metadata })), code('FILE_READONLY'));
      await assert.rejects(transaction(pool, client => queueFileDeletion(client, target(fileId))), code('FILE_READONLY'));
      await transaction(pool, client => replaceFileReferences(client, item, [], owner));
      await assert.rejects(transaction(pool, client => replaceFileReferences(client, item, [{ slot: 'image.0', fileId }], owner)), code('FILE_READONLY'));
      await assert.rejects(deleteQueuedFile(pool, target(fileId), { async delete() { assert.fail('readonly storage must not be touched'); } }), code('FILE_READONLY'));
    });

    await t.test('attachment that locks first makes a waiting deletion observe the committed reference', async () => {
      const file = await ready(pool, owner), item = resource();
      const holder = await pool.connect();
      let other: ReturnType<typeof competing> | undefined;
      try {
        await holder.query('BEGIN');
        await replaceFileReferences(holder, item, [{ slot: 'image.0', fileId: file.id }], owner);
        other = competing(pool, client => queueFileDeletion(client, target(file.id)));
        await waitForLock(pool, await other.pid);
        await holder.query('COMMIT');
        assert.ok(code('FILE_REFERENCED')((await other.result).error));
        assert.equal((await state(pool, file.id)).status, 'ready');
      } finally { await holder.query('ROLLBACK'); holder.release(); await other?.result; }
    });

    await t.test('deletion that locks first makes a waiting attachment reject the committed deleting state', async () => {
      const file = await ready(pool, owner), item = resource();
      const holder = await pool.connect();
      let other: ReturnType<typeof competing> | undefined;
      try {
        await holder.query('BEGIN');
        await queueFileDeletion(holder, target(file.id));
        other = competing(pool, client => replaceFileReferences(client, item, [{ slot: 'image.0', fileId: file.id }], owner));
        await waitForLock(pool, await other.pid);
        await holder.query('COMMIT');
        assert.ok(code('FILE_NOT_READY')((await other.result).error));
        assert.deepEqual(await references(pool, item), []);
        assert.equal((await state(pool, file.id)).status, 'deleting');
      } finally { await holder.query('ROLLBACK'); holder.release(); await other?.result; }
    });

    await t.test('same-resource serialization cannot retain a legacy edge removed by the preceding transaction', async () => {
      const item = resource('community'), fileId = randomUUID();
      await pool.query(`INSERT INTO files(id,app_id,provider,locator,legacy_readonly,status) VALUES($1,$2,'cos',$3,true,'ready')`, [fileId, appId, `legacy/${randomUUID()}`]);
      await pool.query(`INSERT INTO file_references(app_id,resource_kind,resource_id,slot,file_id) VALUES($1,$2,$3,'image.0',$4)`, [appId, item.kind, item.id, fileId]);
      const holder = await pool.connect();
      let other: ReturnType<typeof competing> | undefined;
      try {
        await holder.query('BEGIN');
        await replaceFileReferences(holder, item, [], owner);
        other = competing(pool, client => replaceFileReferences(client, item, [{ slot: 'image.1', fileId }], owner));
        await waitForLock(pool, await other.pid);
        await holder.query('COMMIT');
        assert.ok(code('FILE_READONLY')((await other.result).error));
        assert.deepEqual(await references(pool, item), []);
      } finally { await holder.query('ROLLBACK'); holder.release(); await other?.result; }
    });

    await t.test('multiple resources acquire files in stable order when concurrently swapping attachments', async () => {
      const files = [await ready(pool, owner), await ready(pool, owner)];
      const [a, b] = [resource(), resource()];
      await transaction(pool, client => replaceFileReferences(client, a, [{ slot: 'image.0', fileId: files[0].id }], owner));
      await transaction(pool, client => replaceFileReferences(client, b, [{ slot: 'image.0', fileId: files[1].id }], owner));
      await Promise.all([
        transaction(pool, client => replaceFileReferences(client, a, [{ slot: 'image.0', fileId: files[1].id }], owner)),
        transaction(pool, client => replaceFileReferences(client, b, [{ slot: 'image.0', fileId: files[0].id }], owner)),
      ]);
      assert.equal((await references(pool, a))[0].file_id, files[1].id);
      assert.equal((await references(pool, b))[0].file_id, files[0].id);
    });

    await t.test('storage failure and a lost success ACK retry the immutable object without reopening attachment', async () => {
      const file = await ready(pool, owner, 'cos');
      await transaction(pool, client => queueFileDeletion(client, target(file.id)));
      const calls: StorageObject[] = [];
      let exists = true;
      const adapter = { async delete(object: StorageObject) {
        calls.push(object);
        assert.equal((await state(pool, file.id)).status, 'deleting', 'queue transaction commits before storage operation');
        if (calls.length === 1) throw new Error('synthetic transport failure before delete');
        if (exists) { exists = false; throw new Error('synthetic response lost after successful delete'); }
        // Provider NotFound is success on the retry.
      } };
      await assert.rejects(deleteQueuedFile(pool, target(file.id), adapter), /transport failure/);
      assert.equal((await state(pool, file.id)).status, 'deleting');
      await assert.rejects(transaction(pool, client => replaceFileReferences(client, resource(), [{ slot: 'image.0', fileId: file.id }], owner)), code('FILE_NOT_READY'));
      await assert.rejects(deleteQueuedFile(pool, target(file.id), adapter), /response lost/);
      assert.equal((await state(pool, file.id)).status, 'deleting');
      assert.equal(await deleteQueuedFile(pool, target(file.id), adapter), 'deleted');
      assert.equal((await state(pool, file.id)).status, 'deleted');
      assert.equal(calls.length, 3); assert.ok(calls.every(object => object.provider === file.provider && object.locator === file.locator));
      assert.equal(await deleteQueuedFile(pool, target(file.id), adapter), 'deleted');
      assert.equal(calls.length, 3);
      await assert.rejects(transaction(pool, client => replaceFileReferences(client, resource(), [{ slot: 'image.0', fileId: file.id }], owner)), code('FILE_NOT_READY'));
      await assert.rejects(transaction(pool, client => reserveFile(client, { appId, owner, provider: file.provider, locator: file.locator })), code('FILE_LOCATOR_EXISTS'));
    });

    await t.test('concurrent workers only repeat deletion of one committed locator and cannot race an attachment', async () => {
      const file = await ready(pool, owner);
      await transaction(pool, client => queueFileDeletion(client, target(file.id)));
      let release!: () => void, reached!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const entered = new Promise<void>(resolve => { reached = resolve; });
      const calls: StorageObject[] = [];
      const adapter = { async delete(object: StorageObject) { calls.push(object); if (calls.length === 2) reached(); await gate; } };
      const workers = Promise.all([deleteQueuedFile(pool, target(file.id), adapter), deleteQueuedFile(pool, target(file.id), adapter)]);
      try {
        await entered;
        await assert.rejects(transaction(pool, client => replaceFileReferences(client, resource(), [{ slot: 'image.0', fileId: file.id }], owner)), code('FILE_NOT_READY'));
      } finally { release(); }
      assert.deepEqual(await workers, ['deleted', 'deleted']);
      assert.deepEqual(calls, [{ provider: file.provider, locator: file.locator }, { provider: file.provider, locator: file.locator }]);
    });

    await t.test('a lost database commit ACK cannot reopen or change a deleted object on retry', async () => {
      const file = await ready(pool, owner);
      await transaction(pool, client => queueFileDeletion(client, target(file.id)));
      let commits = 0, deletes = 0;
      const lostAckPool = { async connect() {
        const client = await pool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            const result = await client.query(sql, values);
            if (sql === 'COMMIT' && ++commits === 2) throw new Error('synthetic database commit ACK lost');
            return result;
          },
          release() { client.release(); },
        };
      } } as unknown as Pool;
      const adapter = { async delete(object: StorageObject) { deletes++; assert.equal(object.locator, file.locator); } };
      await assert.rejects(deleteQueuedFile(lostAckPool, target(file.id), adapter), /database commit ACK lost/);
      assert.equal((await state(pool, file.id)).status, 'deleted');
      assert.equal(await deleteQueuedFile(pool, target(file.id), adapter), 'deleted');
      assert.equal(deletes, 1);
    });

    await t.test('an old transaction-wide snapshot is rejected before any reference or deletion mutation', async () => {
      const file = await ready(pool, owner), item = resource();
      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await assert.rejects(replaceFileReferences(client, item, [{ slot: 'image.0', fileId: file.id }], owner), code('FILE_TRANSACTION_ISOLATION'));
        await assert.rejects(queueFileDeletion(client, target(file.id)), code('FILE_TRANSACTION_ISOLATION'));
        await assert.rejects(confirmFile(client, { ...target(file.id), owner, metadata }), code('FILE_TRANSACTION_ISOLATION'));
        await assert.rejects(reserveFile(client, { appId, owner, provider: 'cos', locator: 'wrong-isolation' }), code('FILE_TRANSACTION_ISOLATION'));
      } finally { await client.query('ROLLBACK'); client.release(); }
      assert.deepEqual(await references(pool, item), []);
      assert.equal((await state(pool, file.id)).status, 'ready');
      await transaction(pool, other => queueFileDeletion(other, target(file.id)));
      const oldSnapshotPool = { async connect() {
        const connection = await pool.connect();
        return {
          query(sql: string, values?: unknown[]) { return connection.query(sql === 'BEGIN' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : sql, values); },
          release() { connection.release(); },
        };
      } } as unknown as Pool;
      await assert.rejects(deleteQueuedFile(oldSnapshotPool, target(file.id), { async delete() { assert.fail('unsafe isolation must not touch storage'); } }), code('FILE_TRANSACTION_ISOLATION'));
    });

    await t.test('database constraints preserve locator identity, app scope and trusted-ready metadata', async () => {
      const file = await ready(pool, owner);
      await assert.rejects(pool.query('UPDATE files SET locator=$2 WHERE id=$1', [file.id, `${file.locator}-other`]), code('23514'));
      await assert.rejects(pool.query("UPDATE files SET provider='cos' WHERE id=$1", [file.id]), code('23514'));
      await assert.rejects(pool.query(`INSERT INTO file_references(app_id,resource_kind,resource_id,slot,file_id)
        VALUES('other-app','listing','synthetic','image.0',$1)`, [file.id]), code('23503'));
      await assert.rejects(pool.query(`INSERT INTO files(app_id,provider,locator,status,owner_user_id)
        VALUES($1,'cos','unverified-ready','ready',$2)`, [appId, 'userId' in owner ? owner.userId : null]), code('23514'));
      const foreign = await user(pool, 'foreign-db-app');
      await assert.rejects(pool.query(`INSERT INTO files(app_id,provider,locator,owner_user_id)
        VALUES($1,'cos','foreign-db-user',$2)`, [appId, 'userId' in foreign ? foreign.userId : null]), code('23503'));
      await assert.rejects(pool.query(`INSERT INTO files(app_id,provider,locator) VALUES($1,'cos','unowned-new')`, [appId]), code('23514'));
      await assert.rejects(pool.query(`INSERT INTO files(app_id,provider,locator,owner_user_id) VALUES($1,'cos',$2,$3)`,
        [appId, '中'.repeat(342), 'userId' in owner ? owner.userId : null]), code('23514'));
    });

    await t.test('input boundaries reject malformed locators, duplicate slots and unsafe metadata without coercion', async () => {
      for (const locator of ['', 'x'.repeat(1025), '中'.repeat(342), 'bad\0locator', '\ud800']) {
        await assert.rejects(transaction(pool, client => reserveFile(client, { appId, owner, provider: 'cos', locator })));
      }
      const exactLocator = '中'.repeat(341) + 'x';
      const file = await transaction(pool, client => reserveFile(client, { appId, owner, provider: 'cos', locator: exactLocator }));
      assert.equal(file.locator, exactLocator);
      for (const patch of [{ sizeBytes: Number.MAX_SAFE_INTEGER + 1 }, { sizeBytes: -1 }, { sizeBytes: '12' },
        { sha256: 'a'.repeat(64) + '\n' }, { mediaType: 'image/png\n' }, { mediaType: '' }]) {
        await assert.rejects(transaction(pool, client => confirmFile(client, { ...target(file.id), owner, metadata: { ...metadata, ...patch } })));
      }
      const confirmed = await transaction(pool, client => confirmFile(client, { ...target(file.id), owner, metadata: { ...metadata, sizeBytes: Number.MAX_SAFE_INTEGER } }));
      assert.equal(confirmed.sizeBytes, Number.MAX_SAFE_INTEGER);
      for (const slots of [['image.0', 'image.0'], ['image.0\n'], ['../image'], ['Image']]) {
        await assert.rejects(transaction(pool, client => replaceFileReferences(client, resource(), slots.map(slot => ({ slot, fileId: file.id })), owner)));
      }
      await assert.rejects(transaction(pool, client => replaceFileReferences(client, { ...resource(), id: 'resource\n' }, [], owner)));
    });
  });
