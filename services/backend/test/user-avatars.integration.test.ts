import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Pool } from 'pg';
import sharp from 'sharp';
import { createTestDatabase } from './helpers/database.ts';
import { runMigrations } from '../src/migration/apply.ts';
import { getUser, updateUser } from '../src/users/service.ts';
import { authorizeFileReads } from '../src/files/read.ts';
import { replaceFileReferences, queueFileDeletion } from '../src/files/service.ts';
import { transaction } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import type { FileStorage } from '../src/files/routes.ts';
const enabled = { skip: !process.env.BACKEND_TEST_DATABASE_URL };
const appId = 'avatar-fixture';
async function user(pool: Pool, app = appId) {
  return (await pool.query("INSERT INTO users(app_id,openid,name) VALUES($1,$2,'Before') RETURNING id", [app, randomUUID()])).rows[0].id as string;
}
async function image(pool: Pool, options: { owner?: string; app?: string; legacy?: boolean; status?: string } = {}) {
  const id = randomUUID();
  await pool.query(`INSERT INTO files(id,app_id,provider,locator,owner_user_id,legacy_readonly,status,size_bytes,media_type,sha256,verified_at)
    VALUES($1,$2,'cloudbase',$3,$4,$5,$6,12,'image/png',$7,clock_timestamp())`,
  [id, options.app ?? appId, `cloud://synthetic-avatar/${id}.png`, options.owner ?? null,
    options.legacy ?? !options.owner, options.status ?? 'ready', 'a'.repeat(64)]);
  return id;
}
async function historicalAvatar(pool: Pool, owner: string) {
  const id = await image(pool);
  await pool.query("INSERT INTO file_references VALUES($1,'user',$2,'avatar',$3)", [appId, owner, id]); return id;
}
const unavailable = { code: 'FILE_NOT_FOUND' };
const read = (pool: Pool, id: string, viewer?: string) => authorizeFileReads(pool, appId, [id], viewer ? { userId: viewer } : undefined);

test('avatar updates atomically replace one reference, replay without resurrection, and preserve nested profiles', enabled, async t => {
  const db = await createTestDatabase(); t.after(db.close); const { pool } = db;
  const owner = await user(pool), one = await image(pool, { owner }), two = await image(pool, { owner });
  assert.equal((await getUser(pool, owner)).avatarFileId, null);
  const input = { name: 'After', avatarFileId: one, profile: { vehicle: { brand: 'Honda', model: 'Civic' } } };
  const results = await Promise.all(Array.from({ length: 5 }, () => updateUser(pool, owner, 'avatar-once', input)));
  results.forEach(result => assert.deepEqual(result, results[0])); assert.equal(results[0]!.data.avatarFileId, one);
  await updateUser(pool, owner, 'profile-only', { profile: { vehicle: { model: 'Accord' } } });
  assert.equal((await getUser(pool, owner)).avatarFileId, one);
  assert.deepEqual((await getUser(pool, owner)).profile.vehicle, { brand: 'Honda', model: 'Accord' });
  await updateUser(pool, owner, 'avatar-replace', { avatarFileId: two });
  await assert.rejects(updateUser(pool, owner, 'avatar-once', { ...input, avatarFileId: two }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(await updateUser(pool, owner, 'avatar-once', input), results[0]);
  assert.equal((await getUser(pool, owner)).avatarFileId, two, 'old receipt cannot reattach an earlier image');
  assert.deepEqual((await pool.query("SELECT slot,file_id FROM file_references WHERE resource_kind='user' AND resource_id=$1", [owner])).rows, [{ slot: 'avatar', file_id: two }]);
  await assert.rejects(transaction(pool, client => queueFileDeletion(client, { appId, fileId: two })), { code: 'FILE_REFERENCED' });
  await updateUser(pool, owner, 'avatar-clear', { avatarFileId: null });
  assert.equal((await getUser(pool, owner)).avatarFileId, null);
  assert.deepEqual((await pool.query('SELECT status FROM files ORDER BY id')).rows, [{ status: 'ready' }, { status: 'ready' }]);
});

test('ownership, readiness, exact resource slot and app checks roll back profile changes', enabled, async t => {
  const db = await createTestDatabase(); t.after(db.close); const { pool } = db;
  const owner = await user(pool), other = await user(pool), foreign = await user(pool, 'other-app');
  const inputs: [string, string][] = [[await image(pool, { owner: other }), 'FILE_OWNER_MISMATCH'],
    [await image(pool, { owner: foreign, app: 'other-app' }), 'FILE_NOT_FOUND'], [await image(pool), 'FILE_READONLY'], [randomUUID(), 'FILE_NOT_FOUND']];
  for (const status of ['pending', 'deleting', 'deleted']) inputs.push([await image(pool, { owner, status }), 'FILE_NOT_READY']);
  for (let i = 0; i < inputs.length; i++) {
    const [fileId, code] = inputs[i]!;
    await assert.rejects(updateUser(pool, owner, `avatar-reject-${i}`, { name: 'Must roll back', avatarFileId: fileId }), { code });
  }
  assert.equal((await getUser(pool, owner)).name, 'Before'); assert.equal((await getUser(pool, owner)).avatarFileId, null);
  assert.equal((await pool.query('SELECT count(*)::int n FROM idempotency_requests')).rows[0].n, 0);
  const own = await image(pool, { owner });
  await assert.rejects(transaction(pool, client => replaceFileReferences(client, { appId, kind: 'user', id: other }, [{ slot: 'avatar', fileId: own }], { userId: owner })), { code: 'FILE_OWNER_MISMATCH' });
  await assert.rejects(transaction(pool, client => replaceFileReferences(client, { appId, kind: 'user', id: owner }, [{ slot: 'image.0', fileId: own }], { userId: owner })), { code: 'INVALID_AVATAR_REFERENCE' });
  await assert.rejects(pool.query("INSERT INTO file_references VALUES($1,'user',$2,'image.0',$3)", [appId, owner, own]), /file_references_user_avatar_check/);
});

test('historical unknown-owner avatars can only be retained at their current reference, never moved or resurrected', enabled, async t => {
  const db = await createTestDatabase(); t.after(db.close); const { pool } = db;
  const owner = await user(pool), other = await user(pool), legacy = await historicalAvatar(pool, owner);
  await updateUser(pool, owner, 'legacy-retain', { avatarFileId: legacy, name: 'Retained' });
  assert.equal((await getUser(pool, owner)).avatarFileId, legacy); assert.equal((await read(pool, legacy, owner))[0]!.id, legacy);
  await assert.rejects(read(pool, legacy, other), unavailable);
  await assert.rejects(updateUser(pool, other, 'legacy-takeover', { avatarFileId: legacy }), { code: 'FILE_READONLY' });
  await updateUser(pool, owner, 'legacy-clear', { avatarFileId: null });
  await assert.rejects(updateUser(pool, owner, 'legacy-resurrect', { avatarFileId: legacy }), { code: 'FILE_READONLY' });
  await assert.rejects(read(pool, legacy, owner), unavailable);
  assert.equal((await pool.query('SELECT status FROM files WHERE id=$1', [legacy])).rows[0].status, 'ready');
});

test('a failed profile write restores the avatar; concurrent different keys leave one consistent profile/reference pair', enabled, async t => {
  const db = await createTestDatabase(); t.after(db.close); const { pool } = db;
  const owner = await user(pool), old = await historicalAvatar(pool, owner), one = await image(pool, { owner }), two = await image(pool, { owner });
  await pool.query(`CREATE FUNCTION reject_profile_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic write failure'; END; $$;
    CREATE TRIGGER reject_profile_fixture BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION reject_profile_fixture()`);
  await assert.rejects(updateUser(pool, owner, 'retry-after-failure', { name: 'New', avatarFileId: one }), /synthetic write failure/);
  assert.equal((await getUser(pool, owner)).avatarFileId, old);
  assert.equal((await pool.query('SELECT count(*)::int n FROM idempotency_requests')).rows[0].n, 0);
  await pool.query('DROP TRIGGER reject_profile_fixture ON users');
  const results = await Promise.all([updateUser(pool, owner, 'retry-after-failure', { name: 'One', avatarFileId: one }), updateUser(pool, owner, 'second-avatar-key', { name: 'Two', avatarFileId: two })]);
  assert.deepEqual(results.map(result => result.data.avatarFileId), [one, two]);
  const final = await getUser(pool, owner);
  assert.ok((final.avatarFileId === one && final.name === 'One') || (final.avatarFileId === two && final.name === 'Two'));
  assert.equal((await pool.query("SELECT count(*)::int n FROM file_references WHERE resource_kind='user' AND resource_id=$1", [owner])).rows[0].n, 1);
});

async function ride(pool: Pool, kind: string, creator: string, members: { id: string; role: string }[]) {
  const id = randomUUID();
  await pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone)
    VALUES($1,$2,$3,'ny_nj','open',4,clock_timestamp()+interval '1 day','America/New_York')`, [id, kind, creator]);
  for (const m of members) await pool.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state,joined_at) VALUES($1,$2,$3,$4,'active',clock_timestamp())`, [id, m.id, m.role, m.role === 'driver' ? 0 : 1]);
  return id;
}
test('avatar reads enforce ride participant roles, active membership and cancelled-ride boundaries', enabled, async t => {
  const db = await createTestDatabase(); t.after(db.close); const { pool } = db;
  const driver = await user(pool), a = await user(pool), b = await user(pool), outsider = await user(pool);
  const driverImage = await historicalAvatar(pool, driver), aImage = await historicalAvatar(pool, a), bImage = await historicalAvatar(pool, b);
  const offer = await ride(pool, 'offer', driver, [{ id: driver, role: 'driver' }, { id: a, role: 'passenger' }, { id: b, role: 'passenger' }]);
  assert.equal((await read(pool, aImage, driver))[0]!.id, aImage); assert.equal((await read(pool, driverImage, a))[0]!.id, driverImage);
  await assert.rejects(read(pool, bImage, a), unavailable); await assert.rejects(read(pool, aImage, outsider), unavailable); await assert.rejects(read(pool, aImage), unavailable);
  await pool.query("UPDATE rides SET status='closed' WHERE id=$1", [offer]);
  assert.equal((await read(pool, aImage, driver))[0]!.id, aImage);
  await pool.query("UPDATE rides SET status='cancelled' WHERE id=$1", [offer]); await assert.rejects(read(pool, aImage, driver), unavailable);
  const request = await ride(pool, 'request', a, [{ id: driver, role: 'driver' }, { id: a, role: 'passenger' }, { id: b, role: 'passenger' }]);
  assert.equal((await read(pool, bImage, a))[0]!.id, bImage);
  await pool.query("UPDATE ride_members SET state='left',left_at=clock_timestamp() WHERE ride_id=$1 AND user_id=$2", [request, a]);
  await assert.rejects(read(pool, bImage, a), unavailable); assert.equal((await read(pool, aImage, a))[0]!.id, aImage);
});

test('avatar reads require visible nonmanaged sellers or outgoing active blocks; replacement revokes old public access', enabled, async t => {
  const db = await createTestDatabase(); t.after(db.close); const { pool } = db;
  const seller = await user(pool), viewer = await user(pool), foreign = await user(pool, 'foreign-app');
  const avatar = await historicalAvatar(pool, seller), listing = randomUUID();
  await assert.rejects(read(pool, avatar, viewer), unavailable);
  await pool.query(`INSERT INTO market_listings(app_id,id,owner_user_id,content,status,expires_at) VALUES($1,$2,$3,'{}','online',clock_timestamp()+interval '1 day')`, [appId, listing, seller]);
  assert.equal((await read(pool, avatar, viewer))[0]!.id, avatar); await assert.rejects(read(pool, avatar), unavailable); await assert.rejects(read(pool, avatar, foreign), { code: 'UNAUTHORIZED' });
  await pool.query('UPDATE market_listings SET shared_admin_management=true WHERE id=$1', [listing]); await assert.rejects(read(pool, avatar, viewer), unavailable);
  await pool.query('UPDATE market_listings SET shared_admin_management=false WHERE id=$1', [listing]);
  for (const status of ['offline', 'sold', 'deleted']) { await pool.query('UPDATE market_listings SET status=$2 WHERE id=$1', [listing, status]); await assert.rejects(read(pool, avatar, viewer), unavailable); }
  await pool.query("UPDATE market_listings SET status='online',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1", [listing]); await assert.rejects(read(pool, avatar, viewer), unavailable);
  await pool.query("INSERT INTO user_blocks(blocker_id,target_id,reason) VALUES($1,$2,'fixture')", [seller, viewer]); await assert.rejects(read(pool, avatar, viewer), unavailable);
  await pool.query("INSERT INTO user_blocks(blocker_id,target_id,reason) VALUES($1,$2,'fixture')", [viewer, seller]); assert.equal((await read(pool, avatar, viewer))[0]!.id, avatar);
  await pool.query('UPDATE user_blocks SET active=false WHERE blocker_id=$1', [viewer]); await assert.rejects(read(pool, avatar, viewer), unavailable);
  await pool.query("UPDATE market_listings SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1", [listing]);
  const replacement = await image(pool, { owner: seller }); await updateUser(pool, seller, 'seller-new-avatar', { avatarFileId: replacement });
  await assert.rejects(read(pool, avatar, viewer), unavailable); assert.equal((await read(pool, replacement, viewer))[0]!.id, replacement);
});

test('HTTP authenticates upload, binds and resolves an image ID, and rejects every avatarUrl alias', enabled, async t => {
  const db = await createTestDatabase(); const objects = new Map<string, { body: Buffer; mediaType: string }>();
  const provider: FileStorage = { bucket: 'synthetic-avatar-bucket', objects: {
    async put(locator, body, mediaType) { objects.set(locator, { body: Buffer.from(body), mediaType }); },
    async read(locator) { return objects.get(locator) ?? null; }
  }, async readUrl(file, ttl) { assert.equal(ttl, 300); return `https://images.example.test/${file.id}`; } };
  const app = await createApp({ pool: db.pool, config: { databaseUrl: '', host: '127.0.0.1', port: 3100, appId, sessionTtlSeconds: 3600, businessMode: 'active' }, storage: provider, exchange: async () => ({ openid: 'synthetic-avatar-user' }) });
  t.after(async () => { await app.close(); await db.close(); });
  assert.equal((await app.inject({ url: '/api/v1/me' })).statusCode, 401);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { code: 'synthetic-login' } }); assert.equal(login.statusCode, 200, login.body);
  const authorization = `Bearer ${login.json().data.token}`;
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#457890' } }).png().toBuffer();
  const uploaded = await app.inject({ method: 'POST', url: '/api/v1/files/images', headers: { authorization, 'content-type': 'application/octet-stream', 'idempotency-key': 'avatar-image-upload' }, payload: bytes });
  assert.equal(uploaded.statusCode, 201, uploaded.body); const fileId = uploaded.json().data.fileId;
  const saved = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: { authorization, 'idempotency-key': 'avatar-profile-save' }, payload: { avatarFileId: fileId } });
  assert.equal(saved.statusCode, 200, saved.body); assert.equal(saved.json().data.avatarFileId, fileId); assert.equal(Object.hasOwn(saved.json().data, 'avatarUrl'), false);
  const opened = await app.inject({ url: '/api/v1/me', headers: { authorization } }); assert.equal(opened.json().data.avatarFileId, fileId); assert.equal(opened.headers['cache-control'], 'private, no-store');
  const urls = await app.inject({ method: 'POST', url: '/api/v1/files/urls', headers: { authorization }, payload: { fileIds: [fileId] } }); assert.equal(urls.statusCode, 200, urls.body);
  for (const avatarUrl of ['https://images.example.test/pretend.png', 'cloud://arbitrary/path', fileId, '']) {
    const response = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: { authorization, 'idempotency-key': 'reject-avatar-url' }, payload: { avatarUrl } }); assert.equal(response.statusCode, 400);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/files/urls', payload: { fileIds: [fileId] } })).statusCode, 404);
});

test('migration 025 refuses populated legacy avatar data and rolls back all schema changes', enabled, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'linkx-avatar-schema-')), schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.BACKEND_TEST_DATABASE_URL, max: 1 }); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.BACKEND_TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 1 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(directory, { recursive: true, force: true }); });
  const source = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const name of await readdir(source)) if (/^\d{3}_.*\.sql$/.test(name) && name < '025_') await copyFile(join(source, name), join(directory, name));
  await runMigrations(pool, directory);
  await pool.query("INSERT INTO users(app_id,openid,avatar_url) VALUES('avatar-migration','synthetic-user','cloud://preserved/avatar.png')");
  await assert.rejects(runMigrations(pool), /Existing avatars require explicit reconciliation/);
  assert.equal((await pool.query('SELECT avatar_url FROM users')).rows[0].avatar_url, 'cloud://preserved/avatar.png');
  assert.equal((await pool.query("SELECT count(*)::int n FROM schema_migrations WHERE version LIKE '025_%'")).rows[0].n, 0);
  await pool.query("UPDATE users SET avatar_url='' "); // Only this synthetic fixture is deliberately cleared.
  await runMigrations(pool);
  assert.equal((await pool.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema=$1 AND table_name='users' AND column_name='avatar_url'", [schema])).rows[0].n, 0);
});
