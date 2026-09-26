import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { adminHttpGuard } from './routes.ts';
import { requireAdmin } from './service.ts';
import { bulkCreateAdminMarketListings, createAdminMarketListing, getAdminMarketListing, updateAdminMarketListing } from './market.ts';

/** Canonical UUID-file API, not a drop-in adapter for the deployed web client.
 * registerAdminRoutes owns the shared /api/v1/admin/* OPTIONS route. */
export function registerAdminMarketRoutes(app: FastifyInstance, deps: { pool: Pool; appId: string }): void {
  app.register(async scope => {
    scope.addHook('onRequest', adminHttpGuard(deps));
    scope.post('/api/v1/admin/market/listings', async (request, reply) => {
      const actor = await requireAdmin(deps.pool, deps.appId, request.headers.authorization);
      const result = await createAdminMarketListing(deps.pool, actor, request.headers['idempotency-key'], request.body);
      return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
    });
    scope.get<{ Params: { id: string } }>('/api/v1/admin/market/listings/:id', async request => {
      const actor = await requireAdmin(deps.pool, deps.appId, request.headers.authorization);
      z.strictObject({}).parse(request.query);
      return { ok: true, data: await getAdminMarketListing(deps.pool, actor, request.params.id), requestId: request.id };
    });
    scope.post<{ Params: { id: string } }>('/api/v1/admin/market/listings/:id/edit', async (request, reply) => {
      const actor = await requireAdmin(deps.pool, deps.appId, request.headers.authorization);
      const result = await updateAdminMarketListing(deps.pool, actor, request.headers['idempotency-key'], request.params.id, request.body);
      return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
    });
    scope.post('/api/v1/admin/market/batches', async request => {
      const actor = await requireAdmin(deps.pool, deps.appId, request.headers.authorization);
      return { ok: true, data: await bulkCreateAdminMarketListings(deps.pool, actor, request.body), requestId: request.id };
    });
  });
}
