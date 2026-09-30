const test = require('node:test')
const assert = require('node:assert/strict')
const historical = require('./fixtures/legacy-business-events.json')

// Fixed synthetic output captured before retiring the CloudBase producer.
// Keep historical receiver compatibility without carrying a second writer.
test('collector accepts the fixed historical wire for every retired business transition without rewriting it', async () => {
  const { validateBusinessEvents } = await import('../services/analytics-collector/src/places.mjs')
  const events = structuredClone(historical.transitions), original = JSON.stringify(events)
  assert.deepEqual(events.map(event => event.action), ['publish', 'join', 'quit', 'kick', 'status', 'delete', 'accept'])
  for (const event of events) assert.equal(validateBusinessEvents({ schemaVersion: 1, events: [event] }).events[0], event)
  assert.equal(JSON.stringify(events), original)
  assert.equal(events[0].after.destinations[0].placeId, 'ewr')
  assert.equal(events[0].after.referencePriceCents, 1300)
  assert.equal(events[1].after.availableSeats, 2)
  assert.equal(events[5].after, null)
})

test('unknown fields in historical deletion snapshots remain unknown and accepted by the current collector', async () => {
  const { validateBusinessEvents } = await import('../services/analytics-collector/src/places.mjs')
  const event = structuredClone(historical.unknown), original = JSON.stringify(event)
  assert.equal(validateBusinessEvents({ schemaVersion: 1, events: [event] }).events[0], event)
  assert.equal(JSON.stringify(event), original)
  assert.equal(event.before.departures[0].date, '')
  assert.equal(event.before.destinations[0].address, '')
  assert.equal(event.before.availableSeats, null)
  assert.equal(event.before.referencePriceCents, null)
  assert.equal(event.before.departureAtMs, null)
})

test('fixed version-zero baseline keeps its source label and excludes the old contact fields', async () => {
  const { validateBusinessEvents } = await import('../services/analytics-collector/src/places.mjs')
  const event = structuredClone(historical.legacySnapshot), original = JSON.stringify(event)
  assert.equal(event.version, 0)
  assert.equal(event.action, 'legacy_snapshot')
  assert.equal(event.source, 'legacy_snapshot')
  assert.equal(event.eventAtMs, historical.observedAt)
  assert.equal(event.after.serviceDate, '2026-09-23')
  assert.equal(event.after.passengerOpenids[0], 'synthetic_passenger_contract_0003')
  assert.doesNotMatch(original, /do-not-export|"phone"|"name"|"pickupAddress"/)
  assert.equal(validateBusinessEvents({ schemaVersion: 1, events: [event] }).events[0], event)
  assert.equal(JSON.stringify(event), original)
})
