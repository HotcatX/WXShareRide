import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { Pool } from 'pg';
import type { Config } from './config.ts';
import { AppError } from './errors.ts';
import { sessionService } from './auth/session.ts';
import { wechatCodeExchange } from './auth/wechat.ts';
import type { CodeExchange } from './auth/wechat.ts';
import { registerUserRoutes } from './users/routes.ts';
import { registerRideRoutes } from './rides/routes.ts';
import { registerPrivateRideRoutes } from './rides/private-routes.ts';
import { createLoginAdmission } from './auth/admission.ts';
import { registerTemplateRoutes } from './templates/routes.ts';
import { registerNotificationRoutes } from './notifications/routes.ts';
import { registerBlockRoutes } from './blocks/routes.ts';
import { registerRatingRoutes } from './ratings/routes.ts';
import { registerStatisticsRoutes } from './statistics/routes.ts';
import { registerReferralRoutes } from './referrals/routes.ts';
import { registerAdminRoutes } from './admin/routes.ts';

export async function createApp(deps: { config: Config; pool: Pool; exchange?: CodeExchange }) {
  const app = Fastify({ bodyLimit: 65536, requestTimeout: 15000, logger: false, genReqId: () => randomUUID() });
  const sessions = sessionService(deps.pool, deps.config, deps.exchange ?? wechatCodeExchange(deps.config.appId, deps.config.appSecret));
  const loginAdmission = createLoginAdmission();
  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof AppError;
    const invalid = error instanceof ZodError;
    const parserStatus = (error as { statusCode?: number }).statusCode;
    const status = known ? error.status : invalid || parserStatus === 400 ? 400 : parserStatus === 413 ? 413 : parserStatus === 415 ? 415 : 500;
    if (status === 429) reply.header('Retry-After', '60');
    // Request bodies, headers, tokens, DB errors and external URLs never enter logs.
    if (status >= 500) process.stderr.write(`${JSON.stringify({ level: 'error', requestId: request.id, code: known ? error.code : 'INTERNAL_ERROR' })}\n`);
    return reply.code(status).send({ ok: false, error: {
      code: known ? error.code : status === 400 ? 'INVALID_INPUT' : status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'INTERNAL_ERROR',
      message: known ? error.message : status === 400 ? '请求格式不正确' : status === 413 ? '请求过大' : status === 415 ? '请使用 JSON 请求' : '服务暂不可用'
    }, requestId: request.id });
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.split('?')[0].startsWith('/api/v1/admin/')) {
      reply.header('Cache-Control', 'private, no-store').header('Vary', 'Origin').header('X-Content-Type-Options', 'nosniff');
    }
    return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '接口不存在' }, requestId: request.id });
  });
  app.get('/healthz', async request => {
    await deps.pool.query('SELECT 1');
    return { ok: true, data: { status: 'ready' }, requestId: request.id };
  });
  app.post('/api/v1/auth/login', async request => {
    const input = z.strictObject({ code: z.string().min(1).max(256) }).parse(request.body);
    return { ok: true, data: await loginAdmission.run(request.ip, () => sessions.login(input.code)), requestId: request.id };
  });
  app.post('/api/v1/auth/logout', async request => {
    await sessions.logout(request);
    return { ok: true, data: {}, requestId: request.id };
  });
  await registerUserRoutes(app, { pool: deps.pool, requireUser: sessions.requireUser });
  await registerRideRoutes(app, { pool: deps.pool, requireUser: sessions.requireUser });
  registerPrivateRideRoutes(app, { pool: deps.pool, requireUser: sessions.requireUser });
  await registerTemplateRoutes(app, { pool: deps.pool, requireUser: sessions.requireUser });
  registerNotificationRoutes(app, { pool: deps.pool, requireUser: sessions.requireUser });
  registerBlockRoutes(app, { pool: deps.pool, requireUser: sessions.requireUser });
  registerRatingRoutes(app, { pool: deps.pool, requireUser: sessions.requireUser });
  registerStatisticsRoutes(app, { pool: deps.pool, appId: deps.config.appId, requireUser: sessions.requireUser });
  registerReferralRoutes(app, { pool: deps.pool, requireUser: sessions.requireUser });
  registerAdminRoutes(app, { pool: deps.pool, appId: deps.config.appId });
  return app;
}
