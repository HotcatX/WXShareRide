import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { transaction } from '../db.ts';
import { AppError } from '../errors.ts';
import { issueSession } from './session.ts';
import type { Session } from './session.ts';

export const cloudBaseLoginPath = '/internal/v1/auth/cloudbase';
const domain = 'linkx-auth-bridge-v1';
const windowMs = 60_000;
const unauthorized = () => new AppError(401, 'AUTH_BRIDGE_UNAUTHORIZED', '登录凭证无效');
const unavailable = () => new AppError(503, 'LOGIN_UNAVAILABLE', '登录服务暂不可用');
const bodySchema = z.strictObject({ purpose: z.literal('login'), appId: z.string().regex(/^wx[0-9a-f]{16}$/),
  openid: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/), source: z.enum(['wx_client', 'wx_devtools']) });
export type CloudBaseLoginRequest = { method: string; path: string; rawHeaders: readonly string[]; body: Buffer };

/** This module does not register an HTTP route or enable itself. The runtime
 * must supply its explicit activation gate and this purpose's separate key. */
export function createCloudBaseLoginBridge(deps: { pool: Pool; appId: string; key: Buffer; sessionTtlSeconds: number;
  isActive: () => boolean; now?: () => number }) {
  if (!/^wx[0-9a-f]{16}$/.test(deps.appId) || !Buffer.isBuffer(deps.key) || deps.key.length !== 32 ||
      !Number.isInteger(deps.sessionTtlSeconds) || deps.sessionTtlSeconds < 60 || deps.sessionTtlSeconds > 2592000 ||
      typeof deps.isActive !== 'function') throw unavailable();
  const key = Buffer.from(deps.key), now = deps.now ?? Date.now;
  function active() { if (deps.isActive() !== true) throw unavailable(); }
  function verify(request: CloudBaseLoginRequest) {
    if (request.method !== 'POST' || request.path !== cloudBaseLoginPath || !Buffer.isBuffer(request.body) ||
        !request.body.length || request.body.length > 1024 || !Array.isArray(request.rawHeaders) || request.rawHeaders.length > 100 ||
        request.rawHeaders.length % 2) throw unauthorized();
    const names = ['x-linkx-auth-timestamp', 'x-linkx-auth-nonce', 'x-linkx-auth-signature'];
    const headers = new Map<string, string>();
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i], value = request.rawHeaders[i + 1];
      if (typeof name !== 'string' || typeof value !== 'string') throw unauthorized();
      const lower = name.toLowerCase();
      if (!names.includes(lower)) continue;
      if (headers.has(lower)) throw unauthorized();
      headers.set(lower, value);
    }
    const timestamp = headers.get(names[0]) ?? '', nonce = headers.get(names[1]) ?? '', signature = headers.get(names[2]) ?? '';
    const at = Number(timestamp), current = now();
    if (!/^[1-9][0-9]{0,15}$/.test(timestamp) || !Number.isSafeInteger(at) || !Number.isSafeInteger(current) ||
        Math.abs(current - at) > windowMs || !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) throw unauthorized();
    const expected = createHmac('sha256', key).update(`${domain}\nPOST\n${cloudBaseLoginPath}\n${deps.appId}\n${timestamp}\n${nonce}\n`).update(request.body).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw unauthorized();
    let body: z.infer<typeof bodySchema>;
    try {
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(request.body);
      const parsed: unknown = JSON.parse(raw);
      if (JSON.stringify(parsed) !== raw) throw unauthorized();
      body = bodySchema.parse(parsed);
    } catch { throw unauthorized(); }
    if (body.appId !== deps.appId) throw unauthorized();
    return { ...body, at, nonce };
  }
  return {
    async login(request: CloudBaseLoginRequest): Promise<Session> {
      try {
        active();
        // Parse and detach before awaits; mutable caller buffers never enter a transaction.
        const proof = verify(request);
        return await transaction(deps.pool, async client => {
          active();
          const current = now();
          if (!Number.isSafeInteger(current) || Math.abs(current - proof.at) > windowMs) throw unauthorized();
          await client.query(`DELETE FROM auth_bridge_nonces WHERE app_id=$1 AND nonce IN
            (SELECT nonce FROM auth_bridge_nonces WHERE app_id=$1 AND expires_at<$2 ORDER BY expires_at
             LIMIT 100 FOR UPDATE SKIP LOCKED)`, [deps.appId, new Date(current)]);
          const inserted = await client.query(`INSERT INTO auth_bridge_nonces(app_id,nonce,expires_at) VALUES($1,$2,$3)
            ON CONFLICT DO NOTHING`, [deps.appId, proof.nonce, new Date(proof.at + windowMs)]);
          if (!inserted.rowCount) throw new AppError(409, 'AUTH_BRIDGE_REPLAY', '登录凭证已使用，请重新登录');
          active();
          const beforeIssue = now();
          if (!Number.isSafeInteger(beforeIssue) || Math.abs(beforeIssue - proof.at) > windowMs) throw unauthorized();
          const session = await issueSession(client, deps, proof.openid);
          active();
          const beforeCommit = now();
          if (!Number.isSafeInteger(beforeCommit) || Math.abs(beforeCommit - proof.at) > windowMs) throw unauthorized();
          return session;
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        // Never expose proof contents, credentials, raw transport or DB diagnostics.
        throw unavailable();
      }
    }
  };
}
