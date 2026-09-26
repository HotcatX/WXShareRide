import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { normalizeAds } from '../src/migration/ads.ts';
import type { AdRow, AdClickRow } from '../src/migration/ads.ts';
import { normalizeCommunity } from '../src/migration/community.ts';
import type { CommunityContent, CommunityRow, CommunityRevisionRow } from '../src/migration/community.ts';
import type { UserRow } from '../src/migration/types.ts';
import { createTestDatabase } from './helpers/database.ts';

const appId = 'content-schema-fixture';
const at = '2026-09-01T12:00:00.000Z';
const file = 'cloud://fixture/community/old.jpg';
const group = { enabled: true, title: 'Fixture group', imageFileID: file, expiresAt: Date.parse('2000-01-01T00:00:00Z') };
const announcement = { enabled: false, id: 'fixture-notice', title: 'Notice', body: 'Fixture\nnotice', imageFileID: '', showGroupImage: true,
  maxShows: 1, intervalHours: 24, startAt: 0, endAt: 0 };
const legacyContent = { group, announcement };
const content: CommunityContent = {
  group: { enabled: true, title: group.title, expiresAt: '2000-01-01T00:00:00.000Z' },
  announcement: { enabled: false, id: announcement.id, title: announcement.title, body: announcement.body, showGroupImage: true,
    maxShows: 1, intervalHours: 24, startAt: null, endAt: null },
};
const ad: AdRow = { id: 'fixture-ad', appId, status: 'online', placement: 'market_feed', title: 'Fixture ad', subtitle: '',
  badgeText: '广告', ctaText: '查看', weight: 1.5, priority: -2.5, startAt: null, endAt: null,
  target: { kind: 'contact', sessionFrom: 'fixture-source', messageCard: { enabled: false, title: 'Fixture message', path: '/pages/market/market' } },
  createdAt: at, updatedAt: null };
type Client = Pick<Pool | PoolClient, 'query'>;
async function insertAd(client: Client, patch: Record<string, unknown> = {}) {
  const row = { ...ad, id: randomUUID(), ...patch };
  return (await client.query(`INSERT INTO ads(app_id,id,status,placement,title,subtitle,badge_text,cta_text,weight,priority,
    start_at,end_at,target,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
  [row.appId, row.id, row.status, row.placement, row.title, row.subtitle, row.badgeText, row.ctaText, row.weight, row.priority,
    row.startAt, row.endAt, JSON.stringify(row.target), row.createdAt, row.updatedAt])).rows[0];
}
async function insertClick(client: Client, patch: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = { id: randomUUID(), appId, adId: 'missing-ad', placement: 'market_feed',
    listingType: 'goods', actorUserId: null, createdAt: null, ...patch };
  return (await client.query(`INSERT INTO ad_clicks(app_id,id,ad_id,placement,listing_type,actor_user_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
  [row.appId, row.id, row.adId, row.placement, row.listingType, row.actorUserId, row.createdAt])).rows[0];
}
async function insertConfig(client: Client, patch: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = { appId, version: 0, content, updatedByAdminId: null, updatedAt: null, ...patch };
  return (await client.query(`INSERT INTO community_configs(app_id,version,content,updated_by_admin_id,updated_at)
    VALUES($1,$2,$3,$4,$5) RETURNING *`, [row.appId, row.version, JSON.stringify(row.content), row.updatedByAdminId, row.updatedAt])).rows[0];
}
async function insertRevision(client: Client, patch: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = { appId, id: randomUUID(), version: 1, previousVersion: 0, before: content, after: content,
    updatedByAdminId: null, updatedAt: null, ...patch };
  return (await client.query(`INSERT INTO community_revisions(app_id,id,version,previous_version,before_content,after_content,updated_by_admin_id,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [row.appId, row.id, row.version, row.previousVersion, JSON.stringify(row.before),
    JSON.stringify(row.after), row.updatedByAdminId, row.updatedAt])).rows[0];
}
const noErrors = (_collection: string, code: string, _field?: string, severity = 'error') => { if (severity === 'error') assert.fail(code); };

test('content storage preserves imported facts with bounded app-scoped records and separate attachments',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL, timeout: 30000 }, async t => {
    const db = await createTestDatabase();
    t.after(db.close);
    const { pool } = db;
    const ownerId = (await pool.query<{ id: string }>('INSERT INTO users(app_id,openid) VALUES($1,$2) RETURNING id', [appId, 'fixture-user'])).rows[0].id;
    const foreignId = (await pool.query<{ id: string }>('INSERT INTO users(app_id,openid) VALUES($1,$2) RETURNING id', ['foreign-content', 'fixture-user'])).rows[0].id;
    await pool.query(`INSERT INTO admin_accounts(app_id,id,owner_key,enabled,credential_version)
      VALUES($1,'fixture-admin','fixture-owner',true,1),('foreign-content','foreign-admin','foreign-owner',true,1)`, [appId]);

    await t.test('real converter candidates map to all four tables, including null actors and independent times', async () => {
      const user: UserRow = { id: ownerId, appId, openid: 'fixture-user', name: '', avatarUrl: '', profile: {}, createdAt: at, updatedAt: null };
      const sourceAd = { _id: 'source-ad', status: 'online', placement: 'market_feed', title: 'Fixture ad', subtitle: '', badgeText: '广告', ctaText: '查看',
        weight: 1, priority: 0, startAtMs: 0, endAtMs: 0, imageFileID: file, thumbFileID: file, targetType: 'contact',
        contactSessionFrom: 'fixture', contactMessageTitle: 'Fixture message', contactMessagePath: '/pages/market/market', showMessageCard: false,
        createTime: at, updateTime: at };
      const ads = normalizeAds({ ads: [sourceAd], events: [
        { _id: 'known-click', _openid: user.openid, adId: sourceAd._id, type: 'click', placement: 'market_feed', listingType: 'goods', createTime: { $date: at } },
        { _id: 'orphan-click', _openid: 'unknown-old-user', adId: 'old-missing-ad', type: 'click', placement: 'market_feed', listingType: 'sublet' },
      ] }, { appId, users: [user] }, noErrors);
      const config = { _id: 'main', ...legacyContent, version: 1, updatedBy: 'fixture-admin', updatedAtMs: Date.parse(at) + 45,
        lastRequestHash: createHash('sha256').update(JSON.stringify(legacyContent)).digest('hex') };
      const history = { _id: 'original-non-version-id', version: 1, previousVersion: 0, before: legacyContent, after: legacyContent,
        updatedBy: 'fixture-admin', updatedAtMs: Date.parse(at) };
      const community = normalizeCommunity({ configs: [config], history: [history] },
        { appId, adminOwners: [{ accountId: 'fixture-admin', ownerKey: 'fixture-owner' }] }, noErrors);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of ads.ads) await insertAd(client, row);
        for (const row of ads.events) await insertClick(client, row);
        // A deferred application/config FK permits either order inside the
        // caller's atomic import, without inventing a temporary current row.
        for (const row of community.revisions) await insertRevision(client, row);
        for (const row of community.configs) await insertConfig(client, { ...row, content: { group: row.group, announcement: row.announcement } });
        await client.query('COMMIT');
      } finally { await client.query('ROLLBACK'); client.release(); }
      const storedAd = (await pool.query('SELECT * FROM ads WHERE app_id=$1 AND id=$2', [appId, sourceAd._id])).rows[0];
      assert.deepEqual(storedAd.target, ads.ads[0]!.target);
      const clicks = (await pool.query('SELECT * FROM ad_clicks WHERE app_id=$1 ORDER BY id', [appId])).rows;
      assert.equal(clicks.length, 2); assert.equal(clicks[0].actor_user_id, ownerId); assert.equal(clicks[1].actor_user_id, null);
      assert.equal(clicks[1].ad_id, 'old-missing-ad'); assert.equal(clicks[1].created_at, null);
      assert.equal((await pool.query('SELECT count(*)::integer AS n FROM ads WHERE id=$1', ['old-missing-ad'])).rows[0].n, 0);
      const current = (await pool.query('SELECT * FROM community_configs WHERE app_id=$1', [appId])).rows[0];
      const revision = (await pool.query('SELECT * FROM community_revisions WHERE app_id=$1', [appId])).rows[0];
      assert.deepEqual(current.content, content); assert.equal(current.version, 1);
      assert.equal(current.updated_at.getTime() - revision.updated_at.getTime(), 45);
      assert.equal(revision.id, 'original-non-version-id'); assert.deepEqual(revision.before_content, content);
      assert.deepEqual(revision.after_content, content);
      assert.equal(current.content.announcement.enabled, false); assert.equal(current.content.group.enabled, true);
    });

    await t.test('unknown historical timestamps and actors remain nullable without fake accounts', async () => {
      const stored = await insertAd(pool, { createdAt: null, updatedAt: null });
      assert.equal(stored.created_at, null); assert.equal(stored.updated_at, null);
      const click = await insertClick(pool); assert.equal(click.actor_user_id, null); assert.equal(click.created_at, null);
      const otherApp = 'unknown-history';
      const config = await insertConfig(pool, { appId: otherApp });
      const revision = await insertRevision(pool, { appId: otherApp });
      assert.equal(config.updated_by_admin_id, null); assert.equal(config.updated_at, null);
      assert.equal(revision.updated_by_admin_id, null); assert.equal(revision.updated_at, null);
    });

    await t.test('click and administrator actors cannot cross app boundaries or create missing identities', async () => {
      await assert.rejects(insertClick(pool, { actorUserId: foreignId }), { code: '23503' });
      await assert.rejects(insertClick(pool, { actorUserId: randomUUID() }), { code: '23503' });
      const stored = await insertClick(pool, { actorUserId: ownerId }); assert.equal(stored.actor_user_id, ownerId);
      await assert.rejects(insertConfig(pool, { appId: 'another-content', updatedByAdminId: 'fixture-admin' }), { code: '23503' });
      await assert.rejects(insertRevision(pool, { version: 2, previousVersion: 1, updatedByAdminId: 'foreign-admin' }), { code: '23503' });
    });

    await t.test('ad windows, weights, inactive states and contact flags remain exact', async () => {
      for (const status of ['online', 'offline', 'deleted']) assert.equal((await insertAd(pool, { status })).status, status);
      const instant = await insertAd(pool, { startAt: at, endAt: at }); assert.equal(instant.start_at.getTime(), instant.end_at.getTime());
      const row = await insertAd(pool); assert.equal(row.weight, 1.5); assert.equal(row.priority, -2.5); assert.equal(row.target.messageCard.enabled, false);
      for (const patch of [{ status: 'expired' }, { weight: 0 }, { weight: Infinity }, { priority: Number.NaN },
        { startAt: '2027-01-01', endAt: at }, { startAt: 'infinity' }, { createdAt: '-infinity' },
        { updatedAt: '2000-01-01' }, { title: '' }, { title: 'x'.repeat(1001) }, { placement: 'bad\nvalue' }]) {
        await assert.rejects(insertAd(pool, patch), { code: '23514' });
      }
    });

    await t.test('target JSON is the bounded contact contract rather than a second generic payload', async () => {
      for (const target of [null, [], {}, { ...ad.target, kind: null }, { ...ad.target, kind: 'page' },
        { ...ad.target, image: file }, { ...ad.target, messageCard: null },
        { ...ad.target, messageCard: { ...ad.target.messageCard, enabled: 'false' } },
        { ...ad.target, messageCard: { ...ad.target.messageCard, path: '//other/path' } },
        { ...ad.target, messageCard: { ...ad.target.messageCard, path: 'https://other/path' } },
        { ...ad.target, messageCard: { ...ad.target.messageCard, rawOpenid: 'unexpected' } }]) {
        await assert.rejects(insertAd(pool, { target }), { code: '23514' });
      }
    });

    await t.test('community content accepts nullable windows but no image aliases, open bags or invalid frequency', async () => {
      let serial = 0;
      for (const invalid of [null, [], {}, { ...content, images: [] },
        { ...content, group: { ...content.group, imageFileID: file } },
        { ...content, announcement: { ...content.announcement, available: true } },
        { ...content, announcement: { ...content.announcement, maxShows: 0 } },
        { ...content, announcement: { ...content.announcement, maxShows: 1.5 } },
        { ...content, announcement: { ...content.announcement, maxShows: '1' } },
        { ...content, announcement: { ...content.announcement, intervalHours: 8761 } },
        { ...content, announcement: { ...content.announcement, body: 'x'.repeat(2001) } }]) {
        await assert.rejects(insertConfig(pool, { appId: `invalid-content-${serial++}`, content: invalid }), { code: '23514' });
        await assert.rejects(insertRevision(pool, { version: 2, previousVersion: 1, before: invalid }), { code: '23514' });
        await assert.rejects(insertRevision(pool, { version: 2, previousVersion: 1, after: invalid }), { code: '23514' });
      }
      const config = await insertConfig(pool, { appId: 'nullable-windows', content: { ...content, group: { ...content.group, expiresAt: null } } });
      assert.equal(config.content.group.expiresAt, null, 'availability belongs to the reader, not the storage predicate');
    });

    await t.test('versions are app-scoped and bounded; revision predecessors are checked without a full-chain trigger', async () => {
      await assert.rejects(insertConfig(pool, { appId }), { code: '23505' });
      await assert.rejects(insertConfig(pool, { appId: 'negative-version', version: -1 }), { code: '23514' });
      await assert.rejects(insertConfig(pool, { appId: 'overflow-version', version: 2147483648 }), { code: '22003' });
      await assert.rejects(insertRevision(pool, { version: 1, previousVersion: 0 }), { code: '23505' });
      await assert.rejects(insertRevision(pool, { version: 0, previousVersion: 0 }), { code: '23514' });
      await assert.rejects(insertRevision(pool, { version: 2, previousVersion: 0 }), { code: '23514' });
      await assert.rejects(insertRevision(pool, { version: 2147483647, previousVersion: 2147483647 }), { code: '23514' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await insertRevision(client, { appId: 'missing-singleton' });
        await assert.rejects(client.query('COMMIT'), { code: '23503' });
      } finally { await client.query('ROLLBACK'); client.release(); }
      assert.equal((await pool.query("SELECT count(*)::integer AS n FROM community_revisions WHERE app_id='missing-singleton'")).rows[0].n, 0);
      assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM pg_trigger
        WHERE tgrelid IN ('community_configs'::regclass,'community_revisions'::regclass) AND NOT tgisinternal`)).rows[0].n, 0);
    });

    await t.test('current and historical community references retain the same resource and remain app-scoped', async () => {
      const fileId = randomUUID();
      await pool.query(`INSERT INTO files(id,app_id,provider,locator,legacy_readonly,status,created_at,updated_at)
        VALUES($1,$2,'cloudbase',$3,true,'ready',NULL,NULL)`, [fileId, appId, file]);
      for (const slot of ['group', 'history.1.before.group', 'history.1.after.group']) await pool.query(`INSERT INTO file_references
        (app_id,resource_kind,resource_id,slot,file_id) VALUES($1,'community','main',$2,$3)`, [appId, slot, fileId]);
      await pool.query(`INSERT INTO file_references(app_id,resource_kind,resource_id,slot,file_id)
        VALUES($1,'ad','source-ad','image',$2),($1,'ad','source-ad','thumbnail',$2)`, [appId, fileId]);
      assert.equal((await pool.query('SELECT count(*)::integer AS n FROM file_references WHERE file_id=$1', [fileId])).rows[0].n, 5);
      await assert.rejects(pool.query(`INSERT INTO file_references(app_id,resource_kind,resource_id,slot,file_id)
        VALUES('other-app','community','main','group',$1)`, [fileId]), { code: '23503' });
      await assert.rejects(pool.query(`INSERT INTO file_references(app_id,resource_kind,resource_id,slot,file_id)
        VALUES($1,'community','main',$2,$3)`, [appId, 'x'.repeat(65), fileId]), { code: '23514' });
      const row = (await pool.query('SELECT content FROM community_configs WHERE app_id=$1', [appId])).rows[0];
      assert.deepEqual(row.content, content); assert.equal('imageFileID' in row.content.group, false);
    });

    await t.test('fixed click type and main identity are not duplicated as editable columns', async () => {
      const columns = (await pool.query<{ table_name: string; column_name: string }>(`SELECT table_name,column_name FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name IN ('ads','ad_clicks','community_configs','community_revisions')`)).rows;
      assert.equal(columns.some(row => row.table_name === 'ad_clicks' && row.column_name === 'type'), false);
      assert.equal(columns.some(row => row.table_name === 'community_configs' && row.column_name === 'id'), false);
      assert.equal(columns.some(row => ['openid', 'image_file_id', 'image_url', 'has_image', 'ref_count', 'click_count'].includes(row.column_name)), false);
      const clickId = randomUUID(); await insertClick(pool, { id: clickId });
      await assert.rejects(insertClick(pool, { id: clickId }), { code: '23505' });
      await insertClick(pool, { appId: 'other-app', id: clickId });
      await assert.rejects(insertClick(pool, { listingType: 'rental' }), { code: '23514' });
      await assert.rejects(insertClick(pool, { adId: 'bad/id' }), { code: '23514' });
    });
  });
