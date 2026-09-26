import { z } from 'zod';
import { createRideSchema } from '../rides/schemas.ts';

// Templates currently expose the existing driver/offer product only. Absolute time
// belongs to the instantiated ride; the weekly schedule is stored once outside definition.
export const templateDefinitionSchema = createRideSchema.options[0].omit({ departureAt: true, timeZone: true });
export const createTemplateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  weekday: z.number().int().min(0).max(6),
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timeZone: z.literal('America/New_York'),
  definition: templateDefinitionSchema,
});
export const updateTemplateSchema = createTemplateSchema.partial().refine(value => Object.keys(value).length > 0);
export const templateIdSchema = z.uuid();
export const listTemplatesSchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
export type TemplateDefinition = z.infer<typeof templateDefinitionSchema>;
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
