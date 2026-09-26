import { parseListedPrice } from '../prices.ts';
import { migrationSource, serializeSource, sourceHash } from './source.ts';
import type { Document, Collection, ExportObservation, MigrationIssue, MigrationPlan, MigrationReport, RideRow, MemberRow, StopRow } from './types.ts';
import { object, text, present, migrationReaders, parseExportTimestamp, localDepartureCandidates } from './values.ts';
import { indexFields, normalizeUsers } from './users.ts';
import { normalizeTemplates } from './templates.ts';
import { normalizeLegacyNotifications } from './notifications.ts';
import { normalizeLegacyBlocks } from './blocks.ts';
import { normalizeRatings } from './ratings.ts';
import { normalizeCompletions } from './completions.ts';
import { validateRatingSummaries } from './rating-summaries.ts';
import { normalizePublicStatistics } from './public-statistics.ts';
import { normalizeReferralCodes } from './referrals.ts';
import { rideMetadataFields, validateRideMetadata } from './ride-metadata.ts';
import { normalizeAdminAccounts, normalizeAdminOrigins } from './admin.ts';
import { normalizeMarketListings } from './market.ts';
import { normalizeMarketFiles } from './files.ts';
import { normalizeMarketViews } from './market-views.ts';
import { validateMarketShadow } from './market-shadow.ts';
import { normalizeAds } from './ads.ts';
import { normalizeCommunity } from './community.ts';
import { normalizeContentFiles } from './content-files.ts';
import { normalizeAdminAudit, validateLegacyMarketAdmins, validateLegacyMarketAdminSettings } from './admin-audit.ts';
export type { MigrationIssue, UserRow, RideRow, MemberRow, StopRow, MigrationPlan, MigrationReport, CloudBaseExport } from './types.ts';
export { parseExportTimestamp, localDepartureCandidates } from './values.ts';
export { migrationUserId } from './users.ts';

const collections: Collection[] = ['userInfo', 'Carpool', 'CarpoolRequest'];
const optionalCollections = new Set(['CarpoolTemplate', 'Notifications', 'UserBlocks', 'TripRatings', 'PublicStats',
  'WebAdminAccounts', 'WebAdminSettings', 'WebAdminAuditLogs', 'market_admins', 'MarketAdminSettings', 'market_goods', 'MarketFiles', 'market_view_events', 'houseShare',
  'WebAdminUploads', 'market_ads', 'market_ad_events', 'community_config', 'CommunityConfigHistory']);
const rideFields = new Set([
  '_id', '_openid', 'cityKey', 'cityLabel', 'departures', 'destinations', 'passengerCount', 'availSeatNum', 'passengers', 'passengerID',
  'driverOpenid', 'status', 'referencePrice', 'comment', 'zelle', 'largeLuggageCount', 'createdAt', 'updatedAt',
  'departureAtMs', 'latestDepartureAtMs', 'firstDepartureDate', 'firstDepartureTime', 'businessVersion', 'businessSynthetic',
  ...rideMetadataFields,
]);
const pointFields = new Set(['address', 'date', 'time', 'placeId']);
const passengerFields = new Set(['_openid', 'name', 'nickName', 'nickname', 'avatarUrl', 'joinedAt', 'pickupAddress', 'dropoffAddress']);
/** Read-only candidate normalization. The plan contains private data: print only report. */
export function normalizeCloudBaseExport(input: unknown, options: { timeZone: 'America/New_York'; observation?: ExportObservation }): { plan: MigrationPlan | null; report: MigrationReport } {
  const plan: MigrationPlan = { sourceSha256: '', observedBefore: null, sources: [], users: [], rides: [], members: [], stops: [], templates: [], notifications: [], blocks: [], ratings: [], completions: [], publicStatistics: [], referralCodes: [], adminAccounts: [], adminOrigins: [], adminAudit: [], listings: [], files: [], fileReferences: [], marketViews: [], ads: [], adClicks: [], communityConfigs: [], communityRevisions: [] };
  const report: MigrationReport = { sourceKind: 'rejected', ready: false, inputCounts: { userInfo: 0, Carpool: 0, CarpoolRequest: 0, other: 0 }, candidateCounts: { users: 0, rides: 0, members: 0, stops: 0, templates: 0, notifications: 0, blocks: 0, ratings: 0, completions: 0, publicStatistics: 0, referralCodes: 0, adminAccounts: 0, adminOrigins: 0, adminAudit: 0, listings: 0, files: 0, fileReferences: 0, marketViews: 0, ads: 0, adClicks: 0, communityConfigs: 0, communityRevisions: 0 }, issues: [] };
  const issue = (collection: Collection, code: string, field = '-', severity: 'error' | 'notice' = 'error', count = 1) => {
    const previous = report.issues.find(item => item.collection === collection && item.code === code && item.field === field && item.severity === severity);
    if (previous) previous.count += count; else report.issues.push({ collection, code, field, severity, count });
  };
  const mergeIssues = (issues: MigrationIssue[]) => {
    for (const item of issues) issue(item.collection, item.code, item.field, item.severity, item.count);
  };
  if (options.timeZone !== 'America/New_York' || !object(input) || input.kind !== 'cloudbase-full-export' || !text(input.appId) || !object(input.collections)) {
    issue('other', 'FULL_EXPORT_REQUIRED'); return { plan: null, report };
  }
  try { plan.sourceSha256 = sourceHash(serializeSource(input)); }
  catch { issue('other', 'INVALID_SOURCE_JSON'); return { plan: null, report }; }
  if (options.observation !== undefined) {
    const observation = options.observation;
    const at = object(observation) && typeof observation.at === 'string' ? parseExportTimestamp(observation.at) : null;
    if (!object(observation) || Object.keys(observation).some(key => key !== 'sourceSha256' && key !== 'at') ||
      observation.sourceSha256 !== plan.sourceSha256 || !at) issue('other', 'INVALID_EXPORT_OBSERVATION');
    else plan.observedBefore = at;
  }
  const appId = input.appId;
  const docs = input.collections;
  report.sourceKind = 'cloudbase-full-export';
  for (const required of collections) if (!Array.isArray(docs[required])) issue(required, 'COLLECTION_MISSING');
  for (const [name, values] of Object.entries(docs)) {
    const collection: Collection = collections.includes(name as Collection) ? name as Collection : 'other';
    if (!Array.isArray(values)) { issue(collection, 'INVALID_COLLECTION'); continue; }
    report.inputCounts[collection] += values.length;
    const sourceIds = new Set<string>();
    for (const raw of values) {
      if (!object(raw)) { issue(collection, 'INVALID_DOCUMENT'); continue; }
      try {
        const source = migrationSource(name, raw);
        if (sourceIds.has(source.sourceId)) issue(collection, 'DUPLICATE_SOURCE_ID');
        else { sourceIds.add(source.sourceId); plan.sources.push(source); }
      } catch { issue(collection, 'MISSING_SOURCE_ID'); }
    }
    if (collection === 'other' && !optionalCollections.has(name) && values.length) issue('other', 'UNMAPPED_COLLECTION');
  }
  const { unknownFields, alias, stamp, recordedUpdate, joinedStamp } = migrationReaders(issue);
  if (docs.PublicStats !== undefined) plan.publicStatistics = normalizePublicStatistics(docs.PublicStats, appId, issue);
  const sourceUsers = (Array.isArray(docs.userInfo) ? docs.userInfo : []).filter(object);
  plan.users = normalizeUsers(sourceUsers, appId, issue);
  plan.referralCodes = normalizeReferralCodes(sourceUsers, plan.users, appId, issue);
  if (docs.WebAdminAccounts !== undefined) plan.adminAccounts = normalizeAdminAccounts(docs.WebAdminAccounts, appId, issue);
  if (docs.WebAdminSettings !== undefined) plan.adminOrigins = normalizeAdminOrigins(docs.WebAdminSettings, appId, issue);
  if (docs.WebAdminAuditLogs !== undefined) plan.adminAudit = normalizeAdminAudit(docs.WebAdminAuditLogs, appId, issue);
  if (docs.market_admins !== undefined) validateLegacyMarketAdmins(docs.market_admins, issue);
  if (docs.MarketAdminSettings !== undefined) validateLegacyMarketAdminSettings(docs.MarketAdminSettings, issue);
  // A market slice needs both its authoritative records and complete file
  // ledger, including unreferenced rows. Omission is not an empty collection.
  if (['market_goods', 'MarketFiles', 'market_view_events', 'houseShare'].some(name => docs[name] !== undefined)) {
    const complete = ['market_goods', 'MarketFiles', 'WebAdminAccounts', 'market_view_events'].every(name => Array.isArray(docs[name]));
    if (!complete) issue('other', 'INCOMPLETE_MARKET_SOURCE', 'market_goods');
    else {
      const context = { appId, users: plan.users, adminOwners: plan.adminAccounts.map(row => ({ accountId: row.id, ownerKey: row.ownerKey })) };
      plan.listings = normalizeMarketListings(docs.market_goods, context, issue);
      const converted = normalizeMarketFiles(docs.MarketFiles, plan.listings, context, issue);
      plan.files = converted.files;
      plan.fileReferences = converted.references;
      plan.marketViews = normalizeMarketViews({ events: docs.market_view_events, listings: docs.market_goods }, context, issue);
      if (docs.houseShare !== undefined) validateMarketShadow(docs.houseShare, docs.market_goods, issue);
    }
  }
  const contentCollections = ['WebAdminUploads', 'market_ads', 'market_ad_events', 'community_config', 'CommunityConfigHistory'];
  if (contentCollections.some(name => docs[name] !== undefined)) {
    const complete = [...contentCollections, 'WebAdminAccounts', 'market_goods', 'MarketFiles', 'market_view_events']
      .every(name => Array.isArray(docs[name]));
    if (!complete) issue('other', 'INCOMPLETE_CONTENT_SOURCE', 'contentFiles');
    else {
      const context = { appId, users: plan.users, adminOwners: plan.adminAccounts.map(row => ({ accountId: row.id, ownerKey: row.ownerKey })) };
      const ads = normalizeAds({ ads: docs.market_ads, events: docs.market_ad_events }, context, issue);
      const community = normalizeCommunity({ configs: docs.community_config, history: docs.CommunityConfigHistory }, context, issue);
      plan.ads = ads.ads; plan.adClicks = ads.events;
      plan.communityConfigs = community.configs; plan.communityRevisions = community.revisions;
      const files = normalizeContentFiles({ market: { files: plan.files, references: plan.fileReferences },
        adReferences: ads.references, communityReferences: community.references, uploads: docs.WebAdminUploads }, context, issue);
      plan.files = files.files; plan.fileReferences = files.references;
    }
  }
  const userByOpenid = new Map(plan.users.map(user => [user.openid, user]));
  if (docs.CarpoolTemplate !== undefined) plan.templates = normalizeTemplates(docs.CarpoolTemplate, plan.users, issue);
  if (docs.Notifications !== undefined) {
    const converted = normalizeLegacyNotifications(docs.Notifications, plan.users, appId);
    plan.notifications = converted.rows ?? [];
    mergeIssues(converted.issues);
  }
  if (docs.UserBlocks !== undefined) {
    const converted = normalizeLegacyBlocks(docs.UserBlocks, plan.users, appId);
    plan.blocks = converted.rows ?? [];
    mergeIssues(converted.issues);
  }
  const rideIds = new Set<string>();
  const expiredUnlocatedRides = new Set<string>();
  const historicalDrivers = new Map<string, string>();
  for (const collection of ['Carpool', 'CarpoolRequest'] as const) {
    for (const raw of Array.isArray(docs[collection]) ? docs[collection] : []) {
      if (!object(raw)) { issue(collection, 'INVALID_DOCUMENT'); continue; }
      unknownFields(raw, rideFields, collection);
      if (!text(raw._id)) { issue(collection, 'MISSING_RIDE_ID'); continue; }
      if (raw._id.length > 160 || !/^[a-zA-Z0-9:_-]+$/.test(raw._id)) issue(collection, 'INVALID_RIDE_ID');
      if (rideIds.has(raw._id)) { issue(collection, 'DUPLICATE_RIDE_ID'); continue; }
      rideIds.add(raw._id);
      if (raw.businessSynthetic === true) issue(collection, 'SYNTHETIC_RECORD_REQUIRES_SEPARATE_IMPORT');
      const creator = typeof raw._openid === 'string' ? userByOpenid.get(raw._openid) : undefined;
      if (!creator) { issue(collection, 'UNKNOWN_USER', 'creator'); continue; }
      const kind = collection === 'Carpool' ? 'offer' : 'request';
      for (const field of kind === 'offer' ? ['passengerID', 'driverOpenid', 'largeLuggageCount'] : ['passengers', 'availSeatNum', 'zelle']) {
        if (raw[field] !== undefined) issue(collection, 'UNMAPPED_FIELD_FOR_RIDE_KIND', field);
      }
      if (raw.businessSynthetic !== undefined && typeof raw.businessSynthetic !== 'boolean') issue(collection, 'INVALID_SYNTHETIC_FLAG', 'businessSynthetic');
      const createdAt = stamp(raw, ['createdAt'], collection, 'createdAt');
      const updatedAt = recordedUpdate(raw, ['updatedAt'], collection);
      if (createdAt && updatedAt && updatedAt < createdAt) issue(collection, 'INVALID_TIMESTAMP_ORDER');
      const stops: StopRow[] = [];
      for (const [field, stopKind] of [['departures', 'departure'], ['destinations', 'destination']] as const) {
        if (!Array.isArray(raw[field]) || !raw[field].length) { issue(collection, 'MISSING_STOPS', field); continue; }
        for (const point of raw[field]) {
          if (!object(point) || !text(point.address)) { issue(collection, 'MISSING_ADDRESS', field); continue; }
          unknownFields(point, pointFields, collection, field);
          let departureAt: string | null = null;
          if (stopKind === 'departure' || present(point.date) || present(point.time)) {
            const candidates = localDepartureCandidates(point.date, point.time, options.timeZone);
            if (candidates.length !== 1) issue(collection, candidates.length > 1 ? 'AMBIGUOUS_LOCAL_TIME' : 'MISSING_OR_INVALID_LOCAL_TIME', field);
            else departureAt = candidates[0]!;
          }
          if (point.placeId !== undefined && point.placeId !== null && !text(point.placeId)) issue(collection, 'INVALID_PLACE_ID', field);
          stops.push({ rideId: raw._id, position: stops.length, kind: stopKind, address: point.address, placeId: text(point.placeId) ? point.placeId : null, departureAt });
        }
      }
      const times = stops.filter(stop => stop.kind === 'departure' && stop.departureAt).map(stop => stop.departureAt!).sort();
      const departures = stops.filter(stop => stop.kind === 'departure');
      if (departures.some((stop, index) => index > 0 && stop.departureAt && departures[index - 1]!.departureAt && stop.departureAt < departures[index - 1]!.departureAt!)) {
        issue(collection, 'UNORDERED_DEPARTURE_TIMES', 'departures');
      }
      if (departures.length > 10 || stops.length - departures.length > 10) issue(collection, 'TOO_MANY_STOPS');
      if (present(raw.firstDepartureDate) || present(raw.firstDepartureTime)) {
        const cached = localDepartureCandidates(raw.firstDepartureDate, raw.firstDepartureTime, options.timeZone);
        if (cached.length !== 1 || cached[0] !== times[0]) issue(collection, 'CONFLICTING_DEPARTURE_TIME', 'firstDeparture');
      }
      for (const [field, time] of [['departureAtMs', times[0]], ['latestDepartureAtMs', times[times.length - 1]]] as const) {
        if (present(raw[field]) && parseExportTimestamp(raw[field]) !== time) issue(collection, 'CONFLICTING_DEPARTURE_TIME', field);
      }
      const statuses: Record<string, RideRow['status']> = { open: 'open', full: 'open', past: 'closed', closed: 'closed', cancelled: 'cancelled', canceled: 'cancelled' };
      let status = typeof raw.status === 'string' && Object.hasOwn(statuses, raw.status) ? statuses[raw.status] : undefined;
      if (!status) issue(collection, 'UNMAPPED_RIDE_STATUS', 'status');
      // One known legacy class is an already-expired open ride with no city.
      // Only a source-hash-bound observation can establish it was historical.
      // Do not close otherwise complete open bookings here: their pending
      // accounting belongs to the normal close job after the actual cutover.
      if (status === 'open' && !present(raw.cityKey) && plan.observedBefore && times.length &&
        times.at(-1)! < plan.observedBefore && raw.servedStatsCounted !== true &&
        raw.statsDriverCounted !== true && raw._rideCompletionSettled !== true) {
        status = 'closed';
        expiredUnlocatedRides.add(raw._id);
        issue(collection, 'EXPIRED_UNLOCATED_RIDE_ARCHIVED', 'status', 'notice');
      }
      const price = parseListedPrice(raw.referencePrice);
      if (price.classification === 'unresolved') {
        // Free-text quotes can be preserved without claiming a scalar amount.
        // Invalid non-string values still block import rather than losing data.
        issue(collection, typeof raw.referencePrice === 'string' ? 'PRICE_TEXT_PRESERVED' : 'INVALID_PRICE_VALUE',
          'referencePrice', typeof raw.referencePrice === 'string' ? 'notice' : 'error');
      }
      const seatCount = typeof raw.passengerCount === 'number' ? raw.passengerCount : NaN;
      const validSeatCount = Number.isInteger(seatCount) && seatCount >= 1 && seatCount <= (kind === 'offer' ? 8 : 4);
      if (!validSeatCount) issue(collection, 'INVALID_SEAT_COUNT', 'passengerCount', status === 'closed' && kind === 'offer' ? 'notice' : 'error');
      const version = raw.businessVersion === undefined ? 1 : raw.businessVersion;
      if (raw.businessVersion === undefined) issue(collection, 'INITIAL_VERSION_ASSIGNED', 'businessVersion', 'notice');
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 2_147_483_647) issue(collection, 'INVALID_VERSION', 'businessVersion');
      const details: Document = {};
      if (raw.comment !== undefined) {
        if (typeof raw.comment !== 'string') issue(collection, 'INVALID_RIDE_DETAIL', 'comment'); else details.note = raw.comment;
      }
      if (kind === 'offer' && raw.zelle !== undefined) {
        if (raw.zelle !== undefined && raw.zelle !== 'yes' && raw.zelle !== 'no') issue(collection, 'INVALID_RIDE_DETAIL', 'zelle');
        else details.zelleDisplay = raw.zelle === 'yes';
      }
      if (raw.largeLuggageCount !== undefined) {
        if (typeof raw.largeLuggageCount !== 'number' || !Number.isInteger(raw.largeLuggageCount) || raw.largeLuggageCount < 0 || raw.largeLuggageCount > 20) issue(collection, 'INVALID_RIDE_DETAIL', 'largeLuggageCount'); else details.largeLuggageCount = raw.largeLuggageCount;
      }
      const knownCity = raw.cityKey === 'ny_nj' || raw.cityKey === 'ny' || raw.cityKey === 'nj';
      if (!knownCity) issue(collection, !present(raw.cityKey) && status === 'closed' ? 'UNKNOWN_HISTORICAL_CITY' : 'UNMAPPED_CITY', 'cityKey', !present(raw.cityKey) && status === 'closed' ? 'notice' : 'error');
      if (raw.cityKey === 'ny' || raw.cityKey === 'nj') issue(collection, 'CITY_ALIAS_NORMALIZED', 'cityKey', 'notice');
      const ride: RideRow = { id: raw._id, kind, creatorId: creator.id, cityKey: knownCity ? 'ny_nj' : null, status: status || 'open', seatCapacity: kind === 'offer' ? validSeatCount ? seatCount : null : 4, departureAt: times[0] || '', timeZone: options.timeZone, listedPriceCents: price.cents, listedPriceLabel: price.label, details, version: typeof version === 'number' ? version : 1, createdAt, updatedAt };
      plan.rides.push(ride); plan.stops.push(...stops);
      const members: MemberRow[] = [];
      const addMember = (openid: unknown, role: MemberRow['role'], seats: number, joinedAt: string | null, memberDetails: Document = {}) => {
        const user = typeof openid === 'string' ? userByOpenid.get(openid) : undefined;
        if (!user) { issue(collection, 'UNKNOWN_USER', 'member'); return; }
        if (members.some(member => member.userId === user.id)) { issue(collection, 'DUPLICATE_MEMBER', 'member'); return; }
        if (joinedAt && createdAt && joinedAt < createdAt) issue(collection, 'INVALID_TIMESTAMP_ORDER', 'joinedAt');
        members.push({ rideId: ride.id, userId: user.id, role, seatCount: seats, state: 'active', joinedAt, leftAt: null, details: memberDetails });
      };
      if (kind === 'offer') {
        addMember(creator.openid, 'driver', 0, createdAt);
        if (!Array.isArray(raw.passengers)) issue(collection, 'INVALID_MEMBER_LIST', 'passengers');
        else for (const passenger of raw.passengers) {
          if (typeof passenger === 'string') { issue(collection, 'MISSING_MEMBERSHIP_TIMESTAMP', 'joinedAt', 'notice'); addMember(passenger, 'passenger', 1, null); continue; }
          if (!object(passenger)) { issue(collection, 'INVALID_MEMBER', 'passengers'); continue; }
          unknownFields(passenger, passengerFields, collection, 'passengers');
          const memberDetails: Document = {};
          const name = alias(passenger, ['name', 'nickName', 'nickname'], collection, 'passengerName');
          if (name !== undefined) { if (typeof name !== 'string') issue(collection, 'INVALID_MEMBER_DETAIL', 'passengers');  }
          for (const key of ['avatarUrl', 'pickupAddress', 'dropoffAddress']) if (passenger[key] !== undefined) {
            if (typeof passenger[key] !== 'string') issue(collection, 'INVALID_MEMBER_DETAIL', 'passengers'); else if (key !== 'avatarUrl') memberDetails[key] = passenger[key];
          }
          addMember(passenger._openid, 'passenger', 1, joinedStamp(passenger, collection), memberDetails);
        }
        if (typeof raw.availSeatNum !== 'number' || raw.availSeatNum !== seatCount - members.filter(member => member.role === 'passenger').length) {
          issue(collection, 'SEAT_BALANCE_MISMATCH', 'availSeatNum', status === 'closed' ? 'notice' : 'error');
          if (status === 'closed') ride.seatCapacity = null;
        }
      } else {
        if (!Array.isArray(raw.passengerID) || raw.passengerID.some(id => !text(id))) issue(collection, 'INVALID_MEMBER_LIST', 'passengerID');
        const ids: string[] = Array.isArray(raw.passengerID) ? raw.passengerID.filter(text) : [];
        if (new Set(ids).size !== ids.length) issue(collection, 'DUPLICATE_MEMBER', 'passengerID');
        // The creator is intrinsically a passenger in the old detail/role/completion consumers.
        if (!ids.includes(creator.openid)) issue(collection, 'CREATOR_MEMBERSHIP_IMPLICIT', 'passengerID', 'notice');
        const others = ids.filter(id => id !== creator.openid);
        // Closed legacy rows can still list the assigned driver as a passenger.
        // Existing role/permission consumers give the explicit driver precedence.
        // Keep original account counts when deriving the creator's party: never
        // transfer that driver's old seat into the creator's group.
        const historicalDriverOverlap = status === 'closed' && typeof raw.driverOpenid === 'string' && raw.driverOpenid !== creator.openid && others.includes(raw.driverOpenid);
        if (historicalDriverOverlap) {
          issue(collection, 'HISTORICAL_ROLE_CONFLICT_ARCHIVED', 'passengerID', 'notice');
          ride.seatCapacity = null;
          historicalDrivers.set(ride.id, raw.driverOpenid as string);
        }
        const creatorSeats = seatCount - others.length;
        if (!Number.isInteger(creatorSeats) || creatorSeats < 1) issue(collection, 'SEAT_BALANCE_MISMATCH', 'passengerCount');
        // Existing joinTrip adds exactly one seat per additional account. Extra seats belong to the creator's original group.
        addMember(creator.openid, 'passenger', creatorSeats, createdAt);
        for (const id of others) {
          if (historicalDriverOverlap && id === raw.driverOpenid) continue;
          issue(collection, 'MISSING_MEMBERSHIP_TIMESTAMP', 'joinedAt', 'notice'); addMember(id, 'passenger', 1, null);
        }
        if (present(raw.driverOpenid)) { issue(collection, 'MISSING_MEMBERSHIP_TIMESTAMP', 'joinedAt', 'notice'); addMember(raw.driverOpenid, 'driver', 0, null); }
      }
      const occupied = members.filter(member => member.role === 'passenger').reduce((sum, member) => sum + member.seatCount, 0);
      if (ride.seatCapacity !== null && occupied > ride.seatCapacity) {
        issue(collection, 'SEAT_CAPACITY_EXCEEDED', '-', status === 'closed' ? 'notice' : 'error');
        if (status === 'closed') ride.seatCapacity = null;
      }
      if (ride.seatCapacity !== null && ((raw.status === 'full' && occupied !== ride.seatCapacity) || (raw.status === 'open' && occupied >= ride.seatCapacity))) issue(collection, 'SEAT_STATUS_MISMATCH', 'status');
      plan.members.push(...members);
    }
  }
  const ratings = normalizeRatings(docs.TripRatings ?? [], plan.users, plan.rides, plan.members, appId);
  mergeIssues(ratings.issues);
  plan.ratings = ratings.rows ?? [];
  const completions = normalizeCompletions(sourceUsers, plan.users, plan.rides, appId);
  mergeIssues(completions.issues);
  plan.completions = completions.rows ?? [];
  for (const rideId of expiredUnlocatedRides) {
    if (plan.completions.some(row => row.rideId === rideId)) issue('other', 'EXPIRED_RIDE_HAS_COMPLETION_RECEIPTS');
  }
  const normalizedRides = new Map(plan.rides.map(ride => [ride.id, ride]));
  const lastDepartures = new Map<string, string>();
  for (const stop of plan.stops) {
    if (stop.kind === 'departure' && stop.departureAt && stop.departureAt > (lastDepartures.get(stop.rideId) ?? '')) {
      lastDepartures.set(stop.rideId, stop.departureAt);
    }
  }
  for (const collection of ['Carpool', 'CarpoolRequest'] as const) {
    for (const raw of Array.isArray(docs[collection]) ? docs[collection] : []) {
      if (!object(raw) || typeof raw._id !== 'string') continue;
      const ride = normalizedRides.get(raw._id);
      if (ride) validateRideMetadata(raw, collection, { sourceUsers, ride, completions: plan.completions,
        lastDepartureAt: lastDepartures.get(ride.id) ?? '' }, issue);
    }
  }
  validateRatingSummaries(sourceUsers, plan.users, plan.ratings, appId, issue);
  // Old user arrays are indexes, not membership facts. Report disagreements instead of importing a second truth.
  for (const user of sourceUsers) {
    const openid = typeof user._openid === 'string' ? user._openid : user.openid;
    const target = typeof openid === 'string' ? userByOpenid.get(openid) : undefined;
    for (const field of indexFields) {
      if (user[field] === undefined) continue;
      if (!Array.isArray(user[field])) { issue('userInfo', 'INVALID_LEGACY_INDEX', 'rideIndexes'); continue; }
      for (const id of user[field]) {
        const ride = plan.rides.find(ride => ride.id === id);
        const member = plan.members.find(member => member.rideId === id && member.userId === target?.id);
        const expectedRole = field.startsWith('tripDriver') ? 'driver' : 'passenger';
        const expectedKind = field.startsWith('tripDriverJoin') || field.startsWith('tripPassengerCreate') ? 'request' : field.startsWith('tripDriver') ? 'offer' : undefined;
        if (!text(id)) issue('userInfo', 'INVALID_LEGACY_INDEX', 'rideIndexes');
        else if (!ride && !rideIds.has(id)) issue('userInfo', 'ORPHAN_INDEX_ARCHIVED', 'rideIndexes', 'notice');
        else if (ride && member?.role === 'driver' && field === 'tripPassengerHistory' && historicalDrivers.get(id) === openid) {
          issue('userInfo', 'HISTORICAL_ROLE_INDEX_ARCHIVED', 'rideIndexes', 'notice');
        }
        else if (!ride || !member || member.role !== expectedRole || (expectedKind && ride.kind !== expectedKind) ||
          (field.startsWith('tripPassengerCreate') && ride.creatorId !== target?.id)) issue('userInfo', 'UNRESOLVED_LEGACY_MEMBERSHIP', 'rideIndexes');
      }
    }
  }
  report.candidateCounts = { users: plan.users.length, rides: plan.rides.length, members: plan.members.length, stops: plan.stops.length,
    templates: plan.templates.length, notifications: plan.notifications.length, blocks: plan.blocks.length,
    ratings: plan.ratings.length, completions: plan.completions.length, publicStatistics: plan.publicStatistics.length,
    referralCodes: plan.referralCodes.length, adminAccounts: plan.adminAccounts.length, listings: plan.listings.length,
    files: plan.files.length, fileReferences: plan.fileReferences.length, marketViews: plan.marketViews.length,
    adminOrigins: plan.adminOrigins.length, adminAudit: plan.adminAudit.length, ads: plan.ads.length, adClicks: plan.adClicks.length,
    communityConfigs: plan.communityConfigs.length, communityRevisions: plan.communityRevisions.length };
  report.issues.sort((a, b) => `${a.collection}:${a.code}:${a.field}`.localeCompare(`${b.collection}:${b.code}:${b.field}`));
  report.ready = !report.issues.some(item => item.severity === 'error');
  // Never expose a partially valid import plan, invented fallback status, or unresolved required facts.
  return { plan: report.ready ? plan : null, report };
}
