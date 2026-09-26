import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Identity } from '../auth/session.ts';
import { createListing, deleteListing, setListingStatus, updateListing } from './service.ts';
import { getMarketListing, listMarketListings, listMyMarketListings, listSellerMarketListings } from './read.ts';

type Dependencies = { pool: Pool; appId: string; requireUser: (request: FastifyRequest) => Promise<Identity> };

/** Not a legacy marketApi adapter. Clients still need UUID image/URL and DTO
 * adaptation before these routes can replace the deployed cloud calls. */
export function registerMarketRoutes(app: FastifyInstance, { pool, appId, requireUser }: Dependencies) {
  const optionalUser = (request: FastifyRequest) => request.headers.authorization === undefined ? undefined : requireUser(request);
  app.get('/api/v1/market/listings', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization');
    const user = await optionalUser(request);
    return { ok: true, data: await listMarketListings(pool, appId, request.query, user?.id), requestId: request.id };
  });
  app.get<{ Params: { id: string } }>('/api/v1/market/listings/:id', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization');
    const user = await optionalUser(request);
    z.strictObject({}).parse(request.query);
    return { ok: true, data: await getMarketListing(pool, appId, request.params.id, user?.id), requestId: request.id };
  });
  app.get('/api/v1/me/market/listings', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const user = await requireUser(request);
    return { ok: true, data: await listMyMarketListings(pool, appId, user.id, request.query), requestId: request.id };
  });
  app.get<{ Params: { sellerId: string } }>('/api/v1/market/sellers/:sellerId/listings', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization');
    const user = await optionalUser(request);
    return { ok: true, data: await listSellerMarketListings(pool, appId, request.params.sellerId, request.query, user?.id), requestId: request.id };
  });
  app.post('/api/v1/market/listings', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const user = await requireUser(request);
    const result = await createListing(pool, user.id, request.headers['idempotency-key'], request.body);
    return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
  });
  for (const [method, path, handler] of [
    ['PATCH', '/api/v1/market/listings/:id', updateListing],
    ['POST', '/api/v1/market/listings/:id/status', setListingStatus],
    ['DELETE', '/api/v1/market/listings/:id', deleteListing],
  ] as const) {
    app.route<{ Params: { id: string } }>({ method, url: path, handler: async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const user = await requireUser(request);
      const result = await handler(pool, user.id, request.headers['idempotency-key'], request.params.id, request.body);
      return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
    } });
  }
}
