import { createHmac, timingSafeEqual } from 'node:crypto';
import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { requireThat } from './errors.mjs';
import { shape, id, purpose } from './validation.mjs';
import { NOTICE_PATTERN } from './compat/legacy.mjs';

export const BRIDGE_WINDOW_MS = 300_000;
export const isNoticeVersion = value => typeof value === 'string' && NOTICE_PATTERN.test(value);
export function loadBridgeKey(path) {
  if (!path) return null;
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 64 || stat.size > 128) throw new Error();
    const bytes = Buffer.alloc(129); const n = readSync(fd, bytes, 0, bytes.length, 0);
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, n)).trim();
    if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error();
    return Buffer.from(value, 'hex');
  } catch { throw new Error('Invalid analytics bridge key file'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function verifyBridgeRequest(req, key, raw, now = Date.now()) {
  requireThat(Buffer.isBuffer(key) && key.length === 32, 503, 'BRIDGE_DISABLED');
  for (const name of ['x-linkx-timestamp', 'x-linkx-nonce', 'x-linkx-signature']) {
    let count = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) count++;
    requireThat(count === 1, 401, 'BRIDGE_UNAUTHORIZED');
  }
  const timestamp = req.headers['x-linkx-timestamp']; const nonce = req.headers['x-linkx-nonce'];
  const signature = req.headers['x-linkx-signature']; const at = Number(timestamp);
  requireThat(typeof timestamp === 'string' && /^[1-9][0-9]{0,15}$/.test(timestamp)
    && Number.isSafeInteger(at) && Math.abs(now - at) <= BRIDGE_WINDOW_MS
    && typeof nonce === 'string' && /^[a-f0-9]{32}$/.test(nonce)
    && typeof signature === 'string' && /^[a-f0-9]{64}$/.test(signature), 401, 'BRIDGE_UNAUTHORIZED');
  const expected = createHmac('sha256', key).update(`${timestamp}\n${nonce}\n`).update(raw).digest();
  requireThat(timingSafeEqual(expected, Buffer.from(signature, 'hex')), 401, 'BRIDGE_UNAUTHORIZED');
  return { nonce, expiresAt: at + BRIDGE_WINDOW_MS };
}
export function validateParticipationRequest(body, purposeVersion, noticeVersion) {
  requireThat(shape(body, {
    accountSubject: value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
    action: value => ['status', 'activate', 'withdraw'].includes(value), requestId: id,
    expectedStatusVersion: value => Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647,
    purposeVersion: purpose, noticeVersion: isNoticeVersion, synthetic: value => value === true,
    openid: value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value),
  }, ['accountSubject', 'action', 'requestId', 'expectedStatusVersion', 'purposeVersion', 'noticeVersion']), 422, 'INVALID_PARTICIPATION_REQUEST');
  requireThat(body.purposeVersion === purposeVersion && body.noticeVersion === noticeVersion, 409, 'NOTICE_VERSION_MISMATCH');
  return body;
}
