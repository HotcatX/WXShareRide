import { z } from 'zod';
import { AppError } from '../errors.ts';
import { legacyRideSchemas } from './legacy-rides.ts';
import { legacyProfilesSchema } from './legacy-profiles.ts';

// Temporary wire contract of the deployed CloudBase handoff. Validate without
// trimming/defaults: the original body is the receipt's permanent identity.
// Legacy cloud query adapters have per-action read credentials. These names
// are wire aliases only, not a second domain model or database authority.
export const compatQueryActions: ReadonlySet<string> = new Set(['profile.get', 'profiles.list', ...Object.keys(legacyRideSchemas)]);
export const compatReads: ReadonlySet<string> = new Set(['identity', 'templates.list', 'templates.get', 'notifications.list', 'notifications.unread', ...compatQueryActions]);
export const compatWrites: ReadonlySet<string> = new Set(['templates.create', 'templates.update', 'templates.delete',
  'notifications.read', 'notifications.readAll', 'notifications.clear', 'profile.spots.add', 'profile.spots.remove']);
const text = (max: number, empty = false) => z.string().max(max).refine(value => value === value.trim() &&
  (empty || value.length > 0) && !/[\u0000-\u001f\u007f-\u009f]/.test(value));
const id = z.string().regex(/^[A-Za-z0-9:_-]{1,160}$/);
const empty = z.strictObject({});
export const compatTemplateForm = z.strictObject({
  templateName: text(120), departureAddress: text(300), destinationAddress: text(300),
  weekdayIndex: z.number().int().min(0).max(6), weekdayText: z.string(),
  departureTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), passengerCount: z.number().int().min(1).max(8),
  referencePrice: text(1000, true), comment: text(1000, true),
  carNumber: text(100, true).optional(), carBrand: text(100, true).optional(), carModel: text(100, true).optional(),
  zelle: z.enum(['yes', 'no']).optional(),
}).refine(value => value.departureAddress !== value.destinationAddress &&
  value.weekdayText === ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][value.weekdayIndex]);
const schemas: Record<string, z.ZodType> = {
  ...legacyRideSchemas, 'profiles.list': legacyProfilesSchema,
  identity: empty, 'profile.get': empty, 'templates.list': z.strictObject({ page: z.number().int().min(1).max(1000) }),
  'templates.get': z.strictObject({ id }), 'templates.create': z.strictObject({ form: compatTemplateForm }),
  'templates.update': z.strictObject({ id, form: compatTemplateForm }), 'templates.delete': z.strictObject({ id }),
  'notifications.list': empty, 'notifications.unread': empty, 'notifications.read': z.strictObject({ id }),
  'notifications.readAll': empty, 'notifications.clear': empty,
  'profile.spots.add': z.strictObject({ field: z.enum(['pickupSpot', 'dropoffSpot']), value: text(300) }),
  'profile.spots.remove': z.strictObject({ field: z.enum(['pickupSpot', 'dropoffSpot']), value: text(300) }),
};
export function parseCompatAction(action: unknown, body: unknown, options: { writeOnly?: boolean } = {}): Record<string, unknown> {
  if (typeof action !== 'string' || !(options.writeOnly ? compatWrites.has(action) : compatWrites.has(action) || compatReads.has(action))) {
    throw new AppError(400, 'INVALID_ACTION', '操作类型无效');
  }
  if (Object.hasOwn(legacyRideSchemas, action) && !schemas[action]!.safeParse(body).success) {
    throw new AppError(409, 'LEGACY_READ_UPGRADE_REQUIRED', '此读取方式已升级，请使用新版小程序');
  }
  schemas[action]!.parse(body);
  if (Buffer.byteLength(JSON.stringify(body)) > 65536) throw new AppError(400, 'INVALID_INPUT', '请求内容过大');
  return body as Record<string, unknown>;
}
export function compatOperation(action: string): string {
  if (!compatWrites.has(action)) throw new AppError(400, 'INVALID_ACTION', '操作类型无效');
  return `compat.${action}`;
}
