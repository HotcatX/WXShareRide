import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config.ts';
import type { Identity } from '../auth/session.ts';
import { AppError } from '../errors.ts';
import { createSignedCollectorRequest } from './transport.ts';
import { collectionProtocol as protocol, validCollectionVersions } from './protocol.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{16,80}$/);
const version = z.number().int().min(0).max(2147483647);
const inputSchema = z.strictObject({ action: z.enum(['status','activate','withdraw']), requestId: id,
  expectedStatusVersion: version, purposeVersion: z.string(),
  noticeVersion: z.string(), collectionMode: z.literal('test').optional() })
  .refine(value => validCollectionVersions(value.purposeVersion, value.noticeVersion));
const tokenSession = z.strictObject({ participantKey: id, grantId: id, status: z.literal('active'), statusVersion: version,
  confirmed: z.literal(true), purposeVersion: z.string(), acceptedPurposeVersion: z.string(),
  token: z.string().max(2048).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/), tokenExpiresAtMs: z.number().int() });
const replySchema = z.strictObject({ ok: z.literal(true), status: z.enum(['none','active','revoked']),
  statusVersion: version, purposeVersion: z.string(), noticeVersion: z.string(),
  synthetic: z.boolean().optional(), participantKey: id.optional(), session: tokenSession.optional() });
const unavailable = () => new AppError(503, 'COLLECTION_UNAVAILABLE', '数据采集暂不可用');
const conflicts = new Set(['STALE_STATE','STATE_CONFLICT','REQUEST_CONFLICT','STATUS_CONFLICT','OPERATION_CONFLICT',
  'NOTICE_VERSION_MISMATCH','RECONSENT_REQUIRED','OPERATION_SUPERSEDED','PARTICIPANT_KIND_IMMUTABLE','ACCOUNT_IDENTITY_CONFLICT']);

/** The business session supplies the original OpenID. The collector remains the
 * only grant/token store; its existing requestId/CAS protocol owns retries. */
export function createCollectionSessions(config: Config, transport: typeof fetch = fetch) {
  const settings = config.collector;
  const post = settings ? createSignedCollectorRequest(settings, protocol.path, transport) : null;
  return async (user: Identity, raw: unknown) => {
    const input = inputSchema.parse(raw);
    if (!settings?.subjectKey || !post) throw unavailable();
    const synthetic = input.collectionMode === 'test';
    const accountSubject = createHmac('sha256', settings.subjectKey)
      .update(`${synthetic ? protocol.testSubject : protocol.subject}\n${config.appId}\n${user.openid}`).digest('hex');
    const body = { accountSubject, openid: user.openid, action: input.action, requestId: input.requestId,
      expectedStatusVersion: input.expectedStatusVersion, purposeVersion: input.purposeVersion, noticeVersion: input.noticeVersion,
      ...(synthetic ? { synthetic: true } : {}) };
    let response;
    try { response = await post(JSON.stringify(body)); } catch { throw unavailable(); }
    if (response.status !== 200) {
      const error = response.body as { ok?: unknown; error?: unknown } | null;
      if (response.status === 409 && error?.ok === false && typeof error.error === 'string' && conflicts.has(error.error)) {
        throw new AppError(409, error.error, '采集状态已变化，请刷新后重试');
      }
      throw unavailable();
    }
    const checked = replySchema.safeParse(response.body);
    if (!checked.success) throw unavailable();
    const reply = checked.data, now = Date.now();
    if (reply.purposeVersion !== input.purposeVersion || reply.noticeVersion !== input.noticeVersion ||
      (reply.synthetic === true) !== synthetic || (reply.status === 'none' ? reply.statusVersion !== 0 || !!reply.participantKey || !!reply.session
      : reply.statusVersion < 1 || !reply.participantKey) || reply.session &&
      (reply.status !== 'active' || reply.session.participantKey !== reply.participantKey || reply.session.statusVersion !== reply.statusVersion ||
        reply.session.purposeVersion !== input.purposeVersion || reply.session.acceptedPurposeVersion !== input.purposeVersion ||
        reply.session.tokenExpiresAtMs <= now || reply.session.tokenExpiresAtMs > now + 930000)) throw unavailable();
    return reply;
  };
}
