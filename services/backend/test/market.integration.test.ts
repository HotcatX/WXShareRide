import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { transaction } from '../src/db.ts';
import { reserveFile, confirmFile, queueFileDeletion } from '../src/files/service.ts';
import { createListing, updateListing, setListingStatus, deleteListing } from '../src/market/service.ts';
import { marketListingExpiresAt } from '../src/market/time.ts';
import { createTestDatabase } from './helpers/database.ts';

const appId = 'market-service-test';
const content = () => ({ listingType: 'goods', title: 'Desk', description: 'Synthetic item', priceCents: 1200,
  category: '家具', condition: '99新', region: { state: 'NJ', county: 'Bergen', area: 'Fort Lee' },
  buildingName: '', location: null, startDate: '2026-09-01', endDate: '2026-09-30', sellerContact: null, sublet: null });
async function user(pool: Pool, application = appId): Promise<string> {
  return (await pool.query('INSERT INTO users(app_id,openid) VALUES($1,$2) RETURNING id', [application, randomUUID()])).rows[0].id;
}
async function file(pool: Pool, userId: string, application = appId): Promise<string> {
  return transaction(pool, async client => {
    const row = await reserveFile(client, { appId: application, owner: { userId }, provider: 'cos', locator: `test-bucket/${randomUUID()}.jpg` });
    await confirmFile(client, { appId: application, fileId: row.id, owner: { userId }, metadata: {
      sizeBytes: 100, mediaType: 'image/jpeg', sha256: 'a'.repeat(64),
    } });
    return row.id;
  });
}
async function listing(pool: Pool, id: unknown) { return (await pool.query('SELECT * FROM market_listings WHERE app_id=$1 AND id=$2', [appId, id])).rows[0]; }
async function references(pool: Pool, id: unknown) {
  return (await pool.query('SELECT slot,file_id FROM file_references WHERE app_id=$1 AND resource_id=$2 ORDER BY slot', [appId, id])).rows;
}

test('market: concurrent create retries store one item and ordered image pairs; deletion never resets the receipt', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = await user(db.pool);
  const [first, thumb, second] = await Promise.all(Array.from({ length: 3 }, () => file(db.pool, owner)));
  const body = { ...content(), images: [{ fileId: first, thumbFileId: thumb }, { fileId: second }] };
  const writes = await Promise.all(Array.from({ length: 8 }, () => createListing(db.pool, owner, 'create-item-001', body)));
  for (const result of writes) assert.deepEqual(result, writes[0]);
  const id = writes[0].data.id;
  assert.equal((await db.pool.query('SELECT count(*) FROM market_listings')).rows[0].count, '1');
  assert.equal((await db.pool.query('SELECT count(*) FROM idempotency_requests')).rows[0].count, '1');
  assert.deepEqual((await listing(db.pool, id)).content, content());
  assert.deepEqual(await references(db.pool, id), [{ slot: 'image.0', file_id: first }, { slot: 'image.1', file_id: second }, { slot: 'thumbnail.0', file_id: thumb }]);
  await assert.rejects(createListing(db.pool, owner, 'create-item-001', { ...body, title: 'Changed' }), { code: 'IDEMPOTENCY_CONFLICT' });
  const deleted = await deleteListing(db.pool, owner, 'delete-item-001', id, { expectedVersion: 0 });
  assert.deepEqual(deleted.data, { id, version: 1, status: 'deleted' });
  assert.deepEqual(await deleteListing(db.pool, owner, 'delete-item-001', id, { expectedVersion: 0 }), deleted);
  assert.deepEqual(await createListing(db.pool, owner, 'create-item-001', body), writes[0]);
  assert.equal((await listing(db.pool, id)).status, 'deleted');
  assert.deepEqual(await references(db.pool, id), []);
  await assert.rejects(updateListing(db.pool, owner, 'edit-deleted-001', id, { expectedVersion: 1, patch: { title: 'Resurrection' } }), { code: 'LISTING_NOT_FOUND' });
});

test('market: owner and app isolation, client metadata rejection and file denial leave no partial business writes', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const [owner, stranger, otherApp] = await Promise.all([user(db.pool), user(db.pool), user(db.pool, 'other-app')]);
  const ownImage = await file(db.pool, owner);
  const item = await createListing(db.pool, owner, 'owned-create-001', { ...content(), images: [{ fileId: ownImage }] });
  const id = item.data.id;
  for (const intruder of [stranger, otherApp]) {
    await assert.rejects(updateListing(db.pool, intruder, 'unauthorized-edit', id, { expectedVersion: 0, patch: { title: 'Denied' } }), { code: 'LISTING_NOT_FOUND' });
    await assert.rejects(setListingStatus(db.pool, intruder, 'unauthorized-status', id, { expectedVersion: 0, status: 'offline' }), { code: 'LISTING_NOT_FOUND' });
    await assert.rejects(deleteListing(db.pool, intruder, 'unauthorized-delete', id, { expectedVersion: 0 }), { code: 'LISTING_NOT_FOUND' });
  }
  const foreignImage = await file(db.pool, stranger);
  const before = await listing(db.pool, id);
  await assert.rejects(updateListing(db.pool, owner, 'foreign-image-edit', id, { expectedVersion: 0, patch: { title: 'Must roll back', images: [{ fileId: foreignImage }] } }), { code: 'FILE_OWNER_MISMATCH' });
  assert.deepEqual(await listing(db.pool, id), before);
  assert.deepEqual(await references(db.pool, id), [{ slot: 'image.0', file_id: ownImage }]);
  await assert.rejects(createListing(db.pool, owner, 'foreign-image-create', { ...content(), images: [{ fileId: foreignImage }] }), { code: 'FILE_OWNER_MISMATCH' });
  await assert.rejects(createListing(db.pool, otherApp, 'cross-app-create', { ...content(), images: [{ fileId: ownImage }] }), { code: 'FILE_NOT_FOUND' });
  for (const patch of [{ ownerUserId: stranger }, { status: 'sold' }, { expiresAt: '2100-01-01' }, { version: 42 }]) {
    await assert.rejects(createListing(db.pool, owner, 'forged-create-001', { ...content(), images: [], ...patch }));
  }
  assert.equal((await db.pool.query('SELECT count(*) FROM market_listings')).rows[0].count, '1');
  assert.equal((await db.pool.query('SELECT count(*) FROM idempotency_requests')).rows[0].count, '1');
});

test('market: only explicit date/type changes recalculate expiry; content and status preserve historical milliseconds', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = await user(db.pool);
  const item = await createListing(db.pool, owner, 'expiry-create-001', { ...content(), images: [] });
  const id = item.data.id;
  const historicalExpiry = new Date('2026-09-30T23:12:45.123Z');
  await db.pool.query('UPDATE market_listings SET expires_at=$2 WHERE id=$1', [id, historicalExpiry]);
  await updateListing(db.pool, owner, 'expiry-title-edit', id, { expectedVersion: 0, patch: { title: 'New title', images: [] } });
  assert.deepEqual((await listing(db.pool, id)).expires_at, historicalExpiry);
  await setListingStatus(db.pool, owner, 'expiry-status-001', id, { expectedVersion: 1, status: 'sold' });
  assert.deepEqual((await listing(db.pool, id)).expires_at, historicalExpiry);
  await updateListing(db.pool, owner, 'expiry-same-date', id, { expectedVersion: 2, patch: { endDate: content().endDate } });
  assert.deepEqual((await listing(db.pool, id)).expires_at, historicalExpiry);
  const unchanged = await listing(db.pool, id);
  const sameStatus = await setListingStatus(db.pool, owner, 'expiry-status-same', id, { expectedVersion: 3, status: 'sold' });
  assert.equal(sameStatus.data.version, 3);
  assert.deepEqual(await listing(db.pool, id), unchanged);
  const endDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  await updateListing(db.pool, owner, 'expiry-change-date', id, { expectedVersion: 3, patch: { endDate } });
  assert.deepEqual((await listing(db.pool, id)).expires_at, marketListingExpiresAt(endDate));
  await assert.rejects(updateListing(db.pool, owner, 'expiry-over-limit', id, { expectedVersion: 4, patch: { endDate: '9999-01-01' } }), { code: 'INVALID_DATE_WINDOW' });
});

test('market: concurrent edits have one winner and stale versions cannot silently overwrite it', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = await user(db.pool);
  const id = (await createListing(db.pool, owner, 'race-create-001', { ...content(), images: [] })).data.id;
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => updateListing(db.pool, owner, `race-edit-${i}`, id,
    { expectedVersion: 0, patch: { title: `Title ${i}` } })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'LISTING_VERSION_CONFLICT'));
  assert.equal((await listing(db.pool, id)).version, '1');
  assert.equal((await db.pool.query('SELECT count(*) FROM idempotency_requests')).rows[0].count, '2');
});

test('market: shared images remain protected until every listing releases them', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = await user(db.pool);
  const fileId = await file(db.pool, owner);
  const body = { ...content(), images: [{ fileId }] };
  const [one, two] = await Promise.all(['shared-create-one', 'shared-create-two'].map(key => createListing(db.pool, owner, key, body)));
  await deleteListing(db.pool, owner, 'shared-delete-one', one.data.id, { expectedVersion: 0 });
  await assert.rejects(transaction(db.pool, client => queueFileDeletion(client, { appId, fileId })), { code: 'FILE_REFERENCED' });
  assert.equal((await db.pool.query('SELECT status FROM files WHERE id=$1', [fileId])).rows[0].status, 'ready');
  await deleteListing(db.pool, owner, 'shared-delete-two', two.data.id, { expectedVersion: 0 });
  assert.equal(await transaction(db.pool, client => queueFileDeletion(client, { appId, fileId })), 'deleting');
});

test('market: legacy images can be reordered in their original listing without becoming reusable upload permissions', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = await user(db.pool);
  const id = (await createListing(db.pool, owner, 'legacy-create-001', { ...content(), images: [] })).data.id;
  const ids = [randomUUID(), randomUUID()];
  for (const [index, fileId] of ids.entries()) {
    await db.pool.query(`INSERT INTO files(id,app_id,provider,locator,owner_user_id,legacy_readonly,status,created_at,updated_at)
      VALUES($1,$2,'cloudbase',$3,$4,true,'ready',NULL,NULL)`, [fileId, appId, `cloud://synthetic/market/${fileId}.jpg`, owner]);
    await db.pool.query(`INSERT INTO file_references VALUES($1,'listing',$2,$3,$4)`, [appId, id, `image.${index}`, fileId]);
  }
  await updateListing(db.pool, owner, 'legacy-reorder-001', id, { expectedVersion: 0, patch: { images: ids.toReversed().map(fileId => ({ fileId })) } });
  assert.deepEqual((await references(db.pool, id)).map(row => row.file_id), ids.toReversed());
  await assert.rejects(createListing(db.pool, owner, 'legacy-copy-forbidden', { ...content(), images: [{ fileId: ids[0] }] }), { code: 'FILE_READONLY' });
});

test('market: a receipt failure rolls back content, attachment changes and the listing version', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const owner = await user(db.pool);
  const [first, second] = await Promise.all([file(db.pool, owner), file(db.pool, owner)]);
  const id = (await createListing(db.pool, owner, 'rollback-create-001', { ...content(), images: [{ fileId: first }] })).data.id;
  const before = await listing(db.pool, id);
  await db.pool.query(`CREATE FUNCTION reject_market_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.operation='market.update' THEN RAISE EXCEPTION 'synthetic receipt failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_market_receipt BEFORE INSERT ON idempotency_requests FOR EACH ROW EXECUTE FUNCTION reject_market_receipt()`);
  await assert.rejects(updateListing(db.pool, owner, 'rollback-edit-001', id, { expectedVersion: 0, patch: { title: 'Must roll back', images: [{ fileId: second }] } }), /synthetic receipt failure/);
  assert.deepEqual(await listing(db.pool, id), before);
  assert.deepEqual(await references(db.pool, id), [{ slot: 'image.0', file_id: first }]);
});
