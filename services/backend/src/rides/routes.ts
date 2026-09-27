import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { cancelRide, createRide, getRide, joinRide, leaveRide, listRides, removeRideMember } from './service.ts';
import { rideCalendar } from './read.ts';
import { getRidePreview, listRidePreviews } from './preview.ts';
import { z } from 'zod';

type Dependencies = {
  pool: Pool;
  appId?: string;
  requireUser: (request: FastifyRequest) => Promise<{ id: string; openid: string }>;
};

export function registerRideRoutes(app: FastifyInstance, { pool, appId, requireUser }: Dependencies) {
  if (appId) {
    app.get('/api/v1/previews/rides', async request => ({ ok: true,
      data: await listRidePreviews(pool, appId, request.query), requestId: request.id }));
    app.get<{ Params: { rideId: string } }>('/api/v1/previews/rides/:rideId', async request => {
      z.strictObject({}).parse(request.query);
      return { ok: true, data: await getRidePreview(pool, appId, request.params.rideId), requestId: request.id };
    });
  }
  const viewer = async (request: FastifyRequest) => request.headers.authorization === undefined ? undefined : (await requireUser(request)).id;
  app.get('/api/v1/rides', async (request, reply) => {
    reply.header('Vary', 'Authorization');
    return { ok: true, data: await listRides(pool, request.query, await viewer(request), appId), requestId: request.id };
  });
  app.get('/api/v1/rides/calendar', async (request, reply) => {
    reply.header('Vary', 'Authorization');
    return { ok: true, data: await rideCalendar(pool, request.query, await viewer(request), appId), requestId: request.id };
  });
  app.get<{ Params: { rideId: string } }>('/api/v1/rides/:rideId', async request => ({
    ok: true, data: await getRide(pool, request.params.rideId, appId), requestId: request.id,
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
  app.post<{ Params: { rideId: string; memberId: string } }>('/api/v1/rides/:rideId/members/:memberId/remove', async (request, reply) => {
    const user = await requireUser(request);
    const result = await removeRideMember(pool, user.id, request.headers['idempotency-key'], request.params.rideId, request.params.memberId, request.body);
    return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
  });
}
