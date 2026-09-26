import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { getMarketListing, listMarketListings, listMyMarketListings, listSellerMarketListings } from '../src/market/read.ts';
import { createTestDatabase } from './helpers/database.ts';

const appId = 'market-read-fixture';
const content = () => ({ listingType: 'goods', title: 'Desk', description: 'Synthetic item', priceCents: 1200,
  category: '家具', condition: '99新', region: { state: 'NJ', county: 'Bergen', area: 'Fort Lee' },
  buildingName: '', location: null, startDate: '2030-09-01', endDate: '2030-09-30', sellerContact: null, sublet: null });
async function user(pool: Pool, application = appId) {
  return (await pool.query(`INSERT INTO users(app_id,openid,name,avatar_url,profile) VALUES($1,$2,'Synthetic seller',
    'https://example.test/avatar.png',$3) RETURNING id`, [application, `internal-openid-${randomUUID()}`,
    { wechatId: 'synthetic_wechat', phone: '2125550101', bio: 'Synthetic bio', region: { area: 'Fort Lee', label: 'Long label' },
      location: { residence: 'Synthetic building', address: 'private profile address', latitude: 40, longitude: -74 },
      vehicle: { plate: 'private plate' }, zelle: { account: 'private payment' }, privateExtra: 'do not expose' }])).rows[0].id as string;
}
async function listing(pool: Pool, owner: string, patch: Record<string, unknown> = {}) {
  const value = { appId, id: randomUUID(), owner, status: 'online', expiresAt: new Date('2040-01-01'),
    createdAt: new Date('2026-01-01'), updatedAt: null, content: content(), adminOwnerKey: null, shared: false, ...patch };
  await pool.query(`INSERT INTO market_listings(app_id,id,owner_user_id,admin_owner_key,shared_admin_management,status,expires_at,content,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [value.appId, value.id, value.owner, value.adminOwnerKey,
    value.shared, value.status, value.expiresAt, value.content, value.createdAt, value.updatedAt]);
  return String(value.id);
}
const ids = (result: { items: { id: string }[] }) => result.items.map(item => item.id);

test('market read: public, owner and seller reads preserve visibility and app isolation', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const { pool } = db;
  const owner = await user(pool), stranger = await user(pool), foreign = await user(pool, 'foreign-app');
  const visible = await listing(pool, owner, { id: 'visible' });
  const offline = await listing(pool, owner, { id: 'offline', status: 'offline' });
  const sold = await listing(pool, owner, { id: 'sold', status: 'sold' });
  const expired = await listing(pool, owner, { id: 'expired', expiresAt: new Date('2020-01-01') });
  const deleted = await listing(pool, owner, { id: 'deleted', status: 'deleted' });
  await listing(pool, foreign, { appId: 'foreign-app', id: visible });
  await listing(pool, foreign, { appId: 'foreign-app', id: 'foreign-only' });
  assert.deepEqual(ids(await listMarketListings(pool, appId, {})), [visible]);
  assert.deepEqual(ids(await listMarketListings(pool, appId, {}, stranger)), [visible]);
  assert.deepEqual(ids(await listSellerMarketListings(pool, appId, owner, {}, stranger)), [visible]);
  assert.deepEqual(ids(await listSellerMarketListings(pool, appId, foreign, {}, stranger)), []);
  assert.deepEqual(ids(await listMyMarketListings(pool, appId, owner, {})), [expired, offline, sold, visible]);
  assert.deepEqual(ids(await listMyMarketListings(pool, appId, foreign, {})), []);
  for (const id of [offline, sold, expired]) {
    assert.equal((await getMarketListing(pool, appId, id, owner)).id, id);
    for (const viewer of [undefined, stranger, foreign]) await assert.rejects(getMarketListing(pool, appId, id, viewer), { code: 'LISTING_NOT_FOUND' });
  }
  for (const viewer of [undefined, owner, stranger]) {
    await assert.rejects(getMarketListing(pool, appId, deleted, viewer), { code: 'LISTING_NOT_FOUND' });
    await assert.rejects(getMarketListing(pool, appId, 'foreign-only', viewer), { code: 'LISTING_NOT_FOUND' });
  }
  const loaded = await getMarketListing(pool, appId, visible, owner);
  assert.ok('isOwner' in loaded && loaded.isOwner);
  assert.ok('updatedAt' in loaded && loaded.updatedAt === null);
  // Future pickup start does not hide an otherwise currently published item.
  assert.equal(loaded.startDate, '2030-09-01');
});

test('market read: guest redaction and authenticated nested whitelists preserve intended contact visibility', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const { pool } = db, owner = await user(pool), viewer = await user(pool);
  const privateId = (await pool.query('SELECT openid FROM users WHERE id=$1', [owner])).rows[0].openid;
  const itemContent = { ...content(), title: 'Desk seller_marker',
    description: `${privateId}; seller_marker; explicit_contact; 2125550199; contact@example.test; https://example.test/private\n123 Test Street; 40.12345,-74.12345\n2026-09-01 remains`,
    buildingName: 'private listing building',
    location: { displayName: 'private display', address: 'private pickup', latitude: 40, longitude: -74, hidden: 'nested location secret' },
    sellerContact: { name: 'seller_marker', wechat: 'explicit_contact', phone: '2125550199', avatar: 'https://example.test/contact.png', note: 'seller note', hidden: 'nested contact secret' },
    region: { state: 'NJ', county: 'Bergen', area: 'Fort Lee', hidden: 'nested region secret' },
    hidden: 'content secret' };
  const id = await listing(pool, owner, { content: itemContent });
  const guest = await getMarketListing(pool, appId, id);
  assert.deepEqual(Object.keys(guest).sort(), ['category', 'condition', 'createdAt', 'description', 'endDate', 'expiresAt', 'id', 'images',
    'listingType', 'priceCents', 'region', 'startDate', 'status', 'title', 'viewCount'].sort());
  assert.deepEqual(guest.region, { state: 'NJ' });
  const guestJson = JSON.stringify(guest);
  for (const secret of [privateId, 'seller_marker', 'explicit_contact', '2125550199', 'contact@example.test',
    'example.test/private', '123 Test Street', '40.12345', 'private pickup', 'synthetic_wechat', 'Fort Lee']) assert.ok(!guestJson.includes(secret), secret);
  assert.ok(guest.description.includes('2026-09-01'));
  const authenticated = await getMarketListing(pool, appId, id, viewer);
  assert.ok('seller' in authenticated);
  if (!('seller' in authenticated)) return;
  assert.equal(authenticated.isOwner, false);
  assert.deepEqual(authenticated.seller, { userId: owner, name: 'Synthetic seller', avatarUrl: 'https://example.test/avatar.png',
    regionLabel: 'Fort Lee', residence: 'Synthetic building', bio: 'Synthetic bio', wechatId: 'explicit_contact', phone: '2125550199' });
  assert.deepEqual(authenticated.sellerContact, { name: 'seller_marker', wechat: 'explicit_contact', phone: '2125550199',
    avatar: 'https://example.test/contact.png', note: 'seller note' });
  assert.deepEqual(authenticated.location, { displayName: 'private display', address: 'private pickup', latitude: 40, longitude: -74 });
  const authenticatedJson = JSON.stringify(authenticated);
  for (const secret of ['private profile address', 'private plate', 'private payment', 'do not expose', 'content secret',
    'nested location secret', 'nested region secret', 'nested contact secret']) assert.ok(!authenticatedJson.includes(secret), secret);
  assert.ok(!Object.keys(authenticated).includes('openid'));
  // Contact snapshots belong to managed listings; the owner's current profile
  // must not replace that explicitly supplied seller or invent an admin user.
  const managed = await listing(pool, owner, { owner: null, adminOwnerKey: 'private_owner_key', content: itemContent });
  const managedItem = await getMarketListing(pool, appId, managed, viewer);
  assert.ok('seller' in managedItem);
  if ('seller' in managedItem) assert.deepEqual(managedItem.seller, { userId: null, name: 'seller_marker',
    avatarUrl: 'https://example.test/contact.png', regionLabel: 'Fort Lee', residence: '', bio: 'seller note',
    wechatId: 'explicit_contact', phone: '2125550199' });
  assert.ok(!JSON.stringify(managedItem).includes('private_owner_key'));
});

test('market read: filters, literal keyword and stable pages apply before pagination without timestamp ties skipping items', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const { pool } = db, owner = await user(pool);
  for (const id of ['c', 'a', 'b']) await listing(pool, owner, { id });
  const sublet = { ...content(), listingType: 'sublet', category: 'Studio', sublet: { housingType: '', depositCents: null,
    furnished: false, utilitiesIncluded: false, genderPreference: '', roommateCount: null } };
  await listing(pool, owner, { id: 'sublet', content: sublet });
  await listing(pool, owner, { id: 'literal', content: { ...content(), description: 'literal 50%_off [.*]' } });
  await listing(pool, owner, { id: 'wrong-area', content: { ...content(), region: { state: 'NY', county: 'Queens', area: 'LIC' } } });
  assert.deepEqual(ids(await listMarketListings(pool, appId, { listingType: 'sublet' }, owner)), ['sublet']);
  assert.equal((await listMarketListings(pool, appId, { listingType: 'all' }, owner)).items.length, 6);
  assert.deepEqual(ids(await listMarketListings(pool, appId, { keyword: '50%_off' }, owner)), ['literal']);
  assert.deepEqual(ids(await listMarketListings(pool, appId, { keyword: '[.*]' }, owner)), ['literal']);
  assert.deepEqual(ids(await listMarketListings(pool, appId, { keyword: 'DESK', category: '家具', regionState: 'NY', regionCounty: 'Queens', regionArea: 'LIC' }, owner)), ['wrong-area']);
  const first = await listMarketListings(pool, appId, { limit: '2' }, owner);
  assert.deepEqual(ids(first), ['a', 'b']); assert.equal(first.hasMore, true); assert.equal(first.nextOffset, 2);
  const next = await listMarketListings(pool, appId, { offset: first.nextOffset, limit: 3 }, owner);
  assert.deepEqual(ids(next), ['c', 'literal', 'wrong-area']); assert.equal(next.hasMore, false);
  assert.equal((await listMarketListings(pool, appId, { offset: 5 }, owner)).items.length, 0);
  for (const query of [{ callerOpenID: 'forged' }, { ownerId: owner }, { appId: 'foreign-app' }, { limit: 51 },
    { offset: -1 }, { offset: '1e2' }, { listingType: 'bad' }, { status: 'offline' }, { keyword: '' }]) {
    await assert.rejects(listMarketListings(pool, appId, query, owner));
  }
});

test('market read: distance ordering uses all matching records, keeps unknown locations last and rejects incomplete coordinates', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const { pool } = db, owner = await user(pool);
  await listing(pool, owner, { id: 'unknown' });
  for (const [id, lat, lng] of [['same-a', 40, -74], ['same-b', 40, -74], ['far', 41, -74], ['antipodal', -40, 106]] as const) {
    await listing(pool, owner, { id, content: { ...content(), location: { displayName: '', address: '', latitude: lat, longitude: lng } } });
  }
  const query = { sort: 'distance', latitude: '40', longitude: '-74' };
  const result = await listMarketListings(pool, appId, query, owner);
  assert.deepEqual(ids(result), ['same-a', 'same-b', 'far', 'antipodal', 'unknown']);
  assert.ok('distanceMiles' in result.items[0] && result.items[0].distanceMiles === 0);
  assert.ok('distanceMiles' in result.items[2] && Math.abs(result.items[2].distanceMiles! - 69.094) < .01);
  assert.ok('distanceMiles' in result.items[3] && Number.isFinite(result.items[3].distanceMiles));
  assert.ok('distanceMiles' in result.items[4] && result.items[4].distanceMiles === null);
  assert.deepEqual(ids(await listMarketListings(pool, appId, { ...query, offset: 2, limit: 2 }, owner)), ['far', 'antipodal']);
  for (const query of [{ sort: 'distance' }, { sort: 'distance', latitude: 0 }, { latitude: 0, longitude: 0 },
    { sort: 'distance', latitude: '', longitude: 0 }, { sort: 'distance', latitude: 91, longitude: 0 }]) {
    await assert.rejects(listMarketListings(pool, appId, query, owner));
  }
  for (const query of [{ keyword: 'Desk' }, { regionCounty: 'Bergen' }, { regionArea: 'Fort Lee' },
    { sort: 'distance', latitude: 40, longitude: -74 }]) {
    await assert.rejects(listMarketListings(pool, appId, query), { code: 'UNAUTHORIZED' });
  }
});

test('market read: image references preserve original/thumbnail pairing and never expose storage locators', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const { pool } = db, owner = await user(pool), id = await listing(pool, owner);
  const files = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  for (const fileId of files) await pool.query(`INSERT INTO files(id,app_id,provider,locator,legacy_readonly,status)
    VALUES($1,$2,'cloudbase',$3,true,'ready')`, [fileId, appId, `cloud://internal-fixture/${fileId}`]);
  for (const [slot, index] of [['image.1', 1], ['thumbnail.1', 2], ['image.0', 0], ['thumbnail.2', 3], ['image-3', 3]] as const) {
    await pool.query(`INSERT INTO file_references(app_id,resource_kind,resource_id,slot,file_id) VALUES($1,'listing',$2,$3,$4)`,
      [appId, id, slot, files[index]]);
  }
  const images = [{ fileId: files[0] }, { fileId: files[1], thumbFileId: files[2] }];
  for (const viewer of [undefined, owner]) {
    const result = await getMarketListing(pool, appId, id, viewer);
    assert.deepEqual(result.images, images);
    assert.ok(!JSON.stringify(result).includes('cloud://internal-fixture'));
    assert.ok(!JSON.stringify(result).includes('imageUrl'));
  }
  await pool.query("UPDATE files SET status='deleting' WHERE id=$1", [files[2]]);
  assert.deepEqual((await getMarketListing(pool, appId, id)).images, [{ fileId: files[0] }, { fileId: files[1] }]);
});

test('market read: view count comes only from app-scoped counted buckets and GET does not create impressions', async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const { pool } = db, owner = await user(pool);
  const id = await listing(pool, owner, { content: { ...content(), viewCount: 9000 } });
  assert.equal((await getMarketListing(pool, appId, id)).viewCount, 0);
  for (const [application, listingId, count] of [[appId, id, 3], [appId, id, 5], ['foreign-app', id, 100],
    [appId, 'historically-deleted-listing', 200]] as const) {
    await pool.query(`INSERT INTO market_views(app_id,id,listing_id,day,count) VALUES($1,$2,$3,'2026-09-01',$4)`,
      [application, randomUUID(), listingId, count]);
  }
  const before = (await pool.query('SELECT count(*)::integer AS rows,sum(count)::integer AS count FROM market_views')).rows[0];
  for (const viewer of [undefined, owner]) assert.equal((await getMarketListing(pool, appId, id, viewer)).viewCount, 8);
  assert.equal((await listMarketListings(pool, appId, {}, owner)).items[0].viewCount, 8);
  assert.deepEqual((await pool.query('SELECT count(*)::integer AS rows,sum(count)::integer AS count FROM market_views')).rows[0], before);
  await assert.rejects(getMarketListing(pool, appId, 'historically-deleted-listing', owner), { code: 'LISTING_NOT_FOUND' });
});
