const test = require('node:test')
const assert = require('node:assert/strict')
const { createRideClient, toRide } = require('../utils/compat/rides')
const id = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
const stats = { completedTrips: 2, ratingCount: 0, averageRating: null, weightedRating: null }
const row = (patch = {}) => ({ id: 'ride', kind: 'offer', cityKey: 'ny_nj', status: 'open', seatCapacity: 3, availableSeats: 2,
  hasDriver: true, listedPriceCents: null, listedPriceLabel: '11-13$', version: 1, note: '', driverStatistics: stats,
  departureAt: '2030-01-01T20:00:00.000Z', stops: [{ position: 0, kind: 'departure', address: 'Fort Lee', placeId: 'fort_lee', departureAt: '2030-01-01T20:00:00.000Z' },
  { position: 1, kind: 'destination', address: 'Columbia', placeId: 'columbia', departureAt: null }], ...patch })
function harness(guest = false) {
  const state = { owner: guest ? '' : 'openid-owner', calls: [], cloud: [], writes: [],
    row: row(), viewer: { rideId: 'ride', version: 1, userId: id, isCreator: false, role: 'passenger', seatCount: 1 },
    members: { rideId: 'ride', kind: 'offer', version: 1, participants: [
      { id, name: 'Passenger', role: 'passenger', seatCount: 1, avatarFileId: null, statistics: stats },
      { id: other, name: 'Driver', role: 'driver', seatCount: 0, avatarFileId: null, statistics: stats, isCreator: true, wechatId: 'private-contact' }] } }
  const wx = { getStorageSync: key => key === 'openid' ? state.owner : false,
    cloud: { callFunction: async input => { state.cloud.push(input); return { result: { ok: true } } } } }
  const backend = { isBackendEnabled: () => true, resolveImages: async () => [], async get(path) {
    state.calls.push(path)
    if (state.get) return state.get(path)
    if (path.endsWith('/membership')) return state.viewer
    if (path.endsWith('/participants')) return state.members
    if (path.endsWith('/ratings')) return { ratings: [] }
    return state.row
  }, async mutate(...args) { state.writes.push(args); return { rideId: 'ride', version: 2, status: 'open', changed: true } } }
  return { state, backend, wx, api: createRideClient({ backend, wx }) }
}
test('public DTO preserves all stops, New York local time, unresolved quote and never creates identities', () => {
  const trip = toRide(row())
  assert.equal(trip.departures[0].date, '2030-01-01'); assert.equal(trip.departures[0].time, '15:00')
  assert.equal(trip.referencePrice, '11-13$'); assert.equal(trip.listedPriceCents, null)
  assert.equal(trip.availSeatNum, 2); assert.equal('_openid' in trip, false)
  assert.throws(() => toRide(row({ availableSeats: 5 })), { code: 'INVALID_RESPONSE' })
})
test('guest details make one public read and reveal neither memberships nor contacts', async () => {
  const h = harness(true), value = await h.api.getTripDetail('carpool', 'ride')
  assert.deepEqual(h.state.calls, ['/api/v1/rides/ride'])
  assert.equal(value.viewer.userId, null); assert.equal(value.driverInfo, null)
  assert.deepEqual(value.participants, []); assert.equal(h.state.cloud.length, 0)
})
test('member detail uses real UUIDs and one consistent public/membership/participants version', async () => {
  const h = harness(), detail = await h.api.getTripDetail('carpool', 'ride')
  assert.equal(detail.driverInfo.userId, other); assert.equal(detail.data.creatorUserId, other)
  assert.equal(detail.driverInfo.rideStats.completedDriverTrips, 2); assert.equal(detail.driverInfo.wechatID, 'private-contact'); assert.equal('_openid' in detail.driverInfo, false)
  h.state.members.version = 2
  await assert.rejects(h.api.getTripDetail('carpool', 'ride'), { code: 'RIDE_CHANGED' })
  assert.equal(h.state.cloud.length, 0)
  h.state.viewer.role = null; h.state.viewer.seatCount = 0; h.state.calls = []
  const outsider = await h.api.getTripDetail('carpool', 'ride')
  assert.equal(outsider.driverInfo, null)
  assert.equal(h.state.calls.some(p => p.endsWith('/participants')), false)
})
test('changed account discards private read; access errors do not become empty success or CloudBase fallback', async () => {
  const h = harness()
  h.state.get = async () => { h.state.owner = 'different-account'; return row() }
  await assert.rejects(h.api.getTripDetail('carpool', 'ride'), { code: 'REQUEST_CANCELLED' })
  h.state.get = async () => { throw Object.assign(Error('denied'), { code: 'RIDE_NOT_FOUND' }) }
  await assert.rejects(h.api.getTripDetail('carpool', 'ride'), { code: 'RIDE_NOT_FOUND' })
  assert.equal(h.state.cloud.length, 0)
})
test('date pagination is saturated only inside requested window and calendar honors the exact filters', async () => {
  const h = harness()
  h.state.get = async path => path.includes('/calendar?') ? { month: '2030-01', days: [{ date: '2030-01-01', offerCount: 51, requestCount: 0 }] }
    : { rides: path.includes('page=1&') ? Array.from({ length: 50 }, (_, n) => row({ id: 'ride' + n })) : [row({ id: 'last' })], nextPage: path.includes('page=1&') ? 2 : null, nextDate: '2030-01-05' }
  const value = await h.api.callTripList({ type: 'all', startDate: '2030-01-01', endDateExclusive: '2030-01-03' })
  assert.equal(value.result.data.carpool.length, 51); assert.equal(value.result.page.nextDate, '2030-01-05')
  const calendar = await h.api.callTripList({ month: '2030-01', type: 'carpool', fromPlace: '其他', fromPresets: ['Fort Lee', 'JFK'] })
  assert.equal(calendar.result.data.days[0].carpoolCount, 51)
  assert.match(h.state.calls.at(-1), /kind=offer/); assert.match(h.state.calls.at(-1), /fromPresets=%5B/)
})
test('write transport receives only canonical fields and validates receipt before retiring pending intent', async () => {
  const h = harness()
  await h.api.joinTrip({ type: 'carpool', tripId: 'ride', passengerInfo: { _openid: 'fake', phone: 'not-sent', pickupAddress: 'Lobby', dropoffAddress: 'Gate' } })
  assert.deepEqual(h.state.writes[0][3], { role: 'passenger', seatCount: 1, pickupAddress: 'Lobby', dropoffAddress: 'Gate' })
  const validate = h.state.writes[0][4].validate
  assert.equal(validate({ rideId: 'different', version: 2, status: 'open', changed: true }), false)
  assert.equal(validate({ rideId: 'ride', version: 2, status: 'open', changed: true }), true)
  await assert.rejects(h.api.callTripManage({ action: 'kickPassenger', tripId: 'ride', targetOpenid: other }), { code: 'INVALID_REQUEST' })
  assert.equal(h.state.writes.length, 1)
})
test('an active retry of changed input recovers exactly the previous operation without sending new input', async () => {
  const h = harness()
  h.backend.mutate = async () => { throw Object.assign(Error('pending'), { code: 'PENDING_OPERATION' }) }
  let recovered
  h.backend.retryPending = async (scope, options) => {
    recovered = scope
    const receipt = { ratingId: other, rideId: 'ride', targetId: other, score: 3 }
    assert.equal(options.validate(receipt), true)
    return receipt
  }
  const result = await h.api.callTripManage({ action: 'rateUser', tripId: 'ride', targetUserId: other, score: 5 })
  assert.equal(result.recovered, true); assert.equal(result.data.score, 3); assert.equal(recovered, 'rides.rate:ride:' + other)
})
test('explicit legacy selection uses original names and returns original envelopes', async () => {
  const h = harness(); h.backend.isBackendEnabled = () => false
  await h.api.callTripList({ month: '2030-01' }); await h.api.getTripDetail('request', 'old'); await h.api.getHomeTripList()
  await h.api.callTripManage({ action: 'quitTrip' }); await h.api.joinTrip({ type: 'request' })
  assert.deepEqual(h.state.cloud.map(c => c.name), ['getTripList', 'getTripDetail', 'getHomeTripList', 'tripManage', 'joinTrip'])
  assert.equal(h.state.calls.length, 0)
})
