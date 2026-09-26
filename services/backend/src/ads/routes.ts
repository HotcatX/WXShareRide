import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Identity } from '../auth/session.ts';
import { z } from 'zod';
import { listAds, recordAdClick } from './service.ts';

type Dependencies = { pool: Pool; appId: string; requireUser: (request: FastifyRequest) => Promise<Identity> };

/** Guest display is public. Clicks use the existing verified WeChat session;
 * this does not mint an anonymous identity or replace legacy guest tracking. */
export function registerAdRoutes(app: FastifyInstance, { pool, appId, requireUser }: Dependencies) {
  app.get('/api/v1/ads', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { ok: true, data: await listAds(pool, appId, request.query), requestId: request.id };
  });
  app.post<{ Params: { id: string } }>('/api/v1/ads/:id/clicks', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const user = await requireUser(request);
    z.strictObject({}).parse(request.query);
    const result = await recordAdClick(pool, user.id, request.headers['idempotency-key'], request.params.id, request.body);
    return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
  });
}
