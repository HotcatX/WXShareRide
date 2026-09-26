import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { blockUser, listBlocks, unblockUser } from './service.ts';

type Dependencies = { pool: Pool; requireUser: (request: FastifyRequest) => Promise<{ id: string; openid: string }> };

export function registerBlockRoutes(app: FastifyInstance, { pool, requireUser }: Dependencies) {
  app.get('/api/v1/blocks', async request => {
    const user = await requireUser(request);
    return { ok: true, data: await listBlocks(pool, user.id, request.query), requestId: request.id };
  });
  app.post('/api/v1/blocks', async (request, reply) => {
    const user = await requireUser(request);
    const result = await blockUser(pool, user.id, request.headers['idempotency-key'], request.body);
    return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
  });
  app.delete<{ Params: { targetUserId: string } }>('/api/v1/blocks/:targetUserId', async (request, reply) => {
    const user = await requireUser(request);
    z.strictObject({}).parse(request.body ?? {});
    const result = await unblockUser(pool, user.id, request.headers['idempotency-key'], request.params.targetUserId);
    return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
  });
}
