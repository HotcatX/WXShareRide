import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Identity } from '../auth/session.ts';
import { getUser, updateUser } from './service.ts';

export async function registerUserRoutes(app: FastifyInstance, deps: { pool: Pool; requireUser: (request: FastifyRequest) => Promise<Identity> }) {
  app.get('/api/v1/me', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const identity = await deps.requireUser(request);
    return { ok: true, data: await getUser(deps.pool, identity.id), requestId: request.id };
  });
  app.patch('/api/v1/me', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const identity = await deps.requireUser(request);
    const result = await updateUser(deps.pool, identity.id, request.headers['idempotency-key'], request.body);
    return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
  });
}
