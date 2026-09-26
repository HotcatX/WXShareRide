const test = require('node:test')
const assert = require('node:assert/strict')
const { appendBusinessEvent } = require('../cloudfunctions/tripManage/businessLedger')
const { makeBaseline, packBatches, PROJECTION } = require('../research/paper-feasibility-2026-09-22/scripts/bootstrap-place-history.cjs')
const DRIVER = 'openid_driver_contract_0001', CREATOR = 'openid_creator_contract_0002', PASSENGER = 'openid_passenger_contract_0003'
const NOW = Date.parse('2026-09-23T20:00:00Z')
const options = { today: '2026-09-23', observedAt: NOW }
function trip(overrides = {}) {
  return { _id: 'contract_trip_1', _openid: DRIVER, cityKey: 'ny_nj', status: 'open',
    departures: [{ address: 'Fort Lee', date: '2026-09-23', time: '16:00' }], destinations: [{ address: 'EWR 机场' }],
    departureAtMs: NOW, latestDepartureAtMs: NOW, referencePrice: '$13.00',
    passengers: [], passengerCount: 3, availSeatNum: 3, ...overrides }
}
async function record(type, action, before, after, actorOpenid = DRIVER) {
  const rows = []
  const transaction = { collection(name) { assert.equal(name, 'TripActions'); return { async add({ data }) { rows.push(data); return { _id: data._id } } } } }
  const event = await appendBusinessEvent(transaction, { serverDate: () => new Date(NOW) }, { type, tripId: 'contract_trip_1', action, before, after, actorOpenid, now: NOW })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].event, event)
  return event
}
test('real cloud serializer is accepted by real collector validator for every deployed state transition', async () => {
  const { validateBusinessEvents } = await import('../services/analytics-collector/src/places.mjs')
  const events = [
    await record('carpool', 'publish', null, trip()),
    await record('carpool', 'join', trip({ businessVersion: 1 }), trip({ passengers: [{ _openid: PASSENGER }], availSeatNum: 2 }), PASSENGER),
    await record('carpool', 'quit', trip({ businessVersion: 2, passengers: [{ _openid: PASSENGER }], availSeatNum: 2 }), trip(), PASSENGER),
    await record('carpool', 'kick', trip({ businessVersion: 3, passengers: [{ _openid: PASSENGER }], availSeatNum: 2 }), trip()),
    await record('carpool', 'status', trip({ businessVersion: 4 }), trip({ status: 'past' }), ''),
    await record('carpool', 'delete', trip({ businessVersion: 5 }), null)
  ]
  const request = trip({ _openid: CREATOR, passengers: undefined, passengerID: [CREATOR, PASSENGER], passengerCount: 2, driverOpenid: '' })
  events.push(await record('request', 'accept', request, { ...request, driverOpenid: DRIVER }))
  for (const event of events) assert.equal(validateBusinessEvents({ schemaVersion: 1, events: [event] }).events[0], event)
  assert.equal(events[0].after.destinations[0].placeId, 'ewr')
  assert.equal(events[0].after.referencePriceCents, 1300)
  assert.equal(events[1].after.availableSeats, 2)
  assert.equal(events[5].after, null)
})
test('unknown legacy endpoint/date/seat values become explicit unknowns instead of poisoning the outbox', async () => {
  const { validateBusinessEvents } = await import('../services/analytics-collector/src/places.mjs')
  const old = trip({ departures: [{ address: 'Fort Lee\u0000', date: '2026-02-30', time: 'bad' }], destinations: [],
    firstDepartureDate: 'not-a-date', availSeatNum: -5, passengerCount: 3.5, departureAtMs: -10, latestDepartureAtMs: NaN, referencePrice: 100000 })
  const event = await record('carpool', 'delete', old, null)
  assert.equal(validateBusinessEvents({ schemaVersion: 1, events: [event] }).events.length, 1)
  assert.equal(event.before.departures[0].date, '')
  assert.equal(event.before.destinations[0].address, '')
  assert.equal(event.before.availableSeats, null)
  assert.equal(event.before.referencePriceCents, null)
  assert.equal(event.before.departureAtMs, null)
})
test('legacy bootstrap events are distinguishable, retain no contact fields, and validate at version zero', async () => {
  const { validateBusinessEvents } = await import('../services/analytics-collector/src/places.mjs')
  const original = trip({ passengers: [{ _openid: PASSENGER, phone: 'do-not-export', name: 'do-not-export', pickupAddress: 'do-not-export' }],
    destinations: [{ address: '哥大' }], firstDepartureDate: undefined })
  const { event } = makeBaseline(original, 'carpool', options)
  assert.equal(event.version, 0)
  assert.equal(event.action, 'legacy_snapshot')
  assert.equal(event.source, 'legacy_snapshot')
  assert.equal(event.eventAtMs, NOW)
  assert.equal(event.after.serviceDate, '2026-09-23')
  assert.equal(event.after.passengerOpenids[0], PASSENGER)
  assert.ok(!JSON.stringify(event).includes('do-not-export'))
  assert.equal(validateBusinessEvents({ schemaVersion: 1, events: [event] }).events.length, 1)
  assert.equal(makeBaseline(original, 'carpool', { ...options, observedAt: NOW + 10 }).event.eventId, event.eventId, 'the same snapshot has a stable ID; reuse exact exported bytes on retry')
  assert.equal(PROJECTION['passengers._openid'], 1)
  assert.equal(PROJECTION.passengers, undefined)
  assert.equal(PROJECTION['passengers.phone'], undefined)
})
test('bootstrap excludes new ledger facts, cancelled records, invalid identities and out-of-window dates', () => {
  for (const [override, skip] of [
    [{ businessVersion: 1 }, 'newLedgerAlreadyPresent'], [{ isCancelled: true }, 'cancelledOrUnsupported'],
    [{ _openid: 'invalid' }, 'invalidIdentity'], [{ businessSynthetic: true }, 'synthetic'],
    [{ firstDepartureDate: '2026-01-01' }, 'outsideWindow'], [{ departures: [], firstDepartureDate: '' }, 'unknownServiceDate']
  ]) assert.equal(makeBaseline(trip(override), 'carpool', options).skip, skip)
})
test('bootstrap batches satisfy both count and UTF-8 byte ceilings without dropping an event', () => {
  const events = Array.from({ length: 23 }, (_, index) => makeBaseline(trip({ _id: `trip_${index}`, destinations: [{ address: '哥大' }] }), 'carpool', options).event)
  const batches = packBatches(events, 6000)
  assert.deepEqual(batches.flatMap(batch => batch.events), events)
  assert.ok(batches.every(batch => batch.events.length <= 10 && Buffer.byteLength(JSON.stringify(batch)) <= 6000))
  assert.throws(() => packBatches(events, 20), /oversized/)
})
