import type { Document, Collection, IssueReporter, UserRow } from './types.ts';

export const object = (value: unknown): value is Document => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
export const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
export const present = (value: unknown) => value !== undefined && value !== null && value !== '';

export function indexMigrationUsers(users: readonly Pick<UserRow, 'id' | 'openid' | 'appId'>[], appId: string, issue: IssueReporter) {
  const result = new Map<string, Pick<UserRow, 'id' | 'openid' | 'appId'>>();
  const ids = new Set<string>();
  for (const user of users) {
    if (!object(user) || user.appId !== appId || !text(user.openid) || user.openid.trim() !== user.openid ||
      typeof user.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(user.id) ||
      result.has(user.openid) || ids.has(user.id.toLowerCase())) {
      issue('other', 'INVALID_USER_MAPPING', 'users');
      continue;
    }
    result.set(user.openid, user);
    ids.add(user.id.toLowerCase());
  }
  return result;
}

/** CloudBase Date exports and explicit UTC/offset strings only; never host-local parsing. */
export function parseExportTimestamp(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (object(value) && Object.keys(value).length === 1 && '$date' in value) return parseExportTimestamp(value.$date);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  // Reject dates which JavaScript silently rolls into the following month.
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (!year || !month || !day || month > 12 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  const [hour, minute, second] = value.slice(11, 19).split(':').map(Number);
  if (hour! > 23 || minute! > 59 || second! > 59) return null;
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Returns all matching instants. A fall DST overlap has two; a spring gap has none. */
export function localDepartureCandidates(date: unknown, time: unknown, timeZone = 'America/New_York'): string[] {
  if (typeof date !== 'string' || typeof time !== 'string') return [];
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const clock = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match || !clock) return [];
  const expected = [+match[1]!, +match[2]!, +match[3]!, +clock[1]!, +clock[2]!];
  const [year, month, day, hour, minute] = expected as [number, number, number, number, number];
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59) return [];
  const nominal = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = (ms: number) => {
    const values = Object.fromEntries(formatter.formatToParts(new Date(ms)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    return [values.year!, values.month!, values.day!, values.hour!, values.minute!];
  };
  const offsets = new Set([-36, 0, 36].map(hours => {
    const at = nominal + hours * 3_600_000;
    const p = parts(at);
    return Date.UTC(p[0]!, p[1]! - 1, p[2]!, p[3]!, p[4]!) - at;
  }));
  return [...offsets].map(offset => nominal - offset)
    .filter(candidate => parts(candidate).every((value, i) => value === expected[i]))
    .sort((a, b) => a - b).map(ms => new Date(ms).toISOString());
}

export function migrationReaders(issue: IssueReporter) {
  const unknownFields = (doc: Document, allowed: Set<string>, collection: Collection, field = '-') => {
    for (const key of Object.keys(doc)) if (!allowed.has(key)) issue(collection, 'UNMAPPED_FIELD', field);
  };
  const alias = (doc: Document, keys: string[], collection: Collection, field: string): unknown => {
    const values = keys.map(key => doc[key]).filter(present);
    if (values.length > 1 && values.some(value => JSON.stringify(value) !== JSON.stringify(values[0]))) issue(collection, 'CONFLICTING_ALIASES', field);
    return values[0];
  };
  const stamp = (doc: Document, keys: string[], collection: Collection, field: string): string => {
    const values = keys.map(key => doc[key]).filter(present);
    const normalized = values.map(parseExportTimestamp);
    if (!normalized.length || normalized.some(value => !value)) { issue(collection, 'MISSING_OR_INVALID_TIMESTAMP', field); return ''; }
    if (normalized.some(value => value !== normalized[0])) issue(collection, 'CONFLICTING_ALIASES', field);
    return normalized[0]!;
  };
  // These clocks are independent old write paths, not competing aliases or field winners.
  const recordedUpdate = (doc: Document, keys: string[], collection: Collection): string | null => {
    const values = keys.map(key => doc[key]).filter(present);
    if (!values.length) { issue(collection, 'UNKNOWN_UPDATED_AT', 'updatedAt', 'notice'); return null; }
    const normalized = values.map(parseExportTimestamp);
    if (normalized.some(value => !value)) { issue(collection, 'MISSING_OR_INVALID_TIMESTAMP', 'updatedAt'); return null; }
    return normalized.filter((value): value is string => value !== null).sort().at(-1)!;
  };
  const joinedStamp = (doc: Document, collection: Collection): string | null => {
    if (!present(doc.joinedAt)) { issue(collection, 'MISSING_MEMBERSHIP_TIMESTAMP', 'joinedAt', 'notice'); return null; }
    return stamp(doc, ['joinedAt'], collection, 'joinedAt');
  };
  return { unknownFields, alias, stamp, recordedUpdate, joinedStamp };
}
