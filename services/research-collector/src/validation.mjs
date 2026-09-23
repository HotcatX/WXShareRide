import { requireThat } from './errors.mjs';

export const MAX_BYTES = 65_536;
export const MAX_EVENTS = 50;
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(v);
const recordId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const shortCode = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(v);
const integer = (min, max) => v => Number.isSafeInteger(v) && v >= min && v <= max;
const values = (...allowed) => v => allowed.includes(v);
const bool = v => typeof v === 'boolean';
const area = values('fort_lee', 'columbia', 'flushing', 'jfk', 'ewr', 'lga', 'lic', 'jsq', 'other', 'unknown');
const tripType = values('carpool', 'request');
const page = values('home', 'carpool_list', 'trip_detail', 'request_detail', 'trip_history', 'market', 'profile');
const serviceDate = v => typeof v === 'string' && /^20\d\d-\d\d-\d\d$/.test(v)
  && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
export const purpose = v => typeof v === 'string' && /^ride-research-v[1-9][0-9]{0,3}$/.test(v);
export const version = integer(1, 2_147_483_647);

export function shape(value, fields, required = Object.keys(fields)) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).every(key => Object.hasOwn(fields, key) && fields[key](value[key]))
    && required.every(key => Object.hasOwn(value, key));
}

const quote = { referencePriceCents: integer(0, 1_000_000),
  currency: values('USD', 'unknown'),
  priceKind: values('driverReference', 'configuredRequestReference', 'unknown', 'listed_reference') };
const tripSnapshot = { availableSeats: integer(0, 20), serviceDate,
  departureMinute: integer(0, 1439), originArea: area, destinationArea: area, snapshotAt: integer(0, Number.MAX_SAFE_INTEGER),
  tripVersion: integer(0, 2_147_483_647), dataGeneratedAt: integer(0, Number.MAX_SAFE_INTEGER), dataTimeSource: values('server', 'unknown'),
  originPlaceIds: v => Array.isArray(v) && v.length <= 10 && v.every(placeId),
  destinationPlaceIds: v => Array.isArray(v) && v.length <= 10 && v.every(placeId), ...quote };
const candidate = v => shape(v, { tripKey: recordId, tripType, position: integer(0, 999),
  tripVersion: integer(0, 2_147_483_647), ...tripSnapshot }, ['tripKey', 'tripType', 'position']);
const followup = { followupId: id, tripKey: recordId, tripType, role: values('driver', 'passenger') };
const eventContext = v => shape(v, { clientVersion: shortCode, sdkVersion: shortCode,
  platform: values('ios', 'android', 'devtools', 'windows', 'mac', 'ohos', 'unknown'),
  buildMode: values('develop', 'trial', 'release', 'unknown') }, []);
const placeId = v => typeof v === 'string' && /^[a-z][a-z0-9_]{1,79}$/.test(v);
const placeSource = values('fixed', 'personal', 'circle', 'city', 'new', 'custom');
const picker = { pickerSessionId: id, field: values('departure', 'destination'),
  mode: values('driver', 'passenger', 'filter'), cityKey: shortCode, catalogVersion: shortCode,
  rankingVersion: shortCode, snapshotId: id, counterpartPlaceId: placeId, preferenceVersion: shortCode,
  circleIds: v => Array.isArray(v) && v.length <= 2 && v.every(shortCode),
  generatedAt: integer(0, Number.MAX_SAFE_INTEGER), cacheAgeMs: integer(0, 86_400_000) };
const pickerRequired = ['pickerSessionId', 'field', 'mode', 'cityKey', 'catalogVersion', 'rankingVersion'];

export const eventSchemas = {
  place_picker_open: v => shape(v, picker, pickerRequired),
  place_picker_rendered: v => shape(v, { ...picker, items: list => Array.isArray(list) && list.length <= 20
    && list.every(item => shape(item, { placeId, position: integer(0, 49), source: placeSource })),
    stage: values('rendered', 'visible') }, [...pickerRequired, 'items', 'stage']),
  place_picker_selected: v => shape(v, { ...picker, placeId, position: integer(0, 49), source: placeSource },
    [...pickerRequired, 'placeId', 'position', 'source']),
  place_picker_dismissed: v => shape(v, { ...picker, reason: values('close', 'replaced', 'page_hide') }, [...pickerRequired, 'reason']),
  place_picker_custom: v => shape(v, { ...picker, result: values('confirmed', 'cancelled'), placeId }, [...pickerRequired, 'result']),
  page_view: v => shape(v, { page }),
  search_submitted: v => shape(v, {
    searchId: id, tripType: values('all', 'carpool', 'request'), serviceDate,
    originArea: area, destinationArea: area, partySize: integer(1, 8), intentId: id, hideFullTrips: bool,
  }, ['searchId', 'tripType', 'serviceDate']),
  result_set_rendered: v => shape(v, {
    searchId: id, selectionSetId: id, source: values('network', 'cache'),
    renderedCount: integer(0, 500), loadedDateCount: integer(0, 31), hasMore: bool, candidatesComplete: bool,
    zeroReason: values('none', 'empty', 'filtered', 'load_error'),
    candidates: list => Array.isArray(list) && list.length <= 50 && list.every(candidate),
  }, ['searchId', 'selectionSetId', 'source', 'renderedCount', 'loadedDateCount', 'hasMore', 'candidatesComplete'])
    && (!v.candidatesComplete || (Array.isArray(v.candidates) && v.candidates.length === v.renderedCount)),
  list_snapshot: v => shape(v, { selectionSetId: id, source: values('network', 'cache'), renderedCount: integer(0, 500),
    hasMore: bool, candidatesComplete: bool, candidates: list => Array.isArray(list) && list.length <= 50 && list.every(candidate), searchId: id },
    ['selectionSetId', 'source', 'renderedCount', 'hasMore', 'candidatesComplete', 'candidates']) &&
    (!v.candidatesComplete || v.candidates.length === v.renderedCount),
  result_card_visible: v => shape(v, {
    selectionSetId: id, tripKey: recordId, tripType, position: integer(0, 999),
    visibilityBucket: values('half_1s', 'full_1s'), ...tripSnapshot,
  }, ['selectionSetId', 'tripKey', 'tripType', 'position', 'visibilityBucket']),
  trip_card_clicked: v => shape(v, { tripKey: recordId, tripType, selectionSetId: id, position: integer(0, 999), ...tripSnapshot }, ['tripKey', 'tripType']),
  trip_detail_opened: v => shape(v, {
    tripKey: id, tripType, source: values('list', 'history', 'share', 'other'),
  }),
  contact_entry_clicked: v => shape(v, {
    tripKey: id, tripType, method: values('phone', 'wechat', 'zelle', 'other'),
  }),
  detail_viewed: v => shape(v, { tripKey: recordId, tripType, source: values('list', 'history', 'share', 'other'), ...tripSnapshot }, ['tripKey', 'tripType', 'source']),
  contact_action: v => shape(v, { tripKey: recordId, tripType, channel: values('wechat', 'phone', 'zelle'),
    action: values('copy', 'call'), outcome: values('attempt', 'success', 'failure', 'missing'), targetRole: values('driver', 'passenger', 'unknown') }),
  followup_presented: v => shape(v, followup),
  followup_dismissed: v => shape(v, followup),
  followup_answer: v => shape(v, { ...followup, outcome: values('yes', 'no'),
    outcomeScope: values('driver_any_passenger', 'respondent_booking'), ...quote }, [...Object.keys(followup), 'outcome', 'outcomeScope']) &&
    v.outcomeScope === (v.role === 'driver' ? 'driver_any_passenger' : 'respondent_booking'),
  service_request: v => shape(v, { operation: shortCode, outcome: values('success', 'business_error', 'network_error'),
    durationMs: integer(0, 3600000), code: shortCode, cloudRequestId: v => typeof v === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(v), tripKey: recordId, tripType }, ['operation', 'outcome', 'durationMs', 'code']),
  client_error: v => shape(v, { errorKind: values('runtime', 'unhandled_rejection'), code: shortCode,
    fingerprint: value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }),
  no_suitable_option: v => shape(v, {
    searchId: id, intentId: id,
    reason: values('time', 'place', 'price', 'full', 'none', 'other', 'unspecified'),
  }, ['searchId', 'reason']),
  collection_diagnostic: v => shape(v, {
    reason: values('queue_limit', 'expired', 'invalid_event', 'upload_failed'),
    droppedCount: integer(0, 500),
  }),
};

// No free text or arbitrary metadata. IDs must be opaque generated identifiers;
// schema validation is not permission to encode personal data into those IDs.
export function validateBatch(body, now = Date.now(), checkAge = true) {
  const good = shape(body, {
    schemaVersion: v => v === 1,
    batchId: id,
    events: events => Array.isArray(events) && events.length >= 1 && events.length <= MAX_EVENTS
      && events.every(event => shape(event, {
        eventId: id, eventName: v => Object.hasOwn(eventSchemas, v), schemaVersion: v => v === 1,
        occurredAt: checkAge ? integer(now - MAX_AGE_MS, now + 5 * 60 * 1000) : integer(0, Number.MAX_SAFE_INTEGER), sessionId: id,
        data: v => Object.hasOwn(eventSchemas, event.eventName) && eventSchemas[event.eventName](v), context: eventContext,
      }, ['eventId', 'eventName', 'schemaVersion', 'occurredAt', 'data']))
      && new Set(events.map(event => event.eventId)).size === events.length,
  });
  requireThat(good, 422, 'INVALID_BATCH');
  return body;
}

export function validateState(body) {
  requireThat(shape(body, {
    participantKey: id, grantId: id, status: values('active', 'revoked'),
    statusVersion: version, purposeVersion: purpose, synthetic: bool,
  }), 422, 'INVALID_PARTICIPANT_STATE');
  return body;
}

export function validateTokenRequest(body) {
  requireThat(shape(body, { participantKey: id }, ['participantKey']), 422, 'INVALID_TOKEN_REQUEST');
  return body;
}
