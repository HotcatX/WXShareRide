const { test, before } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { validateEvent } = require('../utils/analyticsSchema')
let validateBatch, makeRideEvents
const NOW = Date.now()
before(async () => {
  ;({ validateBatch } = await import('../services/analytics-collector/src/validation.mjs'))
  ;({ makeRideEvents } = await import('../services/analytics-collector/test/fixtures/ride-events.mjs'))
})
const names = ['search_submitted','result_set_rendered','list_snapshot','result_card_visible','trip_card_clicked',
  'detail_viewed','contact_action','followup_presented','followup_dismissed','followup_answer','service_request','client_error']
const fixture = name => makeRideEvents(NOW).find(event => event.eventName === name)
function parity(event, expected, label) {
  // Compare the ordinary JSON wire representation, not JS prototypes/getters.
  const wire = JSON.parse(JSON.stringify(event))
  let server = true
  try { validateBatch({ schemaVersion: 1, batchId: randomUUID(), events: [wire] }, NOW) } catch { server = false }
  assert.equal(validateEvent(wire, NOW), expected, `client: ${label || event.eventName}`)
  assert.equal(server, expected, `receiver: ${label || event.eventName}`)
}

for (const name of names) test(`schema parity: ${name} accepts its complete contract and rejects extra/missing data`, () => {
  const event = fixture(name); parity(event, true)
  parity({ ...event, data: { ...event.data, rawPayload: { private: 'not-collected' } } }, false, `${name}: raw payload`)
  parity({ ...event, data: null }, false, `${name}: null data`)
  const missing = structuredClone(event); delete missing.data; parity(missing, false, `${name}: missing data`)
  parity({ ...event, context: {} }, true, `${name}: optional context fields`)
  const noContext = structuredClone(event); delete noContext.context; parity(noContext, true, `${name}: legacy event envelope`)
})

test('context parity is bounded to version/platform/build metadata, with no raw error/device/user data', () => {
  const event = fixture('detail_viewed')
  for (const platform of ['ios','android','devtools','windows','mac','ohos','unknown']) parity({ ...event, context: { platform } }, true)
  for (const buildMode of ['develop','trial','release','unknown']) parity({ ...event, context: { buildMode } }, true)
  for (const context of [null, [], { platform: 'linux' }, { buildMode: 'production' }, { clientVersion: 'a'.repeat(81) },
    { sdkVersion: '3.16.0\nprivate' }, { openid: 'private_account_123456' }, { model: 'full-device-model' }, { stack: 'raw stack' }])
    parity({ ...event, context }, false, JSON.stringify(context))
})

test('business trip IDs remain distinct from opaque event/session/selection IDs', () => {
  for (const name of ['result_card_visible','trip_card_clicked','detail_viewed','contact_action','followup_presented','followup_dismissed','followup_answer','service_request']) {
    const event = fixture(name)
    for (const tripKey of ['a','x'.repeat(80),'business_trip-123']) parity({ ...event, data: { ...event.data, tripKey } }, true)
    for (const tripKey of ['', 'x'.repeat(81), '../private', 'bad value', 123]) parity({ ...event, data: { ...event.data, tripKey } }, false)
  }
  const event = fixture('trip_card_clicked')
  for (const field of ['eventId','sessionId']) parity({ ...event, [field]: 'short' }, false, field)
  parity({ ...event, data: { ...event.data, selectionSetId: 'short' } }, false)
})

test('list candidate truncation is explicit and a declared complete set must match rendered count', () => {
  for (const name of ['result_set_rendered','list_snapshot']) {
    const event = fixture(name); const one = event.data.candidates[0]
    parity({ ...event, data: { ...event.data, renderedCount: 75, hasMore: true, candidatesComplete: false,
      candidates: Array.from({ length: 50 }, (_, position) => ({ ...one, position })) } }, true, `${name}: partial 50/75`)
    parity({ ...event, data: { ...event.data, renderedCount: 75, candidatesComplete: true } }, false, `${name}: false completeness`)
    parity({ ...event, data: { ...event.data, renderedCount: 0, candidatesComplete: true, candidates: [] } }, true, `${name}: zero results`)
    parity({ ...event, data: { ...event.data, renderedCount: 51, candidatesComplete: false,
      candidates: Array.from({ length: 51 }, (_, position) => ({ ...one, position })) } }, false, `${name}: size limit`)
    parity({ ...event, data: { ...event.data, candidates: [{ ...one, phone: '5550101234' }], candidatesComplete: false } }, false)
    parity({ ...event, data: { ...event.data, candidates: [{ ...one, serviceDate: '2026-02-30' }], candidatesComplete: false } }, false)
  }
})

test('price fields admit listed references and legacy reference labels, never transaction/paid inputs', () => {
  for (const name of ['result_card_visible','trip_card_clicked','detail_viewed','followup_answer']) {
    const event = fixture(name)
    for (const referencePriceCents of [0, 1_000_000]) parity({ ...event, data: { ...event.data, referencePriceCents } }, true)
    for (const referencePriceCents of [-1, 1_000_001, 2.5, '25']) parity({ ...event, data: { ...event.data, referencePriceCents } }, false)
    for (const priceKind of ['listed_reference','driverReference','configuredRequestReference','unknown']) parity({ ...event, data: { ...event.data, priceKind } }, true)
    for (const priceKind of ['actual_paid','transaction','agreed']) parity({ ...event, data: { ...event.data, priceKind } }, false)
    for (const field of ['actualPriceCents','paidPriceCents','transactionPrice','paymentId']) parity({ ...event, data: { ...event.data, [field]: 2500 } }, false)
  }
})

test('follow-up roles have different outcome scopes and cannot claim a payment or add free text', () => {
  const event = fixture('followup_answer')
  for (const outcome of ['yes','no']) {
    parity({ ...event, data: { ...event.data, role: 'driver', outcome, outcomeScope: 'driver_any_passenger' } }, true)
    parity({ ...event, data: { ...event.data, role: 'passenger', outcome, outcomeScope: 'respondent_booking' } }, true)
  }
  for (const data of [{ ...event.data, role: 'passenger' }, { ...event.data, outcomeScope: 'respondent_booking' },
    { ...event.data, outcome: 'maybe' }, { ...event.data, confirmedPayment: true }, { ...event.data, comment: 'free text' }]) parity({ ...event, data }, false)
})

test('service diagnostics bound request IDs to 16..128 and never admit response bodies or errors as free text', () => {
  const event = fixture('service_request')
  for (const length of [16,128]) parity({ ...event, data: { ...event.data, cloudRequestId: 'r'.repeat(length) } }, true)
  for (const cloudRequestId of ['r'.repeat(15), 'r'.repeat(129), 'bad.request.id.000', '', 123]) parity({ ...event, data: { ...event.data, cloudRequestId } }, false)
  for (const data of [{ ...event.data, durationMs: -1 }, { ...event.data, durationMs: 3600001 }, { ...event.data, durationMs: 2.5 },
    { ...event.data, outcome: 'timeout' }, { ...event.data, code: 'contains private text' }, { ...event.data, response: { openid: 'private' } },
    { ...event.data, errorMessage: 'raw server error' }]) parity({ ...event, data }, false)
  const runtime = fixture('client_error')
  for (const data of [{ ...runtime.data, errorKind: 'arbitrary' }, { ...runtime.data, fingerprint: 'A'.repeat(64) },
    { ...runtime.data, fingerprint: 'a'.repeat(63) }, { ...runtime.data, stack: 'private stack' }]) parity({ ...runtime, data }, false)
})

test('all new/expanded event envelopes and data reject raw identity, contact and arbitrary payload fields', () => {
  for (const name of names) {
    const event = fixture(name)
    for (const [field, value] of Object.entries({ openid: 'private_account_123456', phone: '5550101234', wechatId: 'private_handle',
      coordinates: { latitude: 40.8, longitude: -73.9 }, raw: { anything: true }, token: 'private_token' })) {
      parity({ ...event, [field]: value }, false, `${name}: envelope ${field}`)
      parity({ ...event, data: { ...event.data, [field]: value } }, false, `${name}: data ${field}`)
    }
  }
})

test('age/schema/shape boundary decisions agree on the wire', () => {
  const event = fixture('detail_viewed')
  for (const occurredAt of [NOW - 7 * 86400000, NOW + 300000]) parity({ ...event, occurredAt }, true)
  for (const occurredAt of [NOW - 7 * 86400000 - 1, NOW + 300001, -1, 'now']) parity({ ...event, occurredAt }, false)
  parity({ ...event, schemaVersion: 2 }, false)
  parity({ ...event, eventName: 'unknown_event' }, false)
})

test('place picker contract agrees on both sides and rejects raw user addresses', () => {
  const common = { pickerSessionId: 'picker_session_0000001', field: 'departure', mode: 'driver', cityKey: 'ny_nj',
    catalogVersion: 'places-v1', rankingVersion: 'circle-selection-v1', snapshotId: 'ranking_snapshot_00001',
    counterpartPlaceId: 'columbia', preferenceVersion: 'preference-v1', circleIds: ['columbia:fort_lee'], generatedAt: NOW, cacheAgeMs: 300000 }
  const variants = {
    place_picker_open: common,
    place_picker_rendered: { ...common, stage: 'visible', items: [{ placeId: 'ewr', position: 0, source: 'fixed' }] },
    place_picker_selected: { ...common, placeId: 'lic', position: 7, source: 'fixed' },
    place_picker_dismissed: { ...common, reason: 'close' },
    place_picker_custom: { ...common, result: 'confirmed', placeId: 'custom' }
  }
  for (const [eventName, data] of Object.entries(variants)) {
    const event = { eventId: randomUUID(), eventName, schemaVersion: 1, occurredAt: NOW, data }
    parity(event, true)
    parity({ ...event, data: { ...data, address: 'Private apartment' } }, false)
    parity({ ...event, data: { ...data, openid: 'someone' } }, false)
    parity({ ...event, data: { ...data, field: 'raw' } }, false)
  }
})

test('new regions and ordered stable stops are accepted, without forging acquisition metadata', () => {
  const telemetry = require('./helpers/load-ride-telemetry.cjs')()
  const event = fixture('detail_viewed')
  const data = { ...event.data, originPlaceIds: ['lic', 'custom', 'unknown'], destinationPlaceIds: ['ewr'],
    tripVersion: 7, dataGeneratedAt: NOW - 10000, dataTimeSource: 'server' }
  for (const originArea of ['fort_lee', 'columbia', 'flushing', 'jfk', 'ewr', 'lga', 'lic', 'jsq', 'inwood', 'midtown', 'downtown', 'queens']) {
    parity({ ...event, data: { ...data, originArea, destinationArea: originArea } }, true)
  }
  for (const [address, area] of [['Inwood', 'inwood'], ['中城', 'midtown'], ['Midtown Manhattan', 'midtown'],
    ['下城', 'downtown'], ['Lower Manhattan', 'downtown'], ['Queens', 'queens'], ['皇后区', 'queens'],
    ['LIC, Queens', 'lic'], ['Flushing, Queens', 'flushing'], ['Downtown Jersey City', 'other'], ['Inwood Road', 'other']]) {
    assert.equal(telemetry.coarseArea(address), area, address)
    const snapshot = telemetry.snapshot({ departures: [{ address, date: '2026-09-24', time: '15:00' }], destinations: [{ address }] }, NOW)
    parity({ ...event, data: { ...event.data, ...snapshot } }, true, `snapshot: ${address}`)
  }
  parity({ ...event, data: { ...data, originPlaceIds: ['123 Private Street'] } }, false)
  parity({ ...event, data: { ...data, originPlaceIds: Array(11).fill('lic') } }, false)
  parity({ ...event, data: { ...data, dataTimeSource: 'guessed' } }, false)
})
