import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { transaction } from '../db.ts';
import { AppError } from '../errors.ts';
import { runCompatAction } from './service.ts';
import type { CompatReadDependencies } from './service.ts';
import { compatQueryActions, compatWrites, parseCompatAction } from './contract.ts';

export const compatBridgePath = '/internal/v1/compat/cloudbase';
const domain = 'linkx-compat-bridge-v1', readDomain = 'linkx-compat-read-v1', windowMs = 60_000;
const unauthorized = () => new AppError(401, 'COMPAT_BRIDGE_UNAUTHORIZED', '请求凭证无效');
const unavailable = () => new AppError(503, 'OPERATION_UNAVAILABLE', '操作暂未完成，请重试');
const bodySchema = z.strictObject({ purpose: z.enum(['compat', 'compat-read']), appId: z.string().regex(/^wx[0-9a-f]{16}$/),
  openid: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/), source: z.enum(['wx_client', 'wx_devtools']),
  action: z.string(), body: z.unknown(), key: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).optional() });
type Request = { method: string; path: string; rawHeaders: readonly string[]; body: Buffer };

/** A query adapter receives this leaf, never the root authentication key. It
 * cannot sign other reads, business writes or login/session requests. */
export function compatQueryKey(root: Buffer, action: string): Buffer {
  if (!Buffer.isBuffer(root) || root.length !== 32 || !compatQueryActions.has(action)) throw unauthorized();
  return createHmac('sha256', root).update(`linkx-compat-read-key-v1\n${action}`).digest();
}

/** Same privately deployed root key, cryptographically separate purpose/path;
 * no new credential or receipt table. This endpoint cannot issue sessions. */
export function createCompatBridge(deps: { pool: Pool; appId: string; key: Buffer; isActive: () => boolean; now?: () => number } & CompatReadDependencies) {
  if (!/^wx[0-9a-f]{16}$/.test(deps.appId) || !Buffer.isBuffer(deps.key) || deps.key.length !== 32 || typeof deps.isActive !== 'function') throw unavailable();
  const key = createHmac('sha256', deps.key).update('linkx-compat-bridge-key-v1').digest(), now = deps.now ?? Date.now;
  const active = () => { if (deps.isActive() !== true) throw new AppError(503, 'BACKEND_STAGED', '服务正在准备中，请稍后重试'); };
  const fresh = (at: number) => { const current = now(); if (!Number.isSafeInteger(current) || Math.abs(current - at) > windowMs) throw unauthorized(); return current; };
  function verify(request: Request) {
    if (request.method !== 'POST' || request.path !== compatBridgePath || !Buffer.isBuffer(request.body) || !request.body.length || request.body.length > 69632 ||
        !Array.isArray(request.rawHeaders) || request.rawHeaders.length > 100 || request.rawHeaders.length % 2) throw unauthorized();
    const names = ['x-linkx-compat-timestamp', 'x-linkx-compat-nonce', 'x-linkx-compat-signature'];
    const headers = new Map<string, string>();
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i], value = request.rawHeaders[i + 1];
      if (typeof name !== 'string' || typeof value !== 'string') throw unauthorized();
      if (!names.includes(name.toLowerCase())) continue;
      if (headers.has(name.toLowerCase())) throw unauthorized();
      headers.set(name.toLowerCase(), value);
    }
    const timestamp = headers.get(names[0]!) ?? '', nonce = headers.get(names[1]!) ?? '', signature = headers.get(names[2]!) ?? '';
    const at = Number(timestamp);
    if (!/^[1-9][0-9]{0,15}$/.test(timestamp) || !Number.isSafeInteger(at) || !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) throw unauthorized();
    fresh(at);
    let body: z.infer<typeof bodySchema>;
    try {
      const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(request.body), parsed: unknown = JSON.parse(raw);
      if (JSON.stringify(parsed) !== raw) throw unauthorized();
      body = bodySchema.parse(parsed);
    } catch { throw unauthorized(); }
    if (body.appId !== deps.appId) throw unauthorized();
    const scoped = body.purpose === 'compat-read';
    if (scoped && (!compatQueryActions.has(body.action) || body.key !== undefined)) throw unauthorized();
    const signingKey = scoped ? compatQueryKey(deps.key, body.action) : key;
    const expected = createHmac('sha256', signingKey).update(`${scoped ? readDomain : domain}\nPOST\n${compatBridgePath}\n${deps.appId}\n${timestamp}\n${nonce}\n`).update(request.body).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw unauthorized();
    parseCompatAction(body.action, body.body);
    if (compatWrites.has(body.action) !== (body.key !== undefined)) throw new AppError(400, 'INVALID_INPUT', '请求编号不正确');
    return { ...body, at, nonce };
  }
  return async (request: Request) => {
    try {
      active(); const proof = verify(request);
      return await transaction(deps.pool, async client => {
        // Bounded legacy pagination and contacts share one current snapshot;
        // concurrent row removal must not make OFFSET silently skip a ride.
        // Existing mutation receipt/recovery isolation remains unchanged.
        if (proof.purpose === 'compat-read') await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        active(); const current = fresh(proof.at);
        await client.query(`DELETE FROM auth_bridge_nonces WHERE app_id=$1 AND nonce IN
          (SELECT nonce FROM auth_bridge_nonces WHERE app_id=$1 AND expires_at<$2 ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`, [deps.appId, new Date(current)]);
        const inserted = await client.query(`INSERT INTO auth_bridge_nonces(app_id,nonce,expires_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
          [deps.appId, proof.nonce, new Date(proof.at + windowMs)]);
        if (!inserted.rowCount) throw new AppError(409, 'COMPAT_BRIDGE_REPLAY', '请求凭证已使用，请重试');
        const result = await runCompatAction(client, proof.appId, proof.openid, proof.action, proof.body, proof.key, deps);
        if (proof.purpose === 'compat-read' && Buffer.byteLength(JSON.stringify(result)) > 2097152) {
          throw new AppError(409, 'QUERY_REQUIRES_NEW_CLIENT', '资料较多，请使用新版小程序分页查看');
        }
        active(); fresh(proof.at); return result;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof z.ZodError) throw new AppError(400, 'INVALID_INPUT', '请求格式不正确');
      throw unavailable();
    }
  };
}
