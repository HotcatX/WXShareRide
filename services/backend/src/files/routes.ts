import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { adminHttpGuard } from '../admin/routes.ts';
import { requireAdmin } from '../admin/service.ts';
import { idempotencyInput } from '../db.ts';
import { AppError } from '../errors.ts';
import { authorizeFileReads } from './read.ts';
import type { FileReadViewer, ReadableFile } from './read.ts';
import { MAX_IMAGE_UPLOAD_BYTES, uploadAdminImage, uploadUserImage } from './upload.ts';
import type { ImageUploadStorage } from './upload.ts';

export type FileStorage = ImageUploadStorage & {
  readUrl(file: ReadableFile, expiresSeconds: number): Promise<string>;
};
type Dependencies = { pool: Pool; appId: string; requireUser: (request: FastifyRequest) => Promise<{ id: string }>; storage?: FileStorage };
const uploadSlots = new Set<FastifyRequest>();
const processingUploads = new WeakSet<FastifyRequest>();
const noQuery = z.strictObject({});
const urlsBody = z.strictObject({ fileIds: z.unknown() });
const URL_TTL_SECONDS = 300;
const unavailable = () => new AppError(503, 'FILE_STORAGE_UNAVAILABLE', '图片服务暂不可用，请稍后重试');

function privateResponse(reply: FastifyReply, admin = false) {
  reply.header('Cache-Control', 'private, no-store').header('Vary', admin ? 'Origin, Authorization' : 'Authorization')
    .header('X-Content-Type-Options', 'nosniff');
}
function releaseUnprocessed(request: FastifyRequest) {
  // A disconnected caller cannot release a slot while decoder/storage work
  // continues. The upload handler alone releases those slots in its finally.
  if (!processingUploads.has(request)) uploadSlots.delete(request);
}
function safeUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) throw unavailable();
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw unavailable();
  } catch { throw unavailable(); }
  return value;
}

/** Binary uploads are authenticated and admitted before body parsing. Slots
 * cover receiving, decoding and provider I/O across all app instances in this
 * process; overload rejects immediately rather than accumulating a queue. */
export function registerFileRoutes(app: FastifyInstance, deps: Dependencies): void {
  const viewers = new WeakMap<FastifyRequest, FileReadViewer>();
  const storage = () => { if (!deps.storage) throw unavailable(); return deps.storage; };
  const admitUpload = async (request: FastifyRequest) => {
    noQuery.parse(request.query);
    idempotencyInput(request.headers['idempotency-key'], null);
    storage();
    if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/octet-stream') {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用 application/octet-stream 上传图片');
    }
    if (request.raw.aborted) throw new AppError(400, 'REQUEST_ABORTED', '上传已中断');
    if (uploadSlots.size >= 2) throw new AppError(503, 'FILE_UPLOAD_BUSY', '图片上传繁忙，请稍后重试');
    uploadSlots.add(request);
  };
  const upload = async (request: FastifyRequest, reply: FastifyReply) => {
    processingUploads.add(request);
    try {
      if (request.raw.aborted) throw new AppError(400, 'REQUEST_ABORTED', '上传已中断');
      // Do not let an inherited JSON parser turn a client object into a file.
      if (!Buffer.isBuffer(request.body)) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用 application/octet-stream 上传图片');
      const viewer = viewers.get(request)!;
      const result = 'admin' in viewer
        ? await uploadAdminImage(deps.pool, viewer.admin, request.headers['idempotency-key'], request.body, storage())
        : await uploadUserImage(deps.pool, deps.appId, viewer.userId, request.headers['idempotency-key'], request.body, storage());
      return reply.code(201).send({ ok: true, data: result, requestId: request.id });
    } finally {
      processingUploads.delete(request);
      uploadSlots.delete(request);
    }
  };
  const urls = async (request: FastifyRequest) => {
    noQuery.parse(request.query);
    const input = urlsBody.parse(request.body);
    const files = await authorizeFileReads(deps.pool, deps.appId, input.fileIds, viewers.get(request));
    const provider = storage();
    // Authorize the entire batch first. A signing failure returns no partial
    // URL list, and provider messages/locators never become a public error.
    let items: { fileId: string; url: string }[];
    try {
      items = await Promise.all(files.map(async file => ({ fileId: file.id,
        url: safeUrl(await provider.readUrl(file, URL_TTL_SECONDS)) })));
    } catch { throw unavailable(); }
    return { ok: true, data: { items, expiresIn: URL_TTL_SECONDS }, requestId: request.id };
  };
  app.register(async scope => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_IMAGE_UPLOAD_BYTES },
      async (_request: FastifyRequest, body: Buffer) => body);
    scope.addHook('onRequest', async (_request, reply) => { privateResponse(reply); });
    scope.addHook('onSend', async (_request, reply, payload) => {
      if (reply.statusCode === 503) reply.header('Retry-After', '5');
      return payload;
    });
    scope.addHook('onResponse', async request => { releaseUnprocessed(request); });
    scope.addHook('onError', async request => { releaseUnprocessed(request); });
    scope.addHook('onTimeout', async request => { releaseUnprocessed(request); });
    scope.addHook('onRequestAbort', async request => { releaseUnprocessed(request); });
    scope.post('/api/v1/files/images', { bodyLimit: MAX_IMAGE_UPLOAD_BYTES, onRequest: [async request => {
      viewers.set(request, { userId: (await deps.requireUser(request)).id });
    }, admitUpload] }, upload);
    scope.post('/api/v1/files/urls', { onRequest: async request => {
      if (request.headers.authorization !== undefined) viewers.set(request, { userId: (await deps.requireUser(request)).id });
    } }, urls);
    scope.register(async admin => {
      const guard = adminHttpGuard(deps);
      admin.addHook('onRequest', async (request, reply) => {
        try { await guard(request, reply); }
        finally { privateResponse(reply, true); }
        if (request.method !== 'OPTIONS') viewers.set(request, { admin: await requireAdmin(deps.pool, deps.appId, request.headers.authorization) });
      });
      for (const path of ['/api/v1/admin/files/images', '/api/v1/admin/files/urls']) {
        admin.options(path, async (_request, reply) => reply.code(204).send());
      }
      admin.post('/api/v1/admin/files/images', { bodyLimit: MAX_IMAGE_UPLOAD_BYTES, onRequest: admitUpload }, upload);
      admin.post('/api/v1/admin/files/urls', urls);
    });
  });
}
