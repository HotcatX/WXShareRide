const test = require('node:test')
const assert = require('node:assert/strict')
const { toHistoryRide, loadRideHistory } = require('../utils/compat/rideHistory')
const { eligibleTrip, referencePrice } = require('../utils/tripFollowup')
const rideTime = require('../utils/rideTime')
const own = 'synthetic-own-openid'
const base = { id: 'synthetic-ride', kind: 'offer', role: 'driver', isCreator: true, status: 'closed', followupEligible: true,
  departureAt: '2026-09-21T19:00:00.000Z', latestDepartureAt: '2026-09-22T22:00:00.000Z',
  listedPriceCents: 1500, listedPriceLabel: '15美元/人', version: 5, cityKey: 'ny_nj',
  stops: [{ position: 0, kind: 'departure', address: 'Fort Lee', placeId: 'fort_lee', departureAt: '2026-09-21T19:00:00.000Z' },
    { position: 1, kind: 'departure', address: 'Second stop', placeId: null, departureAt: '2026-09-22T22:00:00.000Z' },
    { position: 2, kind: 'destination', address: '哥大', placeId: 'columbia', departureAt: null }] }
const now = rideTime.parseRideDateTime('2026-09-23', '09:00')

test('history conversion preserves actual last departure and authoritative price without importing private extra fields', () => {
  const trip = toHistoryRide({ ...base, creatorOpenid: 'private-other', passengers: ['private-other'], phone: 'private-phone' }, own)
  assert.equal(trip.businessVersion, 5)
  assert.equal(trip.departures[0].time, '15:00')
  assert.equal(trip.departures[1].time, '18:00')
  assert.equal(eligibleTrip(trip, own, now).departureAt, Date.parse(base.latestDepartureAt))
  assert.equal(eligibleTrip(trip, own, Date.parse(base.latestDepartureAt) + 4 * 3600000 - 1), null)
  assert.deepEqual(referencePrice(trip), { referencePriceCents: 1500, currency: 'USD', priceKind: 'listed_reference' })
  assert.doesNotMatch(JSON.stringify(trip), /private-/)
  for (const label of ['15/人', '待定', '10至20', '免费']) {
    const unknown = toHistoryRide({ ...base, listedPriceCents: null, listedPriceLabel: label }, own)
    assert.equal(unknown.listedPriceLabel, label); assert.deepEqual(referencePrice(unknown), {})
  }
  assert.equal(eligibleTrip(toHistoryRide({ ...base, followupEligible: false }, own), own, now), null)
  assert.equal(eligibleTrip(toHistoryRide({ ...base, status: 'open', followupEligible: false }, own), own, now), null)
})

test('the four-hour elapsed-time rule remains correct across both DST changes after DTO conversion', () => {
  for (const last of ['2026-03-08T04:30:00.000Z', '2026-11-01T03:30:00.000Z']) {
    const dto = { ...base, departureAt: last, latestDepartureAt: last, stops: [{ ...base.stops[0], departureAt: last }, base.stops[2]] }
    const trip = toHistoryRide(dto, own), due = Date.parse(last) + 4 * 3600000
    assert.equal(eligibleTrip(trip, own, due - 1), null)
    assert.ok(eligibleTrip(trip, own, due))
  }
})

test('history loader defaults to the old read and never falls back after a server error', async () => {
  let cloudCalls = 0
  const wx = { getStorageSync: key => key === 'openid' ? own : false,
    cloud: { callFunction: async input => { cloudCalls++; assert.deepEqual(input, { name: 'getMyTripHistory' }); return { result: { ok: true, data: [] } } } } }
  const disabled = { isBackendEnabled: () => false, get: () => assert.fail('unexpected HTTP') }
  assert.deepEqual(await loadRideHistory(own, { wx, backend: disabled }), { result: { ok: true, data: [] } })
  await assert.rejects(loadRideHistory(own, { wx, backend: { isBackendEnabled: () => true, get: async () => { throw new Error('offline') } } }), /offline/)
  assert.equal(cloudCalls, 1)
})

test('private history pagination is complete, validates progress, and cancels when the account changes', async () => {
  let account = own, calls = 0
  const wx = { getStorageSync: key => key === 'openid' ? account : false }
  const backend = { isBackendEnabled: () => true, get: async url => {
    calls++; assert.equal(url, `/api/v1/me/rides?scope=history&page=${calls}&limit=50`)
    return calls === 1 ? { rides: Array.from({ length: 50 }, (_, i) => ({ ...base, id: `ride-${i}` })), nextPage: 2 }
      : { rides: [{ ...base, id: 'ride-50' }], nextPage: null }
  } }
  assert.equal((await loadRideHistory(own, { wx, backend })).result.data.length, 51)
  for (const invalid of [{ rides: [], nextPage: 2 }, { rides: [], nextPage: 1 }, {}, { rides: [base], nextPage: undefined },
    { rides: [{ ...base, role: 'outsider' }], nextPage: null }]) {
    await assert.rejects(loadRideHistory(own, { wx, backend: { isBackendEnabled: () => true, get: async () => invalid } }), { code: 'INVALID_RESPONSE' })
  }
  await assert.rejects(loadRideHistory(own, { wx, backend: { isBackendEnabled: () => true,
    get: async () => { account = 'another-account'; return { rides: [base], nextPage: null } } } }), { code: 'INVALID_RESPONSE' })
})
