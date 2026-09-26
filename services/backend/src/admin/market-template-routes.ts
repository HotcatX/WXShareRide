import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { adminHttpGuard } from './routes.ts';
import { requireAdmin } from './service.ts';
import { deleteMarketTemplate, listMarketTemplates, saveMarketTemplate } from './market-templates.ts';

export function registerAdminMarketTemplateRoutes(app: FastifyInstance, deps: { pool: Pool; appId: string }): void {
  app.register(async scope => {
    scope.addHook('onRequest', adminHttpGuard(deps));
    scope.get('/api/v1/admin/market/templates', async request => {
      const actor = await requireAdmin(deps.pool, deps.appId, request.headers.authorization);
      z.strictObject({}).parse(request.query);
      return { ok: true, data: await listMarketTemplates(deps.pool, actor), requestId: request.id };
    });
    scope.post('/api/v1/admin/market/templates', async (request, reply) => {
      const actor = await requireAdmin(deps.pool, deps.appId, request.headers.authorization);
      z.strictObject({}).parse(request.query);
      const result = await saveMarketTemplate(deps.pool, actor, request.headers['idempotency-key'], request.body);
      return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
    });
    scope.post<{ Params: { id: string } }>('/api/v1/admin/market/templates/:id/delete', async (request, reply) => {
      const actor = await requireAdmin(deps.pool, deps.appId, request.headers.authorization);
      z.strictObject({}).parse(request.query);
      z.strictObject({}).optional().parse(request.body);
      const result = await deleteMarketTemplate(deps.pool, actor, request.headers['idempotency-key'], request.params.id);
      return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
    });
  });
}
