const ID = /^[A-Za-z0-9_-]{16,80}$/
const integer = (min, max) => value => Number.isSafeInteger(value) && value >= min && value <= max
const enumeration = (...values) => value => values.includes(value)
const id = value => typeof value === 'string' && ID.test(value)
const recordId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)
const shortCode = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)
const tripType = enumeration('carpool', 'request')
const area = enumeration('fort_lee', 'columbia', 'flushing', 'jfk', 'ewr', 'lga', 'lic', 'jsq', 'other', 'unknown')
const placeId = value => typeof value === 'string' && /^[a-z][a-z0-9_]{1,79}$/.test(value)
const boolean = value => typeof value === 'boolean'

function plainObject(value) {
  return !!value && !Array.isArray(value) && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function shape(required, optional = {}) {
  return value => plainObject(value) && Object.keys(required).every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every(key => Object.prototype.hasOwnProperty.call(required, key)
      ? required[key](value[key])
      : Object.prototype.hasOwnProperty.call(optional, key) && optional[key](value[key]))
}

function serviceDate(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T12:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const quote = { referencePriceCents: integer(0, 1000000), currency: enumeration('USD', 'unknown'),
  priceKind: enumeration('driverReference', 'configuredRequestReference', 'unknown', 'listed_reference') }
const tripSnapshot = Object.assign({ availableSeats: integer(0, 20), serviceDate,
  originPlaceIds: value => Array.isArray(value) && value.length <= 10 && value.every(placeId),
  destinationPlaceIds: value => Array.isArray(value) && value.length <= 10 && value.every(placeId),
  tripVersion: integer(0, 2147483647), dataGeneratedAt: integer(0, Number.MAX_SAFE_INTEGER),
  dataTimeSource: enumeration('server', 'unknown'),
  departureMinute: integer(0, 1439), originArea: area, destinationArea: area, snapshotAt: integer(0, Number.MAX_SAFE_INTEGER) }, quote)
const candidate = shape({ tripKey: recordId, tripType, position: integer(0, 999) },
  Object.assign({ tripVersion: integer(0, 2147483647) }, tripSnapshot))
const followup = { followupId: id, tripKey: recordId, tripType, role: enumeration('driver', 'passenger') }
const context = shape({}, { clientVersion: shortCode, sdkVersion: shortCode,
  platform: enumeration('ios', 'android', 'devtools', 'windows', 'mac', 'ohos', 'unknown'),
  buildMode: enumeration('develop', 'trial', 'release', 'unknown') })

const picker = { pickerSessionId: id, field: enumeration('departure', 'destination'),
  mode: enumeration('driver', 'passenger', 'filter'), cityKey: shortCode,
  catalogVersion: shortCode, rankingVersion: shortCode }
const pickerOptional = { snapshotId: id, counterpartPlaceId: placeId, preferenceVersion: shortCode,
  circleIds: value => Array.isArray(value) && value.length <= 2 && value.every(shortCode),
  generatedAt: integer(0, Number.MAX_SAFE_INTEGER), cacheAgeMs: integer(0, 86400000) }
const pickerItem = { placeId, position: integer(0, 49), source: enumeration('fixed', 'personal', 'circle', 'city', 'new', 'custom') }

const validators = {
  place_picker_open: shape(picker, pickerOptional),
  place_picker_rendered: shape(Object.assign({}, picker, {
    items: value => Array.isArray(value) && value.length <= 20 && value.every(shape(pickerItem)),
    stage: enumeration('rendered', 'visible') }), pickerOptional),
  place_picker_selected: shape(Object.assign({}, picker, pickerItem), pickerOptional),
  place_picker_dismissed: shape(Object.assign({}, picker, { reason: enumeration('close', 'replaced', 'page_hide') }), pickerOptional),
  place_picker_custom: shape(Object.assign({}, picker, { result: enumeration('confirmed', 'cancelled') }), Object.assign({}, pickerOptional, { placeId })),
  page_view: shape({ page: enumeration('home', 'carpool_list', 'trip_detail', 'request_detail', 'trip_history', 'market', 'profile') }),
  search_submitted: shape({ searchId: id, tripType: enumeration('all', 'carpool', 'request'), serviceDate }, {
    originArea: area, destinationArea: area, partySize: integer(1, 8), intentId: id, hideFullTrips: boolean
  }),
  result_set_rendered: shape({ searchId: id, selectionSetId: id, source: enumeration('network', 'cache'),
    renderedCount: integer(0, 500), loadedDateCount: integer(0, 31), hasMore: boolean, candidatesComplete: boolean }, {
    zeroReason: enumeration('none', 'empty', 'filtered', 'load_error'),
    candidates: value => Array.isArray(value) && value.length <= 50 && value.every(candidate)
  }),
  list_snapshot: shape({ selectionSetId: id, source: enumeration('network', 'cache'), renderedCount: integer(0, 500),
    hasMore: boolean, candidatesComplete: boolean, candidates: value => Array.isArray(value) && value.length <= 50 && value.every(candidate) }, { searchId: id }),
  result_card_visible: shape({ selectionSetId: id, tripKey: recordId, tripType, position: integer(0, 999), visibilityBucket: enumeration('half_1s', 'full_1s') }, tripSnapshot),
  trip_card_clicked: shape({ tripKey: recordId, tripType }, Object.assign({ selectionSetId: id, position: integer(0, 999) }, tripSnapshot)),
  trip_detail_opened: shape({ tripKey: id, tripType, source: enumeration('list', 'history', 'share', 'other') }),
  contact_entry_clicked: shape({ tripKey: id, tripType, method: enumeration('phone', 'wechat', 'zelle', 'other') }),
  no_suitable_option: shape({ searchId: id, reason: enumeration('time', 'place', 'price', 'full', 'none', 'other', 'unspecified') }, { intentId: id }),
  detail_viewed: shape({ tripKey: recordId, tripType, source: enumeration('list', 'history', 'share', 'other') }, tripSnapshot),
  contact_action: shape({ tripKey: recordId, tripType, channel: enumeration('wechat', 'phone', 'zelle'),
    action: enumeration('copy', 'call'), outcome: enumeration('attempt', 'success', 'failure', 'missing'),
    targetRole: enumeration('driver', 'passenger', 'unknown') }),
  followup_presented: shape(followup),
  followup_dismissed: shape(followup),
  followup_answer: value => shape(Object.assign({}, followup, { outcome: enumeration('yes', 'no'),
    outcomeScope: enumeration('driver_any_passenger', 'respondent_booking') }), quote)(value) &&
    value.outcomeScope === (value.role === 'driver' ? 'driver_any_passenger' : 'respondent_booking'),
  service_request: shape({ operation: shortCode, outcome: enumeration('success', 'business_error', 'network_error'),
    durationMs: integer(0, 3600000), code: shortCode }, { cloudRequestId: value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value), tripKey: recordId, tripType }),
  client_error: shape({ errorKind: enumeration('runtime', 'unhandled_rejection'), code: shortCode,
    fingerprint: value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }),
  collection_diagnostic: shape({ reason: enumeration('queue_limit', 'expired', 'invalid_event', 'upload_failed'), droppedCount: integer(0, 500) })
}

function validateEvent(event, now, ttlMs = 7 * 24 * 60 * 60 * 1000) {
  if (!shape({ eventId: id, eventName: value => typeof value === 'string' && Object.prototype.hasOwnProperty.call(validators, value),
    schemaVersion: value => value === 1, occurredAt: integer(0, Number.MAX_SAFE_INTEGER), data: plainObject }, { sessionId: id, context })(event)) return false
  if (!(event.occurredAt >= now - ttlMs && event.occurredAt <= now + 5 * 60 * 1000 && validators[event.eventName](event.data))) return false
  return !['result_set_rendered', 'list_snapshot'].includes(event.eventName) || event.data.candidatesComplete !== true ||
    (Array.isArray(event.data.candidates) && event.data.candidates.length === event.data.renderedCount)
}

module.exports = { validateEvent, isOpaqueId: id }
