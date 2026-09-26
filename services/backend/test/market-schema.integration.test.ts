import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { marketListingContentSchema } from '../src/market/schemas.ts';
import { createTestDatabase } from './helpers/database.ts';

const content = marketListingContentSchema.parse({
  listingType: 'goods', title: 'Fixture desk', description: '', priceCents: 1250, category: '家具', condition: '',
  region: { state: 'NJ', county: 'Bergen', area: 'Fort Lee' }, buildingName: '', location: null,
  startDate: '2026-09-01', endDate: '2026-09-30', sellerContact: null, sublet: null,
});
const appId = 'market-schema-fixture';

test('market listing storage enforces scope, ownership, lifecycle and the single attachment relation',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
    const db = await createTestDatabase();
    t.after(db.close);
    const { pool } = db;
    const owner = (await pool.query<{ id: string }>('INSERT INTO users(app_id,openid) VALUES($1,$2) RETURNING id', [appId, randomUUID()])).rows[0].id;
    const foreign = (await pool.query<{ id: string }>('INSERT INTO users(app_id,openid) VALUES($1,$2) RETURNING id', ['other-app', randomUUID()])).rows[0].id;
    async function insert(patch: Record<string, unknown> = {}) {
      const value = { appId, id: `old_market_${randomUUID()}`, ownerUserId: owner, adminOwnerKey: null, shared: false,
        status: 'online', expiresAt: '2026-09-30T23:59:59.999Z', version: 0, content,
        createdAt: '2026-09-01T12:00:00Z', updatedAt: null, ...patch };
      return (await pool.query(`INSERT INTO market_listings(app_id,id,owner_user_id,admin_owner_key,shared_admin_management,
        status,expires_at,version,content,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [value.appId, value.id, value.ownerUserId, value.adminOwnerKey, value.shared, value.status, value.expiresAt,
        value.version, JSON.stringify(value.content), value.createdAt, value.updatedAt])).rows[0];
    }

    await t.test('source IDs, original expiry, zero versions and unknown update time survive without invented aliases', async () => {
      const row = await insert({ id: 'web_fixture:old-source-id' });
      assert.equal(row.id, 'web_fixture:old-source-id'); assert.equal(row.version, '0');
      assert.equal(row.expires_at.toISOString(), '2026-09-30T23:59:59.999Z');
      assert.equal(row.created_at.toISOString(), '2026-09-01T12:00:00.000Z'); assert.equal(row.updated_at, null);
      assert.deepEqual(row.content, content); assert.equal('images' in row.content, false);
      const storedColumns = (await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='market_listings'`)).rows.map(row => row.column_name);
      assert.deepEqual(storedColumns.sort(), ['app_id', 'id', 'owner_user_id', 'admin_owner_key', 'shared_admin_management',
        'status', 'expires_at', 'version', 'content', 'created_at', 'updated_at'].sort());
      const fresh = (await pool.query(`INSERT INTO market_listings(app_id,id,owner_user_id,expires_at,content)
        VALUES($1,$2,$3,$4,$5) RETURNING created_at,updated_at,version`,
      [appId, randomUUID(), owner, '2026-09-30T23:59:59.999Z', JSON.stringify(content)])).rows[0];
      assert.ok(fresh.created_at instanceof Date); assert.ok(fresh.updated_at instanceof Date); assert.equal(fresh.version, '0');
    });

    await t.test('ownership has exactly one principal; shared management requires the real user owner', async () => {
      assert.equal((await insert({ shared: true })).owner_user_id, owner);
      const admin = await insert({ ownerUserId: null, adminOwnerKey: 'fixture_admin_owner' });
      assert.equal(admin.owner_user_id, null); assert.equal(admin.admin_owner_key, 'fixture_admin_owner');
      for (const patch of [{ ownerUserId: null }, { adminOwnerKey: 'both_owners' },
        { ownerUserId: null, adminOwnerKey: 'fixture_admin_owner', shared: true },
        { ownerUserId: null, adminOwnerKey: '' }, { ownerUserId: null, adminOwnerKey: 'contains spaces' }]) {
        await assert.rejects(insert(patch), { code: '23514' });
      }
      await assert.rejects(insert({ ownerUserId: foreign }), { code: '23503' });
      await assert.rejects(insert({ ownerUserId: randomUUID() }), { code: '23503' });
    });

    await t.test('record identity is app-scoped and opaque legacy IDs stay controlled', async () => {
      const id = 'same_old_id';
      await insert({ id });
      await assert.rejects(insert({ id }), { code: '23505' });
      await insert({ appId: 'other-app', id, ownerUserId: foreign });
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM market_listings WHERE id=$1', [id])).rows[0].count, 2);
      for (const invalid of ['', 'a'.repeat(161), 'path/id', 'has space']) await assert.rejects(insert({ id: invalid }), { code: '23514' });
      await assert.rejects(insert({ appId: ' ' }), { code: '23514' });
    });

    await t.test('a deleted tombstone is distinct from sold or expiry and unsafe versions are rejected', async () => {
      for (const status of ['online', 'offline', 'sold', 'deleted']) assert.equal((await insert({ status })).status, status);
      for (const status of ['expired', 'pending', 'ONLINE', '']) await assert.rejects(insert({ status }), { code: '23514' });
      assert.equal((await insert({ version: Number.MAX_SAFE_INTEGER })).version, String(Number.MAX_SAFE_INTEGER));
      for (const version of [-1, '9007199254740992']) await assert.rejects(insert({ version }), { code: '23514' });
      await assert.rejects(insert({ createdAt: null }), { code: '23502' });
      await assert.rejects(insert({ expiresAt: null }), { code: '23502' });
    });

    await t.test('content cannot hold any images value and file relationships remain independently app-scoped', async () => {
      for (const invalid of [null, [], 'text', 1, { ...content, images: [] }, { ...content, images: null },
        { ...content, images: [{ fileId: randomUUID() }] }]) await assert.rejects(insert({ content: invalid }), { code: '23514' });
      const row = await insert();
      const fileId = randomUUID();
      await pool.query(`INSERT INTO files(id,app_id,provider,locator,legacy_readonly,status,created_at,updated_at)
        VALUES($1,$2,'cloudbase',$3,true,'ready',NULL,NULL)`, [fileId, appId, `cloud://fixture/market/${randomUUID()}.jpg`]);
      await pool.query(`INSERT INTO file_references(app_id,resource_kind,resource_id,slot,file_id)
        VALUES($1,'listing',$2,'image.0',$3)`, [appId, row.id, fileId]);
      assert.deepEqual((await pool.query('SELECT content FROM market_listings WHERE app_id=$1 AND id=$2', [appId, row.id])).rows[0].content, content);
      assert.equal((await pool.query(`SELECT file_id FROM file_references WHERE app_id=$1 AND resource_kind='listing' AND resource_id=$2`, [appId, row.id])).rows[0].file_id, fileId);
      await assert.rejects(pool.query(`INSERT INTO file_references(app_id,resource_kind,resource_id,slot,file_id)
        VALUES('other-app','listing',$1,'image.0',$2)`, [row.id, fileId]), { code: '23503' });
    });
  });
