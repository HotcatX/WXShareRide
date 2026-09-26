import { createHash } from 'node:crypto';
import { createTemplateSchema, templateIdSchema } from '../templates/schemas.ts';
import type { TemplateDefinition } from '../templates/schemas.ts';
import { parseListedPrice } from '../prices.ts';
import { serializeSource } from './source.ts';
import { indexMigrationUsers, parseExportTimestamp } from './values.ts';

type User = { id: string; openid: string; appId: string };
type Issue = (collection: 'other', code: string, field?: string, severity?: 'error' | 'notice') => void;
export type TemplateRow = {
  id: string; sourceId: string; userId: string; name: string; weekday: number;
  localTime: string; timeZone: 'America/New_York'; definition: TemplateDefinition;
  createdAt: string; updatedAt: string | null;
};

const fields = new Set(['_id', '_openid', 'templateName', 'departureAddress', 'destinationAddress',
  'weekdayIndex', 'weekdayText', 'departureTime', 'passengerCount', 'referencePrice', 'comment',
  'carBrand', 'carModel', 'carNumber', 'driverID', 'zelle', 'createdAt', 'updatedAt']);
const archivedStrings = ['carBrand', 'carModel', 'carNumber', 'driverID'] as const;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value === value.trim();

/** App-scoped source identity, independent of owner/profile changes. Not an authentication mechanism. */
function templateId(appId: string, sourceId: string): string {
  // PostgreSQL uuid ignores letter case; collision checks must use its identity.
  if (templateIdSchema.safeParse(sourceId).success) return sourceId.toLowerCase();
  const bytes = createHash('sha256').update(JSON.stringify(['linkx-template-v1', appId, sourceId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Pure, private candidate mapping. The parent must archive every source document
 * and reject the entire migration plan on any error; returned rows are not an
 * independently importable subset. Never print rows or unknown source values.
 */
export function normalizeTemplates(documents: unknown, users: readonly User[], issue: Issue): TemplateRow[] {
  if (!Array.isArray(documents)) { issue('other', 'INVALID_TEMPLATE_COLLECTION', 'templates'); return []; }
  const appId = users[0]?.appId;
  if (users.length && !identity(appId)) { issue('other', 'INVALID_USER_MAPPING', 'users'); return []; }
  let invalidUsers = false;
  const owners = indexMigrationUsers(users, appId ?? '', (_collection, code, field, severity) => {
    invalidUsers = true; issue('other', code, field, severity);
  });
  if (invalidUsers) return [];
  const rows: TemplateRow[] = [];
  const sourceIds = new Set<string>();
  const targetIds = new Set<string>();
  for (const raw of documents) {
    let valid = true;
    const error = (code: string, field = 'templates') => { valid = false; issue('other', code, field); };
    const notice = (code: string, field = 'templates') => issue('other', code, field, 'notice');
    if (!object(raw)) { error('INVALID_TEMPLATE_DOCUMENT'); continue; }
    try { serializeSource(raw); } catch { error('INVALID_SOURCE_JSON'); continue; }
    for (const key of Object.keys(raw)) if (!fields.has(key)) error('UNMAPPED_TEMPLATE_FIELD');
    if (!identity(raw._id)) { error('INVALID_TEMPLATE_SOURCE_ID'); continue; }
    if (sourceIds.has(raw._id)) { error('DUPLICATE_TEMPLATE_SOURCE_ID'); continue; }
    sourceIds.add(raw._id);
    const owner = identity(raw._openid) ? owners.get(raw._openid) : undefined;
    if (!owner) { error('UNKNOWN_TEMPLATE_USER', 'owner'); continue; }
    const id = templateId(owner.appId, raw._id);
    if (targetIds.has(id)) { error('DUPLICATE_TEMPLATE_ID'); continue; }
    targetIds.add(id);
    if (id !== raw._id) notice('TEMPLATE_ID_MAPPED');

    const text = (key: 'templateName' | 'departureAddress' | 'destinationAddress' | 'comment', maximum: number, optional = false): string => {
      const value = raw[key];
      if (value === undefined && optional) return '';
      if (typeof value !== 'string' || (!optional && !value.trim()) || value.trim().length > maximum) {
        error('INVALID_TEMPLATE_TEXT', key); return '';
      }
      if (value !== value.trim()) notice('TEMPLATE_TEXT_NORMALIZED', key);
      return value.trim();
    };
    const name = text('templateName', 120);
    const departureAddress = text('departureAddress', 300);
    const destinationAddress = text('destinationAddress', 300);
    const note = text('comment', 1000, true);
    const weekday = typeof raw.weekdayIndex === 'number' && Number.isInteger(raw.weekdayIndex) && raw.weekdayIndex >= 0 && raw.weekdayIndex <= 6
      ? (raw.weekdayIndex + 1) % 7 : null;
    if (weekday === null) error('INVALID_TEMPLATE_WEEKDAY', 'weekday');
    if (raw.weekdayText !== undefined) {
      const match = typeof raw.weekdayText === 'string' ? /^(?:每周|周|星期)([一二三四五六日天])$/.exec(raw.weekdayText.trim()) : null;
      const textIndex = match ? '一二三四五六日'.indexOf(match[1] === '天' ? '日' : match[1]!) : -1;
      if (textIndex < 0 || textIndex !== raw.weekdayIndex) error('CONFLICTING_TEMPLATE_WEEKDAY', 'weekday');
    }
    if (typeof raw.departureTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.departureTime)) error('INVALID_TEMPLATE_TIME', 'localTime');
    // The current template editor and applyDriverShortcut both use safeSeat('')
    // = 1, then expose an editable seat input and a publication confirmation.
    // Preserve only that verified template default; never infer a ride capacity.
    const seatCapacity = raw.passengerCount === '' ? 1 : typeof raw.passengerCount === 'number' ? raw.passengerCount
      : typeof raw.passengerCount === 'string' && /^[1-8]$/.test(raw.passengerCount.trim()) ? Number(raw.passengerCount.trim()) : NaN;
    if (!Number.isInteger(seatCapacity) || seatCapacity < 1 || seatCapacity > 8) error('INVALID_TEMPLATE_SEAT_COUNT', 'seatCapacity');
    else if (raw.passengerCount === '') notice('TEMPLATE_DEFAULT_SEAT_APPLIED', 'seatCapacity');
    else if (typeof raw.passengerCount === 'string') notice('TEMPLATE_SEAT_STRING_NORMALIZED', 'seatCapacity');
    const price = parseListedPrice(raw.referencePrice);
    if (price.classification === 'unresolved') {
      if (typeof raw.referencePrice === 'string') notice('PRICE_TEXT_PRESERVED', 'listedPriceLabel');
      else error('INVALID_TEMPLATE_PRICE_VALUE', 'listedPriceLabel');
    }
    // driverID is an old userInfo document ID, not an OpenID or a second owner.
    // These unused publication snapshots remain only in the parent's source archive.
    for (const key of archivedStrings) if (raw[key] !== undefined && typeof raw[key] !== 'string') error('INVALID_TEMPLATE_METADATA', 'legacyMetadata');
    if (raw.zelle !== undefined && raw.zelle !== 'yes' && raw.zelle !== 'no') error('INVALID_TEMPLATE_METADATA', 'legacyMetadata');
    if (archivedStrings.some(key => raw[key] !== undefined) || raw.zelle !== undefined || raw.weekdayText !== undefined) notice('TEMPLATE_METADATA_ARCHIVED', 'legacyMetadata');
    const createdAt = parseExportTimestamp(raw.createdAt);
    if (createdAt === null) error('INVALID_TEMPLATE_TIMESTAMP', 'createdAt');
    const updatedAt = raw.updatedAt === undefined || raw.updatedAt === null || raw.updatedAt === '' ? null : parseExportTimestamp(raw.updatedAt);
    if (updatedAt === null) {
      if (raw.updatedAt === undefined || raw.updatedAt === null || raw.updatedAt === '') notice('UNKNOWN_TEMPLATE_UPDATED_AT', 'updatedAt');
      else error('INVALID_TEMPLATE_TIMESTAMP', 'updatedAt');
    }
    if (createdAt && updatedAt && updatedAt < createdAt) error('INVALID_TEMPLATE_TIMESTAMP_ORDER', 'updatedAt');
    const normalized = createTemplateSchema.safeParse({ name, weekday, localTime: raw.departureTime, timeZone: 'America/New_York',
      definition: { kind: 'offer', cityKey: 'ny_nj', seatCapacity, listedPriceCents: price.cents, listedPriceLabel: price.label, note,
        stops: [{ kind: 'departure', address: departureAddress, offsetMinutes: 0 }, { kind: 'destination', address: destinationAddress }] } });
    if (!normalized.success) error('INVALID_TEMPLATE_DEFINITION', 'definition');
    if (valid && normalized.success && createdAt) rows.push({ id, sourceId: raw._id, userId: owner.id, ...normalized.data, createdAt, updatedAt });
  }
  return rows;
}
