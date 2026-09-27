import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withIdempotency } from '../db.ts';
import { AppError } from '../errors.ts';
import { getLocationCatalog } from './routes.ts';

const inputSchema = z.strictObject({ cityKey: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), sourcePage: z.enum(['home', 'carpoolList']) });
const serviceCities = new Set(['ny_nj', 'ny', 'nj']);
export async function requestCity(pool: Pool, userId: string, key: unknown, body: unknown) {
  const input = inputSchema.parse(body);
  const cityKey = serviceCities.has(input.cityKey) ? 'ny_nj' : input.cityKey;
  const city = getLocationCatalog().cityTree.countries.flatMap(country => country.groups.flatMap(group => group.cities))
    .find(city => city.key === cityKey);
  if (!city) throw new AppError(400, 'UNKNOWN_CITY', '请选择有效的城市');
  return withIdempotency(pool, userId, 'locations.request', key, input, async client => {
    // Identities always come from a verified session, including a guest's
    // explicitly requested submission. Browsing mode does not change actor.
    if (cityKey === 'ny_nj') return { status: 200, data: { requestId: null, cityKey, status: 'already_available' } };
    const result = await client.query<{ id: string }>(`INSERT INTO city_requests(user_id,city_key,city_label,city_aliases,source_page)
      VALUES($1,$2,$3,$4,$5) RETURNING id`, [userId, cityKey, city.label, city.aliases, input.sourcePage]);
    return { status: 201, data: { requestId: result.rows[0]!.id, cityKey, status: 'recorded' } };
  });
}
export function registerCityRequestRoutes(app: FastifyInstance, { pool, requireUser }: {
  pool: Pool; requireUser: (request: FastifyRequest) => Promise<{ id: string; openid: string }>;
}) {
  app.post('/api/v1/locations/requests', async (request, reply) => {
    const user = await requireUser(request);
    const result = await requestCity(pool, user.id, request.headers['idempotency-key'], request.body);
    return reply.code(result.status).send({ ok: true, data: result.data, requestId: request.id });
  });
}
