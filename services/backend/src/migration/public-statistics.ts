import type { IssueReporter } from './types.ts';
import { object, parseExportTimestamp, text } from './values.ts';
import { serializeSource } from './source.ts';

export type PublicStatisticsRow = { appId: string; servedCount: number; coverageText: string | null; updatedAt: string };
const fields = new Set(['_id', 'servedTrips', 'coverageText', 'createdAt', 'updatedAt', 'lastServedAt',
  'servedTripsLastDelta', 'servedTripsLastSource', 'servedTripsLastTripId', 'servedTripsLastCollection']);
const lastFields = ['lastServedAt', 'servedTripsLastDelta', 'servedTripsLastSource', 'servedTripsLastTripId', 'servedTripsLastCollection'];

/** Preserve the authoritative total; surviving ride deltas cannot reconstruct its baseline. */
export function normalizePublicStatistics(documents: unknown, appId: string, issue: IssueReporter): PublicStatisticsRow[] {
  let valid = true;
  const error = (code: string, field = '-') => { valid = false; issue('other', code, `PublicStats.${field}`); };
  if (!text(appId) || appId !== appId.trim()) error('INVALID_APP_ID');
  if (!Array.isArray(documents) || documents.length !== 1) { error('PUBLIC_STATS_BASELINE_REQUIRED'); return []; }
  try { serializeSource(documents); } catch { error('INVALID_SOURCE_JSON'); return []; }
  const raw = documents[0];
  if (!object(raw)) { error('INVALID_DOCUMENT'); return []; }
  for (const key of Object.keys(raw)) if (!fields.has(key)) error('UNMAPPED_FIELD');
  if (raw._id !== 'home') error('UNKNOWN_PUBLIC_STATS_DOCUMENT', '_id');
  if (typeof raw.servedTrips !== 'number' || !Number.isSafeInteger(raw.servedTrips) || raw.servedTrips < 0) error('INVALID_SERVED_COUNT', 'servedTrips');
  let coverageText: string | null = null;
  if (raw.coverageText !== undefined && raw.coverageText !== null) {
    if (typeof raw.coverageText !== 'string' || raw.coverageText.length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(raw.coverageText)) error('INVALID_COVERAGE', 'coverageText');
    else coverageText = raw.coverageText;
  }
  const updatedAt = parseExportTimestamp(raw.updatedAt);
  if (!updatedAt) error('MISSING_OR_INVALID_TIMESTAMP', 'updatedAt');
  if (raw.createdAt !== undefined) {
    const createdAt = parseExportTimestamp(raw.createdAt);
    if (!createdAt) error('MISSING_OR_INVALID_TIMESTAMP', 'createdAt');
    else if (updatedAt && createdAt > updatedAt) error('TIMESTAMP_ORDER', 'createdAt');
  }
  if (lastFields.some(field => raw[field] !== undefined)) {
    const at = parseExportTimestamp(raw.lastServedAt);
    if (!at) error('MISSING_OR_INVALID_TIMESTAMP', 'lastServedAt');
    else if (updatedAt && at > updatedAt) error('TIMESTAMP_ORDER', 'lastServedAt');
    if (typeof raw.servedTripsLastDelta !== 'number' || !Number.isInteger(raw.servedTripsLastDelta) || raw.servedTripsLastDelta < 1 || raw.servedTripsLastDelta > 5) error('INVALID_LAST_DELTA', 'servedTripsLastDelta');
    if (typeof raw.servedTrips === 'number' && typeof raw.servedTripsLastDelta === 'number' && raw.servedTripsLastDelta > raw.servedTrips) error('INVALID_LAST_DELTA', 'servedTripsLastDelta');
    if (!text(raw.servedTripsLastTripId) || !/^[a-zA-Z0-9:_-]{1,160}$/.test(raw.servedTripsLastTripId)) error('INVALID_RIDE_ID', 'servedTripsLastTripId');
    const kind = raw.servedTripsLastCollection === 'Carpool' ? 'carpool' : raw.servedTripsLastCollection === 'CarpoolRequest' ? 'request' : null;
    if (!kind || typeof raw.servedTripsLastSource !== 'string' || ![`syncTripStatus:${kind}`, `syncMyTripStatus:${kind}`].includes(raw.servedTripsLastSource)) error('INVALID_LAST_SOURCE', 'servedTripsLastSource');
    // It is a navigational audit reference, not an instruction to create a
    // deleted ride or to replay its last delta into the already cumulative total.
  }
  return valid ? [{ appId, servedCount: raw.servedTrips as number, coverageText, updatedAt: updatedAt! }] : [];
}
