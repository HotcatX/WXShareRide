import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Identity } from '../auth/session.ts';
import { listMyRideRatings, rateRide } from './service.ts';

type Dependencies = { pool: Pool; requireUser: (request: FastifyRequest) => Promise<Identity> };
const noQuery = z.strictObject({});

export function registerRatingRoutes(app: FastifyInstance, { pool, requireUser }: Dependencies) {
  app.get<{ Params: { rideId: string } }>('/api/v1/rides/:rideId/ratings', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const user = await requireUser(request);
    noQuery.parse(request.query);
    return { ok: true, data: await listMyRideRatings(pool, user.id, request.params.rideId), requestId: request.id };
  });
  app.post<{ Params: { rideId: string } }>('/api/v1/rides/:rideId/ratings', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const user = await requireUser(request);
    noQuery.parse(request.query);
    const result = await rateRide(pool, user.id, request.headers['idempotency-key'], request.params.rideId, request.body);
    return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
  });
}
