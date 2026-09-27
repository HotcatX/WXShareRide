import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Identity } from '../auth/session.ts';
import { publicStatistics, userStatistics } from './service.ts';
import { legacyPublicStatistics } from '../compat/public-statistics.ts';

const noQuery = z.strictObject({});
type Dependencies = { pool: Pool; appId: string; requireUser: (request: FastifyRequest) => Promise<Identity> };

export function registerStatisticsRoutes(app: FastifyInstance, { pool, appId, requireUser }: Dependencies) {
  app.get('/api/v1/me/statistics', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const user = await requireUser(request);
    noQuery.parse(request.query);
    return { ok: true, data: await userStatistics(pool, user.id), requestId: request.id };
  });
  app.get('/api/v1/statistics/public', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    noQuery.parse(request.query);
    return { ok: true, data: await publicStatistics(pool, appId), requestId: request.id };
  });
  // Final cutover rewrites the old public URL to this exact route. It remains
  // under the existing staged guard; no cache, cloud read or sync writer here.
  app.get('/api/v1/statistics/legacy', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    noQuery.parse(request.query);
    const acquiredAt = Date.now();
    return legacyPublicStatistics(await publicStatistics(pool, appId), acquiredAt);
  });
}
