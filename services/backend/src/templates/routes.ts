import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { createTemplate, deleteTemplate, listTemplates, updateTemplate } from './service.ts';

type Dependencies = { pool: Pool; requireUser: (request: FastifyRequest) => Promise<{ id: string; openid: string }> };

export function registerTemplateRoutes(app: FastifyInstance, { pool, requireUser }: Dependencies) {
  app.get('/api/v1/templates', async request => {
    const user = await requireUser(request);
    return { ok: true, data: await listTemplates(pool, user.id, request.query), requestId: request.id };
  });
  app.post('/api/v1/templates', async (request, reply) => {
    const user = await requireUser(request);
    const result = await createTemplate(pool, user.id, request.headers['idempotency-key'], request.body);
    return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
  });
  app.patch<{ Params: { id: string } }>('/api/v1/templates/:id', async (request, reply) => {
    const user = await requireUser(request);
    const result = await updateTemplate(pool, user.id, request.headers['idempotency-key'], request.params.id, request.body);
    return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
  });
  app.delete<{ Params: { id: string } }>('/api/v1/templates/:id', async (request, reply) => {
    const user = await requireUser(request);
    z.strictObject({}).parse(request.body ?? {});
    const result = await deleteTemplate(pool, user.id, request.headers['idempotency-key'], request.params.id);
    return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
  });
}
