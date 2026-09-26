import { TABLES } from './compat/legacy.mjs';
import http from 'node:http';
import net from 'node:net';
import { mkdirSync, chmodSync, existsSync, lstatSync, unlinkSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { TextDecoder } from 'node:util';
import { openStore } from './store.mjs';
import { createTokenService, sameSecret } from './auth.mjs';
import { ApiError, requireThat } from './errors.mjs';
import { readSafeMetrics } from './metrics.mjs';
import { DIAGNOSTIC_ROUTE, readAccountDiagnostics } from './diagnostics.mjs';
import { BRIDGE_ROUTE, DEFAULT_NOTICE_VERSION } from './compat/legacy.mjs';
import { isNoticeVersion, verifyBridgeRequest, validateParticipationRequest } from './bridge.mjs';
import { MAX_BYTES, validateBatch, validateState, validateTokenRequest, shape, purpose } from './validation.mjs';
import { PLACE_ROUTE, BUSINESS_ROUTE } from './places.mjs';

function reply(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(raw),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(raw);
}
async function readJSON(req, maxBytes = MAX_BYTES) {
  requireThat(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || ''), 415, 'JSON_REQUIRED');
  requireThat(!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity', 415, 'ENCODING_NOT_SUPPORTED');
  if (req.headers['content-length']) requireThat(Number(req.headers['content-length']) <= maxBytes, 413, 'BATCH_TOO_LARGE');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new ApiError(413, 'BATCH_TOO_LARGE');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  let decoded; let body;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw); body = JSON.parse(decoded); }
  catch { throw new ApiError(400, 'INVALID_JSON'); }
  // Reject duplicate keys / discarded hidden values before storing original bytes.
  requireThat(JSON.stringify(body) === decoded, 400, 'NON_CANONICAL_JSON');
  return { raw, body };
}
const bearer = req => {
  const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(req.headers.authorization || '');
  requireThat(match, 401, 'INVALID_TOKEN');
  return match[1];
};

function limiter(max, capacity = 4096) {
  const entries = new Map();
  return key => {
    const now = Date.now(); let entry = entries.get(key);
    if (!entry || entry.until <= now) {
      if (entries.size >= capacity) {
        for (const [oldKey, old] of entries) if (old.until <= now) entries.delete(oldKey);
        requireThat(entries.size < capacity, 429, 'RATE_LIMITED');
      }
      entry = { count: 0, until: now + 60_000 }; entries.set(key, entry);
    }
    requireThat(++entry.count <= max, 429, 'RATE_LIMITED');
  };
}

export function createCollector(config) {
  config = { noticeVersion: DEFAULT_NOTICE_VERSION, bridgeKey: null, ...config };
  requireThat(isNoticeVersion(config.noticeVersion), 500, 'INVALID_NOTICE_CONFIGURATION');
  requireThat(config.bridgeKey === null || (Buffer.isBuffer(config.bridgeKey) && config.bridgeKey.length === 32), 500, 'INVALID_BRIDGE_CONFIGURATION');
  requireThat(purpose(config.purposeVersion), 500, 'INVALID_PURPOSE_CONFIGURATION');
  const store = openStore(config.dbPath, config);
  const tokens = createTokenService(config.privatePem, config.token);
  const rateGlobal = limiter(600, 1); const rateParticipant = limiter(60);
  const wrap = handler => {
    // Separate public/admin capacity so stalled uploads cannot exhaust withdrawal slots.
    let inFlight = 0;
    return async (req, res) => {
    let counted = false;
    try {
      requireThat(inFlight < 64, 503, 'SERVER_BUSY'); inFlight++; counted = true;
      await handler(req, res);
    } catch (error) {
      const known = error instanceof ApiError;
      const storageBusy = error?.code?.startsWith('SQLITE_BUSY') || error?.code === 'SQLITE_FULL' || error?.code?.startsWith('SQLITE_IOERR');
      const status = known ? error.status : storageBusy ? 503 : 500;
      const code = known ? error.code : storageBusy ? 'STORAGE_UNAVAILABLE' : 'INTERNAL_ERROR';
      if ([429, 503].includes(status)) res.setHeader('Retry-After', '60');
      if (!res.headersSent && !res.destroyed) reply(res, status, { ok: false, error: code });
      // Deliberately never log request body, token, participant ID, query or IP.
      if (!known) process.stderr.write(JSON.stringify({ level: 'error', code }) + '\n');
    } finally { if (counted) inFlight--; }
    };
  };
  const bridgeGlobal = limiter(120, 1); const bridgeAccount = limiter(20);
  const bridgeHandler = wrap(async (req, res) => {
    requireThat(req.method === 'POST', 404, 'NOT_FOUND');
    requireThat(config.bridgeKey, 503, 'BRIDGE_DISABLED');
    const { raw, body } = await readJSON(req, 8192);
    const now = Date.now();
    const authenticated = verifyBridgeRequest(req, config.bridgeKey, raw, now);
    const request = validateParticipationRequest(body, config.purposeVersion, config.noticeVersion);
    // Only authenticated callers consume authorization capacity; batch capacity is separate.
    bridgeGlobal('bridge'); bridgeAccount(request.accountSubject);
    store.consumeBridgeNonce(authenticated.nonce, authenticated.expiresAt, now);
    const { participant, ...response } = store.participate(request, now);
    if (participant) response.session = {
      participantKey: participant.participantKey, grantId: participant.grantId,
      statusVersion: participant.statusVersion, status: 'active', confirmed: true,
      purposeVersion: participant.purposeVersion, acceptedPurposeVersion: participant.purposeVersion,
      ...tokens.issue(participant),
    };
    reply(res, 200, response);
  });
  const batchHandler = wrap(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      store.db.prepare('SELECT 1').get(); return reply(res, 200, { ok: true, service: 'analytics-collector' });
    }
    requireThat(req.method === 'POST' && ['/v1/batches', PLACE_ROUTE].includes(req.url), 404, 'NOT_FOUND');
    rateGlobal('global');
    const claims = tokens.verify(bearer(req)); rateParticipant(claims.sub);
    const { raw, body } = await readJSON(req);
    if (req.url === PLACE_ROUTE) {
      const fs = statfsSync(dirname(config.dbPath));
      requireThat(fs.bavail * fs.bsize >= config.minFreeBytes, 503, 'STORAGE_UNAVAILABLE');
      return reply(res, 200, store.placeSuggestions(tokens.verify(bearer(req)), body));
    }
    requireThat(!claims.scopes || claims.scopes.includes('batches:write'), 403, 'BATCH_SCOPE_REQUIRED');
    validateBatch(body, Date.now(), false);
    const fs = statfsSync(dirname(config.dbPath));
    requireThat(fs.bavail * fs.bsize >= config.minFreeBytes, 503, 'STORAGE_UNAVAILABLE');
    // Token expiry is checked again after receiving a potentially slow request body.
    tokens.verify(bearer(req));
    reply(res, 200, store.receive(claims, raw, body));
  });
  const businessHandler = wrap(async (req, res) => {
    requireThat(req.method === 'POST', 404, 'NOT_FOUND');
    const { raw, body } = await readJSON(req, 131_072);
    const now = Date.now(); const authenticated = verifyBridgeRequest(req, config.bridgeKey, raw, now);
    bridgeGlobal('bridge'); store.consumeBridgeNonce(authenticated.nonce, authenticated.expiresAt, now);
    const fs = statfsSync(dirname(config.dbPath));
    requireThat(fs.bavail * fs.bsize >= config.minFreeBytes, 503, 'STORAGE_UNAVAILABLE');
    reply(res, 200, store.places.ingestBusiness(body, now));
  });
  const publicServer = http.createServer({ maxHeaderSize: 8192 }, (req, res) =>
    req.url === BRIDGE_ROUTE ? bridgeHandler(req, res) : req.url === BUSINESS_ROUTE ? businessHandler(req, res) : batchHandler(req, res));
  const adminServer = http.createServer({ maxHeaderSize: 8192 }, wrap(async (req, res) => {
    requireThat(/^Bearer [A-Za-z0-9_-]+$/.test(req.headers.authorization || '')
      && sameSecret(req.headers.authorization.slice(7), config.adminToken), 401, 'ADMIN_UNAUTHORIZED');
    if (req.method === 'GET' && req.url === '/v1/status') {
      return reply(res, 200, { ok: true, realCollectionEnabled: config.realEnabled,
        restoreGate: store.db.prepare("SELECT value FROM collector_settings WHERE key='restore_gate'").get().value,
        sqliteVersion: store.sqliteVersion,
        participants: store.db.prepare(`SELECT COUNT(*) AS n FROM ${TABLES.participants}`).get().n,
        batches: store.db.prepare('SELECT COUNT(*) AS n FROM ingest_batches').get().n,
        ...readSafeMetrics(store.db) });
    }
    if (req.method === 'GET' && req.url === '/v1/places/status') return reply(res, 200, store.places.status());
    requireThat(req.method === 'POST', 404, 'NOT_FOUND');
    if (req.url === '/v1/places/catalog/approve' || req.url === '/v1/places/catalog/seed') {
      const { body } = await readJSON(req, 8192);
      return reply(res, 200, req.url.endsWith('/seed') ? store.places.seed(body) : store.places.approve(body));
    }
    if (req.url === '/v1/places/catalog/pending') {
      const { body } = await readJSON(req, 1024);
      return reply(res, 200, store.places.pending(body));
    }
    if (req.url === DIAGNOSTIC_ROUTE) {
      const { body } = await readJSON(req, 1024);
      return reply(res, 200, readAccountDiagnostics(store.db, body));
    }
    requireThat(['/v1/participants/state', '/v1/tokens', '/v1/recovery/complete'].includes(req.url), 404, 'NOT_FOUND');
    const { body } = await readJSON(req);
    if (req.url === '/v1/participants/state') {
      return reply(res, 200, { ok: true, ...store.applyState(validateState(body)) });
    }
    if (req.url === '/v1/tokens') {
      const p = store.activeParticipant(validateTokenRequest(body).participantKey);
      return reply(res, 200, { ok: true, ...p, acceptedPurposeVersion: p.purposeVersion,
        confirmed: true, ...tokens.issue(p) });
    }
    requireThat(shape(body, { stateReconciliationConfirmed: v => v === true }), 422, 'RECONCILIATION_REQUIRED');
    return reply(res, 200, { ok: true, ...store.recoveryComplete() });
  }));
  for (const server of [publicServer, adminServer]) {
    server.requestTimeout = 15_000; server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000; server.maxRequestsPerSocket = 100;
    server.maxConnections = 128;
    server.on('clientError', (_err, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  }
  return {
    store, tokens, publicServer, adminServer,
    async start() {
      mkdirSync(dirname(config.adminSocket), { recursive: true, mode: 0o700 });
      chmodSync(dirname(config.adminSocket), 0o700);
      if (existsSync(config.adminSocket)) {
        requireThat(lstatSync(config.adminSocket).isSocket(), 500, 'ADMIN_SOCKET_PATH_OCCUPIED');
        const active = await new Promise((resolve, reject) => {
          const probe = net.createConnection(config.adminSocket);
          probe.once('connect', () => { probe.destroy(); resolve(true); });
          probe.once('error', error => {
            if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false);
            else reject(error);
          });
        });
        requireThat(!active, 500, 'ADMIN_SOCKET_ALREADY_ACTIVE');
        unlinkSync(config.adminSocket);
      }
      await new Promise((resolve, reject) => adminServer.once('error', reject).listen(config.adminSocket, resolve));
      chmodSync(config.adminSocket, 0o600);
      await new Promise((resolve, reject) => publicServer.once('error', reject).listen(config.port, config.host, resolve));
      return publicServer.address();
    },
    async close() {
      await Promise.all([publicServer, adminServer].map(server => new Promise(resolve => {
        server.close(resolve); server.closeIdleConnections();
      })));
      store.close();
    },
  };
}
