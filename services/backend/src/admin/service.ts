import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { idempotencyInput, runIdempotentMutation, transaction } from '../db.ts';
import type { MutationReceipt, MutationResult } from '../db.ts';
import { AppError } from '../errors.ts';

export type AdminIdentity = { appId: string; accountId: string; ownerKey: string; credentialVersion: number; sessionHash: string };
type Account = { id: string; owner_key: string; enabled: boolean; credential_version: number;
  password_salt: Buffer | null; password_hash: Buffer | null };
const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/);
const loginSchema = z.strictObject({ username: usernameSchema, password: z.string().min(12).max(256) });
const actionSchema = z.string().regex(/^[a-z][a-zA-Z0-9_.-]{0,63}$/);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const unauthorized = () => new AppError(401, 'ADMIN_UNAUTHORIZED', '管理员登录已失效，请重新登录');
const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', '账号或密码不正确');
const digest = (password: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => {
    if (error) reject(error); else resolve(result);
  });
});
function usable(account: Account | undefined): account is Account & { password_salt: Buffer; password_hash: Buffer } {
  return !!account && account.enabled && account.password_salt?.length === 32 && account.password_hash?.length === 64;
}
function sessionHash(authorization: unknown): string {
  if (typeof authorization !== 'string') throw unauthorized();
  const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization);
  if (!match) throw unauthorized();
  return hash(match[1]);
}

async function audit(client: PoolClient, identity: Pick<AdminIdentity, 'appId' | 'accountId'>, action: string): Promise<void> {
  await client.query('INSERT INTO admin_audit(app_id,account_id,action,details) VALUES($1,$2,$3,$4)',
    [identity.appId, identity.accountId, actionSchema.parse(action), {}]);
}

/** Admission commits before expensive password work; successful logins do not reset it. */
async function reserveLoginAttempt(pool: Pool, appId: string, accountId: string): Promise<void> {
  const permitted = await transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['admin-login', appId])]);
    const at: Date = (await client.query('SELECT clock_timestamp() AS at')).rows[0].at;
    const scopes = ['global', hash(accountId)];
    const previous = (await client.query<{ scope: string; window_start: Date; attempt_count: number }>(
      'SELECT scope,window_start,attempt_count FROM admin_login_attempts WHERE app_id=$1 AND scope=ANY($2::text[]) FOR UPDATE',
      [appId, scopes])).rows;
    const windows = scopes.map(scope => {
      const row = previous.find(row => row.scope === scope);
      const fresh = !row || at.getTime() >= row.window_start.getTime() + 15 * 60 * 1000;
      return { scope, start: fresh ? at : row.window_start, count: fresh ? 0 : row.attempt_count };
    });
    if (windows.some(window => window.count >= (window.scope === 'global' ? 120 : 10))) return false;
    for (const window of windows) await client.query(
      `INSERT INTO admin_login_attempts(app_id,scope,window_start,attempt_count) VALUES($1,$2,$3,$4)
       ON CONFLICT(app_id,scope) DO UPDATE SET window_start=EXCLUDED.window_start,attempt_count=EXCLUDED.attempt_count`,
      [appId, window.scope, window.start, window.count + 1]);
    return true;
  });
  if (!permitted) throw new AppError(429, 'ADMIN_LOGIN_RATE_LIMITED', '尝试次数过多，请稍后再试');
}

export async function loginAdmin(pool: Pool, appId: string, input: unknown) {
  const parsed = loginSchema.safeParse(input);
  // Invalid, absent and disabled accounts share the same external error.
  if (!parsed.success) throw invalidCredentials();
  const { username: accountId, password } = parsed.data;
  await reserveLoginAttempt(pool, appId, accountId);
  const account = (await pool.query<Account>(
    'SELECT id,owner_key,enabled,credential_version,password_salt,password_hash FROM admin_accounts WHERE app_id=$1 AND id=$2',
    [appId, accountId])).rows[0];
  const salt = account?.password_salt ?? Buffer.alloc(32);
  const expected = account?.password_hash ?? Buffer.alloc(64);
  const derived = await digest(password, salt);
  if (!timingSafeEqual(expected, derived) || !usable(account)) throw invalidCredentials();
  const token = randomBytes(32).toString('hex');
  return transaction(pool, async client => {
    // Recheck after scrypt: a password change or disable must defeat in-flight login.
    const current = (await client.query<Account>(
      'SELECT id,owner_key,enabled,credential_version,password_salt,password_hash FROM admin_accounts WHERE app_id=$1 AND id=$2 FOR SHARE',
      [appId, accountId])).rows[0];
    if (!usable(current) || current.credential_version !== account.credential_version ||
      !current.password_salt.equals(account.password_salt) || !current.password_hash.equals(account.password_hash)) throw invalidCredentials();
    const session = (await client.query<{ expires_at: Date }>(
      `INSERT INTO admin_sessions(token_hash,app_id,account_id,credential_version,created_at,expires_at)
       SELECT $1,$2,$3,$4,at,at+interval '8 hours' FROM (SELECT clock_timestamp() AS at) clock RETURNING expires_at`,
      [hash(token), appId, accountId, current.credential_version])).rows[0];
    await audit(client, { appId, accountId }, 'login');
    return { token, expiresAt: session.expires_at.toISOString(), admin: { accountId, ownerKey: current.owner_key } };
  });
}

export async function requireAdmin(pool: Pool, appId: string, authorization: unknown): Promise<AdminIdentity> {
  const tokenHash = sessionHash(authorization);
  const row = (await pool.query<{ account_id: string; owner_key: string; credential_version: number }>(
    `SELECT s.account_id,a.owner_key,a.credential_version FROM admin_sessions s
     JOIN admin_accounts a ON a.app_id=s.app_id AND a.id=s.account_id
     WHERE s.token_hash=$1 AND s.app_id=$2 AND s.expires_at>clock_timestamp() AND a.enabled
       AND a.password_salt IS NOT NULL AND a.password_hash IS NOT NULL AND s.credential_version=a.credential_version`,
    [tokenHash, appId])).rows[0];
  if (!row) throw unauthorized();
  return { appId, accountId: row.account_id, ownerKey: row.owner_key, credentialVersion: row.credential_version, sessionHash: tokenHash };
}

/** Business transactions lock account before session; logout uses the same order.
 * The account share lock permits independent sessions, while credential changes
 * wait for admitted transactions. The session lock serializes logout and writes. */
export async function lockAdmin(client: PoolClient, identity: AdminIdentity): Promise<AdminIdentity> {
  const account = (await client.query<Account>(
    'SELECT id,owner_key,enabled,credential_version,password_salt,password_hash FROM admin_accounts WHERE app_id=$1 AND id=$2 FOR SHARE',
    [identity.appId, identity.accountId])).rows[0];
  if (!usable(account) || account.owner_key !== identity.ownerKey || account.credential_version !== identity.credentialVersion) throw unauthorized();
  const session = (await client.query<{ credential_version: number; expires_at: Date }>(
    'SELECT credential_version,expires_at FROM admin_sessions WHERE token_hash=$1 AND app_id=$2 AND account_id=$3 FOR UPDATE',
    [identity.sessionHash, identity.appId, identity.accountId])).rows[0];
  // Read DB wall-clock after both waits, not transaction start or pre-lock filter.
  const at: Date = (await client.query('SELECT clock_timestamp() AS at')).rows[0].at;
  if (!session || session.credential_version !== account.credential_version || session.expires_at <= at) throw unauthorized();
  return { ...identity, ownerKey: account.owner_key, credentialVersion: account.credential_version };
}

export async function getAdminSession(pool: Pool, identity: AdminIdentity) {
  return transaction(pool, async client => {
    await lockAdmin(client, identity);
    const session = (await client.query<{ expires_at: Date }>('SELECT expires_at FROM admin_sessions WHERE token_hash=$1', [identity.sessionHash])).rows[0];
    return { admin: { accountId: identity.accountId, ownerKey: identity.ownerKey }, expiresAt: session.expires_at.toISOString() };
  });
}

export async function logoutAdmin(pool: Pool, identity: AdminIdentity): Promise<void> {
  await transaction(pool, async client => {
    await lockAdmin(client, identity);
    await client.query('DELETE FROM admin_sessions WHERE token_hash=$1', [identity.sessionHash]);
    await audit(client, identity, 'logout');
  });
}

/** Permanent deduplication belongs to app + owner, never a fabricated user UUID. */
export async function withAdminIdempotency(pool: Pool, identity: AdminIdentity, operation: string, key: unknown,
  payload: unknown, work: (client: PoolClient, identity: AdminIdentity) => Promise<MutationResult>): Promise<MutationResult> {
  actionSchema.parse(operation);
  const input = idempotencyInput(key, payload);
  return transaction(pool, client => runIdempotentMutation(client, {
    lockKey: ['admin', identity.appId, identity.ownerKey, operation, input.key], hash: input.hash,
    beforeReceipt: async () => { await lockAdmin(client, identity); },
    read: async () => (await client.query<MutationReceipt>(
      'SELECT payload_hash,response_status,response_body FROM admin_requests WHERE app_id=$1 AND owner_key=$2 AND operation=$3 AND request_key=$4',
      [identity.appId, identity.ownerKey, operation, input.key])).rows[0],
    save: async result => {
      await client.query(`INSERT INTO admin_requests(app_id,owner_key,operation,request_key,payload_hash,response_status,response_body)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [identity.appId, identity.ownerKey, operation, input.key, input.hash, result.status, result.data]);
      await audit(client, identity, operation);
    }
  }, client => work(client, identity)));
}

export async function checkAdminOrigin(pool: Pool, appId: string, origin: unknown): Promise<string> {
  let valid = false;
  if (typeof origin === 'string' && origin.length <= 300) {
    try { const url = new URL(origin); valid = url.protocol === 'https:' && !url.username && !url.password && url.origin === origin; }
    catch { /* Invalid origins have the same response as unlisted origins. */ }
  }
  if (!valid || !(await pool.query('SELECT 1 FROM admin_origins WHERE app_id=$1 AND origin=$2', [appId, origin])).rowCount) {
    throw new AppError(403, 'ADMIN_ORIGIN_NOT_ALLOWED', '该网站尚未获得访问授权');
  }
  return origin as string;
}
