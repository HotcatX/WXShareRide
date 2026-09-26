import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import type { Pool } from 'pg';
import type { AdminIdentity } from '../src/admin/service.ts';
import { emptyCommunity } from '../src/community/schemas.ts';
import type { CommunityContent } from '../src/community/schemas.ts';
import { authorizeFileReads } from '../src/files/read.ts';
import { createTestDatabase } from './helpers/database.ts';

const appId = 'file-reading-fixture';
const settings = { skip: !process.env.BACKEND_TEST_DATABASE_URL, timeout: 30000 };
const code = (expected = 'FILE_NOT_FOUND') => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
const future = () => new Date(Date.now() + 86400000).toISOString();
const past = () => new Date(Date.now() - 86400000).toISOString();
async function user(pool: Pool, app = appId) {
  return (await pool.query('INSERT INTO users(app_id,openid) VALUES($1,$2) RETURNING id', [app, randomUUID()])).rows[0].id as string;
}
async function admin(pool: Pool, id = 'admin_one', ownerKey = 'owner_one', app = appId): Promise<AdminIdentity> {
  await pool.query(`INSERT INTO admin_accounts(app_id,id,owner_key,enabled,credential_version,password_salt,password_hash)
    VALUES($1,$2,$3,true,1,$4,$5)`, [app, id, ownerKey, Buffer.alloc(32, 1), Buffer.alloc(64, 2)]);
  const sessionHash = randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO admin_sessions(token_hash,app_id,account_id,credential_version,expires_at)
    VALUES($1,$2,$3,1,clock_timestamp()+interval '1 hour')`, [sessionHash, app, id]);
  return { appId: app, accountId: id, ownerKey, credentialVersion: 1, sessionHash };
}
async function file(pool: Pool, options: { app?: string; userId?: string; admin?: AdminIdentity; status?: string } = {}) {
  const id = randomUUID(), locator = `cloud://synthetic-private/${randomUUID()}.png`;
  // Real legacy rows can have unknown ownership and no verified binary metadata.
  await pool.query(`INSERT INTO files(id,app_id,provider,locator,owner_user_id,admin_owner_key,uploaded_by_admin_id,legacy_readonly,status)
    VALUES($1,$2,'cloudbase',$3,$4,$5,$6,true,$7)`, [id, options.app ?? appId, locator, options.userId ?? null,
    options.admin?.ownerKey ?? null, options.admin?.accountId ?? null, options.status ?? 'ready']);
  return { id, provider: 'cloudbase', locator };
}
async function reference(pool: Pool, fileId: string, kind: string, resourceId: string, slot: string, app = appId) {
  await pool.query('INSERT INTO file_references(app_id,resource_kind,resource_id,slot,file_id) VALUES($1,$2,$3,$4,$5)',
    [app, kind, resourceId, slot, fileId]);
}
async function listing(pool: Pool, userId: string | null, options: { adminOwner?: string; shared?: boolean; status?: string; expiresAt?: string; app?: string } = {}) {
  const id = randomUUID();
  await pool.query(`INSERT INTO market_listings(app_id,id,owner_user_id,admin_owner_key,shared_admin_management,status,expires_at,content)
    VALUES($1,$2,$3,$4,$5,$6,$7,'{}')`, [options.app ?? appId, id, userId, options.adminOwner ?? null,
    options.shared ?? false, options.status ?? 'online', options.expiresAt ?? future()]);
  return id;
}
async function community(pool: Pool, content: CommunityContent, app = appId) {
  await pool.query(`INSERT INTO community_configs(app_id,version,content) VALUES($1,1,$2)
    ON CONFLICT(app_id) DO UPDATE SET content=EXCLUDED.content`, [app, content]);
}
async function advertisement(pool: Pool, options: { status?: string; start?: string; end?: string; app?: string } = {}) {
  const id = randomUUID();
  await pool.query(`INSERT INTO ads(app_id,id,status,placement,title,subtitle,badge_text,cta_text,weight,priority,start_at,end_at,target)
    VALUES($1,$2,$3,'market','Synthetic','','Ad','Read',1,0,$4,$5,$6)`, [options.app ?? appId, id, options.status ?? 'online',
    options.start ?? null, options.end ?? null,
    { kind: 'contact', sessionFrom: '', messageCard: { enabled: false, title: 'Contact', path: '' } }]);
  return id;
}

test('file reads: guests receive only current ready images from visible listings, with app and slot isolation', settings, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = await user(db.pool), current = await listing(db.pool, owner);
  const main = await file(db.pool), thumb = await file(db.pool);
  await reference(db.pool, main.id, 'listing', current, 'image.0');
  await reference(db.pool, thumb.id, 'listing', current, 'thumbnail.0');
  assert.deepEqual(await authorizeFileReads(db.pool, appId, [thumb.id, main.id]), [thumb, main]);
  const removed = await file(db.pool);
  await reference(db.pool, removed.id, 'listing', current, 'history.1.image');
  await assert.rejects(authorizeFileReads(db.pool, appId, [removed.id]), code());
  for (const status of ['offline', 'sold', 'deleted']) {
    await db.pool.query('UPDATE market_listings SET status=$1 WHERE id=$2', [status, current]);
    await assert.rejects(authorizeFileReads(db.pool, appId, [main.id]), code());
  }
  await db.pool.query("UPDATE market_listings SET status='online',expires_at=$1 WHERE id=$2", [past(), current]);
  await assert.rejects(authorizeFileReads(db.pool, appId, [main.id]), code());
  await db.pool.query('UPDATE market_listings SET expires_at=$1 WHERE id=$2', [future(), current]);
  for (const status of ['pending', 'deleting', 'deleted']) {
    await db.pool.query('UPDATE files SET status=$1 WHERE id=$2', [status, main.id]);
    await assert.rejects(authorizeFileReads(db.pool, appId, [main.id]), code());
  }
  const orphan = await file(db.pool); await reference(db.pool, orphan.id, 'listing', randomUUID(), 'image.0');
  await assert.rejects(authorizeFileReads(db.pool, appId, [orphan.id]), code());
  const foreignUser = await user(db.pool, 'foreign-app');
  const foreignListing = await listing(db.pool, foreignUser, { app: 'foreign-app' });
  const foreignFile = await file(db.pool, { app: 'foreign-app' });
  await reference(db.pool, foreignFile.id, 'listing', foreignListing, 'image.0', 'foreign-app');
  await assert.rejects(authorizeFileReads(db.pool, appId, [foreignFile.id]), code());
  assert.deepEqual(await authorizeFileReads(db.pool, 'foreign-app', [foreignFile.id]), [foreignFile]);
});

test('file reads: owners can read ready private uploads and their nondeleted listings, never other users uploads', settings, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const one = await user(db.pool), two = await user(db.pool);
  const upload = await file(db.pool, { userId: one });
  assert.deepEqual(await authorizeFileReads(db.pool, appId, [upload.id], { userId: one }), [upload]);
  await assert.rejects(authorizeFileReads(db.pool, appId, [upload.id]), code());
  await assert.rejects(authorizeFileReads(db.pool, appId, [upload.id], { userId: two }), code());
  const ownListing = await listing(db.pool, one, { status: 'sold', expiresAt: past() });
  const attached = await file(db.pool); await reference(db.pool, attached.id, 'listing', ownListing, 'image.0');
  assert.deepEqual(await authorizeFileReads(db.pool, appId, [attached.id], { userId: one }), [attached]);
  await assert.rejects(authorizeFileReads(db.pool, appId, [attached.id], { userId: two }), code());
  await db.pool.query("UPDATE market_listings SET status='deleted' WHERE id=$1", [ownListing]);
  await assert.rejects(authorizeFileReads(db.pool, appId, [attached.id], { userId: one }), code());
  await db.pool.query("UPDATE files SET status='pending' WHERE id=$1", [upload.id]);
  await assert.rejects(authorizeFileReads(db.pool, appId, [upload.id], { userId: one }), code());
  const foreign = await user(db.pool, 'foreign-app');
  await assert.rejects(authorizeFileReads(db.pool, appId, [upload.id], { userId: foreign }), code('UNAUTHORIZED'));
});

test('file reads: admin private uploads require original actor; real current shared listings grant narrowly scoped access', settings, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const one = await admin(db.pool), two = await admin(db.pool, 'admin_two'), other = await admin(db.pool, 'admin_other', 'other_owner');
  const privateFile = await file(db.pool, { admin: one });
  assert.deepEqual(await authorizeFileReads(db.pool, appId, [privateFile.id], { admin: one }), [privateFile]);
  for (const identity of [two, other]) await assert.rejects(authorizeFileReads(db.pool, appId, [privateFile.id], { admin: identity }), code());
  const shared = await listing(db.pool, null, { adminOwner: one.ownerKey, status: 'offline', expiresAt: past() });
  await reference(db.pool, privateFile.id, 'listing', shared, 'image.0');
  assert.deepEqual(await authorizeFileReads(db.pool, appId, [privateFile.id], { admin: two }), [privateFile]);
  await assert.rejects(authorizeFileReads(db.pool, appId, [privateFile.id], { admin: other }), code());
  await db.pool.query("UPDATE market_listings SET status='deleted' WHERE id=$1", [shared]);
  await assert.rejects(authorizeFileReads(db.pool, appId, [privateFile.id], { admin: two }), code());
  assert.deepEqual(await authorizeFileReads(db.pool, appId, [privateFile.id], { admin: one }), [privateFile]);
  const legacy = await listing(db.pool, await user(db.pool), { shared: true, status: 'sold', expiresAt: past() });
  const legacyImage = await file(db.pool); await reference(db.pool, legacyImage.id, 'listing', legacy, 'image.0');
  assert.deepEqual(await authorizeFileReads(db.pool, appId, [legacyImage.id], { admin: other }), [legacyImage]);
  const ordinary = await listing(db.pool, await user(db.pool), { status: 'offline' });
  const ordinaryImage = await file(db.pool); await reference(db.pool, ordinaryImage.id, 'listing', ordinary, 'image.0');
  await assert.rejects(authorizeFileReads(db.pool, appId, [ordinaryImage.id], { admin: one }), code());
});

test('file reads: public community uses display availability, manual announcements and exact current slots', settings, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const group = await file(db.pool), announcement = await file(db.pool);
  await reference(db.pool, group.id, 'community', 'main', 'group');
  await reference(db.pool, announcement.id, 'community', 'main', 'announcement');
  const content = emptyCommunity();
  content.group = { enabled: true, title: 'Group', expiresAt: future() };
  content.announcement = { ...content.announcement, id: 'manual', enabled: false };
  await community(db.pool, content);
  assert.deepEqual(await authorizeFileReads(db.pool, appId, [group.id, announcement.id]), [group, announcement]);
  content.announcement.showGroupImage = true; await community(db.pool, content);
  assert.deepEqual(await authorizeFileReads(db.pool, appId, [group.id]), [group]);
  await assert.rejects(authorizeFileReads(db.pool, appId, [announcement.id]), code());
  content.group.expiresAt = past(); await community(db.pool, content);
  await assert.rejects(authorizeFileReads(db.pool, appId, [group.id]), code());
  content.announcement.showGroupImage = false;
  for (const window of [{ startAt: future(), endAt: null }, { startAt: null, endAt: past() }]) {
    Object.assign(content.announcement, window); await community(db.pool, content);
    await assert.rejects(authorizeFileReads(db.pool, appId, [announcement.id]), code());
  }
  Object.assign(content.announcement, { startAt: null, endAt: null, id: '' }); await community(db.pool, content);
  await assert.rejects(authorizeFileReads(db.pool, appId, [announcement.id]), code());
  content.group.enabled = false; content.group.expiresAt = future(); await community(db.pool, content);
  await assert.rejects(authorizeFileReads(db.pool, appId, [group.id]), code());
});

test('file reads: admins may see current and genuine community history across owners, but not orphan history or another app', settings, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const identity = await admin(db.pool), current = await file(db.pool), historical = await file(db.pool), orphan = await file(db.pool);
  const content = emptyCommunity(); await community(db.pool, content);
  await db.pool.query(`INSERT INTO community_revisions(app_id,id,version,previous_version,before_content,after_content)
    VALUES($1,'v_1',1,0,$2,$2)`, [appId, content]);
  await reference(db.pool, current.id, 'community', 'main', 'group');
  await reference(db.pool, historical.id, 'community', 'main', 'history.1.before.group');
  await reference(db.pool, orphan.id, 'community', 'main', 'history.2.before.group');
  assert.deepEqual(await authorizeFileReads(db.pool, appId, [current.id, historical.id], { admin: identity }), [current, historical]);
  for (const image of [current, historical, orphan]) await assert.rejects(authorizeFileReads(db.pool, appId, [image.id]), code());
  await assert.rejects(authorizeFileReads(db.pool, appId, [orphan.id], { admin: identity }), code());
  const foreign = await admin(db.pool, 'foreign_admin', 'foreign_owner', 'foreign-app');
  await assert.rejects(authorizeFileReads(db.pool, appId, [historical.id], { admin: foreign }), code('ADMIN_UNAUTHORIZED'));
  await db.pool.query("UPDATE files SET status='pending' WHERE id=$1", [historical.id]);
  await assert.rejects(authorizeFileReads(db.pool, appId, [historical.id], { admin: identity }), code());
});

test('file reads: advertisements grant public image access only while online and within their window', settings, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const identity = await admin(db.pool);
  const active = await advertisement(db.pool), image = await file(db.pool), thumb = await file(db.pool);
  await reference(db.pool, image.id, 'ad', active, 'image'); await reference(db.pool, thumb.id, 'ad', active, 'thumbnail');
  assert.deepEqual(await authorizeFileReads(db.pool, appId, [image.id, thumb.id]), [image, thumb]);
  for (const state of ['offline', 'deleted']) {
    await db.pool.query('UPDATE ads SET status=$1 WHERE id=$2', [state, active]);
    await assert.rejects(authorizeFileReads(db.pool, appId, [image.id]), code());
    await assert.rejects(authorizeFileReads(db.pool, appId, [image.id], { admin: identity }), code());
  }
  await db.pool.query("UPDATE ads SET status='online',start_at=$1 WHERE id=$2", [future(), active]);
  await assert.rejects(authorizeFileReads(db.pool, appId, [image.id]), code());
  await db.pool.query('UPDATE ads SET start_at=NULL,end_at=$1 WHERE id=$2', [past(), active]);
  await assert.rejects(authorizeFileReads(db.pool, appId, [image.id]), code());
  const extra = await file(db.pool); await reference(db.pool, extra.id, 'ad', active, 'history.image');
  await db.pool.query('UPDATE ads SET end_at=NULL WHERE id=$1', [active]);
  await assert.rejects(authorizeFileReads(db.pool, appId, [extra.id]), code());
});

test('file reads: bounded canonical UUID batches preserve order and fail wholly without exposing locators or existence', settings, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = await user(db.pool), upload = await file(db.pool, { userId: owner }), second = await file(db.pool, { userId: owner });
  assert.deepEqual(await authorizeFileReads(db.pool, appId, [second.id.toUpperCase(), upload.id, second.id], { userId: owner }), [second, upload]);
  for (const invalid of [[], Array(51).fill(upload.id), [upload.locator], { ids: [upload.id] }, [upload.id, null]]) {
    await assert.rejects(authorizeFileReads(db.pool, appId, invalid, { userId: owner }));
  }
  const privateFile = await file(db.pool);
  const errors: { status: unknown; code: unknown; message: string }[] = [];
  for (const id of [privateFile.id, randomUUID()]) {
    try { await authorizeFileReads(db.pool, appId, [upload.id, id], { userId: owner }); assert.fail('Expected rejection'); }
    catch (error) {
      assert.ok(error instanceof Error && 'code' in error && 'status' in error);
      errors.push({ status: error.status, code: error.code, message: error.message });
      for (const secret of [privateFile.id, privateFile.locator, upload.locator]) assert.ok(!error.message.includes(secret));
    }
  }
  assert.deepEqual(errors[0], errors[1]);
  assert.deepEqual(Object.keys((await authorizeFileReads(db.pool, appId, [upload.id], { userId: owner }))[0]!).sort(), ['id', 'locator', 'provider']);
});

test('file reads: expired and revoked admin sessions cannot read even otherwise public files; a lock wait rechecks revocation', settings, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const identity = await admin(db.pool), image = await file(db.pool);
  const published = await listing(db.pool, await user(db.pool)); await reference(db.pool, image.id, 'listing', published, 'image.0');
  await db.pool.query("UPDATE admin_sessions SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE token_hash=$1", [identity.sessionHash]);
  await assert.rejects(authorizeFileReads(db.pool, appId, [image.id], { admin: identity }), code('ADMIN_UNAUTHORIZED'));
  await db.pool.query("UPDATE admin_sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE token_hash=$1", [identity.sessionHash]);
  const blocker = await db.pool.connect();
  try {
    await blocker.query('BEGIN');
    const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await blocker.query('UPDATE admin_accounts SET enabled=false WHERE app_id=$1 AND id=$2', [appId, identity.accountId]);
    const waiting = authorizeFileReads(db.pool, appId, [image.id], { admin: identity }).then(value => ({ value, error: null }), error => ({ value: null, error }));
    let blocked = false;
    for (let index = 0; index < 200; index++) {
      blocked = (await db.pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked;
      if (blocked) break;
      await setTimeout(5);
    }
    assert.equal(blocked, true, 'Authorization must actually wait for the account mutation');
    await blocker.query('COMMIT');
    assert.ok(code('ADMIN_UNAUTHORIZED')((await waiting).error));
    assert.deepEqual(await authorizeFileReads(db.pool, appId, [image.id]), [image]);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
});
