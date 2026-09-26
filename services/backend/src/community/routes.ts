import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { adminHttpGuard } from '../admin/routes.ts';
import { requireAdmin } from '../admin/service.ts';
import { getAdminCommunity, getCommunity, updateCommunity } from './service.ts';

export function registerCommunityRoutes(app: FastifyInstance, deps: { pool: Pool; appId: string }) {
  app.get('/api/v1/community', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    z.strictObject({}).parse(request.query);
    return { ok: true, data: await getCommunity(deps.pool, deps.appId), requestId: request.id };
  });
  app.register(async scope => {
    scope.addHook('onRequest', adminHttpGuard(deps));
    scope.get('/api/v1/admin/community', async request => {
      const identity = await requireAdmin(deps.pool, deps.appId, request.headers.authorization);
      z.strictObject({}).parse(request.query);
      return { ok: true, data: await getAdminCommunity(deps.pool, identity), requestId: request.id };
    });
    scope.post('/api/v1/admin/community', async (request, reply) => {
      const identity = await requireAdmin(deps.pool, deps.appId, request.headers.authorization);
      const result = await updateCommunity(deps.pool, identity, request.headers['idempotency-key'], request.body);
      return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
    });
  });
}
