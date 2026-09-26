import COS from 'cos-nodejs-sdk-v5';
import { createHash } from 'node:crypto';
import type { CosConfig } from '../config.ts';
import { AppError } from '../errors.ts';
import type { ReadableFile } from './read.ts';
import type { FileStorage } from './routes.ts';

const unavailable = () => new AppError(503, 'FILE_STORAGE_UNAVAILABLE', '图片服务暂不可用，请稍后重试');
const invalidObject = () => new AppError(503, 'FILE_STORAGE_UNAVAILABLE', '图片尚未完成存储配置');
const requestTimeoutMs = 10_000;
type Transport = typeof fetch;

/** COS SDK is used for signing only. Native fetch gives each request AND its
 * response stream a hard deadline, no automatic retries, no redirects, and a
 * byte limit. SDK/provider errors and signed URLs must never enter logs.
 * This adapter deliberately exposes no object deletion capability. */
export function createCosStorage(config: CosConfig, transport: Transport = fetch): FileStorage & { check(): Promise<void> } {
  if (!/^[a-z0-9][a-z0-9-]{1,62}-[0-9]{5,20}$/.test(config.bucket) ||
      !/^[a-z]{2}-[a-z]+(?:-[0-9]+)?$/.test(config.region)) throw invalidObject();
  const host = `${config.bucket}.cos.${config.region}.myqcloud.com`;
  const origin = `https://${host}`;
  const cos = new COS({ SecretId: config.secretId, SecretKey: config.secretKey });

  function keyFor(locator: string, provider: 'cos' | 'cloudbase' = 'cos'): string {
    const prefix = provider === 'cos' ? `cos://${config.bucket}/` :
      config.legacyEnvironment ? `cloud://${config.legacyEnvironment}.${config.bucket}/` : '';
    if (!prefix || !locator.startsWith(prefix)) throw invalidObject();
    const key = locator.slice(prefix.length);
    if (!key || Buffer.byteLength(key) > 1024 || /[\u0000-\u001f\u007f-\u009f\\?#]/u.test(key) ||
        key.split('/').some(segment => !segment || segment === '.' || segment === '..')) throw invalidObject();
    return key;
  }
  function pathFor(key: string) { return `/${key.split('/').map(encodeURIComponent).join('/')}`; }
  function sign(method: 'GET' | 'PUT', key: string, query: Record<string, string>, headers: Record<string, string>, expires = 60) {
    return cos.getAuth({ Method: method, Bucket: config.bucket, Region: config.region, Key: key,
      Query: query, Headers: { ...headers, host }, Expires: expires, ForceSignHost: true });
  }
  async function consume(response: Response, maxBytes: number): Promise<Buffer> {
    const declared = response.headers.get('content-length');
    const encoding = response.headers.get('content-encoding');
    if ((encoding && encoding.toLowerCase() !== 'identity') ||
        (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))) {
      await response.body?.cancel(); throw unavailable();
    }
    if (!response.body) {
      if (declared !== null && Number(declared) !== 0) throw unavailable();
      return Buffer.alloc(0);
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = []; let length = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.byteLength;
        if (length > maxBytes) { await reader.cancel(); throw unavailable(); }
        chunks.push(Buffer.from(next.value));
      }
      if (declared !== null && Number(declared) !== length) throw unavailable();
      return Buffer.concat(chunks, length);
    } finally { reader.releaseLock(); }
  }
  async function request(method: 'GET' | 'PUT', key: string, options: {
    query?: Record<string, string>; headers?: Record<string, string>; body?: Buffer; maxBytes: number;
  }) {
    try {
      const query = options.query ?? {}, headers = options.headers ?? {};
      const params = new URLSearchParams(query).toString();
      const response = await transport(`${origin}${pathFor(key)}${params ? `?${params}` : ''}`, {
        method, headers: { ...headers, authorization: sign(method, key, query, headers) },
        body: options.body ? new Uint8Array(options.body) : undefined,
        redirect: 'error', signal: AbortSignal.timeout(requestTimeoutMs)
      });
      const body = await consume(response, response.ok ? options.maxBytes : 16_384);
      return { response, body };
    } catch { throw unavailable(); }
  }
  async function check() {
    const { response, body } = await request('GET', '', { query: { versioning: '' }, maxBytes: 4096 });
    // The overwrite prohibition does not hold in a versioned/suspended bucket.
    // Only the documented never-enabled response is accepted. Fail closed for
    // malformed XML or unexpected content; there is no general XML evaluator.
    const xml = body.toString('utf8').replace(/^\s*<\?xml[^?]*\?>\s*/, '').trim();
    const empty = /^<VersioningConfiguration(?:\s+xmlns="https?:\/\/[^"<>]+")?\s*(?:\/>|>\s*<\/VersioningConfiguration>)$/.test(xml);
    if (response.status !== 200 || !empty) throw unavailable();
  }
  function providerCode(body: Buffer) { return /<Code>([A-Za-z0-9]+)<\/Code>/.exec(body.toString('utf8'))?.[1]; }
  return {
    bucket: config.bucket,
    check,
    objects: {
      async put(locator, bytes, mediaType) {
        const key = keyFor(locator);
        if (!/^linkx\/images\/[a-f0-9]{16}\/[a-f0-9-]{36}\.(jpg|png|webp)$/.test(key) ||
            !['image/jpeg', 'image/png', 'image/webp'].includes(mediaType) || !bytes.length || bytes.length > 2 * 1024 * 1024) throw invalidObject();
        // Checked before EACH new PUT, not merely once on process startup.
        // Operators must not change bucket versioning while uploads are live.
        await check();
        const { response, body } = await request('PUT', key, { body: bytes, maxBytes: 16_384, headers: {
          'content-type': mediaType, 'content-length': String(bytes.length),
          'content-md5': createHash('md5').update(bytes).digest('base64'),
          'cache-control': 'private, max-age=300', 'x-cos-forbid-overwrite': 'true'
        } });
        if (response.status !== 200 && !(response.status === 409 && providerCode(body) === 'FileAlreadyExists')) throw unavailable();
      },
      async read(locator, maxBytes) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024) throw invalidObject();
        const { response, body } = await request('GET', keyFor(locator), { maxBytes,
          headers: { range: `bytes=0-${maxBytes}` } });
        if (response.status === 404 && providerCode(body) === 'NoSuchKey') return null;
        if (![200, 206].includes(response.status)) throw unavailable();
        const range = response.headers.get('content-range');
        if (response.status === 206) {
          const parts = /^bytes 0-(\d+)\/(\d+)$/.exec(range ?? '');
          if (!parts || Number(parts[1]) + 1 !== body.length || Number(parts[2]) !== body.length) throw unavailable();
        }
        return { body, mediaType: (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() };
      }
    },
    async readUrl(file: ReadableFile, expiresSeconds: number) {
      if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 300) throw invalidObject();
      const key = keyFor(file.locator, file.provider);
      const query = { 'response-cache-control': 'private, max-age=300' };
      // Short bearer capability returned only AFTER authorizeFileReads. It does
      // not change object ACLs, and can remain usable until its five-minute TTL.
      return `${origin}${pathFor(key)}?${new URLSearchParams(query)}&${sign('GET', key, query, {}, expiresSeconds)}`;
    }
  };
}
