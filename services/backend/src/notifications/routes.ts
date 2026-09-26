import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { clearNotifications, listNotifications, markAllNotificationsRead, markNotificationRead, unreadNotifications } from './service.ts';

export function registerNotificationRoutes(app: FastifyInstance, deps: {
  pool: Pool; requireUser: (request: FastifyRequest) => Promise<{ id: string }>;
}) {
  app.get('/api/v1/notifications', async request => {
    const user = await deps.requireUser(request);
    return { ok: true, data: await listNotifications(deps.pool, user.id, request.query), requestId: request.id };
  });
  app.get('/api/v1/notifications/unread', async request => {
    const user = await deps.requireUser(request);
    return { ok: true, data: await unreadNotifications(deps.pool, user.id), requestId: request.id };
  });
  app.post<{ Params: { id: string } }>('/api/v1/notifications/:id/read', async request => {
    const user = await deps.requireUser(request);
    const result = await markNotificationRead(deps.pool, user.id, request.headers['idempotency-key'], request.params.id, request.body);
    return { ok: true, data: result.data, requestId: request.id };
  });
  app.post('/api/v1/notifications/read-all', async request => {
    const user = await deps.requireUser(request);
    const result = await markAllNotificationsRead(deps.pool, user.id, request.headers['idempotency-key'], request.body);
    return { ok: true, data: result.data, requestId: request.id };
  });
  app.delete('/api/v1/notifications', async request => {
    const user = await deps.requireUser(request);
    const result = await clearNotifications(deps.pool, user.id, request.headers['idempotency-key'], request.body);
    return { ok: true, data: result.data, requestId: request.id };
  });
}
