import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { transaction } from '../src/db.ts';
import { AppError } from '../src/errors.ts';
import { reserveFile, confirmFile } from '../src/files/service.ts';
import { marketListingExpiresAt } from '../src/market/time.ts';
import { registerAdminRoutes } from '../src/admin/routes.ts';
import { registerAdminMarketRoutes } from '../src/admin/market-routes.ts';
import { adminMarketListingId, bulkCreateAdminMarketListings, createAdminMarketListing,
  getAdminMarketListing, updateAdminMarketListing } from '../src/admin/market.ts';
import type { AdminIdentity } from '../src/admin/service.ts';
import { createTestDatabase } from './helpers/database.ts';

const integration = { skip: !process.env.BACKEND_TEST_DATABASE_URL };
const APP = 'admin-market-test';
const content = () => ({ listingType: 'goods', title: 'Synthetic desk', description: 'Synthetic content', priceCents: 1200,
  category: '家具', condition: '99新', region: { state: 'NJ', county: 'Bergen', area: 'Fort Lee' },
  buildingName: '', location: null, startDate: '2026-09-01', endDate: '2026-09-30', sellerContact: null, sublet: null, images: [] });
async function admin(pool: Pool, ownerKey = 'shared-owner', appId = APP) {
  const accountId = `admin-${randomUUID()}`;
  const token = createHash('sha256').update(randomUUID()).digest('hex');
  const sessionHash = createHash('sha256').update(token).digest('hex');
  await pool.query(`INSERT INTO admin_accounts(app_id,id,owner_key,enabled,credential_version,password_salt,password_hash)
    VALUES($1,$2,$3,true,1,$4,$5)`, [appId, accountId, ownerKey, Buffer.alloc(32, 1), Buffer.alloc(64, 1)]);
  await pool.query(`INSERT INTO admin_sessions(token_hash,app_id,account_id,credential_version,expires_at)
    VALUES($1,$2,$3,1,clock_timestamp()+interval '1 hour')`, [sessionHash, appId, accountId]);
  return { actor: { appId, accountId, ownerKey, credentialVersion: 1, sessionHash } satisfies AdminIdentity, token };
}
async function file(pool: Pool, actor: AdminIdentity, ready = true) {
  return transaction(pool, async client => {
    const owner = { adminOwnerKey: actor.ownerKey, adminAccountId: actor.accountId };
    const row = await reserveFile(client, { appId: actor.appId, owner, provider: 'cos', locator: `fixture/${randomUUID()}` });
    if (ready) await confirmFile(client, { appId: actor.appId, owner, fileId: row.id,
      metadata: { sizeBytes: 1, mediaType: 'image/jpeg', sha256: 'a'.repeat(64) } });
    return row.id;
  });
}
const count = async (pool: Pool, table: 'market_listings' | 'admin_requests' | 'file_references') =>
  Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

test('admin market: concurrent owner-shared create receipts preserve identity after edit/deletion and reject changed payload', integration, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const [{ actor: first }, { actor: second }] = await Promise.all([admin(db.pool), admin(db.pool)]);
  const image = await file(db.pool, first), thumb = await file(db.pool, first);
  const body = { ...content(), images: [{ fileId: image, thumbFileId: thumb }] };
  // The first uploader establishes a trusted current reference before another
  // same-owner admin can reuse that upload. Receipt replays need no reattachment.
  const original = await createAdminMarketListing(db.pool, first, 'create-row-001', body);
  const concurrent = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    createAdminMarketListing(db.pool, index % 2 ? first : second, 'create-row-001', body)));
  assert.ok(concurrent.every(result => JSON.stringify(result) === JSON.stringify(original)));
  assert.deepEqual(original, { status: 201, data: { id: adminMarketListingId(first.ownerKey, 'create-row-001') } });
  assert.equal(await count(db.pool, 'market_listings'), 1); assert.equal(await count(db.pool, 'admin_requests'), 1);
  const item = await getAdminMarketListing(db.pool, second, original.data.id);
  assert.deepEqual(item.images, body.images); assert.equal(item.version, 0);
  assert.equal((await db.pool.query('SELECT content FROM market_listings')).rows[0].content.images, undefined);
  await assert.rejects(createAdminMarketListing(db.pool, first, 'create-row-001', { ...body, title: 'Other' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await db.pool.query("UPDATE market_listings SET status='deleted',version=4 WHERE id=$1", [original.data.id]);
  assert.deepEqual(await createAdminMarketListing(db.pool, second, 'create-row-001', body), original);
  await assert.rejects(getAdminMarketListing(db.pool, second, original.data.id), { code: 'LISTING_NOT_FOUND' });
  assert.equal(await count(db.pool, 'market_listings'), 1);
});

test('admin market: exact owner/app boundaries and explicit shared-user management; no status or owner patch', integration, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const [{ actor: own }, { actor: other }, { actor: foreign }] = await Promise.all([admin(db.pool), admin(db.pool, 'other-owner'), admin(db.pool, 'shared-owner', 'other-app')]);
  const id = (await createAdminMarketListing(db.pool, own, 'private-item-001', content())).data.id;
  for (const actor of [other, foreign]) {
    await assert.rejects(getAdminMarketListing(db.pool, actor, id), { code: 'LISTING_NOT_FOUND' });
    await assert.rejects(updateAdminMarketListing(db.pool, actor, 'private-edit-001', id, { expectedVersion: 0, patch: { title: 'Denied' } }), { code: 'LISTING_NOT_FOUND' });
  }
  const user = (await db.pool.query('INSERT INTO users(app_id,openid) VALUES($1,$2) RETURNING id', [APP, 'synthetic-user'])).rows[0].id;
  const { images: _images, ...stored } = content();
  for (const shared of [false, true]) {
    const sharedId = `legacy-shared-${shared}`;
    await db.pool.query(`INSERT INTO market_listings(app_id,id,owner_user_id,shared_admin_management,content,expires_at,status)
      VALUES($1,$2,$3,$4,$5,'2020-01-01T00:00:00Z','sold')`, [APP, sharedId, user, shared, stored]);
    if (!shared) {
      await assert.rejects(getAdminMarketListing(db.pool, own, sharedId), { code: 'LISTING_NOT_FOUND' });
      continue;
    }
    const updated = await updateAdminMarketListing(db.pool, other, 'shared-edit-001', sharedId, { expectedVersion: 0, patch: { title: 'Shared edit' } });
    assert.deepEqual(updated.data, { id: sharedId, version: 1, status: 'sold' });
    const raw = (await db.pool.query('SELECT * FROM market_listings WHERE id=$1', [sharedId])).rows[0];
    assert.equal(raw.owner_user_id, user); assert.equal(raw.admin_owner_key, null); assert.equal(raw.expires_at.toISOString(), '2020-01-01T00:00:00.000Z');
    await assert.rejects(getAdminMarketListing(db.pool, foreign, sharedId), { code: 'LISTING_NOT_FOUND' });
  }
  for (const patch of [{ status: 'online' }, { adminOwnerKey: other.ownerKey }, { sharedAdminManagement: true }, { ownerUserId: user }]) {
    await assert.rejects(updateAdminMarketListing(db.pool, own, 'invalid-edit-001', id, { expectedVersion: 0, patch }), ZodError);
  }
});

test('admin market: edits preserve expiry, enforce optimistic versions and atomically roll back file or audit failure', integration, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const [{ actor: actor }, { actor: other }] = await Promise.all([admin(db.pool), admin(db.pool, 'other-owner')]);
  const image = await file(db.pool, actor), invalid = await file(db.pool, other);
  const id = (await createAdminMarketListing(db.pool, actor, 'edit-create-001', { ...content(), images: [{ fileId: image }] })).data.id;
  await db.pool.query("UPDATE market_listings SET expires_at='2020-01-01T00:00:00.123Z',status='offline' WHERE id=$1", [id]);
  const before = await getAdminMarketListing(db.pool, actor, id);
  await assert.rejects(updateAdminMarketListing(db.pool, actor, 'file-denied-001', id, { expectedVersion: 0, patch: { title: 'Rollback', images: [{ fileId: invalid }] } }), { code: 'FILE_OWNER_MISMATCH' });
  assert.deepEqual(await getAdminMarketListing(db.pool, actor, id), before);
  const update = await updateAdminMarketListing(db.pool, actor, 'title-edit-001', id, { expectedVersion: 0, patch: { title: 'Edited' } });
  assert.deepEqual(await updateAdminMarketListing(db.pool, actor, 'title-edit-001', id, { expectedVersion: 0, patch: { title: 'Edited' } }), update);
  assert.deepEqual((await getAdminMarketListing(db.pool, actor, id)).expiresAt, before.expiresAt);
  const races = await Promise.allSettled(Array.from({ length: 4 }, (_, index) => updateAdminMarketListing(db.pool, actor, `race-edit-${index}`, id,
    { expectedVersion: 1, patch: { title: `Title ${index}` } })));
  assert.equal(races.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(races.filter(result => result.status === 'rejected').every(result => result.reason.code === 'LISTING_VERSION_CONFLICT'));
  const endDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  await updateAdminMarketListing(db.pool, actor, 'date-edit-001', id, { expectedVersion: 2, patch: { endDate } });
  assert.deepEqual((await getAdminMarketListing(db.pool, actor, id)).expiresAt, marketListingExpiresAt(endDate));
  await db.pool.query(`CREATE FUNCTION reject_market_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='market.update' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_market_audit BEFORE INSERT ON admin_audit FOR EACH ROW EXECUTE FUNCTION reject_market_audit()`);
  const last = await getAdminMarketListing(db.pool, actor, id);
  await assert.rejects(updateAdminMarketListing(db.pool, actor, 'audit-failed-001', id, { expectedVersion: 3, patch: { images: [], title: 'Must roll back' } }), /synthetic failure/);
  assert.deepEqual(await getAdminMarketListing(db.pool, actor, id), last);
  assert.equal((await db.pool.query("SELECT count(*) FROM admin_requests WHERE request_key='audit-failed-001'")).rows[0].count, '0');
});

test('admin market: bulk partial retry preserves committed rows and effective key precedence across batches', integration, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const { actor } = await admin(db.pool);
  const pending = await file(db.pool, actor, false);
  const body = { batchId: 'batch_one', items: [
    { clientRequestId: 'explicit_key', externalId: 'external_one', item: content() },
    { externalId: 'external_two', item: { ...content(), images: [{ fileId: pending }] } },
    { item: { ...content(), title: 'Third' } },
  ] };
  const first = await bulkCreateAdminMarketListings(db.pool, actor, body);
  assert.equal(first.status, 'partial'); assert.equal(first.success, 2); assert.equal(first.failed, 1);
  assert.deepEqual(first.failures, [{ index: 1, error: 'FILE_NOT_READY' }]);
  assert.deepEqual(first.results.map(row => row.id), [adminMarketListingId(actor.ownerKey, 'explicit_key'), adminMarketListingId(actor.ownerKey, 'batch_one_row_3')]);
  assert.equal(await count(db.pool, 'market_listings'), 2); assert.equal(await count(db.pool, 'admin_requests'), 2);
  await transaction(db.pool, client => confirmFile(client, { appId: APP, fileId: pending,
    owner: { adminOwnerKey: actor.ownerKey, adminAccountId: actor.accountId }, metadata: { sizeBytes: 1, mediaType: 'image/jpeg', sha256: 'a'.repeat(64) } }));
  const retried = await bulkCreateAdminMarketListings(db.pool, actor, body);
  assert.equal(retried.status, 'done'); assert.equal(retried.success, 3); assert.equal(retried.failed, 0);
  assert.deepEqual(retried.results.map(row => row.id), [adminMarketListingId(actor.ownerKey, 'explicit_key'), adminMarketListingId(actor.ownerKey, 'external_external_two'), adminMarketListingId(actor.ownerKey, 'batch_one_row_3')]);
  assert.equal(await count(db.pool, 'market_listings'), 3); assert.equal(await count(db.pool, 'admin_requests'), 3);
  await db.pool.query("UPDATE market_listings SET status='deleted' WHERE id=$1", [retried.results[0].id]);
  assert.deepEqual(await bulkCreateAdminMarketListings(db.pool, actor, body), retried);
  const next = await bulkCreateAdminMarketListings(db.pool, actor, { batchId: 'batch_two', items: body.items.slice(0, 2) });
  assert.equal(next.status, 'done'); assert.equal(await count(db.pool, 'market_listings'), 3);
  await assert.rejects(bulkCreateAdminMarketListings(db.pool, actor, { ...body, items: body.items.slice(0, 1) }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('admin market: bulk validation is per-row, persistent failures remain retryable and ambiguous legacy hashes are never relabeled', integration, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const { actor } = await admin(db.pool);
  const input = { batchId: 'invalid_rows', items: [{ item: { ...content(), ownerKey: 'forged' } }, { item: content(), extra: 'forged' }] };
  const failed = await bulkCreateAdminMarketListings(db.pool, actor, input);
  assert.equal(failed.status, 'failed'); assert.deepEqual(failed.failures, [{ index: 0, error: 'INVALID_INPUT' }, { index: 1, error: 'INVALID_INPUT' }]);
  assert.deepEqual(await bulkCreateAdminMarketListings(db.pool, actor, input), failed);
  assert.equal(await count(db.pool, 'market_listings'), 0);
  const key = 'legacy-request-001', id = adminMarketListingId(actor.ownerKey, key);
  await db.pool.query(`INSERT INTO admin_requests(app_id,owner_key,operation,request_key,payload_hash,payload_format,response_status,response_body)
    VALUES($1,$2,'market.create',$3,$4,'legacy-web-v1',201,$5)`, [APP, actor.ownerKey, id, 'b'.repeat(64), { id }]);
  await assert.rejects(createAdminMarketListing(db.pool, actor, key, content()), { code: 'LEGACY_REQUEST_CONFLICT' });
  await db.pool.query(`INSERT INTO market_import_batches(app_id,owner_key,id,payload_hash,payload_format,total,status,results)
    VALUES($1,$2,'legacy_batch',$3,'legacy-web-v1',1,'done',$4)`, [APP, actor.ownerKey, 'c'.repeat(64), JSON.stringify([{ index: 0, id, externalId: 'old' }])]);
  await assert.rejects(bulkCreateAdminMarketListings(db.pool, actor, { batchId: 'legacy_batch', items: [{ item: content() }] }), { code: 'LEGACY_REQUEST_CONFLICT' });
  assert.equal(await count(db.pool, 'market_listings'), 0);
  assert.equal((await db.pool.query('SELECT payload_format FROM admin_requests')).rows[0].payload_format, 'legacy-web-v1');
  await db.pool.query('DELETE FROM admin_sessions WHERE token_hash=$1', [actor.sessionHash]);
  await assert.rejects(createAdminMarketListing(db.pool, actor, key, content()), { code: 'ADMIN_UNAUTHORIZED' });
  await assert.rejects(bulkCreateAdminMarketListings(db.pool, actor, input), { code: 'ADMIN_UNAUTHORIZED' });
});

function intercepted(pool: Pool, before: (sql: string, values: unknown[]) => Promise<void>): Pool {
  return new Proxy(pool, { get(target, key) {
    if (key === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(connection, name) {
        if (name === 'query') return async (sql: string, values: unknown[] = []) => {
          await before(sql, values); return connection.query(sql, values);
        };
        const value = Reflect.get(connection, name, connection);
        return typeof value === 'function' ? value.bind(connection) : value;
      } });
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

test('admin market: a stale failing bulk attempt cannot downgrade a concurrently completed batch', integration, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const [{ actor: first }, { actor: second }] = await Promise.all([admin(db.pool), admin(db.pool)]);
  const body = { batchId: 'racing_batch', items: [{ item: content() }] };
  let pause!: () => void, resume!: () => void;
  const paused = new Promise<void>(resolve => { pause = resolve; });
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  let batchLocks = 0;
  const proxy = intercepted(db.pool, async (sql, values) => {
    if (sql.startsWith('INSERT INTO market_listings')) throw new Error('synthetic transient failure');
    if (sql.startsWith('SELECT pg_advisory_xact_lock') && String(values[0]).includes('admin-market-batch') && ++batchLocks === 2) {
      pause(); await resumed;
    }
  });
  const stale = bulkCreateAdminMarketListings(proxy, first, body);
  await paused;
  try {
    const done = await bulkCreateAdminMarketListings(db.pool, second, body);
    assert.equal(done.status, 'done'); resume();
    assert.deepEqual(await stale, done);
    assert.equal((await db.pool.query('SELECT status FROM market_import_batches')).rows[0].status, 'done');
    assert.equal(await count(db.pool, 'market_listings'), 1);
  } finally { resume(); await stale.catch(() => {}); }
});

test('admin market HTTP: exact origin/session checks, private DTO, strict identities and no new status/delete surface', integration, async t => {
  const db = await createTestDatabase();
  const app = Fastify();
  t.after(async () => { await app.close(); await db.close(); });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500)
    .send({ ok: false, error: { code: error instanceof AppError ? error.code : 'INVALID_INPUT' } }));
  registerAdminRoutes(app, { pool: db.pool, appId: APP }); registerAdminMarketRoutes(app, { pool: db.pool, appId: APP });
  const { actor, token } = await admin(db.pool);
  const origin = 'https://admin.example.test';
  await db.pool.query('INSERT INTO admin_origins VALUES($1,$2)', [APP, origin]);
  const headers = { origin, authorization: `Bearer ${token}`, 'idempotency-key': 'http-create-001' };
  for (const altered of [{ ...headers, origin: 'https://evil.example.test' }, { ...headers, authorization: 'Bearer invalid' }]) {
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/market/listings', headers: altered, payload: content() });
    assert.ok([401, 403].includes(response.statusCode)); assert.equal(response.headers['cache-control'], 'private, no-store');
  }
  const created = await app.inject({ method: 'POST', url: '/api/v1/admin/market/listings', headers, payload: content() });
  assert.equal(created.statusCode, 201); const id = created.json().data.id;
  const read = await app.inject({ method: 'GET', url: `/api/v1/admin/market/listings/${id}`, headers });
  assert.equal(read.statusCode, 200); assert.equal(read.headers['cache-control'], 'private, no-store');
  assert.deepEqual(Object.keys(read.json().data).sort(), ['id', 'content', 'images', 'status', 'version', 'expiresAt', 'createdAt', 'updatedAt'].sort());
  assert.ok(!read.body.includes(actor.ownerKey)); assert.ok(!read.body.includes(actor.accountId));
  assert.equal((await app.inject({ method: 'GET', url: `/api/v1/admin/market/listings/${id}?ownerKey=forged`, headers })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/admin/market/listings/${id}`, headers })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/admin/market/listings/${id}/status`, headers, payload: { status: 'sold' } })).statusCode, 404);
  const edited = await app.inject({ method: 'POST', url: `/api/v1/admin/market/listings/${id}/edit`, headers: { ...headers, 'idempotency-key': 'http-edit-001' },
    payload: { expectedVersion: 0, patch: { title: 'Updated' } } });
  assert.equal(edited.statusCode, 200); assert.equal(edited.json().data.version, 1);
  const bulk = await app.inject({ method: 'POST', url: '/api/v1/admin/market/batches', headers,
    payload: { batchId: 'http_batch', items: [{ item: content() }] } });
  assert.equal(bulk.statusCode, 200); assert.equal(bulk.json().data.status, 'done');
  const options = await app.inject({ method: 'OPTIONS', url: '/api/v1/admin/market/batches', headers: { origin, 'access-control-request-method': 'POST' } });
  assert.equal(options.statusCode, 204);
});
