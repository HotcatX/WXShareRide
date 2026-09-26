import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { AppError } from '../errors.ts';
import { checkAdminOrigin, getAdminSession, loginAdmin, logoutAdmin, requireAdmin } from './service.ts';

/** Reuse this hook on future admin route scopes so parser/auth failures stay private. */
export function adminHttpGuard(deps: { pool: Pool; appId: string }) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Origin').header('X-Content-Type-Options', 'nosniff');
    const origin = await checkAdminOrigin(deps.pool, deps.appId, request.headers.origin);
    reply.header('Access-Control-Allow-Origin', origin);
    if (request.method === 'OPTIONS') {
      const method = request.headers['access-control-request-method'];
      const headers = request.headers['access-control-request-headers'];
      if (typeof method !== 'string' || !['GET', 'POST'].includes(method) ||
        (headers !== undefined && (typeof headers !== 'string' || headers.split(',').some(value =>
          !['authorization', 'content-type', 'idempotency-key'].includes(value.trim().toLowerCase()))))) {
        throw new AppError(403, 'ADMIN_CORS_NOT_ALLOWED', '请求方式尚未获得访问授权');
      }
      reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        .header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key')
        .header('Access-Control-Max-Age', '600');
    }
  };
}

export function registerAdminRoutes(app: FastifyInstance, deps: { pool: Pool; appId: string }): void {
  app.register(async scope => {
    scope.addHook('onRequest', adminHttpGuard(deps));
    scope.options('/api/v1/admin/*', async (_request, reply) => reply.code(204).send());
    scope.post('/api/v1/admin/auth/login', async request => ({ ok: true,
      data: await loginAdmin(deps.pool, deps.appId, request.body), requestId: request.id }));
    scope.get('/api/v1/admin/session', async request => {
      const identity = await requireAdmin(deps.pool, deps.appId, request.headers.authorization);
      return { ok: true, data: await getAdminSession(deps.pool, identity), requestId: request.id };
    });
    scope.post('/api/v1/admin/auth/logout', async request => {
      const identity = await requireAdmin(deps.pool, deps.appId, request.headers.authorization);
      await logoutAdmin(deps.pool, identity);
      return { ok: true, data: {}, requestId: request.id };
    });
  });
}
