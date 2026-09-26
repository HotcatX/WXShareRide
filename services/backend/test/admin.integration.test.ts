import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, scrypt } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { ZodError } from 'zod';
import { createTestDatabase } from './helpers/database.ts';
import { AppError } from '../src/errors.ts';
import { registerAdminRoutes } from '../src/admin/routes.ts';
import { getAdminSession, lockAdmin, loginAdmin, logoutAdmin, requireAdmin, withAdminIdempotency } from '../src/admin/service.ts';
import type { AdminIdentity } from '../src/admin/service.ts';

const integration = { skip: !process.env.BACKEND_TEST_DATABASE_URL };
const APP = 'synthetic-admin-app';
const PASSWORD = 'synthetic-password-only';
const SALT = Buffer.alloc(32, 7);
const DIGEST = new Promise<Buffer>((resolve, reject) => scrypt(PASSWORD, SALT, 64,
  { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function account(pool: Pool, id: string, options: { appId?: string; ownerKey?: string; enabled?: boolean; credentials?: boolean } = {}) {
  await pool.query(`INSERT INTO admin_accounts(app_id,id,owner_key,enabled,credential_version,password_salt,password_hash)
    VALUES($1,$2,$3,$4,1,$5,$6)`, [options.appId ?? APP, id, options.ownerKey ?? `owner_${id}`,
    options.enabled ?? true, options.credentials === false ? null : SALT, options.credentials === false ? null : await DIGEST]);
}
async function identity(pool: Pool, id: string, appId = APP): Promise<AdminIdentity> {
  const login = await loginAdmin(pool, appId, { username: id, password: PASSWORD });
  return requireAdmin(pool, appId, `Bearer ${login.token}`);
}
async function waitBlocked(pool: Pool, pid: number) {
  for (let i = 0; i < 300; i++) {
    if ((await pool.query('SELECT cardinality(pg_blocking_pids($1)) AS n', [pid])).rows[0].n > 0) return;
    await setTimeout(5);
  }
  assert.fail('Expected a real PostgreSQL lock wait');
}

test('admin: normalized legacy credentials, hashed sessions and immediate revocation', integration, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  await account(db.pool, 'legacy_admin');
  const login = await loginAdmin(db.pool, APP, { username: ' LEGACY_ADMIN ', password: PASSWORD });
  assert.match(login.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(login.admin, { accountId: 'legacy_admin', ownerKey: 'owner_legacy_admin' });
  const stored = (await db.pool.query('SELECT *,extract(epoch FROM expires_at-created_at) AS duration FROM admin_sessions')).rows[0];
  assert.equal(stored.token_hash, hash(login.token));
  assert.equal(Number(stored.duration), 8 * 60 * 60);
  const actor = await requireAdmin(db.pool, APP, `Bearer ${login.token}`);
  assert.deepEqual((await getAdminSession(db.pool, actor)).admin, login.admin);
  await assert.rejects(requireAdmin(db.pool, 'other-app', `Bearer ${login.token}`), { code: 'ADMIN_UNAUTHORIZED' });
  await assert.rejects(requireAdmin(db.pool, APP, `Bearer ${actor.sessionHash}`), { code: 'ADMIN_UNAUTHORIZED' });
  await assert.rejects(requireAdmin(db.pool, APP, ['Bearer forged']), { code: 'ADMIN_UNAUTHORIZED' });
  await db.pool.query('UPDATE admin_accounts SET enabled=false WHERE app_id=$1 AND id=$2', [APP, actor.accountId]);
  await assert.rejects(requireAdmin(db.pool, APP, `Bearer ${login.token}`), { code: 'ADMIN_UNAUTHORIZED' });
  await assert.rejects(getAdminSession(db.pool, actor), { code: 'ADMIN_UNAUTHORIZED' });
  await db.pool.query('UPDATE admin_accounts SET enabled=true WHERE app_id=$1 AND id=$2', [APP, actor.accountId]);
  await assert.rejects(requireAdmin(db.pool, APP, `Bearer ${login.token}`), { code: 'ADMIN_UNAUTHORIZED' });
  const rotated = await identity(db.pool, actor.accountId);
  await db.pool.query('UPDATE admin_accounts SET credential_version=2 WHERE app_id=$1 AND id=$2', [APP, actor.accountId]);
  await assert.rejects(getAdminSession(db.pool, rotated), { code: 'ADMIN_UNAUTHORIZED' });
  const fresh = await identity(db.pool, actor.accountId);
  await logoutAdmin(db.pool, fresh);
  await assert.rejects(getAdminSession(db.pool, fresh), { code: 'ADMIN_UNAUTHORIZED' });
  assert.equal((await db.pool.query("SELECT count(*) FROM admin_audit WHERE action='logout'")).rows[0].count, '1');
  assert.ok((await db.pool.query('SELECT details FROM admin_audit')).rows.every(row => JSON.stringify(row.details) === '{}'));
  assert.equal((await db.pool.query('SELECT count(*) FROM users')).rows[0].count, '0');
});

test('admin: absent, disabled, unset and incorrect credentials share errors; attempts persist before password work', integration, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  await account(db.pool, 'disabled_admin', { enabled: false });
  await account(db.pool, 'unset_admin', { credentials: false });
  await account(db.pool, 'active_admin');
  for (const [username, password] of [['absent_admin', PASSWORD], ['disabled_admin', PASSWORD], ['unset_admin', PASSWORD], ['active_admin', 'incorrect-test-password']]) {
    await assert.rejects(loginAdmin(db.pool, APP, { username, password }), { status: 401, code: 'INVALID_CREDENTIALS', message: '账号或密码不正确' });
    assert.equal((await db.pool.query('SELECT attempt_count FROM admin_login_attempts WHERE app_id=$1 AND scope=$2', [APP, hash(username)])).rows[0].attempt_count, 1);
  }
  assert.equal((await db.pool.query('SELECT count(*) FROM admin_sessions')).rows[0].count, '0');
  await loginAdmin(db.pool, APP, { username: 'active_admin', password: PASSWORD });
  assert.equal((await db.pool.query('SELECT attempt_count FROM admin_login_attempts WHERE app_id=$1 AND scope=$2', [APP, hash('active_admin')])).rows[0].attempt_count, 2);
  await assert.rejects(loginAdmin(db.pool, APP, { username: 'active_admin', password: PASSWORD, ownerKey: 'forged' }), { code: 'INVALID_CREDENTIALS' });
});

test('admin: concurrent account and app-wide login limits are atomic and windows expire', integration, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => loginAdmin(db.pool, APP, { username: 'missing_admin', password: PASSWORD })));
  const codes = attempts.map(result => result.status === 'rejected' ? result.reason.code : 'unexpected-success');
  assert.equal(codes.filter(code => code === 'INVALID_CREDENTIALS').length, 10);
  assert.equal(codes.filter(code => code === 'ADMIN_LOGIN_RATE_LIMITED').length, 2);
  assert.deepEqual((await db.pool.query('SELECT attempt_count FROM admin_login_attempts ORDER BY scope')).rows.map(row => row.attempt_count), [10, 10]);
  await db.pool.query("UPDATE admin_login_attempts SET window_start=clock_timestamp()-interval '16 minutes' WHERE app_id=$1", [APP]);
  await assert.rejects(loginAdmin(db.pool, APP, { username: 'missing_admin', password: PASSWORD }), { code: 'INVALID_CREDENTIALS' });
  assert.ok((await db.pool.query('SELECT attempt_count FROM admin_login_attempts')).rows.every(row => row.attempt_count === 1));
  await db.pool.query("UPDATE admin_login_attempts SET attempt_count=119 WHERE app_id=$1 AND scope='global'", [APP]);
  const global = await Promise.allSettled(['different_one', 'different_two', 'different_three'].map(username => loginAdmin(db.pool, APP, { username, password: PASSWORD })));
  assert.equal(global.filter(result => result.status === 'rejected' && result.reason.code === 'INVALID_CREDENTIALS').length, 1);
  assert.equal(global.filter(result => result.status === 'rejected' && result.reason.code === 'ADMIN_LOGIN_RATE_LIMITED').length, 2);
  assert.equal((await db.pool.query("SELECT attempt_count FROM admin_login_attempts WHERE app_id=$1 AND scope='global'", [APP])).rows[0].attempt_count, 120);
  await assert.rejects(loginAdmin(db.pool, 'other-app', { username: 'missing_admin', password: PASSWORD }), { code: 'INVALID_CREDENTIALS' });
});

test('admin: credential changes during password verification prevent session creation', integration, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  await account(db.pool, 'racing_admin');
  const original = db.pool.query.bind(db.pool);
  let release!: () => void, captured!: () => void;
  const capturedPromise = new Promise<void>(resolve => { captured = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const proxy = new Proxy(db.pool, { get(target, key) {
    if (key !== 'query') return Reflect.get(target, key, target);
    return async (sql: string, values: unknown[]) => {
      const result = await original(sql, values);
      if (sql.startsWith('SELECT id,owner_key') && sql.includes('FROM admin_accounts')) { captured(); await released; }
      return result;
    };
  } });
  const attempt = loginAdmin(proxy, APP, { username: 'racing_admin', password: PASSWORD });
  const rejected = assert.rejects(attempt, { code: 'INVALID_CREDENTIALS' });
  await capturedPromise;
  await db.pool.query('UPDATE admin_accounts SET credential_version=credential_version+1 WHERE app_id=$1', [APP]);
  release();
  await rejected;
  assert.equal((await db.pool.query('SELECT count(*) FROM admin_sessions')).rows[0].count, '0');
  assert.equal((await db.pool.query('SELECT count(*) FROM admin_audit')).rows[0].count, '0');
});

test('admin: locked business authorization rechecks disable and expiry after real lock waits', integration, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  await account(db.pool, 'locking_admin');
  for (const reason of ['disabled', 'expired']) {
    const actor = await identity(db.pool, 'locking_admin');
    const holder = await db.pool.connect();
    const worker = await db.pool.connect();
    try {
      await holder.query('BEGIN'); await worker.query('BEGIN');
      const pid = (await worker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      if (reason === 'disabled') {
        await holder.query('SELECT id FROM admin_accounts WHERE app_id=$1 FOR UPDATE', [APP]);
      } else {
        await holder.query('SELECT token_hash FROM admin_sessions WHERE token_hash=$1 FOR UPDATE', [actor.sessionHash]);
        await holder.query("UPDATE admin_sessions SET created_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()+interval '300 milliseconds' WHERE token_hash=$1", [actor.sessionHash]);
      }
      const attempt = lockAdmin(worker, actor);
      const rejected = assert.rejects(attempt, { code: 'ADMIN_UNAUTHORIZED' });
      await waitBlocked(db.pool, pid);
      if (reason === 'disabled') {
        await holder.query('UPDATE admin_accounts SET enabled=false WHERE app_id=$1', [APP]);
      } else {
        // It expires during the real lock wait. Transaction-start now() would
        // wrongly admit it; authorization must read wall-clock after the wait.
        await holder.query('SELECT pg_sleep(0.35)');
      }
      await holder.query('COMMIT');
      await rejected;
      await worker.query('ROLLBACK');
    } finally { await holder.query('ROLLBACK'); await worker.query('ROLLBACK'); holder.release(); worker.release(); }
    await db.pool.query('UPDATE admin_accounts SET enabled=true WHERE app_id=$1', [APP]);
  }
});

test('admin: permanent owner-scoped receipts deduplicate, reauthorize and roll back with business and audit', integration, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  await account(db.pool, 'first_admin', { ownerKey: 'shared_owner' });
  await account(db.pool, 'second_admin', { ownerKey: 'shared_owner' });
  await account(db.pool, 'third_admin', { ownerKey: 'different_owner' });
  const [first, second, third] = await Promise.all(['first_admin', 'second_admin', 'third_admin'].map(id => identity(db.pool, id)));
  await db.pool.query('CREATE TABLE admin_fixture_changes (id text PRIMARY KEY, changes integer NOT NULL)');
  await db.pool.query("INSERT INTO admin_fixture_changes VALUES('record',0)");
  const change = (actor: AdminIdentity, payload: unknown = { amount: 1, value: 'one' }) => withAdminIdempotency(db.pool, actor, 'market.update', 'same-request-001', payload, async client => {
    const row = (await client.query("UPDATE admin_fixture_changes SET changes=changes+1 WHERE id='record' RETURNING changes")).rows[0];
    return { status: 201, data: { revision: row.changes } };
  });
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => change(i % 2 ? first : second)));
  assert.ok(results.every(result => result.data.revision === 1));
  assert.deepEqual(await change(second, { value: 'one', amount: 1 }), results[0]);
  await assert.rejects(change(first, { value: 'different', amount: 1 }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal((await change(third)).data.revision, 2);
  assert.equal((await db.pool.query("SELECT count(*) FROM admin_audit WHERE action='market.update'")).rows[0].count, '2');
  assert.equal((await db.pool.query('SELECT count(*) FROM admin_requests')).rows[0].count, '2');
  await logoutAdmin(db.pool, first);
  await assert.rejects(change(first), { code: 'ADMIN_UNAUTHORIZED' });
  assert.equal((await change(second)).data.revision, 1);
  await assert.rejects(withAdminIdempotency(db.pool, second, 'market.fail', 'failed-request-001', {}, async client => {
    await client.query("UPDATE admin_fixture_changes SET changes=900 WHERE id='record'");
    throw new Error('synthetic business failure');
  }), /synthetic business failure/);
  assert.equal((await db.pool.query('SELECT changes FROM admin_fixture_changes')).rows[0].changes, 2);
  await db.pool.query(`CREATE FUNCTION reject_admin_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='market.auditFailure' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_admin_audit BEFORE INSERT ON admin_audit FOR EACH ROW EXECUTE FUNCTION reject_admin_audit()`);
  await assert.rejects(withAdminIdempotency(db.pool, second, 'market.auditFailure', 'failed-audit-001', {}, async client => {
    await client.query("UPDATE admin_fixture_changes SET changes=901 WHERE id='record'");
    return { status: 200, data: {} };
  }), /synthetic audit failure/);
  assert.equal((await db.pool.query('SELECT changes FROM admin_fixture_changes')).rows[0].changes, 2);
  assert.equal((await db.pool.query('SELECT count(*) FROM admin_requests')).rows[0].count, '2');
  await assert.rejects(withAdminIdempotency(db.pool, second, 'market.update', 'short', {}, async () => ({ status: 200, data: {} })), { code: 'IDEMPOTENCY_KEY_REQUIRED' });
});

test('admin HTTP: exact HTTPS origins, empty defaults, private errors and OPTIONS; no public provisioning', integration, async t => {
  const db = await createTestDatabase();
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof AppError ? error.status : error instanceof ZodError ? 400 : (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({ ok: false, error: { code: error instanceof AppError ? error.code : 'INVALID_INPUT' }, requestId: request.id });
  });
  registerAdminRoutes(app, { pool: db.pool, appId: APP });
  t.after(async () => { await app.close(); await db.close(); });
  await account(db.pool, 'http_admin');
  const origin = 'https://admin.example.test';
  const login = () => app.inject({ method: 'POST', url: '/api/v1/admin/auth/login', headers: { origin }, payload: { username: 'http_admin', password: PASSWORD } });
  assert.equal((await login()).statusCode, 403);
  await db.pool.query('INSERT INTO admin_origins(app_id,origin) VALUES($1,$2)', [APP, origin]);
  for (const untrusted of [undefined, 'null', 'http://admin.example.test', `${origin}/`, `${origin}.evil.test`, 'https://evil.example.test']) {
    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/session', headers: untrusted ? { origin: untrusted } : {} });
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  const preflight = await app.inject({ method: 'OPTIONS', url: '/api/v1/admin/auth/login', headers: { origin,
    'access-control-request-method': 'POST', 'access-control-request-headers': 'Authorization, Content-Type, Idempotency-Key' } });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['cache-control'], 'private, no-store');
  assert.equal(preflight.headers['access-control-allow-origin'], origin);
  assert.equal(preflight.headers.vary, 'Origin');
  const badPreflight = await app.inject({ method: 'OPTIONS', url: '/api/v1/admin/session', headers: { origin, 'access-control-request-method': 'DELETE' } });
  assert.equal(badPreflight.statusCode, 403);
  assert.equal(badPreflight.headers['cache-control'], 'private, no-store');
  const unauth = await app.inject({ method: 'GET', url: '/api/v1/admin/session', headers: { origin } });
  assert.equal(unauth.statusCode, 401);
  assert.equal(unauth.headers['cache-control'], 'private, no-store');
  const malformed = await app.inject({ method: 'POST', url: '/api/v1/admin/auth/login', headers: { origin, 'content-type': 'application/json' }, payload: '{' });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.headers['cache-control'], 'private, no-store');
  const success = await login();
  assert.equal(success.statusCode, 200, success.body);
  assert.equal(success.headers['cache-control'], 'private, no-store');
  const data = success.json().data;
  const headers = { origin, authorization: `Bearer ${data.token}` };
  const current = await app.inject({ method: 'GET', url: '/api/v1/admin/session', headers });
  assert.equal(current.statusCode, 200);
  assert.deepEqual(Object.keys(current.json().data).sort(), ['admin', 'expiresAt']);
  assert.deepEqual(Object.keys(current.json().data.admin).sort(), ['accountId', 'ownerKey']);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/auth/logout', headers })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/session', headers })).statusCode, 401);
  for (const url of ['/api/v1/admin/accounts', '/api/v1/admin/auth/register', '/api/v1/admin/auth/password']) {
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: {} })).statusCode, 404);
  }
});

test('admin DB: credential pairs and lengths, scoped IDs and shared ownership are enforced', integration, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  await account(db.pool, 'same_admin');
  await account(db.pool, 'same_admin', { appId: 'second-app' });
  await account(db.pool, 'shared_admin', { ownerKey: 'owner_same_admin' });
  await db.pool.query("UPDATE admin_accounts SET created_at='2025-01-01T00:00:00Z',updated_at=NULL WHERE app_id=$1 AND id='same_admin'", [APP]);
  const legacy = (await db.pool.query("SELECT created_at,updated_at FROM admin_accounts WHERE app_id=$1 AND id='same_admin'", [APP])).rows[0];
  assert.equal(legacy.created_at.toISOString(), '2025-01-01T00:00:00.000Z');
  assert.equal(legacy.updated_at, null);
  for (const sql of ['password_salt=NULL', "password_salt=decode('00','hex')", 'credential_version=0', "id='UPPERCASE'", "owner_key=''" ]) {
    await assert.rejects(db.pool.query(`UPDATE admin_accounts SET ${sql} WHERE app_id=$1 AND id='same_admin'`, [APP]), { code: '23514' });
  }
  await db.pool.query('UPDATE admin_accounts SET password_salt=NULL,password_hash=NULL WHERE app_id=$1', [APP]);
  await assert.rejects(loginAdmin(db.pool, APP, { username: 'same_admin', password: PASSWORD }), { code: 'INVALID_CREDENTIALS' });
  assert.equal((await db.pool.query('SELECT count(*) FROM admin_accounts')).rows[0].count, '3');
});

test('admin: direct credential or owner updates permanently revoke sessions without version changes', integration, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  await account(db.pool, 'changed_admin');
  for (const change of ['password_hash', 'password_salt', 'owner_key']) {
    const actor = await identity(db.pool, 'changed_admin');
    const value = change === 'owner_key' ? 'new_owner' : Buffer.alloc(change === 'password_hash' ? 64 : 32, 9);
    await db.pool.query(`UPDATE admin_accounts SET ${change}=$1 WHERE app_id=$2`, [value, APP]);
    assert.equal((await db.pool.query('SELECT count(*) FROM admin_sessions')).rows[0].count, '0');
    await db.pool.query('UPDATE admin_accounts SET password_salt=$1,password_hash=$2,owner_key=$3 WHERE app_id=$4', [SALT, await DIGEST, 'owner_changed_admin', APP]);
    await assert.rejects(getAdminSession(db.pool, actor), { code: 'ADMIN_UNAUTHORIZED' });
  }
});
