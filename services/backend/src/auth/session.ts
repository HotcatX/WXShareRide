import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../config.ts';
import { transaction } from '../db.ts';
import { AppError } from '../errors.ts';
import type { CodeExchange } from './wechat.ts';

export type Identity = { id: string; openid: string };
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
function bearer(request: FastifyRequest): string {
  const match = /^Bearer ([a-zA-Z0-9_-]{43})$/.exec(request.headers.authorization || '');
  if (!match) throw new AppError(401, 'UNAUTHORIZED', '请先登录');
  return match[1];
}

export function sessionService(pool: Pool, config: Config, exchange: CodeExchange) {
  return {
    async login(code: string) {
      const identity = await exchange(code);
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000);
      const user = await transaction(pool, async client => {
        const result = await client.query<Identity>(
          `INSERT INTO users(app_id,openid) VALUES($1,$2)
           ON CONFLICT(app_id,openid) DO UPDATE SET openid=EXCLUDED.openid RETURNING id,openid`,
          [config.appId, identity.openid]
        );
        await client.query('DELETE FROM sessions WHERE user_id=$1 AND expires_at<=now()', [result.rows[0].id]);
        await client.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [tokenHash(token), result.rows[0].id, expiresAt]);
        return result.rows[0];
      });
      return { token, expiresAt: expiresAt.toISOString(), user };
    },
    async requireUser(request: FastifyRequest): Promise<Identity> {
      const token = bearer(request);
      const result = await pool.query<Identity>(
        `SELECT u.id,u.openid FROM sessions s JOIN users u ON u.id=s.user_id
         WHERE s.token_hash=$1 AND s.expires_at>now() AND u.app_id=$2`, [tokenHash(token), config.appId]
      );
      if (!result.rows.length) throw new AppError(401, 'UNAUTHORIZED', '登录已过期，请重新登录');
      return result.rows[0];
    },
    async logout(request: FastifyRequest): Promise<void> {
      await pool.query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash(bearer(request))]);
    }
  };
}
