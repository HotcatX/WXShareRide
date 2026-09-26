import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { ZodError } from 'zod';
import { AppError } from '../src/errors.ts';
import { registerAdminRoutes } from '../src/admin/routes.ts';
import { registerAdminMarketTemplateRoutes } from '../src/admin/market-template-routes.ts';
import { deleteMarketTemplate, listMarketTemplates, marketTemplateDataSchema, saveMarketTemplate } from '../src/admin/market-templates.ts';
import { requireAdmin } from '../src/admin/service.ts';
import { createTestDatabase } from './helpers/database.ts';

const appId = 'market-templates-fixture', origin = 'https://admin.example.test';
const data = () => ({ listingType: 'goods', priceCents: 1250,
  region: { state: 'NJ', county: 'Bergen', area: 'Fort Lee' },
  sellerContact: { name: 'Synthetic contact', wechat: 'synthetic_wechat', phone: '', avatar: '', note: '' } });
const input = (patch: Record<string, unknown> = {}) => ({ name: 'Shared template', data: data(), ...patch });
type Template = { id: string; name: string; data: ReturnType<typeof data> };
const savedTemplate = (result: { data: Record<string, unknown> }) => result.data.template as Template;
async function admin(pool: Pool, accountId: string, application = appId, ownerKey = `owner_${accountId}`) {
  await pool.query(`INSERT INTO admin_accounts(app_id,id,owner_key,enabled,credential_version,password_salt,password_hash)
    VALUES($1,$2,$3,true,1,$4,$5)`, [application, accountId, ownerKey, Buffer.alloc(32, 1), Buffer.alloc(64, 2)]);
  const token = randomBytes(32).toString('hex'), hash = createHash('sha256').update(token).digest('hex');
  await pool.query(`INSERT INTO admin_sessions(token_hash,app_id,account_id,credential_version,created_at,expires_at)
    VALUES($1,$2,$3,1,clock_timestamp(),clock_timestamp()+interval '1 hour')`, [hash, application, accountId]);
  return { token, identity: await requireAdmin(pool, application, `Bearer ${token}`) };
}

test('template draft schema requires contact/region, reuses canonical fields and refuses images/authority injection', () => {
  assert.equal(marketTemplateDataSchema.safeParse(data()).success, true);
  for (const patch of [{ images: [] }, { imageFileID: 'cloud://private/image.jpg' }, { ownerKey: 'forged' }, { title: '' },
    { priceCents: 12.5 }, { region: { state: 'bad', county: 'Bergen', area: 'Fort Lee' } },
    { sellerContact: { ...data().sellerContact, name: '' } }, { sellerContact: { ...data().sellerContact, wechat: '' } },
    { sellerContact: { ...data().sellerContact, avatar: 'https://example.test/image.jpg' } },
    { startDate: '2026-09-03', endDate: '2026-09-02' }, { listingType: 'sublet', category: 'invalid' },
    { sublet: { housingType: '', depositCents: null, furnished: false, utilitiesIncluded: false, genderPreference: '', roommateCount: null } }]) {
    assert.equal(marketTemplateDataSchema.safeParse({ ...data(), ...patch }).success, false);
  }
});

test('administrator templates are shared, app-scoped and atomic with permanent receipts',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL, timeout: 30000 }, async t => {
    const db = await createTestDatabase(); t.after(db.close); const { pool } = db;
    const first = await admin(pool, 'first_admin'), second = await admin(pool, 'second_admin');
    const foreign = await admin(pool, 'foreign_admin', 'foreign-app');
    let template: Template;

    await t.test('all effective local administrators can list/edit one shared template without owner ACL', async () => {
      const created = await saveMarketTemplate(pool, first.identity, 'create-template-001', input());
      assert.equal(created.status, 201); template = savedTemplate(created);
      assert.equal(template.id, 'web_tpl_' + createHash('sha256').update(`${first.identity.ownerKey}:Shared template`).digest('hex').slice(0, 40));
      assert.deepEqual((await listMarketTemplates(pool, second.identity)).templates, [template]);
      assert.deepEqual((await listMarketTemplates(pool, foreign.identity)).templates, []);
      assert.equal('startDate' in template.data, false); assert.equal('title' in template.data, false);
      const updated = await saveMarketTemplate(pool, second.identity, 'update-template-001', input({ id: template.id, name: 'Changed by second admin' }));
      assert.equal(updated.status, 200); template = savedTemplate(updated);
      const row = (await pool.query('SELECT * FROM market_templates WHERE app_id=$1 AND id=$2', [appId, template.id])).rows[0];
      assert.equal(row.created_by_admin_id, first.identity.accountId); assert.equal(row.updated_by_admin_id, second.identity.accountId);
      await assert.rejects(saveMarketTemplate(pool, foreign.identity, 'foreign-update-001', input({ id: template.id })), { code: 'MARKET_TEMPLATE_NOT_FOUND' });
      await assert.rejects(deleteMarketTemplate(pool, foreign.identity, 'foreign-delete-001', template.id), { code: 'MARKET_TEMPLATE_NOT_FOUND' });
    });

    await t.test('same owner/name saves replace one template and concurrent key replay creates one audit/receipt', async () => {
      const results = await Promise.all(Array.from({ length: 12 }, () => saveMarketTemplate(pool, first.identity, 'concurrent-template-001', input({ name: 'Concurrent template' }))));
      for (const result of results) assert.deepEqual(result, results[0]);
      const id = savedTemplate(results[0]!).id;
      assert.equal((await pool.query('SELECT count(*)::integer AS n FROM market_templates WHERE app_id=$1 AND id=$2', [appId, id])).rows[0].n, 1);
      const changed = await saveMarketTemplate(pool, first.identity, 'same-name-new-key', input({ name: 'Concurrent template', data: { ...data(), priceCents: 2000 } }));
      assert.equal(changed.status, 200); assert.equal(savedTemplate(changed).id, id);
      assert.deepEqual(await saveMarketTemplate(pool, first.identity, 'concurrent-template-001', input({ name: 'Concurrent template' })), results[0]);
      await assert.rejects(saveMarketTemplate(pool, first.identity, 'concurrent-template-001', input({ name: 'Wrong' })), { code: 'IDEMPOTENCY_CONFLICT' });
      const sharedOwner = await admin(pool, 'same_owner_admin', appId, first.identity.ownerKey);
      assert.deepEqual(await saveMarketTemplate(pool, sharedOwner.identity, 'concurrent-template-001', input({ name: 'Concurrent template' })), results[0]);
      assert.equal((await pool.query("SELECT count(*)::integer AS n FROM admin_requests WHERE request_key='concurrent-template-001'")).rows[0].n, 1);
    });

    await t.test('delete is soft, replay never mutates a restored row, and an explicit existing legacy ID remains editable', async () => {
      const deletion = await deleteMarketTemplate(pool, second.identity, 'delete-template-001', template.id);
      assert.equal((await listMarketTemplates(pool, first.identity)).templates.some(row => row.id === template.id), false);
      assert.equal((await pool.query('SELECT status FROM market_templates WHERE app_id=$1 AND id=$2', [appId, template.id])).rows[0].status, 'deleted');
      await saveMarketTemplate(pool, first.identity, 'restore-template-001', input({ id: template.id }));
      assert.deepEqual(await deleteMarketTemplate(pool, second.identity, 'delete-template-001', template.id), deletion);
      assert.equal((await pool.query('SELECT status FROM market_templates WHERE app_id=$1 AND id=$2', [appId, template.id])).rows[0].status, 'active');
      await pool.query(`INSERT INTO market_templates(app_id,id,name,data,status,created_at,updated_at)
        VALUES($1,'tpl_legacy','Legacy',$2,'deleted',NULL,NULL)`, [appId, data()]);
      const legacy = await saveMarketTemplate(pool, second.identity, 'save-legacy-template', input({ id: 'tpl_legacy' }));
      assert.equal(savedTemplate(legacy).id, 'tpl_legacy');
      const row = (await pool.query("SELECT * FROM market_templates WHERE id='tpl_legacy'")).rows[0];
      assert.equal(row.created_at, null); assert.equal(row.created_by_admin_id, null); assert.equal(row.status, 'active');
      await assert.rejects(saveMarketTemplate(pool, first.identity, 'missing-template-id', input({ id: 'missing' })), { code: 'MARKET_TEMPLATE_NOT_FOUND' });
    });

    await t.test('competing save and delete serialize to a complete state with no partial draft or lost receipt', async () => {
      const result = await Promise.all([
        saveMarketTemplate(pool, first.identity, 'competing-save-001', input({ id: template.id, name: 'Concurrent final name' })),
        deleteMarketTemplate(pool, second.identity, 'competing-delete-001', template.id),
      ]);
      assert.ok(result.every(value => value.status === 200));
      const row = (await pool.query('SELECT * FROM market_templates WHERE app_id=$1 AND id=$2', [appId, template.id])).rows[0];
      assert.equal(row.name, 'Concurrent final name'); assert.deepEqual(row.data, data()); assert.ok(['active', 'deleted'].includes(row.status));
      assert.equal((await pool.query("SELECT count(*)::integer AS n FROM admin_requests WHERE request_key IN ('competing-save-001','competing-delete-001')")).rows[0].n, 2);
    });

    await t.test('audit failure rolls back template and receipt, and revoked sessions cannot read or replay', async () => {
      await pool.query("ALTER TABLE admin_audit ADD CONSTRAINT reject_template_test CHECK(action!='marketTemplate.save') NOT VALID");
      await assert.rejects(saveMarketTemplate(pool, first.identity, 'rolled-back-template', input({ name: 'Must roll back' })));
      assert.equal((await pool.query("SELECT count(*)::integer AS n FROM market_templates WHERE name='Must roll back'")).rows[0].n, 0);
      assert.equal((await pool.query("SELECT count(*)::integer AS n FROM admin_requests WHERE request_key='rolled-back-template'")).rows[0].n, 0);
      await pool.query('ALTER TABLE admin_audit DROP CONSTRAINT reject_template_test');
      await pool.query('UPDATE admin_accounts SET enabled=false WHERE app_id=$1 AND id=$2', [appId, first.identity.accountId]);
      await assert.rejects(listMarketTemplates(pool, first.identity), { code: 'ADMIN_UNAUTHORIZED' });
      await assert.rejects(saveMarketTemplate(pool, first.identity, 'create-template-001', input()), { code: 'ADMIN_UNAUTHORIZED' });
    });

    await t.test('SQL retains same-app actors, bounded names/data, original IDs and nullable legacy clocks', async () => {
      const insert = (name: unknown, body: unknown, creator: unknown = null, status = 'active') => pool.query(`INSERT INTO market_templates
        (app_id,id,name,data,status,created_by_admin_id) VALUES($1,$2,$3,$4,$5,$6)`, [appId, 'sql_' + randomBytes(8).toString('hex'), name, body, status, creator]);
      for (const badName of ['', ' ', 'a'.repeat(61), 'contains\nnewline']) await assert.rejects(insert(badName, data()));
      for (const body of [{ ...data(), images: [] }, { ...data(), listingType: null }, { ...data(), priceCents: 1.5 }, { ...data(), priceCents: -1 }, {}]) await assert.rejects(insert('Invalid', body));
      await assert.rejects(insert('Foreign actor', data(), foreign.identity.accountId));
      await assert.rejects(insert('Unknown status', data(), null, 'inactive'));
    });
  });

test('template HTTP routes reuse admin origin/session guard and expose no owner or source aliases',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL, timeout: 30000 }, async t => {
    const db = await createTestDatabase(); const app = Fastify({ logger: false });
    t.after(async () => { await app.close(); await db.close(); });
    const local = await admin(db.pool, 'http_admin'), foreign = await admin(db.pool, 'foreign_admin', 'foreign-app');
    await db.pool.query('INSERT INTO admin_origins(app_id,origin) VALUES($1,$2)', [appId, origin]);
    app.setErrorHandler((error, request, reply) => reply.code(error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500)
      .send({ ok: false, error: { code: error instanceof AppError ? error.code : 'INVALID_INPUT' }, requestId: request.id }));
    registerAdminRoutes(app, { pool: db.pool, appId });
    registerAdminMarketTemplateRoutes(app, { pool: db.pool, appId });
    const url = '/api/v1/admin/market/templates', headers = { origin, authorization: `Bearer ${local.token}` };
    for (const badHeaders of [{}, { origin }, { ...headers, origin: 'https://untrusted.example.test' },
      { ...headers, authorization: `Bearer ${foreign.token}` }, { ...headers, authorization: 'Bearer invalid' }]) {
      const response = await app.inject({ method: 'GET', url, headers: badHeaders });
      assert.ok([401, 403].includes(response.statusCode)); assert.equal(response.headers['cache-control'], 'private, no-store');
    }
    for (const body of [{ ...input(), ownerKey: 'forged' }, input({ data: { ...data(), images: [] } }), input({ name: '' })]) {
      assert.equal((await app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': 'invalid-body-key' }, payload: body })).statusCode, 400);
    }
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: input() })).statusCode, 400);
    const saved = await app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': 'http-create-key' }, payload: input() });
    assert.equal(saved.statusCode, 201); const id = saved.json().data.template.id;
    const listed = await app.inject({ method: 'GET', url, headers });
    assert.equal(listed.statusCode, 200); assert.equal(listed.headers['access-control-allow-origin'], origin);
    assert.deepEqual(Object.keys(listed.json().data.templates[0]).sort(), ['data', 'id', 'name']);
    for (const privateField of ['ownerKey', 'createdByAdminId', 'sessionHash', 'password', '_openid', '_id']) assert.ok(!listed.body.includes(privateField));
    assert.equal((await app.inject({ method: 'GET', url: url + '?appId=foreign-app', headers })).statusCode, 400);
    const removed = await app.inject({ method: 'POST', url: `${url}/${id}/delete`, headers: { ...headers, 'idempotency-key': 'http-delete-key' }, payload: {} });
    assert.equal(removed.statusCode, 200); assert.deepEqual((await app.inject({ method: 'GET', url, headers })).json().data.templates, []);
    const preflight = await app.inject({ method: 'OPTIONS', url, headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,idempotency-key,content-type' } });
    assert.equal(preflight.statusCode, 204);
  });
