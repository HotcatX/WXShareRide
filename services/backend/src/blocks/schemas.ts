import { z } from 'zod';

export const targetUserIdSchema = z.uuid().transform(value => value.toLowerCase());
export const blockUserSchema = z.strictObject({
  targetUserId: targetUserIdSchema,
  reason: z.string().trim().max(180).default(''),
});
export const listBlocksSchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

