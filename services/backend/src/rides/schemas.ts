import { z } from 'zod';

const place = z.object({
  address: z.string().trim().min(1).max(300),
  placeId: z.string().trim().min(1).max(100).optional(),
}).strict();

const base = z.object({
  cityKey: z.literal('ny_nj'),
  departureAt: z.string().datetime(),
  timeZone: z.literal('America/New_York'),
  origin: place,
  destination: place,
  listedPriceCents: z.number().int().min(0).max(100_000_000).nullable(),
  note: z.string().trim().max(1000).default(''),
});

export const createRideSchema = z.discriminatedUnion('kind', [
  base.extend({ kind: z.literal('offer'), seatCapacity: z.number().int().min(1).max(8) }).strict(),
  base.extend({ kind: z.literal('request'), partySize: z.number().int().min(1).max(4) }).strict(),
]);

export const joinRideSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('passenger'), seatCount: z.number().int().min(1).max(8) }).strict(),
  z.object({ role: z.literal('driver') }).strict(),
]);

export const leaveRideSchema = z.object({ reason: z.string().trim().max(500).default('') }).strict();
export const cancelRideSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
export const rideIdSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9:_-]+$/);
export const listRidesSchema = z.object({
  cityKey: z.literal('ny_nj').default('ny_nj'),
  kind: z.enum(['offer', 'request']).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

export type CreateRideInput = z.infer<typeof createRideSchema>;
export type JoinRideInput = z.infer<typeof joinRideSchema>;
