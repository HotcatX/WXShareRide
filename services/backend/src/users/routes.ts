import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Identity } from '../auth/session.ts';
import { withIdempotency } from '../db.ts';
import { AppError } from '../errors.ts';

const shortText = z.string().trim().max(200);
const addressList = z.array(z.string().trim().min(1).max(300)).max(20);
export const profileSchema = z.strictObject({
  phone: z.string().trim().max(32).optional(), phoneRegion: z.string().trim().max(8).optional(),
  wechatId: shortText.optional(), bio: z.string().trim().max(1000).optional(),
  vehicle: z.strictObject({ plate: shortText.optional(), brand: shortText.optional(), model: shortText.optional() }).optional(),
  zelle: z.strictObject({ name: shortText.optional(), account: shortText.optional(), public: z.boolean().optional() }).optional(),
  region: z.strictObject({ state: shortText.optional(), county: shortText.optional(), area: shortText.optional(), key: shortText.optional(), label: shortText.optional() }).optional(),
  location: z.strictObject({ label: shortText.optional(), address: z.string().max(300).optional(), latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional() }).optional(),
  preferences: z.strictObject({ pickupAddresses: addressList.optional(), dropoffAddresses: addressList.optional(), comments: z.array(shortText).max(20).optional() }).optional(),
  profileCompleted: z.boolean().optional()
});
const updateSchema = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  avatarUrl: z.union([z.literal(''), z.url().refine(value => /^(https:|cloud:)/.test(value))]).optional(),
  profile: profileSchema.optional()
}).refine(value => Object.keys(value).length > 0);

/** Nested profile keys are merged; arrays and scalars replace. Never accept old aliases. */
function mergeProfile(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeProfile((base[key] && typeof base[key] === 'object' ? base[key] : {}) as Record<string, unknown>, value as Record<string, unknown>)
      : value;
  }
  return merged;
}

export async function registerUserRoutes(app: FastifyInstance, deps: { pool: Pool; requireUser: (request: FastifyRequest) => Promise<Identity> }) {
  app.get('/api/v1/me', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const identity = await deps.requireUser(request);
    const result = await deps.pool.query('SELECT id,openid,name,avatar_url AS "avatarUrl",profile,updated_at AS "updatedAt" FROM users WHERE id=$1', [identity.id]);
    return { ok: true, data: result.rows[0], requestId: request.id };
  });
  app.patch('/api/v1/me', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const identity = await deps.requireUser(request);
    const patch = updateSchema.parse(request.body);
    const result = await withIdempotency(deps.pool, identity.id, 'users.update', request.headers['idempotency-key'], patch, async client => {
      const current = await client.query('SELECT name,avatar_url,profile FROM users WHERE id=$1 FOR UPDATE', [identity.id]);
      if (!current.rows.length) throw new AppError(404, 'USER_NOT_FOUND', '账号不存在');
      const previous = current.rows[0];
      const updated = await client.query(
        `UPDATE users SET name=$2,avatar_url=$3,profile=$4,updated_at=clock_timestamp() WHERE id=$1
         RETURNING id,openid,name,avatar_url AS "avatarUrl",profile,updated_at AS "updatedAt"`,
        [identity.id, patch.name ?? previous.name, patch.avatarUrl ?? previous.avatar_url, mergeProfile(previous.profile, patch.profile ?? {})]
      );
      return { status: 200, data: updated.rows[0] };
    });
    return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
  });
}
