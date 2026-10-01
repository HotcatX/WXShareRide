import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { AppError } from '../errors.ts';
import { collectionProtocol as protocol } from '../analytics/protocol.ts';
import { adminHttpGuard } from './routes.ts';
import { requireSuperAdmin } from './service.ts';
import { createAdminMonitor } from './monitor.ts';
import type { RequestCounter } from './traffic.ts';
import { editConsoleRow, getConsoleRow, listConsoleRows, listConsoleTables } from './data.ts';

const eventQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().max(768).optional(), openid: z.string().trim().min(1).max(160).optional(),
  from: z.coerce.number().int().nonnegative().optional(), to: z.coerce.number().int().nonnegative().optional(),
  type: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/).optional() });
export function registerAdminConsoleRoutes(app: FastifyInstance, deps: { pool: Pool; appId: string; config: Config; traffic?: RequestCounter }): void {
  const monitor = createAdminMonitor(deps.config.adminMonitor, deps.traffic);
  app.register(async scope => {
    scope.addHook('onRequest', adminHttpGuard(deps));
    scope.get('/api/v1/admin/console/status', async request => {
      await requireSuperAdmin(deps.pool, deps.appId, request.headers.authorization);
      z.strictObject({}).parse(request.query);
      return { ok: true, data: await monitor.status(), requestId: request.id };
    });
    scope.get('/api/v1/admin/console/history', async request => {
      await requireSuperAdmin(deps.pool, deps.appId, request.headers.authorization);
      const { range } = z.strictObject({ range: z.enum(['day', 'week', 'month']) }).parse(request.query);
      return { ok: true, data: await monitor.history(range), requestId: request.id };
    });
    scope.get('/api/v1/admin/console/tables', async request => {
      const actor = await requireSuperAdmin(deps.pool, deps.appId, request.headers.authorization);
      z.strictObject({}).parse(request.query);
      return { ok: true, data: await listConsoleTables(deps.pool, actor), requestId: request.id };
    });
    scope.get('/api/v1/admin/console/rows', async request => {
      const actor = await requireSuperAdmin(deps.pool, deps.appId, request.headers.authorization);
      return { ok: true, data: await listConsoleRows(deps.pool, actor, request.query), requestId: request.id };
    });
    scope.get<{ Params: { table: string; id: string } }>('/api/v1/admin/console/rows/:table/:id', async request => {
      const actor = await requireSuperAdmin(deps.pool, deps.appId, request.headers.authorization);
      z.strictObject({}).parse(request.query);
      return { ok: true, data: await getConsoleRow(deps.pool, actor, request.params.table, request.params.id), requestId: request.id };
    });
    scope.post<{ Params: { table: string; id: string } }>('/api/v1/admin/console/rows/:table/:id/edit', async (request, reply) => {
      const actor = await requireSuperAdmin(deps.pool, deps.appId, request.headers.authorization);
      const result = await editConsoleRow(deps.pool, actor, request.params.table, request.params.id, request.headers['idempotency-key'], request.body);
      return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
    });
    scope.get('/api/v1/admin/console/events', async request => {
      await requireSuperAdmin(deps.pool, deps.appId, request.headers.authorization);
      const { openid: search, ...query } = eventQuery.parse(request.query);
      let subject: string | undefined;
      if (search) {
        const user = (await deps.pool.query<{ openid: string }>('SELECT openid FROM users WHERE app_id=$1 AND (id::text=$2 OR openid=$2) LIMIT 1', [deps.appId, search])).rows[0];
        const openid = user?.openid ?? search;
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(openid)) throw new AppError(400, 'CONSOLE_USER_NOT_FOUND', '请输入有效的账号 ID 或 OpenID');
        if (!deps.config.collector?.subjectKey) throw new AppError(503, 'ADMIN_MONITOR_UNAVAILABLE', '采集查询暂不可用');
        subject = createHmac('sha256', deps.config.collector.subjectKey).update(`${protocol.subject}\n${deps.appId}\n${openid}`).digest('hex');
      }
      return { ok: true, data: await monitor.events({ ...query, ...(subject ? { subject } : {}) }), requestId: request.id };
    });
  });
}
