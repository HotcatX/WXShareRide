import { z } from 'zod';
import { offerFieldsSchema, orderedStopsSchema, placeSchema } from '../rides/schemas.ts';

export const templateStopSchema = z.discriminatedUnion('kind', [
  placeSchema.extend({ kind: z.literal('departure'), offsetMinutes: z.number().int().min(0).max(1440) }),
  placeSchema.extend({ kind: z.literal('destination') }),
]);
export const templateStopsSchema = orderedStopsSchema(templateStopSchema).superRefine((stops, context) => {
  let previous: number | undefined;
  stops.forEach((stop, index) => {
    if (stop.kind !== 'departure') return;
    if (previous === undefined && stop.offsetMinutes !== 0) {
      context.addIssue({ code: 'custom', path: [index, 'offsetMinutes'], message: '首个出发站的时间偏移必须为 0' });
    } else if (previous !== undefined && stop.offsetMinutes < previous) {
      context.addIssue({ code: 'custom', path: [index, 'offsetMinutes'], message: '出发站时间偏移不能早于前一站' });
    }
    previous = stop.offsetMinutes;
  });
});

// Only fields actually used to publish an offer belong to a template. Vehicle
// and payment preferences stay in the owner's profile, not editable copies here.
export const templateDefinitionSchema = offerFieldsSchema.extend({ stops: templateStopsSchema });
export const weeklyScheduleSchema = z.strictObject({
  weekday: z.number().int().min(0).max(6),
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timeZone: z.literal('America/New_York'),
});
export const createTemplateSchema = weeklyScheduleSchema.extend({
  name: z.string().trim().min(1).max(120),
  definition: templateDefinitionSchema,
});
export const updateTemplateSchema = createTemplateSchema.partial().refine(value => Object.keys(value).length > 0);
export const templateIdSchema = z.uuid();
export const listTemplatesSchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
export type TemplateDefinition = z.infer<typeof templateDefinitionSchema>;
export type TemplateStop = z.infer<typeof templateStopSchema>;
export type WeeklySchedule = z.infer<typeof weeklyScheduleSchema>;
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
