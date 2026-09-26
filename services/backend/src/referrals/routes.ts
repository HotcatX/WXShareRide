import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { bindReferral, getMyReferral } from './service.ts';

type Dependencies = { pool: Pool; requireUser: (request: FastifyRequest) => Promise<{ id: string; openid: string }> };

export function registerReferralRoutes(app: FastifyInstance, { pool, requireUser }: Dependencies) {
  app.get('/api/v1/referrals/me', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const user = await requireUser(request);
    z.strictObject({}).parse(request.query);
    return { ok: true, data: await getMyReferral(pool, user.id), requestId: request.id };
  });
  app.post('/api/v1/referrals/bind', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const user = await requireUser(request);
    const result = await bindReferral(pool, user.id, request.headers['idempotency-key'], request.body);
    return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
  });
}
