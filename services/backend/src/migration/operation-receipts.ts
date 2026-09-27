import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { compatOperation, parseCompatAction } from '../compat/contract.ts';
import { idempotencyInput } from '../db.ts';
import { serializeSource } from './source.ts';
import { indexMigrationUsers, object, parseExportTimestamp } from './values.ts';
import type { Document, IssueReporter, UserRow } from './types.ts';

export type OperationReceiptRow = {
  userId: string; operation: string; requestKey: string; payloadHash: string;
  responseStatus: 200; responseBody: Document; createdAt: string;
};
type Context = { appId: string; users: readonly Pick<UserRow, 'id' | 'openid' | 'appId'>[] };
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z0-9:_-]{1,160}$/);
const count = z.number().int().min(0);
const exportedTime = z.custom<unknown>(value => !!parseExportTimestamp(value));
const common = {
  _id: hex, id: hex, appId: z.string().min(1), openid: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  action: z.string(), key: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  payload: z.record(z.string(), z.unknown()), payloadHash: hex, state: z.literal('completed'),
  response: z.record(z.string(), z.unknown()), createdAt: exportedTime, completedAt: exportedTime,
};
const single = z.strictObject(common);
const bulk = z.strictObject({ ...common, targets: z.array(id), offset: count, affected: count });
const templateFields = new Set(['_id', '_openid', 'createdAt', 'updatedAt', 'templateName', 'departureAddress',
  'destinationAddress', 'weekdayIndex', 'weekdayText', 'departureTime', 'passengerCount', 'referencePrice',
  'comment', 'carNumber', 'carBrand', 'carModel', 'driverID', 'zelle']);
const metadata = ['carNumber', 'carBrand', 'carModel', 'driverID'] as const;
const uuidV4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function responseFor(action: string, payload: Document, response: Document, openid: string, createdAt: string): Document | null {
  if (action === 'templates.create' || action === 'templates.update') {
    const form = payload.form as Document;
    if (Object.keys(response).some(key => !templateFields.has(key)) || response._openid !== openid ||
      typeof response._id !== 'string' ||
      (action === 'templates.create' ? !uuidV4.test(response._id) : response._id !== payload.id) ||
      Object.entries(form).some(([key, value]) => !Object.hasOwn(response, key) || !isDeepStrictEqual(response[key], value))) return null;
    // An update spreads the previous template before the validated form. Keep
    // only the already reviewed historical metadata, including old driverID;
    // it is a snapshot, never a new owner or editable profile field.
    if (metadata.some(key => response[key] !== undefined && typeof response[key] !== 'string') ||
      (response.zelle !== undefined && response.zelle !== 'yes' && response.zelle !== 'no')) return null;
    if (action === 'templates.create' && Object.keys(response).some(key =>
      !['_id', '_openid', 'createdAt', 'updatedAt'].includes(key) && !Object.hasOwn(form, key))) return null;
    const created = parseExportTimestamp(response.createdAt), updated = parseExportTimestamp(response.updatedAt);
    if (!created || !updated || created > updated || updated > createdAt || action === 'templates.create' && created !== updated) return null;
    // Actual CloudBase export uses {$date}; the verified wx.cloud create/retry
    // wire reply uses ISO strings. Convert ONLY these two known Date fields.
    // The central migration_sources document retains the raw exported JSON.
    return { ...response, createdAt: created, updatedAt: updated };
  }
  if (action === 'templates.delete') {
    const parsed = z.strictObject({ id, deleted: z.literal(true) }).safeParse(response);
    return parsed.success && parsed.data.id === payload.id ? response : null;
  }
  if (action === 'notifications.read') {
    const parsed = z.strictObject({ id, read: z.literal(true) }).safeParse(response);
    return parsed.success && parsed.data.id === payload.id ? response : null;
  }
  if (action === 'notifications.readAll' || action === 'notifications.clear') {
    const schema = action === 'notifications.readAll' ? z.strictObject({ changed: count }) : z.strictObject({ deleted: count });
    return schema.safeParse(response).success ? response : null;
  }
  const parsed = z.strictObject({ field: z.enum(['pickupSpot', 'dropoffSpot']), values: z.array(z.string()).max(20) }).safeParse(response);
  if (!parsed.success || parsed.data.field !== payload.field) return null;
  const values = parsed.data.values;
  // Existing strings retain their exact spelling/order. Only additions pass
  // through Set; removal can leave pre-existing duplicates of another value.
  if (action === 'profile.spots.add') {
    if (!values.includes(payload.value as string) || new Set(values).size !== values.length) return null;
  } else if (values.includes(payload.value as string)) return null;
  return response;
}

/** Import completed handoff receipts into the existing user idempotency table.
 * This never executes their bodies or reconstructs replies from current rows.
 * A deleted template/notification may still have a valid permanent receipt.
 * Any invalid row rejects the complete group and therefore the whole import. */
export function normalizeOperationReceipts(documents: unknown, context: Context, issue: IssueReporter): OperationReceiptRow[] {
  let failed = false;
  const error = (code: string) => { failed = true; issue('other', code, 'OperationReceipts'); };
  if (!context || typeof context.appId !== 'string' || !context.appId || context.appId !== context.appId.trim() || !Array.isArray(context.users)) {
    error('INVALID_OPERATION_RECEIPT_CONTEXT'); return [];
  }
  const users = indexMigrationUsers(context.users, context.appId, (_collection, code) => error(code));
  if (!Array.isArray(documents)) { error('INVALID_OPERATION_RECEIPT_COLLECTION'); return []; }
  const rows: OperationReceiptRow[] = [], ids = new Set<string>(), scopes = new Set<string>();
  for (const raw of documents) {
    try { serializeSource(raw); } catch { error('INVALID_SOURCE_JSON'); continue; }
    if (object(raw) && raw.state === 'prepared') { error('OPERATION_RECEIPT_NOT_COMPLETED'); continue; }
    const isBulk = object(raw) && ['notifications.readAll', 'notifications.clear'].includes(raw.action as string);
    const parsed = (isBulk ? bulk : single).safeParse(raw);
    if (!parsed.success) { error('INVALID_OPERATION_RECEIPT'); continue; }
    const value = parsed.data, user = users.get(value.openid);
    if (!user || value.appId !== context.appId) { error('UNKNOWN_OPERATION_RECEIPT_OWNER'); continue; }
    const expectedId = createHash('sha256').update(JSON.stringify([value.appId, value.openid, value.action, value.key])).digest('hex');
    if (value.id !== expectedId || value._id !== expectedId) { error('INVALID_OPERATION_RECEIPT_ID'); continue; }
    let operation: string, payload: Document;
    try {
      payload = parseCompatAction(value.action, value.payload, { writeOnly: true });
      operation = compatOperation(value.action);
      if (idempotencyInput(value.key, payload).hash !== value.payloadHash) { error('INVALID_OPERATION_RECEIPT_HASH'); continue; }
    } catch { error('INVALID_OPERATION_RECEIPT_PAYLOAD'); continue; }
    const scope = JSON.stringify([user.id, operation, value.key]);
    if (ids.has(value.id) || scopes.has(scope)) { error('DUPLICATE_OPERATION_RECEIPT'); continue; }
    ids.add(value.id); scopes.add(scope);
    const createdAt = parseExportTimestamp(value.createdAt)!, completedAt = parseExportTimestamp(value.completedAt)!;
    if (completedAt < createdAt) { error('INVALID_OPERATION_RECEIPT_TIME'); continue; }
    if (isBulk) {
      const row = value as z.infer<typeof bulk>;
      if (Buffer.byteLength(JSON.stringify(row.targets)) > 512000 || row.targets.some((target, index) => index > 0 && target <= row.targets[index - 1]!) ||
        row.offset !== row.targets.length || row.affected > row.targets.length ||
        row.response[value.action === 'notifications.readAll' ? 'changed' : 'deleted'] !== row.affected) {
        error('INVALID_OPERATION_RECEIPT_PROGRESS'); continue;
      }
    }
    const responseBody = responseFor(value.action, payload, value.response, value.openid, createdAt);
    if (!responseBody) { error('INVALID_OPERATION_RECEIPT_RESPONSE'); continue; }
    rows.push({ userId: user.id, operation, requestKey: value.key, payloadHash: value.payloadHash,
      responseStatus: 200, responseBody, createdAt });
  }
  return failed ? [] : rows;
}
