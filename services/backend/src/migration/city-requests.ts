import { createHash } from 'node:crypto';
import type { IssueReporter, UserRow } from './types.ts';
import { indexMigrationUsers, object, parseExportTimestamp, text } from './values.ts';

export type CityRequestRow = { id: string; userId: string; cityKey: string; cityLabel: string; cityAliases: string[]; sourcePage: string; createdAt: string };
const eventFields = new Set(['_id', 'cityKey', 'cityLabel', 'cityAliases', 'sourcePage', 'openid', 'createdAt']);
const summaryFields = new Set(['_id', 'cityKey', 'cityLabel', 'cityAliases', 'sourcePage', 'requestCount', 'requestOpenids', 'createdAt', 'updatedAt']);
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max &&
  value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const cityKey = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) && !['ny_nj', 'ny', 'nj'].includes(value);
const aliases = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 100 &&
  value.every(item => bounded(item, 200)) && new Set(value).size === value.length;
export function migrationCityRequestId(appId: string, sourceId: string) {
  const bytes = createHash('sha256').update(JSON.stringify(['linkx-city-request-v1', appId, sourceId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 128; bytes[8] = (bytes[8]! & 63) | 128;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Never reconstruct click events from an old cumulative counter. The old
 * event write was best-effort; a mismatch needs explicit investigation before
 * cutover. Both complete source collections remain in migration_sources. */
export function normalizeCityRequests(events: unknown, summaries: unknown, users: UserRow[], appId: string, issue: IssueReporter): CityRequestRow[] {
  const error = (code: string, field = '-') => issue('other', code, `cityRequests.${field}`);
  if (!Array.isArray(events) || !Array.isArray(summaries)) { error('INCOMPLETE_CITY_REQUEST_SOURCE'); return []; }
  const userMap = indexMigrationUsers(users, appId, issue), ids = new Set<string>();
  const rows: CityRequestRow[] = [], expected = new Map<string, { count: number; identities: Set<string> }>();
  for (const raw of events) {
    if (!object(raw)) { error('INVALID_DOCUMENT', 'events'); continue; }
    const at = parseExportTimestamp(raw.createdAt), user = text(raw.openid) ? userMap.get(raw.openid) : undefined;
    if (Object.keys(raw).some(key => !eventFields.has(key))) { error('UNMAPPED_FIELD', 'events'); continue; }
    if (!bounded(raw._id, 160) || ids.has(raw._id) || !cityKey(raw.cityKey) || !bounded(raw.cityLabel, 200) ||
      !aliases(raw.cityAliases) || !bounded(raw.sourcePage, 40) || !at) { error('INVALID_CITY_REQUEST', 'events'); continue; }
    if (!user) { error('UNVERIFIED_CITY_REQUEST_IDENTITY', 'openid'); continue; }
    ids.add(raw._id);
    rows.push({ id: migrationCityRequestId(appId, raw._id), userId: user.id, cityKey: raw.cityKey, cityLabel: raw.cityLabel,
      cityAliases: raw.cityAliases.slice(), sourcePage: raw.sourcePage, createdAt: at });
    const summary = expected.get(raw.cityKey) || { count: 0, identities: new Set<string>() };
    summary.count++; summary.identities.add(raw.openid as string); expected.set(raw.cityKey, summary);
  }
  const cities = new Set<string>();
  for (const raw of summaries) {
    if (!object(raw)) { error('INVALID_DOCUMENT', 'summaries'); continue; }
    if (Object.keys(raw).some(key => !summaryFields.has(key))) { error('UNMAPPED_FIELD', 'summaries'); continue; }
    const created = parseExportTimestamp(raw.createdAt), updated = parseExportTimestamp(raw.updatedAt);
    if (!cityKey(raw.cityKey) || raw._id !== `ride_city_${raw.cityKey}` || cities.has(raw.cityKey) || !bounded(raw.cityLabel, 200) ||
      !aliases(raw.cityAliases) || !bounded(raw.sourcePage, 40) || !created || !updated || created > updated ||
      !Number.isSafeInteger(raw.requestCount) || (raw.requestCount as number) < 1 || !Array.isArray(raw.requestOpenids) ||
      raw.requestOpenids.some(id => !bounded(id, 128) || !userMap.has(id)) || new Set(raw.requestOpenids).size !== raw.requestOpenids.length) {
      error('INVALID_CITY_REQUEST_SUMMARY', 'summaries'); continue;
    }
    cities.add(raw.cityKey);
    const expectedCity = expected.get(raw.cityKey);
    if (!expectedCity || raw.requestCount !== expectedCity.count || raw.requestOpenids.length !== expectedCity.identities.size ||
      raw.requestOpenids.some(id => !expectedCity.identities.has(id as string))) error('CITY_REQUEST_SUMMARY_MISMATCH');
  }
  if ([...expected.keys()].some(city => !cities.has(city))) error('CITY_REQUEST_SUMMARY_MISMATCH');
  return rows;
}
