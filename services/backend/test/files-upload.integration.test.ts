import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import sharp from 'sharp';
import { transaction } from '../src/db.ts';
import type { AdminIdentity } from '../src/admin/service.ts';
import { confirmFile, queueFileDeletion } from '../src/files/service.ts';
import { uploadUserImage, uploadAdminImage, MAX_IMAGE_UPLOAD_BYTES } from '../src/files/upload.ts';
import type { ImageUploadStorage } from '../src/files/upload.ts';
import { createTestDatabase } from './helpers/database.ts';

const integration = { skip: !process.env.BACKEND_TEST_DATABASE_URL };
const APP = 'synthetic-image-app';
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const png = (red = 40) => sharp({ create: { width: 4, height: 4, channels: 3, background: { r: red, g: 60, b: 80 } } }).png().toBuffer();
async function user(pool: Pool, appId = APP) {
  return (await pool.query('INSERT INTO users(app_id,openid) VALUES($1,$2) RETURNING id', [appId, randomUUID()])).rows[0].id as string;
}
async function admin(pool: Pool, ownerKey = 'shared-owner'): Promise<AdminIdentity> {
  const accountId = `admin-${randomUUID()}`, sessionHash = sha(Buffer.from(randomUUID()));
  await pool.query(`INSERT INTO admin_accounts(app_id,id,owner_key,enabled,credential_version,password_salt,password_hash)
    VALUES($1,$2,$3,true,1,$4,$5)`, [APP, accountId, ownerKey, Buffer.alloc(32, 1), Buffer.alloc(64, 1)]);
  await pool.query(`INSERT INTO admin_sessions(token_hash,app_id,account_id,credential_version,expires_at)
    VALUES($1,$2,$3,1,clock_timestamp()+interval '1 hour')`, [sessionHash, APP, accountId]);
  return { appId: APP, accountId, ownerKey, sessionHash, credentialVersion: 1 };
}
function storage() {
  const objects = new Map<string, { body: Buffer; mediaType: string }>();
  const calls = { puts: 0, reads: 0 };
  const config: ImageUploadStorage = { bucket: 'synthetic-bucket-123456', objects: {
    async put(locator, body, mediaType) {
      calls.puts++;
      // Create-only, like the real adapter. Existing data is verified by READ.
      if (!objects.has(locator)) objects.set(locator, { body: Buffer.from(body), mediaType });
    },
    async read(locator, maxBytes) {
      calls.reads++;
      const value = objects.get(locator);
      if (!value) return null;
      assert.ok(value.body.length <= maxBytes);
      return { body: Buffer.from(value.body), mediaType: value.mediaType };
    },
  } };
  return { config, objects, calls };
}
const rows = async (pool: Pool) => (await pool.query('SELECT * FROM files ORDER BY id')).rows;

test('upload: valid decoded image formats, fixed locator and metadata; concurrent same-byte retries return one identity', integration, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = await user(db.pool), store = storage();
  const body = await png();
  const results = await Promise.all(Array.from({ length: 8 }, () => uploadUserImage(db.pool, APP, owner, 'image-request-001', body, store.config)));
  assert.ok(results.every(result => JSON.stringify(result) === JSON.stringify(results[0])));
  assert.equal(store.calls.puts, 1);
  let records = await rows(db.pool); assert.equal(records.length, 1);
  assert.equal(records[0].status, 'ready'); assert.equal(records[0].sha256, sha(body));
  assert.equal(records[0].upload_request_key, 'image-request-001'); assert.ok(records[0].verified_at instanceof Date);
  assert.match(records[0].locator, /^cos:\/\/synthetic-bucket-123456\/linkx\/images\/[a-f0-9]{16}\/[a-f0-9-]{36}\.png$/);
  assert.ok(!JSON.stringify(results[0]).includes('locator')); assert.ok(!records[0].locator.includes(owner));
  const reads = store.calls.reads;
  assert.deepEqual(await uploadUserImage(db.pool, APP, owner, 'image-request-001', body, store.config), results[0]);
  assert.equal(store.calls.reads, reads); assert.equal(store.calls.puts, 1);
  for (const format of ['jpeg', 'webp'] as const) {
    const bytes = await sharp(body)[format]().toBuffer();
    const result = await uploadUserImage(db.pool, APP, owner, `image-${format}-001`, bytes, store.config);
    assert.equal(result.mediaType, `image/${format}`); assert.equal(result.sha256, sha(bytes));
  }
  records = await rows(db.pool); assert.equal(records.length, 3);
  assert.equal((await db.pool.query('SELECT count(*) FROM idempotency_requests')).rows[0].count, '0');
});

test('upload: different bytes cannot replace one key, including concurrent attempts; other actors keep separate identities', integration, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const first = await user(db.pool), second = await user(db.pool), store = storage();
  const [one, two] = await Promise.all([png(10), png(20)]);
  const attempts = await Promise.allSettled([one, two].map(bytes => uploadUserImage(db.pool, APP, first, 'same-key-001', bytes, store.config)));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((attempts.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'UPLOAD_CONTENT_CONFLICT');
  assert.equal(store.calls.puts, 1); assert.equal((await rows(db.pool)).length, 1);
  const result = await uploadUserImage(db.pool, APP, second, 'same-key-001', two, store.config);
  assert.notEqual(result.fileId, (attempts.find(value => value.status === 'fulfilled') as PromiseFulfilledResult<{ fileId: string }>).value.fileId);
  const original = (await rows(db.pool)).find(row => row.owner_user_id === first);
  await assert.rejects(db.pool.query('UPDATE files SET sha256=$2 WHERE id=$1', [original.id, 'f'.repeat(64)]), { code: '23514' });
  await assert.rejects(db.pool.query("UPDATE files SET upload_request_key='changed-key-001' WHERE id=$1", [original.id]), { code: '23514' });
  const puts = store.calls.puts;
  await assert.rejects(uploadUserImage(db.pool, 'other-app', first, 'cross-app-001', one, store.config), { code: 'UNAUTHORIZED' });
  assert.equal(store.calls.puts, puts);
});

test('upload: PUT success with lost ACK remains pending and retry verifies without writing again', integration, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = await user(db.pool), body = await png(), store = storage();
  const originalPut = store.config.objects.put;
  store.config.objects.put = async (...args) => { await originalPut(...args); throw new Error('synthetic lost PUT ACK'); };
  await assert.rejects(uploadUserImage(db.pool, APP, owner, 'lost-put-ack-001', body, store.config), /lost PUT ACK/);
  const pending = (await rows(db.pool))[0];
  assert.equal(pending.status, 'pending'); assert.equal(pending.verified_at, null); assert.equal(pending.sha256, sha(body));
  await assert.rejects(transaction(db.pool, client => queueFileDeletion(client, { appId: APP, fileId: pending.id })), { code: 'FILE_UPLOAD_PENDING' });
  const result = await uploadUserImage(db.pool, APP, owner, 'lost-put-ack-001', body, store.config);
  assert.equal(result.fileId, pending.id); assert.equal(store.calls.puts, 1); assert.equal((await rows(db.pool))[0].status, 'ready');
});

function proxyPool(pool: Pool, intercept: (sql: string, values: unknown[], invoke: () => Promise<unknown>) => Promise<unknown>): Pool {
  return new Proxy(pool, { get(target, key) {
    if (key === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(connection, name) {
        if (name === 'query') return (sql: string, values: unknown[] = []) => intercept(sql, values, () => connection.query(sql, values));
        const value = Reflect.get(connection, name, connection); return typeof value === 'function' ? value.bind(connection) : value;
      } });
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
}

test('upload: no open transaction during storage I/O; database confirmation ACK loss replays ready without I/O', integration, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = await user(db.pool), bytes = await png(), store = storage();
  let transactionOpen = false, commits = 0;
  const proxy = proxyPool(db.pool, async (sql, _values, invoke) => {
    const result = await invoke();
    if (sql === 'BEGIN') transactionOpen = true;
    if (sql === 'COMMIT' || sql === 'ROLLBACK') transactionOpen = false;
    if (sql === 'COMMIT' && ++commits === 2) throw new Error('synthetic lost DB ACK');
    return result;
  });
  const read = store.config.objects.read, put = store.config.objects.put;
  store.config.objects.read = async (...args) => { assert.equal(transactionOpen, false); return read(...args); };
  store.config.objects.put = async (...args) => { assert.equal(transactionOpen, false); return put(...args); };
  await assert.rejects(uploadUserImage(proxy, APP, owner, 'lost-db-ack-001', bytes, store.config), /lost DB ACK/);
  assert.equal((await rows(db.pool))[0].status, 'ready');
  const before = { ...store.calls };
  const result = await uploadUserImage(db.pool, APP, owner, 'lost-db-ack-001', bytes, store.config);
  assert.equal(result.fileId, (await rows(db.pool))[0].id); assert.deepEqual(store.calls, before);
});

test('upload: malformed or corrupt objects never become ready and existing unexpected content is never overwritten', integration, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = await user(db.pool), valid = await png(), store = storage();
  for (const invalid of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), valid.subarray(0, 40), Buffer.alloc(MAX_IMAGE_UPLOAD_BYTES + 1), 'https://untrusted.example/image.png']) {
    await assert.rejects(uploadUserImage(db.pool, APP, owner, 'invalid-input-001', invalid, store.config), { code: 'INVALID_IMAGE' });
  }
  assert.equal((await rows(db.pool)).length, 0); assert.deepEqual(store.calls, { puts: 0, reads: 0 });
  const read = store.config.objects.read;
  let corrupt = true;
  store.config.objects.read = async (locator, maximum) => {
    const value = await read(locator, maximum);
    return value && corrupt ? { ...value, body: Buffer.alloc(value.body.length) } : value;
  };
  await assert.rejects(uploadUserImage(db.pool, APP, owner, 'bad-storage-001', valid, store.config), { code: 'UPLOAD_VERIFICATION_FAILED' });
  assert.equal((await rows(db.pool))[0].status, 'pending');
  await assert.rejects(uploadUserImage(db.pool, APP, owner, 'bad-storage-001', valid, store.config), { code: 'UPLOAD_VERIFICATION_FAILED' });
  assert.equal(store.calls.puts, 1);
  corrupt = false;
  const result = await uploadUserImage(db.pool, APP, owner, 'bad-storage-001', valid, store.config);
  assert.equal((await rows(db.pool))[0].status, 'ready');
  await transaction(db.pool, client => queueFileDeletion(client, { appId: APP, fileId: result.fileId }));
  const calls = { ...store.calls };
  await assert.rejects(uploadUserImage(db.pool, APP, owner, 'bad-storage-001', valid, store.config), { code: 'FILE_NOT_PENDING' });
  assert.deepEqual(store.calls, calls);
});

test('upload: 12 MP boundary decodes with two concurrent uploads; larger dimensions fail before storage', integration, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = await user(db.pool), store = storage();
  const body = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 30, g: 60, b: 90 } } }).png().toBuffer();
  assert.ok(body.length < MAX_IMAGE_UPLOAD_BYTES);
  let peak = process.memoryUsage().rss;
  const start = performance.now();
  const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
  try {
    const results = await Promise.all([0, 1].map(index => uploadUserImage(db.pool, APP, owner, `large-image-${index}`, body, store.config)));
    assert.notEqual(results[0].fileId, results[1].fileId);
  } finally { clearInterval(sample); }
  t.diagnostic(`12 MP × 2: observed process RSS peak ${Math.ceil(peak / 1024 / 1024)} MiB; elapsed ${Math.round(performance.now() - start)} ms`);
  const oversized = await sharp({ create: { width: 4001, height: 3000, channels: 3, background: { r: 30, g: 60, b: 90 } } }).png().toBuffer();
  const calls = { ...store.calls };
  await assert.rejects(uploadUserImage(db.pool, APP, owner, 'oversized-pixels-001', oversized, store.config), { code: 'INVALID_IMAGE' });
  assert.deepEqual(store.calls, calls); assert.equal((await rows(db.pool)).length, 2);
});

test('upload: actor revocation during external I/O prevents confirmation; same admin retries and audits exactly once', integration, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const one = await admin(db.pool), two = await admin(db.pool), bytes = await png(), store = storage();
  const put = store.config.objects.put;
  store.config.objects.put = async (...args) => {
    await put(...args);
    await db.pool.query('DELETE FROM admin_sessions WHERE token_hash=$1', [one.sessionHash]);
  };
  await assert.rejects(uploadAdminImage(db.pool, one, 'admin-image-001', bytes, store.config), { code: 'ADMIN_UNAUTHORIZED' });
  const pending = (await rows(db.pool))[0]; assert.equal(pending.status, 'pending'); assert.equal(pending.uploaded_by_admin_id, one.accountId);
  await assert.rejects(transaction(db.pool, client => confirmFile(client, { appId: APP, fileId: pending.id,
    owner: { adminOwnerKey: two.ownerKey, adminAccountId: two.accountId }, metadata: { sizeBytes: bytes.length, mediaType: 'image/png', sha256: sha(bytes) } })), { code: 'FILE_UPLOADER_MISMATCH' });
  assert.equal((await db.pool.query("SELECT count(*) FROM admin_audit WHERE action='files.upload'")).rows[0].count, '0');
  await db.pool.query(`INSERT INTO admin_sessions(token_hash,app_id,account_id,credential_version,expires_at)
    VALUES($1,$2,$3,1,clock_timestamp()+interval '1 hour')`, [one.sessionHash, APP, one.accountId]);
  const result = await uploadAdminImage(db.pool, one, 'admin-image-001', bytes, store.config);
  assert.equal(result.fileId, pending.id); assert.equal(store.calls.puts, 1);
  assert.deepEqual(await uploadAdminImage(db.pool, one, 'admin-image-001', bytes, store.config), result);
  assert.equal((await db.pool.query("SELECT count(*) FROM admin_audit WHERE action='files.upload'")).rows[0].count, '1');
  store.config.objects.put = put;
  const other = await uploadAdminImage(db.pool, two, 'admin-image-001', bytes, store.config);
  assert.notEqual(other.fileId, result.fileId); assert.equal(store.calls.puts, 2);
});
