import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { withIdempotency } from '../db.ts';
import { AppError } from '../errors.ts';
import { replaceFileReferences } from '../files/service.ts';
import { avatarFileIdSql } from './avatar.ts';

const shortText = z.string().trim().max(200);
const addressList = z.array(z.string().trim().min(1).max(300)).max(20);
export const profileSchema = z.strictObject({
  phone: z.string().trim().max(32).optional(), phoneRegion: z.string().trim().max(8).optional(),
  wechatId: shortText.optional(), bio: z.string().trim().max(1000).optional(),
  vehicle: z.strictObject({ plate: shortText.optional(), brand: shortText.optional(), model: shortText.optional() }).optional(),
  zelle: z.strictObject({ name: shortText.optional(), account: shortText.optional(), public: z.boolean().optional() }).optional(),
  region: z.strictObject({ state: shortText.optional(), county: shortText.optional(), area: shortText.optional(), key: shortText.optional(), label: shortText.optional() }).optional(),
  location: z.strictObject({ label: shortText.optional(), address: z.string().max(300).optional(), residence: z.string().max(300).optional(), latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional() }).optional(),
  preferences: z.strictObject({
    pickupAddresses: addressList.optional(), dropoffAddresses: addressList.optional(), comments: z.array(shortText).max(20).optional(),
    routePrices: z.strictObject({ fortLeeNonCore: z.string().max(1000).optional() }).optional()
  }).optional(),
  profileCompleted: z.boolean().optional()
});
export const updateUserSchema = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  avatarFileId: z.uuid().transform(value => value.toLowerCase()).nullable().optional(),
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

type UserRow = { id: string; openid: string; name: string; avatarFileId: string | null;
  profile: Record<string, unknown>; updatedAt: Date | null };

async function readUser(client: Pool | PoolClient, userId: string) {
  const row = (await client.query<UserRow>(`SELECT u.id,u.openid,u.name,
    ${avatarFileIdSql('u')} AS "avatarFileId",u.profile,u.updated_at AS "updatedAt"
    FROM users u WHERE u.id=$1`, [userId])).rows[0];
  if (!row) throw new AppError(404, 'USER_NOT_FOUND', '账号不存在');
  return { ...row, updatedAt: row.updatedAt?.toISOString() ?? null };
}

/** The caller supplies an authenticated identity, never a client OpenID. */
export function getUser(pool: Pool | PoolClient, userId: string) {
  return readUser(pool, z.uuid().parse(userId));
}

export async function updateUser(pool: Pool, userId: string, key: unknown, body: unknown) {
  const actorId = z.uuid().transform(value => value.toLowerCase()).parse(userId);
  const patch = updateUserSchema.parse(body);
  return withIdempotency(pool, actorId, 'users.update', key, patch, client => updateUserInTransaction(client, actorId, patch));
}

export async function updateUserInTransaction(client: PoolClient, actorId: string, body: unknown) {
    const patch = updateUserSchema.parse(body);
    const previous = (await client.query<{ app_id: string; name: string; profile: Record<string, unknown> }>(
      'SELECT app_id,name,profile FROM users WHERE id=$1 FOR UPDATE', [actorId])).rows[0];
    if (!previous) throw new AppError(404, 'USER_NOT_FOUND', '账号不存在');
    if (patch.avatarFileId !== undefined) {
      await replaceFileReferences(client, { appId: previous.app_id, kind: 'user', id: actorId },
        patch.avatarFileId === null ? [] : [{ slot: 'avatar', fileId: patch.avatarFileId }], { userId: actorId });
    }
    return saveUserProfile(client, actorId, patch.name ?? previous.name, mergeProfile(previous.profile, patch.profile ?? {}));
}

async function saveUserProfile(client: PoolClient, actorId: string, name: string, profile: Record<string, unknown>) {
  await client.query(`UPDATE users SET name=$2,profile=$3,updated_at=clock_timestamp() WHERE id=$1`, [actorId, name, profile]);
  return { status: 200, data: await readUser(client, actorId) };
}

export async function updateUserAddressInTransaction(client: PoolClient, actorId: string, field: 'pickupAddresses' | 'dropoffAddresses', value: string, add: boolean) {
  const row = (await client.query<{ name: string; profile: z.infer<typeof profileSchema> }>('SELECT name,profile FROM users WHERE id=$1 FOR UPDATE', [actorId])).rows[0];
  if (!row) throw new AppError(404, 'USER_NOT_FOUND', '账号不存在');
  // Imported strings remain exact. The new single value is strictly validated
  // by the finite compat contract; parsing the stored profile would trim old
  // entries and turn an unrelated addition into a silent historical rewrite.
  const old = z.array(z.string().max(300)).max(20).parse(row.profile.preferences?.[field] ?? []);
  const values = add ? [...new Set([...old, value])] : old.filter(item => item !== value);
  if (values.length > 20) throw new AppError(400, 'TOO_MANY_ADDRESSES', '常用地址最多20条');
  await saveUserProfile(client, actorId, row.name, mergeProfile(row.profile, { preferences: { [field]: values } }));
  return values;
}
