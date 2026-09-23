import http from 'node:http';
import { readSnapshot, MAX_BYTES } from './snapshot.mjs';
import { SYNC_ROUTE, SyncError, verifySyncSignature, installSnapshot } from './sync.mjs';

export const ROUTE = '/v1/public-stats';
export { SYNC_ROUTE };
function reply(res, status, data, extra = {}) {
  const text = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(text);
}
function hasDuplicateHeader(req, name) {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) count++;
  return count !== 1;
}
async function readBody(req) {
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new SyncError(415, 'UNSUPPORTED_ENCODING');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) throw new SyncError(415, 'JSON_REQUIRED');
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BYTES)) throw new SyncError(413, 'BODY_TOO_LARGE');
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0; let ended = false;
    req.on('data', chunk => {
      if (ended) return;
      bytes += chunk.length;
      if (bytes > MAX_BYTES) { ended = true; chunks.length = 0; reject(new SyncError(413, 'BODY_TOO_LARGE')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!ended) { ended = true; resolve(Buffer.concat(chunks, bytes)); } });
    req.on('aborted', () => { if (!ended) { ended = true; reject(new SyncError(400, 'INCOMPLETE_BODY')); } });
    req.on('error', () => { if (!ended) { ended = true; reject(new SyncError(400, 'INCOMPLETE_BODY')); } });
  });
}

export function createPublicReadPilot({ snapshotPath, now = () => Date.now(), syncKey = null, readEnabled = true, log = () => {} }) {
  if (syncKey !== null && (!Buffer.isBuffer(syncKey) || syncKey.length !== 32)) throw new Error('PUBLIC_STATS_SYNC_KEY_INVALID');
  if (typeof readEnabled !== 'boolean') throw new Error('PUBLIC_STATS_READ_ENABLED_INVALID');
  const server = http.createServer({ maxHeaderSize: 4096 }, async (req, res) => {
    // Compare raw URL: queries, trailing slashes and encoded aliases fail closed.
    if (req.url === SYNC_ROUTE) {
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, { Allow: 'POST' });
      let status = 200;
      try {
        if (!syncKey) throw new SyncError(503, 'SYNC_DISABLED');
        if (hasDuplicateHeader(req, 'x-linkx-timestamp') || hasDuplicateHeader(req, 'x-linkx-signature')) throw new SyncError(401, 'UNAUTHORIZED');
        const rawBody = await readBody(req);
        // Validate time after the full body has arrived, immediately before commit.
        const at = now();
        verifySyncSignature({ key: syncKey, timestamp: req.headers['x-linkx-timestamp'], signature: req.headers['x-linkx-signature'], rawBody, now: at });
        reply(res, 200, installSnapshot({ snapshotPath, rawBody, now: at }));
      } catch (error) {
        status = error instanceof SyncError ? error.status : 503;
        reply(res, status, { ok: false, error: error instanceof SyncError ? error.code : 'SYNC_UNAVAILABLE' }, { Connection: 'close' });
      }
      // Never log headers, body, file paths, source IP, or secrets.
      try { log({ event: 'public-stats-sync', status, at: now() }); } catch {}
      return;
    }
    if (req.url !== ROUTE) return reply(res, 404, { ok: false, error: 'NOT_FOUND' });
    if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, { Allow: 'GET' });
    if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) {
      return reply(res, 400, { ok: false, error: 'BODY_NOT_ALLOWED' }, { Connection: 'close' });
    }
    if (!readEnabled) return reply(res, 503, { ok: false, error: 'PUBLIC_READ_DISABLED' }, { 'Retry-After': '60' });
    try { reply(res, 200, { ok: true, ...readSnapshot(snapshotPath, now()) }); }
    catch { reply(res, 503, { ok: false, error: 'SNAPSHOT_UNAVAILABLE' }, { 'Retry-After': '60' }); }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 64;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  return server;
}
