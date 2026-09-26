import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Identity } from '../auth/session.ts';
import { getRideParticipants, listMyRides } from './participants.ts';

type Dependencies = { pool: Pool; requireUser: (request: FastifyRequest) => Promise<Identity> };
const noQuery = z.strictObject({});

export function registerPrivateRideRoutes(app: FastifyInstance, { pool, requireUser }: Dependencies) {
  app.get<{ Params: { rideId: string } }>('/api/v1/rides/:rideId/participants', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const user = await requireUser(request);
    noQuery.parse(request.query);
    return { ok: true, data: await getRideParticipants(pool, user.id, request.params.rideId), requestId: request.id };
  });
  app.get('/api/v1/me/rides', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const user = await requireUser(request);
    return { ok: true, data: await listMyRides(pool, user.id, request.query), requestId: request.id };
  });
}
