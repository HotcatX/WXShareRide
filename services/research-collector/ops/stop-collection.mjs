import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APPID = 'wx8a8a389199aa2a0e';
export const PURPOSE = 'ride-research-v1';
export const NOTICE = 'ride-research-notice-2026-09-23';
export const ENDPOINT = 'http://127.0.0.1:3000/internal/v1/research/participation';
const SUBJECT_KEY_FILE = '/etc/linkx-research-ops/subject.key';
const BRIDGE_KEY_FILE = '/etc/linkx-research-ops/bridge.key';
const ID = /^[A-Za-z0-9_-]{16,80}$/;
const OPENID = /^[A-Za-z0-9_-]{16,128}$/;
const SAFE_ERRORS = new Set(['STATE_CONFLICT', 'STALE_STATE', 'OPERATION_CONFLICT', 'OPERATION_SUPERSEDED',
  'NOTICE_VERSION_MISMATCH', 'PURPOSE_MISMATCH', 'VERSION_EXHAUSTED', 'RESTORE_QUARANTINE',
  'COLLECTION_DISABLED', 'RECOVERY_RECONSENT_NOTICE_REQUIRED', 'RATE_LIMITED', 'SERVER_BUSY',
  'STORAGE_UNAVAILABLE', 'BRIDGE_REPLAY', 'BRIDGE_UNAUTHORIZED', 'BRIDGE_DISABLED']);
class StopError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new StopError(code); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const version = value => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;

export function parseInput(raw) {
  if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > 4096) fail('INVALID_INPUT');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch { fail('INVALID_INPUT'); }
  // This exact one-field JSON grammar also rejects duplicate keys, rather than
  // silently selecting the last identity in an ambiguous operator input.
  const match = /^\s*\{\s*"openid"\s*:\s*"([A-Za-z0-9_-]{16,128})"\s*\}\s*$/.exec(text);
  if (!match) fail('INVALID_INPUT');
  return match[1];
}

// Main always uses owner UID 0. The argument permits synthetic non-root tests.
export function readPrivateFile(path, maxBytes, ownerUid = 0) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== ownerUid || (stat.mode & 0o777) !== 0o600 ||
      stat.size <= 0 || stat.size > maxBytes) fail('PRIVATE_FILE_UNAVAILABLE');
    const raw = Buffer.alloc(maxBytes + 1); let count = 0;
    while (count < raw.length) {
      const n = readSync(fd, raw, count, raw.length - count, null);
      if (!n) break; count += n;
    }
    if (count === 0 || count > maxBytes) fail('PRIVATE_FILE_UNAVAILABLE');
    return raw.subarray(0, count);
  } catch { fail('PRIVATE_FILE_UNAVAILABLE'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function decodeKey(raw) {
  let value;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(raw).trim(); }
  catch { fail('KEY_UNAVAILABLE'); }
  if (!/^[a-fA-F0-9]{64}$/.test(value)) fail('KEY_UNAVAILABLE');
  return Buffer.from(value, 'hex');
}

export function deriveSubject(openid, subjectKey) {
  if (typeof openid !== 'string' || !OPENID.test(openid) ||
    !Buffer.isBuffer(subjectKey) || subjectKey.length !== 32) fail('INVALID_INPUT');
  return createHmac('sha256', subjectKey).update(`linkx-research-account-v1\n${APPID}\n${openid}`).digest('hex');
}

export function sendLocal(body, key, { request = http.request, now = Date.now,
  nonce = () => randomBytes(16).toString('hex'), timeoutMs = 3000 } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || !['status', 'withdraw'].includes(body?.action)) fail('INVALID_REQUEST');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3000) fail('INVALID_REQUEST');
  const raw = JSON.stringify(body); const timestamp = String(now()); const requestNonce = nonce();
  const signature = createHmac('sha256', key).update(`${timestamp}\n${requestNonce}\n${raw}`).digest('hex');
  return new Promise((resolvePromise, reject) => {
    let settled = false; let req;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(deadline);
      if (error) reject(new StopError(error)); else resolvePromise(result);
    };
    const deadline = setTimeout(() => { finish('BRIDGE_UNAVAILABLE'); req?.destroy(); }, timeoutMs);
    try {
      req = request(ENDPOINT, { method: 'POST', agent: false, maxHeaderSize: 4096, headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw),
        'X-Linkx-Timestamp': timestamp, 'X-Linkx-Nonce': requestNonce, 'X-Linkx-Signature': signature,
      } }, res => {
        const chunks = []; let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 8192) { finish('BRIDGE_UNAVAILABLE'); req.destroy(); return; }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
            if (res.statusCode === 200) return finish(null, parsed);
            finish(object(parsed) && parsed.ok === false && SAFE_ERRORS.has(parsed.error) ? parsed.error : 'BRIDGE_UNAVAILABLE');
          } catch { finish('BRIDGE_UNAVAILABLE'); }
        });
        res.on('error', () => finish('BRIDGE_UNAVAILABLE'));
        res.on('aborted', () => finish('BRIDGE_UNAVAILABLE'));
      });
      req.on('error', () => finish('BRIDGE_UNAVAILABLE'));
      req.end(raw);
    } catch { finish('BRIDGE_UNAVAILABLE'); }
  });
}

function readStatus(reply) {
  if (!object(reply) || reply.ok !== true || !['none', 'active', 'revoked'].includes(reply.status) ||
    !version(reply.statusVersion) || reply.purposeVersion !== PURPOSE || reply.noticeVersion !== NOTICE) fail('INVALID_RESPONSE');
  if (reply.status === 'none') {
    if (reply.statusVersion !== 0 || reply.participantKey !== undefined) fail('INVALID_RESPONSE');
  } else if (reply.statusVersion < 1 || typeof reply.participantKey !== 'string' || !ID.test(reply.participantKey)) fail('INVALID_RESPONSE');
  // Token/session and all extra upstream data are deliberately ignored.
  return { status: reply.status, statusVersion: reply.statusVersion, participantKey: reply.participantKey };
}

export async function stopCollection({ openid, subjectKey, bridgeKey, transport = sendLocal,
  newId = randomUUID }) {
  try {
    if (!Buffer.isBuffer(bridgeKey) || bridgeKey.length !== 32 || !Buffer.isBuffer(subjectKey) ||
      subjectKey.length !== 32 || bridgeKey.equals(subjectKey)) fail('KEY_UNAVAILABLE');
    const accountSubject = deriveSubject(openid, subjectKey);
    const payload = (action, expectedStatusVersion) => {
      const requestId = newId();
      if (typeof requestId !== 'string' || !ID.test(requestId)) fail('INVALID_REQUEST');
      return { accountSubject, action, requestId, expectedStatusVersion, purposeVersion: PURPOSE, noticeVersion: NOTICE };
    };
    const current = readStatus(await transport(payload('status', 0), bridgeKey));
    if (current.status === 'revoked') return { ok: true, status: 'revoked', alreadyClosed: true };
    // Exactly one CAS write. A conflict never refreshes the version and tries again.
    const after = readStatus(await transport(payload('withdraw', current.statusVersion), bridgeKey));
    if (after.status !== 'revoked' || after.statusVersion !== current.statusVersion + 1 ||
      (current.participantKey && after.participantKey !== current.participantKey)) fail('INVALID_RESPONSE');
    return { ok: true, status: 'revoked', alreadyClosed: false };
  } catch (error) {
    const local = ['INVALID_INPUT', 'INVALID_REQUEST', 'KEY_UNAVAILABLE', 'INVALID_RESPONSE', 'BRIDGE_UNAVAILABLE'];
    const code = error instanceof StopError && (SAFE_ERRORS.has(error.code) || local.includes(error.code)) ? error.code : 'OPERATION_FAILED';
    return { ok: false, status: 'unknown', error: code };
  }
}

export async function readStdin(stream, timeoutMs = 5000) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []; let size = 0; let ended = false;
    const finish = (error, value) => {
      if (ended) return; ended = true; clearTimeout(deadline);
      stream.removeListener('data', data); stream.removeListener('end', end); stream.removeListener('error', errorHandler);
      if (error) { stream.pause(); reject(new StopError('INVALID_INPUT')); } else resolvePromise(value);
    };
    const data = chunk => { size += chunk.length; if (size > 4096) finish(true); else chunks.push(Buffer.from(chunk)); };
    const end = () => finish(null, Buffer.concat(chunks));
    const errorHandler = () => finish(true);
    const deadline = setTimeout(() => finish(true), timeoutMs);
    stream.on('data', data); stream.once('end', end); stream.once('error', errorHandler);
  });
}

export async function main(argv = process.argv.slice(2)) {
  try {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) fail('ROOT_REQUIRED');
    if (!(argv.length === 0 || (argv.length === 2 && argv[0] === '--input-file' && argv[1]))) fail('INVALID_ARGUMENTS');
    const raw = argv.length ? readPrivateFile(argv[1], 4096) : await readStdin(process.stdin);
    const openid = parseInput(raw);
    const subjectKey = decodeKey(readPrivateFile(SUBJECT_KEY_FILE, 128));
    const bridgeKey = decodeKey(readPrivateFile(BRIDGE_KEY_FILE, 128));
    try { return await stopCollection({ openid, subjectKey, bridgeKey }); }
    finally { raw.fill(0); subjectKey.fill(0); bridgeKey.fill(0); }
  } catch (error) {
    const allowed = ['ROOT_REQUIRED', 'INVALID_ARGUMENTS', 'INVALID_INPUT', 'PRIVATE_FILE_UNAVAILABLE', 'KEY_UNAVAILABLE'];
    return { ok: false, status: 'unknown', error: error instanceof StopError && allowed.includes(error.code) ? error.code : 'OPERATION_FAILED' };
  }
}

// Importing this file never reads stdin, credentials or the live service.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await main();
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.ok ? 0 : 1;
}
