import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createApp } from '../src/app.ts';
import { requireAdmin } from '../src/admin/service.ts';
import { editConsoleRow, getConsoleRow, listConsoleRows, listConsoleTables } from '../src/admin/data.ts';
import { createTestDatabase } from './helpers/database.ts';

const settings = { skip: !process.env.BACKEND_TEST_DATABASE_URL };
const APP = 'wx1234567890abcdef', OTHER = 'wxabcdef1234567890', ORIGIN = 'https://synthetic-admin.example';
async function admin(pool: Pool, role: 'admin' | 'superadmin' = 'superadmin') {
  const id = `admin-${randomUUID()}`, token = randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO admin_accounts(app_id,id,owner_key,enabled,credential_version,password_salt,password_hash,role)
    VALUES($1,$2,$2,true,1,$3,$4,$5)`, [APP, id, Buffer.alloc(32, 1), Buffer.alloc(64, 2), role]);
  await pool.query(`INSERT INTO admin_sessions(token_hash,app_id,account_id,credential_version,expires_at)
    VALUES($1,$2,$3,1,clock_timestamp()+interval '1 hour')`, [createHash('sha256').update(token).digest('hex'), APP, id]);
  return { actor: await requireAdmin(pool, APP, `Bearer ${token}`), token };
}
async function user(pool: Pool, appId = APP, name = 'synthetic-name') {
  return (await pool.query('INSERT INTO users(app_id,openid,name,profile) VALUES($1,$2,$3,$4) RETURNING *',
    [appId, `synthetic_${randomUUID().replaceAll('-', '')}`, name, { phone: 'synthetic-phone', location: { residence: 'synthetic-home' } }])).rows[0];
}
const key = (values: unknown[]) => Buffer.from(JSON.stringify(values)).toString('base64url');

test('console: live role, complete app-scoped catalog, credential exclusion and exact identity lookup', settings, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const { actor } = await admin(db.pool), ordinary = await admin(db.pool, 'admin');
  const own = await user(db.pool), foreign = await user(db.pool, OTHER);
  const tables = await listConsoleTables(db.pool, actor);
  assert.ok(tables.tables.length >= 25);
  assert.ok(tables.tables.some(table => table.key === 'users' && table.editableFields.includes('profile')));
  assert.ok(!tables.tables.some(table => ['sessions', 'admin_sessions', 'auth_bridge_nonces'].includes(table.key)));
  assert.ok(!tables.tables.find(table => table.key === 'admin_accounts')!.columns.some(column => column.name.startsWith('password_')));
  const all = await listConsoleRows(db.pool, actor, { table: 'users' });
  assert.equal(all.items.length, 1); assert.equal(all.items[0]!.row.openid, own.openid);
  assert.equal((await listConsoleRows(db.pool, actor, { table: 'users', search: own.openid })).items[0]!.row.id, own.id);
  assert.equal((await listConsoleRows(db.pool, actor, { table: 'users', search: foreign.openid })).items.length, 0);
  await assert.rejects(getConsoleRow(db.pool, actor, 'users', key([foreign.id])), { code: 'CONSOLE_ROW_NOT_FOUND' });
  await assert.rejects(listConsoleTables(db.pool, ordinary.actor), { status: 403 });
  await assert.rejects(listConsoleTables(db.pool, { ...ordinary.actor, role: 'superadmin' }), { status: 403 });
  await assert.rejects(listConsoleRows(db.pool, actor, { table: 'users;DROP TABLE users' }), { code: 'CONSOLE_TABLE_NOT_FOUND' });
  assert.equal((await db.pool.query('SELECT count(*) FROM users')).rows[0].count, '2');
});

test('console: bounded primary-key paging, compound rows and search-bound cursors', settings, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const { actor } = await admin(db.pool);
  const users = await Promise.all(Array.from({ length: 5 }, () => user(db.pool)));
  const first = await listConsoleRows(db.pool, actor, { table: 'users', limit: 2 });
  const second = await listConsoleRows(db.pool, actor, { table: 'users', limit: 2, cursor: first.nextCursor });
  const third = await listConsoleRows(db.pool, actor, { table: 'users', limit: 2, cursor: second.nextCursor });
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map(item => item.row.id)).size, 5);
  assert.equal(third.nextCursor, null);
  await assert.rejects(listConsoleRows(db.pool, actor, { table: 'users', limit: 51 }));
  await assert.rejects(listConsoleRows(db.pool, actor, { table: 'users', cursor: first.nextCursor, search: users[0].openid }), { code: 'CONSOLE_INVALID_KEY' });
  await db.pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone)
    VALUES('synthetic-ride','offer',$1,'ny_nj','open',2,clock_timestamp()+interval '1 day','America/New_York')`, [users[0].id]);
  await db.pool.query("INSERT INTO ride_members(ride_id,user_id,role,seat_count,state) VALUES('synthetic-ride',$1,'driver',0,'active')", [users[0].id]);
  const member = (await listConsoleRows(db.pool, actor, { table: 'ride_members', search: users[0].openid })).items[0]!;
  assert.equal((await getConsoleRow(db.pool, actor, 'ride_members', member.key)).row.user_id, users[0].id);
  await assert.rejects(getConsoleRow(db.pool, actor, 'ride_members', key(['synthetic-ride'])), { code: 'CONSOLE_INVALID_KEY' });
});

test('console: profile edits retain stable identity, merge addresses, audit fields, replay and reject stale versions', settings, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const { actor } = await admin(db.pool), account = await user(db.pool);
  const before = await getConsoleRow(db.pool, actor, 'users', key([account.id]));
  const input = { expectedVersion: before.version, patch: { name: 'new-name', profile: { wechatId: 'new-wechat' } } };
  const result = await editConsoleRow(db.pool, actor, 'users', before.key, 'synthetic-edit-1', input);
  assert.equal(result.data.row && (result.data.row as Record<string, unknown>).openid, account.openid);
  assert.deepEqual((result.data.row as Record<string, unknown>).profile, { ...account.profile, wechatId: 'new-wechat' });
  assert.deepEqual(await editConsoleRow(db.pool, actor, 'users', before.key, 'synthetic-edit-1', input), result);
  await assert.rejects(editConsoleRow(db.pool, actor, 'users', before.key, 'synthetic-edit-2', input), { code: 'CONSOLE_VERSION_CONFLICT' });
  await assert.rejects(editConsoleRow(db.pool, actor, 'users', before.key, 'synthetic-edit-1', { ...input, patch: { name: 'another' } }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(editConsoleRow(db.pool, actor, 'users', before.key, 'synthetic-edit-3', { ...input, patch: { openid: 'forged' } }));
  await assert.rejects(editConsoleRow(db.pool, actor, 'rides', key(['missing']), 'synthetic-edit-4', input), { code: 'CONSOLE_ROW_READ_ONLY' });
  const audits = (await db.pool.query("SELECT details FROM admin_audit WHERE action='console.user.edit'")).rows;
  assert.equal(audits.length, 1); assert.deepEqual(audits[0].details.fields, ['name', 'profile']);
  assert.ok(!JSON.stringify(audits).includes('synthetic-phone'));
});

test('console: downgraded administrators cannot replay previous elevated mutation', settings, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const { actor } = await admin(db.pool), account = await user(db.pool);
  const before = await getConsoleRow(db.pool, actor, 'users', key([account.id]));
  const input = { expectedVersion: before.version, patch: { name: 'changed' } };
  await editConsoleRow(db.pool, actor, 'users', before.key, 'synthetic-role-replay', input);
  await db.pool.query("UPDATE admin_accounts SET role='admin' WHERE app_id=$1 AND id=$2", [APP, actor.accountId]);
  await assert.rejects(editConsoleRow(db.pool, actor, 'users', before.key, 'synthetic-role-replay', input), { code: 'ADMIN_UNAUTHORIZED' });
  assert.equal((await db.pool.query('SELECT name FROM users WHERE id=$1', [account.id])).rows[0].name, 'changed');
});

test('console: assembled HTTP paths require elevated session and exact origin even for metrics', settings, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  await db.pool.query('INSERT INTO admin_origins(app_id,origin) VALUES($1,$2)', [APP, ORIGIN]);
  const ordinary = await admin(db.pool, 'admin'), elevated = await admin(db.pool);
  const app = await createApp({ pool: db.pool, config: { appId: APP, databaseUrl: '', host: '127.0.0.1', port: 0,
    sessionTtlSeconds: 3600, businessMode: 'active' }, exchange: async () => ({ openid: 'unused-synthetic' }) });
  t.after(() => app.close());
  for (const path of ['status', 'history?range=day', 'tables', 'rows?table=users', 'events']) {
    const headers = { origin: ORIGIN, authorization: `Bearer ${ordinary.token}` };
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/admin/console/${path}`, headers })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/admin/console/${path}`, headers: { origin: ORIGIN } })).statusCode, 401);
  }
  const status = await app.inject({ method: 'GET', url: '/api/v1/admin/console/status', headers: { origin: ORIGIN, authorization: `Bearer ${elevated.token}` } });
  assert.equal(status.statusCode, 200); assert.equal(status.json().data.host.status, 'unavailable');
  assert.equal(status.headers['cache-control'], 'private, no-store');
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/console/status', headers: { origin: 'https://wrong.example', authorization: `Bearer ${elevated.token}` } })).statusCode, 403);
});
