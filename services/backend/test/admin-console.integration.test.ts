import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { createApp } from '../src/app.ts';
import { requireAdmin } from '../src/admin/service.ts';
import { editConsoleRow, getConsoleRow, getConsoleStatistics, listConsoleRows, listConsoleTables } from '../src/admin/data.ts';
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
  for (const path of ['status', 'history?range=day', 'statistics?range=all', 'tables', 'rows?table=users', 'events']) {
    const headers = { origin: ORIGIN, authorization: `Bearer ${ordinary.token}` };
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/admin/console/${path}`, headers })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/admin/console/${path}`, headers: { origin: ORIGIN } })).statusCode, 401);
  }
  const status = await app.inject({ method: 'GET', url: '/api/v1/admin/console/status', headers: { origin: ORIGIN, authorization: `Bearer ${elevated.token}` } });
  assert.equal(status.statusCode, 200); assert.equal(status.json().data.host.status, 'unavailable');
  assert.equal(status.headers['cache-control'], 'private, no-store');
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/console/status', headers: { origin: 'https://wrong.example', authorization: `Bearer ${elevated.token}` } })).statusCode, 403);
});

test('console: statistics count app-scoped creation dates with New York day boundaries and current permissions', settings, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const { actor } = await admin(db.pool), ordinary = await admin(db.pool, 'admin');
  const recent = await user(db.pool), week = await user(db.pool), old = await user(db.pool), foreign = await user(db.pool, OTHER);
  await db.pool.query("UPDATE users SET created_at=clock_timestamp()-interval '3 days' WHERE id=$1", [week.id]);
  await db.pool.query("UPDATE users SET created_at=clock_timestamp()-interval '35 days' WHERE id=$1", [old.id]);
  for (const [owner, kind, age] of [[recent, 'offer', 0], [week, 'request', 3], [old, 'offer', 35], [foreign, 'offer', 0]] as const) {
    await db.pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone,created_at)
      VALUES($1,$2,$3,'ny_nj','open',2,clock_timestamp()+interval '1 day','America/New_York',clock_timestamp()-$4*interval '1 day')`,
    [randomUUID(), kind, owner.id, age]);
  }
  const all = await getConsoleStatistics(db.pool, actor, 'all');
  assert.deepEqual(all.business, { users: 3, rides: 3 }); assert.equal(all.from, null);
  for (const [range, expected, days] of [['day', 1, 0], ['week', 2, 6], ['month', 2, 29]] as const) {
    const result = await getConsoleStatistics(db.pool, actor, range);
    assert.deepEqual(result.business, { users: expected, rides: expected });
    assert.equal(result.timeZone, 'America/New_York');
    assert.ok(result.businessBytes > 0);
    assert.equal(result.days.length, 7); assert.equal(result.days.at(-1)!.to, result.to);
    assert.ok(result.days.every((day, index) => index === 0 || day.from === result.days[index - 1]!.to + 1));
    const local = new Intl.DateTimeFormat('en-US', { timeZone: result.timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const parts = Object.fromEntries(local.formatToParts(result.from!).map(part => [part.type, part.value]));
    assert.equal(parts.hour, '00'); assert.equal(parts.minute, '00'); assert.equal(parts.second, '00');
    const today = Object.fromEntries(local.formatToParts(result.to).map(part => [part.type, part.value]));
    const expectedDate = new Date(Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day) - days));
    assert.equal(`${parts.year}-${parts.month}-${parts.day}`, expectedDate.toISOString().slice(0, 10));
  }
  await assert.rejects(getConsoleStatistics(db.pool, ordinary.actor, 'all'), { status: 403 });
  await db.pool.query("UPDATE admin_accounts SET role='admin' WHERE app_id=$1 AND id=$2", [APP, actor.accountId]);
  await assert.rejects(getConsoleStatistics(db.pool, actor, 'all'), { status: 401 });
});

test('console: statistics endpoint retains business totals on collection outage and never caches elevated access', settings, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  await db.pool.query('INSERT INTO admin_origins(app_id,origin) VALUES($1,$2)', [APP, ORIGIN]);
  const elevated = await admin(db.pool); await user(db.pool);
  const app = await createApp({ pool: db.pool, config: { appId: APP, databaseUrl: '', host: '127.0.0.1', port: 0,
    sessionTtlSeconds: 3600, businessMode: 'active' }, exchange: async () => ({ openid: 'unused-synthetic' }) });
  t.after(() => app.close());
  const headers = { origin: ORIGIN, authorization: `Bearer ${elevated.token}` };
  const response = await app.inject({ method: 'GET', url: '/api/v1/admin/console/statistics?range=all', headers });
  assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.deepEqual(response.json().data.business, { users: 1, rides: 0 });
  assert.deepEqual(response.json().data.collection, { status: 'unavailable', events: null, followups: null });
  assert.deepEqual(Object.keys(response.json().data).sort(), ['business', 'collection', 'from', 'range', 'sampledAt', 'storage', 'timeZone', 'to']);
  assert.ok(response.json().data.storage.businessBytes > 0);
  assert.equal(response.json().data.storage.collectorBytes, null);
  assert.equal(response.json().data.storage.daily.length, 7);
  assert.ok(response.json().data.storage.daily.every((day: { date: string; bytes: number | null }) => day.bytes === null));
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/console/statistics?range=invalid', headers })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/console/statistics?range=all', headers: { ...headers, origin: 'https://wrong.example' } })).statusCode, 403);
  await db.pool.query("UPDATE admin_accounts SET role='admin' WHERE app_id=$1 AND id=$2", [APP, elevated.actor.accountId]);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/console/statistics?range=all', headers })).statusCode, 401);
});

test('console: the actual statistics query produces seven New York calendar days across both DST changes', settings, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const { actor } = await admin(db.pool);
  const connect = db.pool.connect.bind(db.pool);
  let sampledAt = Date.parse('2026-03-10T16:00:00Z');
  // Freeze only statement_timestamp in the production statistics SQL. The
  // PostgreSQL time-zone conversion and all bounds execute without a mock.
  db.pool.connect = (async () => {
    const client = await connect(), originalQuery = client.query, release = client.release.bind(client);
    const query = originalQuery.bind(client);
    client.query = ((text: string, values?: unknown[]) => query(text.includes('pg_database_size')
      ? text.replaceAll('statement_timestamp()', `to_timestamp(${sampledAt}/1000.0)`) : text, values)) as typeof client.query;
    client.release = () => { client.query = originalQuery; release(); };
    return client;
  }) as typeof db.pool.connect;
  for (const [at, date, hours] of [['2026-03-10T16:00:00Z', '2026-03-08', 23], ['2026-11-03T17:00:00Z', '2026-11-01', 25]] as const) {
    sampledAt = Date.parse(at);
    const result = await getConsoleStatistics(db.pool, actor, 'week');
    assert.equal(result.to, sampledAt); assert.equal(result.days.length, 7); assert.equal(result.days[0]!.from, result.from);
    const transition = result.days.find(day => day.date === date)!;
    assert.equal(transition.to - transition.from + 1, hours * 3600000);
    assert.equal(result.days.at(-1)!.to, result.to);
    assert.ok(result.days.every((day, index) => index === 0 || day.from === result.days[index - 1]!.to + 1));
    assert.equal(new Set(result.days.map(day => day.date)).size, 7);
  }
});

test('console: statistics aggregate through the real collector socket and observe withdrawal and restore immediately', settings, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const { createCollector } = await import(new URL('../../analytics-collector/src/server.mjs', import.meta.url).href);
  const dir = mkdtempSync(join(tmpdir(), 'console-statistics-')), keys = generateKeyPairSync('ed25519');
  const monitor = { socketPath: join(dir, 'admin.sock'), token: randomBytes(32).toString('base64url') };
  const collector = createCollector({ dbPath: join(dir, 'db.sqlite'), adminSocket: monitor.socketPath, adminToken: monitor.token,
    privatePem: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), realEnabled: true, host: '127.0.0.1', port: 0,
    minFreeBytes: 0, token: { issuer: 'test', audience: 'test', kid: 'test', ttlSeconds: 60, scopes: ['batches:write'] } });
  await collector.start();
  t.after(async () => { await collector.close(); rmSync(dir, { recursive: true, force: true }); });
  const account = { accountSubject: randomBytes(32).toString('hex'), openid: `synthetic_${randomUUID()}`, action: 'activate',
    requestId: randomUUID(), expectedStatusVersion: 0, purposeVersion: 'ride-analytics-v1', noticeVersion: 'ride-analytics-notice-2026-09-23' };
  const p = collector.store.updateAccount(account).participant;
  const now = Date.now(), body = { schemaVersion: 1, batchId: randomUUID(), events: [{ eventId: randomUUID(),
    eventName: 'followup_answer', schemaVersion: 1, occurredAt: now, context: { buildMode: 'release' },
    data: { followupId: randomUUID(), tripKey: randomUUID(), tripType: 'carpool', role: 'passenger', outcome: 'yes', outcomeScope: 'respondent_booking' } }] };
  collector.store.receive({ ...p, sub: p.participantKey }, Buffer.from(JSON.stringify(body)), body, now);
  await db.pool.query('INSERT INTO admin_origins(app_id,origin) VALUES($1,$2)', [APP, ORIGIN]);
  const elevated = await admin(db.pool); await user(db.pool);
  const app = await createApp({ pool: db.pool, config: { appId: APP, databaseUrl: '', host: '127.0.0.1', port: 0,
    sessionTtlSeconds: 3600, businessMode: 'active', adminMonitor: monitor }, exchange: async () => ({ openid: 'unused-synthetic' }) });
  t.after(() => app.close());
  const read = async () => {
    const result = await app.inject({ method: 'GET', url: '/api/v1/admin/console/statistics?range=day',
      headers: { origin: ORIGIN, authorization: `Bearer ${elevated.token}` } });
    assert.equal(result.statusCode, 200); return result.json().data;
  };
  const first = await read();
  assert.deepEqual(first.business, { users: 1, rides: 0 });
  assert.deepEqual(first.collection, { status: 'ready', events: 1, followups: {
    responses: 1, users: 1, rides: 1, passenger: 1, driver: 0, yes: 1, no: 0, defaults: 0 } });
  assert.equal(JSON.stringify(first).includes(account.openid), false);
  assert.ok(first.storage.collectorBytes > 0); assert.ok(first.storage.payloadBytes > 0);
  assert.equal(first.storage.addedBytes, first.storage.payloadBytes);
  assert.equal(first.storage.daily.length, 7); assert.equal(first.storage.daily.at(-1).bytes, first.storage.payloadBytes);
  assert.ok(first.storage.freeBytes <= first.storage.totalBytes);
  collector.store.updateAccount({ ...account, action: 'withdraw', requestId: randomUUID(), expectedStatusVersion: 1 });
  assert.equal((await read()).collection.followups.responses, 0);
  collector.store.db.prepare("UPDATE collector_settings SET value='closed' WHERE key='restore_gate'").run();
  assert.deepEqual((await read()).collection, { status: 'unavailable', events: null, followups: null });
});
