const test = require('node:test')
const assert = require('node:assert/strict')
const { loadRideAlternatives } = require('../utils/rideAlternatives')
const { createRideClient } = require('../utils/compat/rides')
const { getRideDateTime, parseRideDateTime } = require('../utils/rideTime')
const NOW = Date.parse('2030-01-01T10:00:00Z')
const AT = Date.parse('2030-01-01T20:00:00Z')
const trip = (id = 'source', patch = {}) => ({ _id: id, kind: 'offer', cityKey: 'ny_nj', status: 'open', canonicalStatus: 'open',
  departureAtMs: AT, latestDepartureAtMs: AT, hasDriver: true, seatCapacity: 3, availableSeats: 0, availSeatNum: 0,
  listedPriceCents: 1000, departures: [{ address: 'Fort Lee', placeId: 'fort_lee', date: '2030-01-01', time: '15:00' }],
  destinations: [{ address: 'Columbia', placeId: 'columbia' }], ...patch })
const candidate = (id, patch = {}) => trip(id, { availableSeats: 1, availSeatNum: 1, ...patch })
const at = (id, offset, patch = {}) => {
  const stamp = AT + offset, wall = getRideDateTime(stamp)
  return candidate(id, { departureAtMs: stamp, latestDepartureAtMs: stamp,
    departures: [{ address: 'Fort Lee', date: wall.date, time: wall.time, second: wall.second }], ...patch })
}
function api(candidates, options = {}) {
  const calls = []
  const rides = { async callTripList(input) {
    calls.push(input)
    if (options.error) throw options.error
    return { result: { success: true, data: { carpool: candidates, request: [] },
      page: { startDate: input.startDate, endDateExclusive: input.endDateExclusive, hasMore: false, nextDate: null, ...options.page } } }
  } }
  return { rides, calls }
}
test('same New York day and complete route aliases include nearby departure times', async () => {
  const h = api([candidate('alias', { departures: [{ address: 'fortlee', date: '2030-01-01', time: '15:00' }],
    destinations: [{ address: '哥伦比亚大学' }] }), candidate('other-clock', { departureAtMs: AT + 60000,
    departures: [{ address: 'Fort Lee', date: '2030-01-01', time: '15:01' }] }),
  candidate('other-day', { departureAtMs: AT + 86400000, departures: [{ address: 'Fort Lee', date: '2030-01-02', time: '15:00' }] }),
  candidate('different-city', { cityKey: 'other' })])
  assert.deepEqual((await loadRideAlternatives(trip(), { rides: h.rides, now: NOW })).map(t => t._id), ['alias', 'other-clock'])
  assert.deepEqual(h.calls, [{ cityKey: 'ny_nj', type: 'carpool', startDate: '2030-01-01', endDateExclusive: '2030-01-02' }])
})
test('inclusive window allows 30 minutes earlier and 15 minutes later, with seconds outside excluded', async () => {
  const h = api([at('early-edge', -30 * 60000), at('late-edge', 15 * 60000),
    at('too-early', -30 * 60000 - 1000), at('too-late', 15 * 60000 + 1000)])
  assert.deepEqual((await loadRideAlternatives(trip(), { rides: h.rides, now: NOW })).map(t => t._id), ['late-edge', 'early-edge'])
  // An earlier alternative must still be future when the fresh day read ends.
  assert.deepEqual(await loadRideAlternatives(trip(), { rides: api([at('already-departed', -60000)]).rides, now: AT - 30000 }), [])
  let time = NOW
  const pending = { async callTripList(input) { time = AT; return api([at('after-source', 60000)]).rides.callTripList(input) } }
  assert.deepEqual(await loadRideAlternatives(trip(), { rides: pending, now: () => time }), [])
})
test('only known seats, assigned drivers and future open offers; current car is excluded', async () => {
  const h = api([candidate('source'), candidate('yes'), candidate('full', { availableSeats: 0, availSeatNum: 0 }),
    candidate('unknown', { availableSeats: null, availSeatNum: null }), candidate('no-driver', { hasDriver: false }),
    candidate('cancelled', { canonicalStatus: 'cancelled' }), candidate('past', { status: 'past' }),
    candidate('request', { kind: 'request' }), candidate('drift', { availSeatNum: 2 }),
    candidate('excess', { seatCapacity: 1, availableSeats: 2, availSeatNum: 2 })])
  assert.deepEqual((await loadRideAlternatives(trip(), { rides: h.rides, now: NOW })).map(t => t._id), ['yes'])
  assert.deepEqual(await loadRideAlternatives(trip(), { rides: h.rides, now: AT }), [])
  assert.equal(h.calls.length, 1)
  let time = NOW
  h.rides.callTripList = async input => { time = AT; return api([candidate('late')]).rides.callTripList(input) }
  assert.deepEqual(await loadRideAlternatives(trip(), { rides: h.rides, now: () => time }), [])
})
test('custom pickups need exact normalized addresses, even when broad placeIds are equal', async () => {
  const source = trip('source', { departures: [{ address: '2050 Central Road', placeId: 'fort_lee', date: '2030-01-01', time: '15:00' }] })
  const h = api([candidate('same', { departures: [{ address: ' 2050  CENTRAL Road ', placeId: 'custom', date: '2030-01-01', time: '15:00' }] }),
    candidate('other-building', { departures: [{ address: 'Modern 800', placeId: 'fort_lee', date: '2030-01-01', time: '15:00' }] }),
    candidate('missing-address', { departures: [{ address: '', placeId: 'fort_lee', date: '2030-01-01', time: '15:00' }] })])
  assert.deepEqual((await loadRideAlternatives(source, { rides: h.rides, now: NOW })).map(t => t._id), ['same'])
  assert.equal('fromPlace' in h.calls[0], false)
})
test('multi-stop routes require all places, ordering and a window at every corresponding departure', async () => {
  const source = trip('source', { latestDepartureAtMs: AT + 600000,
    departures: [trip().departures[0], { address: 'JFK', date: '2030-01-01', time: '15:10' }],
    destinations: [{ address: 'Columbia' }, { address: 'Flushing' }] })
  const good = candidate('exact', { departures: source.departures, destinations: source.destinations, latestDepartureAtMs: source.latestDepartureAtMs })
  const nearby = { ...good, _id: 'nearby', departureAtMs: AT - 30 * 60000, latestDepartureAtMs: AT - 20 * 60000,
    departures: [{ ...source.departures[0], time: '14:30' }, { ...source.departures[1], time: '14:40' }] }
  const h = api([good, nearby, candidate('first-only'), { ...good, _id: 'late-stop-outside', latestDepartureAtMs: AT + 26 * 60000,
    departures: [source.departures[0], { address: 'JFK', date: '2030-01-01', time: '15:26' }] },
  { ...good, _id: 'early-stop-outside', departureAtMs: AT - 30 * 60000, latestDepartureAtMs: AT - 21 * 60000,
    departures: [{ ...source.departures[0], time: '14:30' }, { ...source.departures[1], time: '14:39' }] },
  { ...good, _id: 'destination-order', destinations: [...source.destinations].reverse() },
  { ...good, _id: 'departure-order', departures: [...source.departures].reverse() },
  { ...good, _id: 'missing-last-destination', destinations: [{ address: 'Columbia' }] },
  candidate('later-stop-only', { departures: [{ address: 'Fort Lee', date: '2030-01-01', time: '14:50' }, source.departures[0]], departureAtMs: AT - 600000 })])
  assert.deepEqual((await loadRideAlternatives(source, { rides: h.rides, now: NOW })).map(t => t._id), ['exact', 'nearby'])
  const single = api([good])
  assert.deepEqual(await loadRideAlternatives(trip(), { rides: single.rides, now: NOW }), [])
})
test('nearby times may not cross the corresponding New York calendar date', async () => {
  const sourceAt = Date.parse('2030-01-02T05:10:00Z')
  const source = trip('source', { departureAtMs: sourceAt, latestDepartureAtMs: sourceAt,
    departures: [{ address: 'Fort Lee', date: '2030-01-02', time: '00:10' }] })
  const h = api([at('previous-day', sourceAt - AT - 20 * 60000), at('same-day', sourceAt - AT + 15 * 60000)])
  assert.deepEqual((await loadRideAlternatives(source, { rides: h.rides, now: NOW })).map(t => t._id), ['same-day'])
  const endAt = Date.parse('2030-01-03T04:50:00Z')
  const end = { ...source, departureAtMs: endAt, latestDepartureAtMs: endAt,
    departures: [{ address: 'Fort Lee', date: '2030-01-02', time: '23:50' }] }
  assert.deepEqual(await loadRideAlternatives(end, { rides: api([at('next-day', endAt - AT + 15 * 60000)]).rides, now: NOW }), [])
})
test('New York calendar date follows UTC absolute time; DST ambiguity never becomes a different instant', async () => {
  const stamp = Date.parse('2030-01-02T01:00:00Z')
  const source = trip('source', { departureAtMs: stamp, latestDepartureAtMs: stamp,
    departures: [{ address: 'Fort Lee', date: '2030-01-01', time: '20:00' }] })
  const h = api([{ ...source, _id: 'yes', availableSeats: 1, availSeatNum: 1 }])
  assert.equal((await loadRideAlternatives(source, { rides: h.rides, now: NOW })).length, 1)
  assert.equal(h.calls[0].startDate, '2030-01-01')
  const first = Date.parse('2030-11-03T05:30:00Z'), second = first + 3600000
  const ambiguous = trip('source', { departureAtMs: first, latestDepartureAtMs: first,
    departures: [{ address: 'Fort Lee', date: '2030-11-03', time: '01:30' }] })
  const repeated = api([{ ...ambiguous, _id: 'different-instant', departureAtMs: second, latestDepartureAtMs: second, availableSeats: 1, availSeatNum: 1 }])
  assert.deepEqual(await loadRideAlternatives(ambiguous, { rides: repeated.rides, now: first - 60000 }), [])
  await assert.rejects(loadRideAlternatives({ ...ambiguous, departureAtMs: undefined }, { rides: repeated.rides, now: first - 60000 }), { code: 'INVALID_ALTERNATIVE_ROUTE' })
  assert.ok(Number.isNaN(parseRideDateTime('2030-03-10', '02:30')))
})
test('fresh compatibility reads finish all selected-day pages before matching or returning empty', async () => {
  const calls = []
  const row = (id, seats = 0) => ({ id, kind: 'offer', cityKey: 'ny_nj', status: 'open', seatCapacity: 3, availableSeats: seats,
    hasDriver: true, listedPriceCents: 1000, listedPriceLabel: null, version: 1, departureAt: new Date(AT).toISOString(),
    stops: [{ position: 0, kind: 'departure', address: 'Fort Lee', placeId: 'fort_lee', departureAt: new Date(AT).toISOString() },
      { position: 1, kind: 'destination', address: 'Columbia', placeId: 'columbia', departureAt: null }] })
  const backend = { isBackendEnabled: () => true, async get(path) {
    calls.push(path)
    return path.includes('page=1&') ? { rides: Array.from({ length: 50 }, (_, i) => row('full' + i)), nextPage: 2, nextDate: '2030-01-05' }
      : { rides: [row('second-page-seat', 1)], nextPage: null, nextDate: '2030-01-05' }
  } }
  const rides = createRideClient({ backend, wx: { getStorageSync: () => '' } })
  assert.deepEqual((await loadRideAlternatives(trip(), { rides, now: NOW })).map(t => t._id), ['second-page-seat'])
  assert.equal(calls.length, 2)
  backend.get = async path => { if (path.includes('page=2&')) throw Error('page two failed'); return { rides: Array.from({ length: 50 }, (_, i) => row('full' + i)), nextPage: 2, nextDate: null } }
  await assert.rejects(loadRideAlternatives(trip(), { rides, now: NOW }), /page two failed/)
})
test('load errors, malformed/partial windows and changing pagination never become empty success', async () => {
  const failure = Object.assign(Error('unavailable'), { code: 'NETWORK_ERROR' })
  await assert.rejects(loadRideAlternatives(trip(), { rides: api([], { error: failure }).rides, now: NOW }), { code: 'NETWORK_ERROR' })
  for (const page of [{ startDate: '2030-01-02' }, { nextPage: 2 }, { hasMore: undefined }]) {
    await assert.rejects(loadRideAlternatives(trip(), { rides: api([], { page }).rides, now: NOW }), { code: 'INVALID_ALTERNATIVE_RESPONSE' })
  }
  await assert.rejects(loadRideAlternatives(trip(), { rides: api([candidate('duplicate'), candidate('duplicate')]).rides, now: NOW }), { code: 'RIDE_CHANGED' })
  assert.deepEqual(await loadRideAlternatives(trip(), { rides: api([], { page: { hasMore: true, nextDate: '2030-01-05' } }).rides, now: NOW }), [])
  await assert.rejects(loadRideAlternatives(trip(), { rides: api(Array(50000).fill(candidate('ceiling'))).rides, now: NOW }), { code: 'INVALID_ALTERNATIVE_RESPONSE' })
  await assert.rejects(loadRideAlternatives(trip('source', { departures: [] }), { rides: api([]).rides, now: NOW }), { code: 'INVALID_ALTERNATIVE_ROUTE' })
})
test('nearest first departure wins, with earlier time winning an equal absolute difference', async () => {
  const candidates = [at('far', -10 * 60000, { availableSeats: 3, availSeatNum: 3, listedPriceCents: 0 }),
    at('later', 5 * 60000, { availableSeats: 3, availSeatNum: 3, listedPriceCents: 0 }),
    at('earlier', -5 * 60000, { availableSeats: 1, availSeatNum: 1, listedPriceCents: 10000 }),
    at('same', 0, { availableSeats: 1, availSeatNum: 1, listedPriceCents: 10000 })]
  assert.deepEqual((await loadRideAlternatives(trip(), { rides: api(candidates).rides, now: NOW })).map(t => t._id), ['same', 'earlier', 'later'])
})
test('same-time ties rank at most three by known seats, price and stable identity without changing DTOs', async () => {
  const candidates = [candidate('z'), candidate('c', { availableSeats: 2, availSeatNum: 2, listedPriceCents: null }),
    candidate('b', { availableSeats: 2, availSeatNum: 2, listedPriceCents: 1200 }),
    candidate('a', { availableSeats: 2, availSeatNum: 2, listedPriceCents: 1200 }), candidate('d', { availableSeats: 2, availSeatNum: 2, listedPriceCents: 1000 })]
  const snapshot = structuredClone(candidates)
  assert.deepEqual((await loadRideAlternatives(trip(), { rides: api(candidates).rides, now: NOW })).map(t => t._id), ['d', 'a', 'b'])
  assert.deepEqual(candidates, snapshot)
})
