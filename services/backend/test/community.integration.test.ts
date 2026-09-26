import assert from 'node:assert/strict';
import { randomUUID, scryptSync } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { createApp } from '../src/app.ts';
import { transaction } from '../src/db.ts';
import { loginAdmin, requireAdmin } from '../src/admin/service.ts';
import type { AdminIdentity } from '../src/admin/service.ts';
import { confirmFile, queueFileDeletion, reserveFile } from '../src/files/service.ts';
import { emptyCommunity, communityConfigSchema } from '../src/community/schemas.ts';
import { getCommunity, getAdminCommunity, updateCommunity } from '../src/community/service.ts';
import { createTestDatabase } from './helpers/database.ts';

const appId = 'community-test';
const password = 'synthetic-community-password';
const origin = 'https://admin.example.test';
const future = () => new Date(Date.now() + 86400000).toISOString();
const past = () => new Date(Date.now() - 86400000).toISOString();
const config = () => {
  const defaults = emptyCommunity();
  return { group: { ...defaults.group, imageFileId: null as string | null }, announcement: { ...defaults.announcement, imageFileId: null as string | null } };
};
async function admin(pool: Pool, id = 'admin_one', owner = 'shared-owner', application = appId) {
  const salt = Buffer.alloc(32, 22);
  await pool.query(`INSERT INTO admin_accounts(app_id,id,owner_key,enabled,credential_version,password_salt,password_hash)
    VALUES($1,$2,$3,true,1,$4,$5)`, [application, id, owner, salt, scryptSync(password, salt, 64)]);
  const login = await loginAdmin(pool, application, { username: id, password });
  return { identity: await requireAdmin(pool, application, `Bearer ${login.token}`), token: login.token };
}
async function image(pool: Pool, identity: AdminIdentity) {
  return transaction(pool, async client => {
    const owner = { adminOwnerKey: identity.ownerKey, adminAccountId: identity.accountId };
    const row = await reserveFile(client, { appId: identity.appId, provider: 'cos', locator: `synthetic/${randomUUID()}.png`, owner });
    await confirmFile(client, { appId: identity.appId, owner, fileId: row.id,
      metadata: { sizeBytes: 100, mediaType: 'image/png', sha256: 'a'.repeat(64) } });
    return row.id;
  });
}
async function facts(pool: Pool) {
  const result = await pool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY app_id) FROM community_configs c) AS configs,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY version) FROM community_revisions r) AS revisions,
    (SELECT jsonb_agg(to_jsonb(f) ORDER BY slot) FROM file_references f) AS files,
    (SELECT jsonb_agg(to_jsonb(q) ORDER BY request_key) FROM admin_requests q) AS requests`);
  return result.rows[0];
}

test('community: absent defaults, same-request retries, shared admin editing and one version winner', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const one = (await admin(db.pool)).identity;
  const two = (await admin(db.pool, 'admin_two', 'other-owner')).identity;
  const empty = await getAdminCommunity(db.pool, one);
  assert.deepEqual(empty, { config: config(), version: 0, updatedAt: null });
  assert.equal((await getCommunity(db.pool, appId)).group.enabled, false);
  const current = config(); current.announcement = { ...current.announcement, id: 'welcome', body: 'Hello', enabled: true };
  const body = { config: current, expectedVersion: 0 };
  const writes = await Promise.all(Array.from({ length: 6 }, () => updateCommunity(db.pool, one, 'community-create', body)));
  writes.forEach(result => assert.deepEqual(result, writes[0]));
  assert.equal((await db.pool.query('SELECT count(*) FROM community_revisions')).rows[0].count, '1');
  assert.equal((await db.pool.query("SELECT count(*) FROM admin_audit WHERE action='community.update'")).rows[0].count, '1');
  await assert.rejects(updateCommunity(db.pool, two, 'stale-admin-write', body), { code: 'COMMUNITY_VERSION_CONFLICT' });
  const concurrent = await Promise.allSettled([one, two].map((identity, i) => updateCommunity(db.pool, identity, `community-change-${i}`,
    { expectedVersion: 1, config: { ...current, announcement: { ...current.announcement, body: `Version2-${i}` } } })));
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((concurrent.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'COMMUNITY_VERSION_CONFLICT');
  const chain = (await db.pool.query('SELECT * FROM community_revisions ORDER BY version')).rows;
  assert.deepEqual(chain[1].before_content, chain[0].after_content);
  assert.equal((await getAdminCommunity(db.pool, two)).version, 2);
  await assert.rejects(updateCommunity(db.pool, one, 'community-create', { ...body, config: config() }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(await updateCommunity(db.pool, one, 'community-create', body), writes[0]);
});

test('community: attachments, revisions and receipt commit atomically; history protects rollback images', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const one = (await admin(db.pool)).identity;
  const two = (await admin(db.pool, 'admin_two', 'another-owner')).identity;
  const fileId = await image(db.pool, one);
  const original = config(); original.group = { enabled: true, title: 'Group', expiresAt: future(), imageFileId: fileId };
  const first = await updateCommunity(db.pool, one, 'community-image-first', { expectedVersion: 0, config: original });
  const clean = config();
  await updateCommunity(db.pool, two, 'community-image-remove', { expectedVersion: 1, config: clean });
  await assert.rejects(transaction(db.pool, client => queueFileDeletion(client, { appId, fileId })), { code: 'FILE_REFERENCED' });
  // Historical community use permits restoration by another effective admin,
  // without changing the file owner or granting use on another resource.
  await updateCommunity(db.pool, two, 'community-image-restore', { expectedVersion: 2, config: original });
  assert.equal((await getCommunity(db.pool, appId)).group.imageFileId, fileId);
  const refs = (await db.pool.query('SELECT slot FROM file_references ORDER BY slot')).rows.map(row => row.slot);
  assert.deepEqual(refs, ['group', 'history.1.after.group', 'history.2.before.group', 'history.3.after.group']);
  const foreignFile = await image(db.pool, two);
  const before = await facts(db.pool);
  await assert.rejects(updateCommunity(db.pool, one, 'community-foreign-image', { expectedVersion: 3,
    config: { ...original, group: { ...original.group, imageFileId: foreignFile } } }), { code: 'FILE_OWNER_MISMATCH' });
  assert.deepEqual(await facts(db.pool), before);
  await db.pool.query(`CREATE FUNCTION reject_community_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.operation='community.update' THEN RAISE EXCEPTION 'synthetic community receipt failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_community_receipt BEFORE INSERT ON admin_requests FOR EACH ROW EXECUTE FUNCTION reject_community_receipt()`);
  await assert.rejects(updateCommunity(db.pool, two, 'community-atomic-failure', { expectedVersion: 3, config: clean }), /synthetic community receipt failure/);
  assert.deepEqual(await facts(db.pool), before);
  assert.deepEqual(await updateCommunity(db.pool, one, 'community-image-first', { expectedVersion: 0, config: original }), first);
});

test('community: a second admin cannot introduce an unused same-owner upload, but can retain legacy history', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const one = (await admin(db.pool)).identity;
  const two = (await admin(db.pool, 'admin_two')).identity;
  const ownFile = await image(db.pool, one);
  const original = config(); original.group = { ...original.group, imageFileId: ownFile };
  await assert.rejects(updateCommunity(db.pool, two, 'unpublished-group-image', { expectedVersion: 0, config: original }), { code: 'FILE_UPLOADER_MISMATCH' });
  const legacy = randomUUID();
  await db.pool.query(`INSERT INTO files(id,app_id,provider,locator,legacy_readonly,status,created_at,updated_at)
    VALUES($1,$2,'cloudbase',$3,true,'ready',NULL,NULL)`, [legacy, appId, `cloud://synthetic/community/${legacy}.png`]);
  await db.pool.query(`INSERT INTO community_configs(app_id,version,content) VALUES($1,0,$2)`, [appId, emptyCommunity()]);
  await db.pool.query(`INSERT INTO file_references VALUES($1,'community','main','announcement',$2)`, [appId, legacy]);
  original.group.imageFileId = legacy;
  await updateCommunity(db.pool, two, 'legacy-group-image', { expectedVersion: 0, config: original });
  assert.equal((await getAdminCommunity(db.pool, two)).config.group.imageFileId, legacy);
  assert.equal((await db.pool.query('SELECT owner_user_id,admin_owner_key FROM files WHERE id=$1', [legacy])).rows[0].admin_owner_key, null);
});

test('community: public availability preserves manual mode, windows, group expiry and app isolation', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const identity = (await admin(db.pool)).identity;
  const current = config();
  current.announcement = { ...current.announcement, id: 'manual', enabled: false, title: 'News', body: 'Hello  world\n\n\nnext' };
  await updateCommunity(db.pool, identity, 'manual-announcement', { expectedVersion: 0, config: current });
  let publicData = await getCommunity(db.pool, appId);
  assert.equal(publicData.announcement.available, true);
  assert.equal(publicData.announcement.enabled, false);
  assert.equal(publicData.announcement.body, 'Hello world\n\nnext');
  const serialized = JSON.stringify(publicData);
  for (const privateField of ['updatedBy', 'history', 'owner', 'locator', 'version']) assert.ok(!serialized.includes(privateField));
  assert.equal((await getCommunity(db.pool, 'another-app')).announcement.available, false);
  current.announcement.startAt = future();
  await updateCommunity(db.pool, identity, 'future-announcement', { expectedVersion: 1, config: current });
  assert.equal((await getCommunity(db.pool, appId)).announcement.available, false);
  current.announcement.startAt = null;
  current.group = { ...current.group, enabled: true, imageFileId: await image(db.pool, identity), expiresAt: future() };
  current.announcement.showGroupImage = true;
  await updateCommunity(db.pool, identity, 'group-announcement', { expectedVersion: 2, config: current });
  publicData = await getCommunity(db.pool, appId);
  assert.equal(publicData.announcement.imageFileId, current.group.imageFileId);
  assert.equal(publicData.announcement.endAt, current.group.expiresAt);
  await db.pool.query(`UPDATE community_configs SET content=jsonb_set(content,'{group,expiresAt}',to_jsonb($2::text)) WHERE app_id=$1`, [appId, past()]);
  publicData = await getCommunity(db.pool, appId);
  assert.equal(publicData.group.enabled, false);
  assert.equal(publicData.announcement.available, false);
  assert.equal(publicData.announcement.imageFileId, null);
});

test('community: active expired writes fail, old receipts replay, malformed bodies and revoked sessions cannot write', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const identity = (await admin(db.pool)).identity;
  const current = config(); current.announcement = { ...current.announcement, enabled: true, id: 'expired', body: 'hello', endAt: past() };
  await assert.rejects(updateCommunity(db.pool, identity, 'expired-announcement', { expectedVersion: 0, config: current }), { code: 'COMMUNITY_EXPIRED' });
  current.announcement.endAt = future();
  const body = { expectedVersion: 0, config: current };
  const result = await updateCommunity(db.pool, identity, 'expire-later-announcement', body);
  await db.pool.query(`UPDATE community_configs SET content=jsonb_set(content,'{announcement,endAt}',to_jsonb($2::text)) WHERE app_id=$1`, [appId, past()]);
  assert.deepEqual(await updateCommunity(db.pool, identity, 'expire-later-announcement', body), result);
  for (const input of [
    { ...current, unknown: true }, { ...current, group: { ...current.group, imageFileId: 'cloud://untrusted/file.png' } },
    { ...current, announcement: { ...current.announcement, startAt: '2026-02-30T00:00:00.000Z' } },
    { ...current, announcement: { ...current.announcement, maxShows: 1.5 } },
  ]) assert.equal(communityConfigSchema.safeParse(input).success, false);
  await db.pool.query('UPDATE admin_accounts SET enabled=false WHERE app_id=$1 AND id=$2', [appId, identity.accountId]);
  await assert.rejects(getAdminCommunity(db.pool, identity), { code: 'ADMIN_UNAUTHORIZED' });
  await assert.rejects(updateCommunity(db.pool, identity, 'expire-later-announcement', body), { code: 'ADMIN_UNAUTHORIZED' });
});

test('community routes: real assembled app origin, auth, parser errors, public projection and strict query', async t => {
  const db = await createTestDatabase();
  const app = await createApp({ config: { databaseUrl: '', host: '127.0.0.1', port: 3100, appId, sessionTtlSeconds: 3600 }, pool: db.pool });
  t.after(async () => { await app.close(); await db.close(); });
  const one = await admin(db.pool);
  await db.pool.query('INSERT INTO admin_origins VALUES($1,$2)', [appId, origin]);
  const headers = { origin, authorization: `Bearer ${one.token}` };
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/community' })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/community', headers: { origin } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/community', headers })).statusCode, 200);
  const publicResponse = await app.inject({ method: 'GET', url: '/api/v1/community' });
  assert.equal(publicResponse.statusCode, 200);
  assert.equal(publicResponse.headers['cache-control'], 'no-store');
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/community?appId=other' })).statusCode, 400);
  const invalid = await app.inject({ method: 'POST', url: '/api/v1/admin/community', headers: { ...headers, 'content-type': 'application/json' }, payload: '{' });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.headers['cache-control'], 'private, no-store');
  const created = await app.inject({ method: 'POST', url: '/api/v1/admin/community', headers: { ...headers, 'idempotency-key': 'http-community-save' }, payload: { expectedVersion: 0, config: config() } });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().data.version, 1);
});
