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
import { registerMarketRoutes } from './market/routes.ts';
import { registerCommunityRoutes } from './community/routes.ts';
import { registerAdminMarketRoutes } from './admin/market-routes.ts';
import { registerAdminMarketTemplateRoutes } from './admin/market-template-routes.ts';
import { registerAdRoutes } from './ads/routes.ts';
import { registerFileRoutes } from './files/routes.ts';
import type { FileStorage } from './files/routes.ts';
import { cloudBaseLoginPath, createCloudBaseLoginBridge } from './auth/cloudbase.ts';
import { registerLocationRoutes } from './locations/routes.ts';
import { registerCityRequestRoutes } from './locations/requests.ts';
import { createCollectionSessions } from './analytics/session.ts';
import { compatBridgePath, createCompatBridge } from './compat/bridge.ts';
import { registerLegacyPublicRoutes } from './compat/public-preview.ts';

export async function createApp(deps: { config: Config; pool: Pool; exchange?: CodeExchange; storage?: FileStorage; collectorTransport?: typeof fetch }) {
  const app = Fastify({ bodyLimit: 65536, requestTimeout: 15000, logger: false, genReqId: () => randomUUID() });
  const sessions = sessionService(deps.pool, deps.config, deps.exchange ?? wechatCodeExchange(deps.config.appId, deps.config.appSecret));
  const loginAdmission = createLoginAdmission();
  // One deployment state protects the empty first-import database, including
  // apparently read-only endpoints that record views or ensure user identities.
  // Activation is an explicit deployment after the final import and old-writer
  // handoff, never an automatic fallback after a failed request.
  const isActive = () => deps.config.businessMode === 'active';
  app.addHook('onRequest', async (request, reply) => {
    // The router decodes escaped static segments; checking only the raw URL
    // would let /%61pi/v1/auth/login bypass staging and create real accounts.
    const path = request.routeOptions.url ?? request.url.split('?')[0];
    if (path.startsWith('/api/v1/') || path.startsWith('/internal/v1/')) {
      reply.header('Cache-Control', 'private, no-store');
      if (!isActive()) throw new AppError(503, 'BACKEND_STAGED', '服务正在准备中，请稍后重试');
    }
  });
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
  if (deps.config.authBridgeKey) {
    const compat = createCompatBridge({ pool: deps.pool, appId: deps.config.appId, key: deps.config.authBridgeKey, isActive });
    app.register(async scope => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 69632 }, (_request, body, done) => done(null, body));
      scope.post(compatBridgePath, { bodyLimit: 69632 }, request => compat({
        method: request.method, path: request.url, rawHeaders: request.raw.rawHeaders, body: request.body as Buffer }));
    });
    const bridge = createCloudBaseLoginBridge({ pool: deps.pool, appId: deps.config.appId,
      key: deps.config.authBridgeKey, sessionTtlSeconds: deps.config.sessionTtlSeconds, isActive });
    app.register(async scope => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1024 },
        (_request, body, done) => done(null, body));
      scope.post(cloudBaseLoginPath, { bodyLimit: 1024 }, async request => ({ ok: true,
        data: await loginAdmission.run(request.ip, () => bridge.login({ method: request.method,
          path: request.url, rawHeaders: request.raw.rawHeaders, body: request.body as Buffer })), requestId: request.id }));
    });
  }
  app.post('/api/v1/auth/login', async request => {
    const input = z.strictObject({ code: z.string().min(1).max(256) }).parse(request.body);
    return { ok: true, data: await loginAdmission.run(request.ip, () => sessions.login(input.code)), requestId: request.id };
  });
  app.post('/api/v1/auth/logout', async request => {
    await sessions.logout(request);
    return { ok: true, data: {}, requestId: request.id };
  });
  const collectionSession = createCollectionSessions(deps.config, deps.collectorTransport);
  app.post('/api/v1/analytics/session', async request => {
    const user = await sessions.requireUser(request);
    return { ok: true, data: await collectionSession(user, request.body), requestId: request.id };
  });
  await registerUserRoutes(app, { pool: deps.pool, requireUser: sessions.requireUser });
  await registerRideRoutes(app, { pool: deps.pool, appId: deps.config.appId, requireUser: sessions.requireUser });
  registerPrivateRideRoutes(app, { pool: deps.pool, requireUser: sessions.requireUser });
  await registerTemplateRoutes(app, { pool: deps.pool, requireUser: sessions.requireUser });
  registerNotificationRoutes(app, { pool: deps.pool, requireUser: sessions.requireUser });
  registerBlockRoutes(app, { pool: deps.pool, requireUser: sessions.requireUser });
  registerRatingRoutes(app, { pool: deps.pool, requireUser: sessions.requireUser });
  registerStatisticsRoutes(app, { pool: deps.pool, appId: deps.config.appId, requireUser: sessions.requireUser });
  registerReferralRoutes(app, { pool: deps.pool, requireUser: sessions.requireUser });
  registerAdminRoutes(app, { pool: deps.pool, appId: deps.config.appId });
  registerMarketRoutes(app, { pool: deps.pool, appId: deps.config.appId, requireUser: sessions.requireUser });
  registerCommunityRoutes(app, { pool: deps.pool, appId: deps.config.appId });
  registerAdminMarketRoutes(app, { pool: deps.pool, appId: deps.config.appId });
  registerAdminMarketTemplateRoutes(app, { pool: deps.pool, appId: deps.config.appId });
  registerAdRoutes(app, { pool: deps.pool, appId: deps.config.appId, requireUser: sessions.requireUser });
  registerFileRoutes(app, { pool: deps.pool, appId: deps.config.appId, requireUser: sessions.requireUser, storage: deps.storage });
  registerLocationRoutes(app);
  registerCityRequestRoutes(app, { pool: deps.pool, requireUser: sessions.requireUser });
  registerLegacyPublicRoutes(app, { pool: deps.pool, appId: deps.config.appId, storage: deps.storage,
    publicWebSecret: deps.config.legacyPublic?.secret, houseShareOrigins: deps.config.legacyPublic?.houseShareOrigins,
    houseShareCurrency: deps.config.legacyPublic?.houseShareCurrency });
  return app;
}
