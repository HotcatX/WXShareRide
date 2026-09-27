import { createHmac, randomBytes } from 'node:crypto';
import { AppError } from '../errors.ts';
const maxBatchBytes = 112 * 1024, maxReplyBytes = 8192;
const unavailable = () => new AppError(503, 'COLLECTOR_DELIVERY_UNAVAILABLE', '统计服务暂不可用');

/** Configuration is supplied by the trusted runtime, never an HTTP request.
 * This transport preserves frozen event bytes, signs one request, and does not retry. */
export function createSignedCollectorRequest(config: { origin: string; key: Buffer }, path: string, transport: typeof fetch = fetch) {
  let origin: URL;
  try { origin = new URL(config.origin); } catch { throw unavailable(); }
  if (origin.protocol !== 'https:' || origin.origin !== config.origin || !Buffer.isBuffer(config.key) || config.key.length !== 32) {
    throw unavailable();
  }
  const endpoint = `${origin.origin}${path}`;
  const key = Buffer.from(config.key);
  return async (body: string): Promise<{ status: number; body: unknown }> => {
    if (typeof body !== 'string' || Buffer.byteLength(body) > maxBatchBytes || !body.length) throw unavailable();
    try {
      const timestamp = String(Date.now()), nonce = randomBytes(16).toString('hex');
      const signature = createHmac('sha256', key).update(`${timestamp}\n${nonce}\n`).update(body).digest('hex');
      const response = await transport(endpoint, {
        method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(6500),
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)),
          'accept-encoding': 'identity', 'x-linkx-timestamp': timestamp, 'x-linkx-nonce': nonce, 'x-linkx-signature': signature }
      });
      const declared = response.headers.get('content-length');
      const encoding = response.headers.get('content-encoding');
      if ((encoding && encoding.toLowerCase() !== 'identity') ||
          (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxReplyBytes)) || !response.body) {
        await response.body?.cancel(); throw unavailable();
      }
      const reader = response.body.getReader();
      const chunks: Buffer[] = []; let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > maxReplyBytes) { await reader.cancel(); throw unavailable(); }
          chunks.push(Buffer.from(next.value));
        }
      } finally { reader.releaseLock(); }
      if (declared !== null && Number(declared) !== size) throw unavailable();
      return { status: response.status, body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown };
    } catch { throw unavailable(); }
  };
}
