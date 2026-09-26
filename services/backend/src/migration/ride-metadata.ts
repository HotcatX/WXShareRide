import type { CompletionRow } from './completions.ts';
import type { Document, IssueReporter, RideRow } from './types.ts';
import { serializeSource } from './source.ts';
import { object, parseExportTimestamp, text } from './values.ts';

const servedFields = ['servedStatsCounted', 'servedStatsCountedAt', 'servedStatsDelta', 'servedStatsSource'] as const;
const completionFields = ['_rideCompletionVersion', '_rideCompletionCheckedAt', '_rideCompletionSettled', '_rideCompletionParticipantCount'] as const;
export const rideMetadataFields = [
  ...servedFields, ...completionFields, 'driverID', 'routeCityKey', 'routeCityLabel',
  'completedAt', 'completedBy', 'statsDriverCounted',
] as const;

type RideCollection = 'Carpool' | 'CarpoolRequest';
export type RideMetadataContext = {
  sourceUsers: readonly Document[];
  ride: Pick<RideRow, 'id' | 'kind' | 'status' | 'cityKey' | 'createdAt'>;
  completions: readonly CompletionRow[];
  lastDepartureAt: string;
};
const servedSources = {
  Carpool: new Set(['syncTripStatus:carpool', 'syncMyTripStatus:carpool', 'updateCarpoolStatus',
    'driverCompleteTrip', 'tripManageCompleteCarpool']),
  CarpoolRequest: new Set(['syncTripStatus:request', 'syncMyTripStatus:request', 'updateCarpoolRequestStatus',
    'creatorQuitAndClose', 'tripManageCompleteRequest']),
};

/** Validate archived metadata without creating membership, counters, or events. */
export function validateRideMetadata(
  raw: Document, collection: RideCollection, context: RideMetadataContext, issue: IssueReporter,
): void {
  if (!object(raw)) { issue(collection, 'INVALID_DOCUMENT'); return; }
  try { serializeSource(raw); } catch { issue(collection, 'INVALID_SOURCE_JSON'); return; }
  const { ride } = context;
  if (ride.id !== raw._id || ride.kind !== (collection === 'Carpool' ? 'offer' : 'request')) {
    issue(collection, 'INVALID_RIDE_MAPPING', 'rides'); return;
  }
  const has = (field: string) => Object.hasOwn(raw, field);
  // An export cutoff may close an expired raw-open ride. It must not disguise
  // existing counting markers: the new close job would otherwise count again.
  const sourceClosed = ['past', 'close', 'closed'].includes(String(raw.status)) && ride.status === 'closed';
  const requireClosed = (field: string) => {
    if (!sourceClosed) issue(collection, 'COUNTED_RIDE_NOT_CLOSED', field);
  };
  const timestamp = (field: string): string | null => {
    const value = parseExportTimestamp(raw[field]);
    if (!value) issue(collection, 'MISSING_OR_INVALID_TIMESTAMP', field);
    else if (value < ride.createdAt) issue(collection, 'INVALID_TIMESTAMP_ORDER', field);
    return value;
  };
  const completeGroup = (fields: readonly string[], field: string): boolean => {
    const count = fields.filter(has).length;
    if (count && count !== fields.length) issue(collection, 'INCOMPLETE_RIDE_METADATA', field);
    return count === fields.length;
  };

  if (completeGroup(servedFields, 'servedStats')) {
    if (raw.servedStatsCounted !== true) issue(collection, 'INVALID_SERVED_STATS_FLAG', 'servedStatsCounted');
    if (typeof raw.servedStatsDelta !== 'number' || !Number.isInteger(raw.servedStatsDelta) ||
      raw.servedStatsDelta < 0 || raw.servedStatsDelta > 5) issue(collection, 'INVALID_SERVED_STATS_DELTA', 'servedStatsDelta');
    if (typeof raw.servedStatsSource !== 'string' || !servedSources[collection].has(raw.servedStatsSource)) {
      issue(collection, 'INVALID_SERVED_STATS_SOURCE', 'servedStatsSource');
    }
    timestamp('servedStatsCountedAt');
    requireClosed('servedStats');
  }

  if (completeGroup(completionFields, '_rideCompletion')) {
    if (raw._rideCompletionVersion !== 1) issue(collection, 'INVALID_COMPLETION_VERSION', '_rideCompletionVersion');
    const checkedAt = timestamp('_rideCompletionCheckedAt');
    if (checkedAt && checkedAt < context.lastDepartureAt) issue(collection, 'PREMATURE_COMPLETION_CHECKPOINT', '_rideCompletionCheckedAt');
    requireClosed('_rideCompletion');
    const settled = raw._rideCompletionSettled;
    if (typeof settled !== 'boolean') issue(collection, 'INVALID_COMPLETION_SETTLED', '_rideCompletionSettled');
    const count = raw._rideCompletionParticipantCount;
    if (typeof count !== 'number' || !Number.isInteger(count) ||
      (settled === true ? count < 2 || count > 40 : count !== 0)) {
      issue(collection, 'INVALID_COMPLETION_PARTICIPANT_COUNT', '_rideCompletionParticipantCount');
    } else if (settled === true) {
      // Some original recipients have since left. Current members are not
      // evidence for changing the first committed completion snapshot.
      const receiptCount = new Set(context.completions.filter(row => row.rideId === ride.id).map(row => row.userId)).size;
      if (receiptCount !== count) issue(collection, 'COMPLETION_CHECKPOINT_MISMATCH', '_rideCompletionParticipantCount');
    }
  }

  if (has('driverID')) {
    const value = raw.driverID;
    if (typeof value !== 'string' || value.trim() !== value) issue(collection, 'INVALID_DRIVER_ALIAS', 'driverID');
    else if (value) {
      if (collection === 'CarpoolRequest') {
        if (value !== raw.driverOpenid) issue(collection, 'CONFLICTING_DRIVER_ALIAS', 'driverID');
      } else {
        // Historical offer callers passed userInfo._id, while request callers
        // passed an OpenID. Neither path is an additional identity authority.
        const matches = context.sourceUsers.filter(user => user._id === value);
        if (!matches.length) issue(collection, 'DANGLING_DRIVER_DOCUMENT', 'driverID', 'notice');
        else if (matches.length !== 1 || !text(raw._openid) || matches[0]!._openid !== raw._openid) {
          issue(collection, 'CONFLICTING_DRIVER_ALIAS', 'driverID');
        }
      }
    }
  }

  if (has('routeCityKey')) {
    const key = raw.routeCityKey;
    if (typeof key !== 'string' || !['ny_nj', 'ny', 'nj'].includes(key)) issue(collection, 'INVALID_CITY_ALIAS', 'routeCityKey');
    else if (!['ny_nj', 'ny', 'nj'].includes(String(raw.cityKey)) || ride.cityKey !== 'ny_nj') {
      issue(collection, 'CONFLICTING_CITY_ALIAS', 'routeCityKey');
    }
  }
  if (has('routeCityLabel')) {
    if (!text(raw.routeCityLabel)) issue(collection, 'INVALID_CITY_ALIAS', 'routeCityLabel');
    else if (raw.routeCityLabel !== raw.cityLabel) issue(collection, 'CONFLICTING_CITY_ALIAS', 'routeCityLabel');
  }

  if (completeGroup(['completedAt', 'completedBy'], 'manualCompletion')) {
    const at = timestamp('completedAt');
    const actor = collection === 'Carpool' ? raw._openid : raw.driverOpenid;
    if (!text(raw.completedBy) || raw.completedBy.trim() !== raw.completedBy || raw.completedBy !== actor) {
      issue(collection, 'INVALID_COMPLETION_ACTOR', 'completedBy');
    }
    requireClosed('manualCompletion');
    // The removed manual endpoint allowed early completion; retain that
    // historical fact without using it as a new automatic counting trigger.
    if (at && at < context.lastDepartureAt) issue(collection, 'EARLY_MANUAL_COMPLETION', 'completedAt', 'notice');
  }

  if (has('statsDriverCounted')) {
    if (collection !== 'Carpool' || typeof raw.statsDriverCounted !== 'boolean') {
      issue(collection, 'INVALID_OLD_JOIN_COUNTER', 'statsDriverCounted');
    } else if (raw.statsDriverCounted) {
      requireClosed('statsDriverCounted');
      if (sourceClosed) issue(collection, 'ARCHIVED_OLD_JOIN_COUNTER', 'statsDriverCounted', 'notice');
    }
  }
}
