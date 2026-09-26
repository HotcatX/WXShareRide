import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { Pool } from 'pg';
import sharp from 'sharp';
import { createApp } from '../src/app.ts';
import type { FileStorage } from '../src/files/routes.ts';
import type { ReadableFile } from '../src/files/read.ts';
import { MAX_IMAGE_UPLOAD_BYTES } from '../src/files/upload.ts';
import { createTestDatabase } from './helpers/database.ts';

const options = { skip: !process.env.BACKEND_TEST_DATABASE_URL, timeout: 30000 };
const config = { databaseUrl: '', host: '127.0.0.1', port: 3100, appId: 'files-http-test', sessionTtlSeconds: 3600 };
const origin = 'https://admin.example.test';
const png = () => sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 30, g: 60, b: 90 } } }).png().toBuffer();
type App = Awaited<ReturnType<typeof createApp>>;
function storage() {
  const objects = new Map<string, { body: Buffer; mediaType: string }>();
  const signed: { file: ReadableFile; ttl: number }[] = [];
  let puts = 0;
  const value: FileStorage = { bucket: 'synthetic-bucket-123456', objects: {
    async put(locator, bytes, mediaType) {
      puts++; if (!objects.has(locator)) objects.set(locator, { body: Buffer.from(bytes), mediaType });
    },
    async read(locator, maximum) {
      const object = objects.get(locator); if (!object) return null;
      assert.ok(object.body.length <= maximum); return { body: Buffer.from(object.body), mediaType: object.mediaType };
    }
  }, async readUrl(file, ttl) {
    signed.push({ file: { ...file }, ttl });
    return `https://images.example.test/${file.id}?expires=${ttl}`;
  } };
  return { value, objects, signed, puts: () => puts };
}
async function setup(t: TestContext, provider?: FileStorage) {
  const db = await createTestDatabase();
  const app = await createApp({ pool: db.pool, config, storage: provider, exchange: async code => ({ openid: `synthetic-${code}` }) });
  t.after(async () => { await app.close(); await db.close(); });
  return { app, pool: db.pool };
}
async function login(app: App, code = randomUUID()) {
  const result = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { code } });
  assert.equal(result.statusCode, 200, result.body);
  return { userId: result.json().data.user.id as string, authorization: `Bearer ${result.json().data.token}` };
}
async function admin(app: App, pool: Pool, accountId = 'http_admin') {
  const password = 'synthetic-admin-image-password', salt = Buffer.alloc(32, 2);
  await pool.query(`INSERT INTO admin_accounts(app_id,id,owner_key,enabled,credential_version,password_salt,password_hash)
    VALUES($1,$2,'shared_owner',true,1,$3,$4)`, [config.appId, accountId, salt, scryptSync(password, salt, 64)]);
  await pool.query('INSERT INTO admin_origins VALUES($1,$2) ON CONFLICT DO NOTHING', [config.appId, origin]);
  const result = await app.inject({ method: 'POST', url: '/api/v1/admin/auth/login', headers: { origin }, payload: { username: accountId, password } });
  assert.equal(result.statusCode, 200, result.body);
  return { origin, authorization: `Bearer ${result.json().data.token}` };
}
function upload(app: App, bytes: Buffer, authorization: string, key: string, adminOrigin?: string) {
  return app.inject({ method: 'POST', url: adminOrigin ? '/api/v1/admin/files/images' : '/api/v1/files/images',
    headers: { authorization, 'content-type': 'application/octet-stream', 'idempotency-key': key, ...(adminOrigin ? { origin: adminOrigin } : {}) }, payload: bytes });
}
async function legacyFile(pool: Pool, application = config.appId) {
  const id = randomUUID(), locator = `cloud://synthetic-internal/${randomUUID()}.png`;
  await pool.query("INSERT INTO files(id,app_id,provider,locator,legacy_readonly,status) VALUES($1,$2,'cloudbase',$3,true,'ready')", [id, application, locator]);
  return { id, locator };
}
async function publish(pool: Pool, fileId: string, owner: string) {
  const id = randomUUID();
  await pool.query("INSERT INTO market_listings(app_id,id,owner_user_id,content,expires_at) VALUES($1,$2,$3,'{}','2099-01-01')", [config.appId, id, owner]);
  await pool.query("INSERT INTO file_references VALUES($1,'listing',$2,'image.0',$3)", [config.appId, id, fileId]);
}
function privateHeaders(response: Awaited<ReturnType<App['inject']>>, admin = false) {
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers.vary, admin ? 'Origin, Authorization' : 'Authorization');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
}

test('file HTTP: raw authenticated upload above the normal JSON limit is byte-exact, idempotent and private', options, async t => {
  const store = storage(), { app, pool } = await setup(t, store.value), user = await login(app);
  const bytes = await sharp(randomBytes(256 * 256 * 3), { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer();
  assert.ok(bytes.length > 65536 && bytes.length < MAX_IMAGE_UPLOAD_BYTES);
  const first = await upload(app, bytes, user.authorization, 'raw-image-request');
  assert.equal(first.statusCode, 201, first.body); privateHeaders(first);
  assert.deepEqual(Object.keys(first.json().data).sort(), ['fileId', 'mediaType', 'sha256', 'sizeBytes']);
  assert.equal(first.json().data.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(first.json().data.sizeBytes, bytes.length);
  assert.deepEqual([...store.objects.values()][0]!.body, bytes);
  const repeat = await upload(app, bytes, user.authorization, 'raw-image-request');
  assert.equal(repeat.statusCode, 201); assert.deepEqual(repeat.json().data, first.json().data); assert.equal(store.puts(), 1);
  const conflict = await upload(app, await png(), user.authorization, 'raw-image-request');
  assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().error.code, 'UPLOAD_CONTENT_CONFLICT');
  const rows = (await pool.query('SELECT owner_user_id,uploaded_by_admin_id,status,locator FROM files')).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].owner_user_id, user.userId); assert.equal(rows[0].status, 'ready');
  assert.equal(rows[0].uploaded_by_admin_id, null); assert.ok(!first.body.includes(rows[0].locator));
});

test('file HTTP: authentication and request-key rejection happen before body parsing; oversized and wrong-type bodies never reach storage', options, async t => {
  const store = storage(), { app, pool } = await setup(t, store.value), user = await login(app);
  const oversized = Buffer.alloc(MAX_IMAGE_UPLOAD_BYTES + 1);
  for (const authorization of [undefined, 'Bearer invalid']) {
    const result = await app.inject({ method: 'POST', url: '/api/v1/files/images',
      headers: { ...(authorization ? { authorization } : {}), 'content-type': 'application/octet-stream', 'idempotency-key': 'valid-request-key' }, payload: oversized });
    assert.equal(result.statusCode, 401); privateHeaders(result);
  }
  const wrongKey = await upload(app, oversized, user.authorization, 'bad');
  assert.equal(wrongKey.statusCode, 400); assert.equal(wrongKey.json().error.code, 'IDEMPOTENCY_KEY_REQUIRED'); privateHeaders(wrongKey);
  const tooLarge = await upload(app, oversized, user.authorization, 'oversized-image-request');
  assert.equal(tooLarge.statusCode, 413); privateHeaders(tooLarge);
  for (const type of ['application/json', 'text/plain', 'image/png']) {
    const response = await app.inject({ method: 'POST', url: '/api/v1/files/images', headers: { authorization: user.authorization,
      'content-type': type, 'idempotency-key': 'wrong-media-request' }, payload: type === 'application/json' ? '{' : 'not an image' });
    assert.equal(response.statusCode, 415); privateHeaders(response);
  }
  const invalidImage = await upload(app, Buffer.from('not an image'), user.authorization, 'invalid-image-request');
  assert.equal(invalidImage.statusCode, 400); assert.equal(invalidImage.json().error.code, 'INVALID_IMAGE');
  assert.equal(store.puts(), 0); assert.equal((await pool.query('SELECT count(*) FROM files')).rows[0].count, '0');
  assert.equal((await upload(app, await png(), user.authorization, 'after-parser-errors')).statusCode, 201);
});

test('file HTTP: admin authentication and exact-origin CORS precede parsing, upload actor stays separate from users', options, async t => {
  const store = storage(), { app, pool } = await setup(t, store.value), headers = await admin(app, pool);
  const bytes = await png();
  for (const [requestHeaders, expected] of [[{ origin }, 401], [{ ...headers, origin: 'https://unlisted.example.test' }, 403]] as const) {
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/files/images',
      headers: { ...requestHeaders, 'content-type': 'application/json', 'idempotency-key': 'admin-invalid-body' }, payload: '{' });
    assert.equal(response.statusCode, expected); privateHeaders(response, true);
  }
  const preflight = await app.inject({ method: 'OPTIONS', url: '/api/v1/admin/files/images', headers: { origin,
    'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type, idempotency-key' } });
  assert.equal(preflight.statusCode, 204); assert.equal(preflight.headers['access-control-allow-origin'], origin); privateHeaders(preflight, true);
  const rejectedPreflight = await app.inject({ method: 'OPTIONS', url: '/api/v1/admin/files/urls', headers: { origin,
    'access-control-request-method': 'DELETE' } });
  assert.equal(rejectedPreflight.statusCode, 403); privateHeaders(rejectedPreflight, true);
  const result = await upload(app, bytes, headers.authorization, 'admin-upload-request', origin);
  assert.equal(result.statusCode, 201, result.body); privateHeaders(result, true);
  assert.equal(result.headers['access-control-allow-origin'], origin);
  const file = (await pool.query('SELECT owner_user_id,uploaded_by_admin_id,admin_owner_key FROM files')).rows[0];
  assert.deepEqual(file, { owner_user_id: null, uploaded_by_admin_id: 'http_admin', admin_owner_key: 'shared_owner' });
  assert.equal((await pool.query('SELECT count(*) FROM users')).rows[0].count, '0');
  assert.equal((await pool.query("SELECT count(*) FROM admin_audit WHERE action='files.upload'")).rows[0].count, '1');
  await pool.query("UPDATE admin_accounts SET enabled=false WHERE id='http_admin'");
  const disabled = await upload(app, Buffer.alloc(MAX_IMAGE_UPLOAD_BYTES + 1), headers.authorization, 'disabled-admin-request', origin);
  assert.equal(disabled.statusCode, 401); privateHeaders(disabled, true);
});

test('file HTTP: URL signing follows whole-batch ACL, normalizes UUIDs, fixes TTL and never exposes internal locators', options, async t => {
  const store = storage(), { app, pool } = await setup(t, store.value), owner = await login(app), stranger = await login(app);
  const uploaded = await upload(app, await png(), owner.authorization, 'private-file-request');
  assert.equal(uploaded.statusCode, 201); const privateId = uploaded.json().data.fileId;
  const publicImage = await legacyFile(pool); await publish(pool, publicImage.id, owner.userId);
  const read = (fileIds: unknown, authorization?: string) => app.inject({ method: 'POST', url: '/api/v1/files/urls',
    headers: authorization ? { authorization } : {}, payload: { fileIds } });
  const first = await read([publicImage.id.toUpperCase(), publicImage.id]);
  assert.equal(first.statusCode, 200, first.body); privateHeaders(first);
  assert.deepEqual(first.json().data, { items: [{ fileId: publicImage.id, url: `https://images.example.test/${publicImage.id}?expires=300` }], expiresIn: 300 });
  assert.equal(store.signed.length, 1); assert.equal(store.signed[0]!.ttl, 300); assert.equal(store.signed[0]!.file.locator, publicImage.locator);
  assert.ok(!first.body.includes(publicImage.locator));
  for (const authorization of [undefined, stranger.authorization]) {
    const before: number = store.signed.length;
    const mixed = await read([publicImage.id, privateId], authorization);
    assert.equal(mixed.statusCode, 404); assert.equal(store.signed.length, before); privateHeaders(mixed);
  }
  const own = await read([privateId], owner.authorization); assert.equal(own.statusCode, 200);
  assert.equal((await read([publicImage.id], 'Bearer invalid')).statusCode, 401);
  const foreignFile = await legacyFile(pool, 'foreign-app'); assert.equal((await read([foreignFile.id], owner.authorization)).statusCode, 404);
  for (const ids of [[], Array(51).fill(publicImage.id), [publicImage.locator], [null]]) assert.equal((await read(ids)).statusCode, 400);
  const spoofed = await app.inject({ method: 'POST', url: '/api/v1/files/urls', payload: { fileIds: [privateId], userId: owner.userId } });
  assert.equal(spoofed.statusCode, 400);
  await pool.query('DELETE FROM sessions WHERE user_id=$1', [owner.userId]);
  assert.equal((await read([publicImage.id], owner.authorization)).statusCode, 401);
});

test('file HTTP: same-owner admins cannot sign another actor private upload; revoked and malformed admin URL requests stay private', options, async t => {
  const store = storage(), { app, pool } = await setup(t, store.value), one = await admin(app, pool), two = await admin(app, pool, 'http_admin_two');
  const created = await upload(app, await png(), one.authorization, 'admin-private-request', origin);
  const body = { fileIds: [created.json().data.fileId] };
  const read = (headers: typeof one) => app.inject({ method: 'POST', url: '/api/v1/admin/files/urls', headers, payload: body });
  const allowed = await read(one); assert.equal(allowed.statusCode, 200); privateHeaders(allowed, true);
  const denied = await read(two); assert.equal(denied.statusCode, 404); privateHeaders(denied, true);
  const parseError = await app.inject({ method: 'POST', url: '/api/v1/admin/files/urls', headers: { ...one, 'content-type': 'application/json' }, payload: '{' });
  assert.equal(parseError.statusCode, 400); privateHeaders(parseError, true);
  await pool.query("DELETE FROM admin_sessions WHERE account_id='http_admin'");
  const invalid = await read(one); assert.equal(invalid.statusCode, 401); privateHeaders(invalid, true);
});

test('file HTTP: absent storage and signing/provider failures return controlled errors without URLs or storage secrets', options, async t => {
  const absent = await setup(t), user = await login(absent.app), bytes = await png();
  const unauthenticated = await absent.app.inject({ method: 'POST', url: '/api/v1/files/images', headers: { 'content-type': 'application/octet-stream' }, payload: bytes });
  assert.equal(unauthenticated.statusCode, 401);
  const unavailable = await upload(absent.app, bytes, user.authorization, 'missing-storage-request');
  assert.equal(unavailable.statusCode, 503); assert.equal(unavailable.json().error.code, 'FILE_STORAGE_UNAVAILABLE');
  assert.equal(unavailable.headers['retry-after'], '5'); privateHeaders(unavailable);
  const publicImage = await legacyFile(absent.pool); await publish(absent.pool, publicImage.id, user.userId);
  const missingRead = await absent.app.inject({ method: 'POST', url: '/api/v1/files/urls', payload: { fileIds: [publicImage.id] } });
  assert.equal(missingRead.statusCode, 503); privateHeaders(missingRead); assert.equal(missingRead.headers['retry-after'], '5');

  const store = storage(), present = await setup(t, store.value), owner = await login(present.app);
  const legacy = await legacyFile(present.pool); await publish(present.pool, legacy.id, owner.userId);
  const leaked = 'synthetic-private-provider-credential';
  for (const value of ['http://unsafe.example.test/a', `https://user:${leaked}@images.example.test/a`, 'javascript:alert(1)', 'https://images.example.test/a\n']) {
    store.value.readUrl = async () => value;
    const response = await present.app.inject({ method: 'POST', url: '/api/v1/files/urls', payload: { fileIds: [legacy.id] } });
    assert.equal(response.statusCode, 503); assert.ok(!response.body.includes(value)); assert.ok(!response.body.includes(leaked)); privateHeaders(response);
  }
  store.value.readUrl = async file => { assert.equal(file.provider, 'cloudbase'); throw new Error(`${leaked}: ${file.locator}`); };
  const failed = await present.app.inject({ method: 'POST', url: '/api/v1/files/urls', payload: { fileIds: [legacy.id] } });
  assert.equal(failed.statusCode, 503); assert.equal(failed.json().error.code, 'FILE_STORAGE_UNAVAILABLE');
  assert.ok(!failed.body.includes(leaked)); assert.ok(!failed.body.includes(legacy.locator));
  store.value.objects.read = async locator => { throw new Error(`${leaked}: ${locator}`); };
  const failedUpload = await upload(present.app, bytes, owner.authorization, 'provider-failing-request');
  assert.equal(failedUpload.statusCode, 500); assert.equal(failedUpload.json().error.code, 'INTERNAL_ERROR');
  assert.ok(!failedUpload.body.includes(leaked)); assert.ok(!failedUpload.body.includes('cos://')); privateHeaders(failedUpload);
});

test('file HTTP: two process-wide uploads run while the third rejects without a queue, then slots recover', options, async t => {
  const store = storage(), { app, pool } = await setup(t, store.value), user = await login(app), bytes = await png();
  const otherApp = await createApp({ config, pool, storage: store.value, exchange: async () => ({ openid: 'unused-fixture' }) });
  t.after(() => otherApp.close());
  let release!: () => void, admitted!: () => void, puts = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const bothAdmitted = new Promise<void>(resolve => { admitted = resolve; });
  const original = store.value.objects.put;
  store.value.objects.put = async (...args) => { if (++puts === 2) admitted(); await gate; await original(...args); };
  const first = upload(app, bytes, user.authorization, 'parallel-image-first');
  const second = upload(app, bytes, user.authorization, 'parallel-image-second');
  // inject starts execution when its promise is consumed, not when its chain is created.
  const firstResult = Promise.resolve(first), secondResult = Promise.resolve(second);
  try {
    await bothAdmitted;
    const overflow = await upload(otherApp, Buffer.alloc(MAX_IMAGE_UPLOAD_BYTES + 1), user.authorization, 'parallel-image-third');
    assert.equal(overflow.statusCode, 503); assert.equal(overflow.json().error.code, 'FILE_UPLOAD_BUSY');
    assert.equal(overflow.headers['retry-after'], '5'); privateHeaders(overflow);
    assert.equal(puts, 2); assert.equal((await pool.query('SELECT count(*) FROM files')).rows[0].count, '2');
  } finally { release(); }
  assert.equal((await firstResult).statusCode, 201); assert.equal((await secondResult).statusCode, 201);
  assert.equal((await upload(otherApp, bytes, user.authorization, 'parallel-image-third')).statusCode, 201);
});
