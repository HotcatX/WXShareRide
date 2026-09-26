import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { cancelRide, createRide, getRide, joinRide, leaveRide, listRides } from './service.ts';

type Dependencies = {
  pool: Pool;
  requireUser: (request: FastifyRequest) => Promise<{ id: string; openid: string }>;
};

export function registerRideRoutes(app: FastifyInstance, { pool, requireUser }: Dependencies) {
  app.get('/api/v1/rides', async request => ({ ok: true, data: await listRides(pool, request.query), requestId: request.id }));
  app.get<{ Params: { rideId: string } }>('/api/v1/rides/:rideId', async request => ({
    ok: true, data: await getRide(pool, request.params.rideId), requestId: request.id,
  }));
  app.post('/api/v1/rides', async (request, reply) => {
    const user = await requireUser(request);
    const result = await createRide(pool, user.id, request.headers['idempotency-key'], request.body);
    return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
  });
  for (const [action, handler] of Object.entries({ join: joinRide, leave: leaveRide, cancel: cancelRide })) {
    app.post<{ Params: { rideId: string } }>(`/api/v1/rides/:rideId/${action}`, async (request, reply) => {
      const user = await requireUser(request);
      const result = await handler(pool, user.id, request.headers['idempotency-key'], request.params.rideId, request.body);
      return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
    });
  }
}
