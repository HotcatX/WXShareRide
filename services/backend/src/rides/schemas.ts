import { z } from 'zod';
import { parseListedPrice } from '../prices.ts';

export const placeSchema = z.object({
  address: z.string().trim().min(1).max(300),
  placeId: z.string().trim().min(1).max(100).optional(),
}).strict();

const commonFieldsSchema = z.object({
  cityKey: z.literal('ny_nj'),
  listedPriceCents: z.number().int().min(0).max(100_000_000).nullable(),
  listedPriceLabel: z.string().max(1000).nullable().optional(),
  note: z.string().trim().max(1000).default(''),
}).strict().refine(value => value.listedPriceLabel == null ||
  parseListedPrice(value.listedPriceLabel).cents === value.listedPriceCents,
{ path: ['listedPriceCents'], message: '报价金额与文字不一致' });

// Used by both concrete rides and weekly templates. Timing belongs to their
// respective stop schemas; these are the shared offer business fields only.
export const offerFieldsSchema = commonFieldsSchema.safeExtend({
  kind: z.literal('offer'), seatCapacity: z.number().int().min(1).max(8),
});

export function orderedStopsSchema<T extends z.ZodType<{ kind: 'departure' | 'destination' }>>(stopSchema: T) {
  return z.array(stopSchema).min(2).max(20).superRefine((stops, context) => {
    const departures = stops.filter(stop => stop.kind === 'departure').length;
    const destinations = stops.length - departures;
    if (departures < 1 || departures > 10 || destinations < 1 || destinations > 10) {
      context.addIssue({ code: 'custom', message: '路线必须包含 1–10 个出发站和 1–10 个到达站' });
    }
    let destinationSeen = false;
    stops.forEach((stop, index) => {
      if (stop.kind === 'destination') destinationSeen = true;
      else if (destinationSeen) context.addIssue({ code: 'custom', path: [index, 'kind'], message: '出发站必须全部位于到达站之前' });
    });
  });
}

export const rideStopSchema = z.discriminatedUnion('kind', [
  placeSchema.extend({ kind: z.literal('departure'), departureAt: z.string().datetime() }),
  placeSchema.extend({ kind: z.literal('destination') }),
]);
export const rideStopsSchema = orderedStopsSchema(rideStopSchema).superRefine((stops, context) => {
  let previous = -Infinity;
  stops.forEach((stop, index) => {
    if (stop.kind !== 'departure') return;
    const at = Date.parse(stop.departureAt);
    if (at < previous) context.addIssue({ code: 'custom', path: [index, 'departureAt'], message: '出发站时间不能早于前一站' });
    previous = at;
  });
});

const routeFields = { stops: rideStopsSchema, timeZone: z.literal('America/New_York') };

export const createRideSchema = z.discriminatedUnion('kind', [
  offerFieldsSchema.safeExtend(routeFields),
  commonFieldsSchema.safeExtend({ ...routeFields, kind: z.literal('request'),
    partySize: z.number().int().min(1).max(4), largeLuggageCount: z.number().int().min(0).max(20).default(0) }),
]);

export const joinRideSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('passenger'), seatCount: z.number().int().min(1).max(8),
    pickupAddress: z.string().trim().min(1).max(60).optional(),
    dropoffAddress: z.string().trim().min(1).max(60).optional() }).strict(),
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
