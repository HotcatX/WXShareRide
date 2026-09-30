const test = require('node:test')
const assert = require('node:assert/strict')
const { createFollowupController, eligibleTrip, referencePrice, STORAGE_PREFIX } = require('../utils/tripFollowup')
const { validateEvent } = require('../utils/analyticsSchema')
const { sha256 } = require('../utils/hash')
const { parseRideDateTime: at } = require('../utils/rideTime')

const DAY = 86400000
const T = at('2026-09-23', '09:00')
const SCOPE = 'real:participant_00000001:1'
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
function trip(patch = {}) {
  return Object.assign({ _id: 'trip_1', historySource: 'carpool', historyRole: 'driver_create',
    _openid: 'driver-a', status: 'past', departures: [{ date: '2026-09-22', time: '18:00', address: 'fixture origin' }],
    destinations: [{ address: 'fixture destination' }], passengers: [{ _openid: 'passenger-a' }], price: '$20' }, patch)
}
function harness(options = {}) {
  const store = options.store || { openid: 'driver-a' }
  const state = { now: options.now || T, scope: options.scope || SCOPE, events: [], attempts: [],
    rejectAnswer: false, rejectPresented: false, failStorage: false, id: 0 }
  const wx = {
    getStorageSync(key) { if (state.failStorage) throw new Error('storage unavailable'); return copy(store[key]) },
    setStorageSync(key, value) { if (state.failStorage) throw new Error('storage unavailable'); store[key] = copy(value) }
  }
  const analytics = {
    getCollectionScope: () => state.scope,
    makeEventId: () => `fixture_event_${String(++state.id).padStart(10, '0')}`,
    recordEvent(name, data, meta) {
      const event = Object.assign({ eventName: name, schemaVersion: 1, data: copy(data) }, meta)
      assert.equal(validateEvent(event, state.now), true, 'all follow-up events satisfy the shared production schema')
      state.attempts.push(copy(event))
      if (name === 'followup_presented' && state.rejectPresented) return { ok: false }
      if (name === 'followup_answer' && state.rejectAnswer) return { ok: false }
      state.events.push(copy(event)); return { ok: true }
    }
  }
  const controller = createFollowupController({ wx, analytics, now: () => state.now })
  const page = { data: {}, setData(patch) { Object.assign(this.data, copy(patch)) } }
  return { controller, page, store, state, wx, analytics }
}

test('current creator/member identity determines driver and booking roles, including multi-person requests', () => {
  assert.equal(eligibleTrip(trip(), 'driver-a', T).role, 'driver')
  assert.equal(eligibleTrip(trip({ historyRole: 'passenger' }), 'passenger-a', T).role, 'passenger')
  assert.equal(eligibleTrip(trip({ passengers: undefined, passengerID: ['passenger-a'], historyRole: 'passenger' }), 'passenger-a', T).role, 'passenger')
  const request = trip({ historySource: 'request', _openid: 'creator-a', driverOpenid: 'driver-b',
    historyRole: 'driver_join', passengerID: [{ _openid: 'passenger-b', passengerNum: 3 }] })
  assert.equal(eligibleTrip(request, 'driver-b', T).role, 'driver')
  assert.equal(eligibleTrip(Object.assign({}, request, { historyRole: 'passenger_create' }), 'creator-a', T).role, 'passenger')
  assert.equal(eligibleTrip(Object.assign({}, request, { historyRole: 'passenger' }), 'passenger-b', T).role, 'passenger')
  assert.equal(eligibleTrip(trip({ historyRole: 'passenger' }), 'stranger', T), null)
  assert.equal(eligibleTrip(trip({ historyRole: 'passenger' }), 'driver-a', T), null)
  assert.equal(eligibleTrip(trip({ passengers: [], passengerID: ['passenger-a'], historyRole: 'passenger' }), 'passenger-a', T), null)
})

test('unmatched creators remain eligible to report no; a matched trip is not assumed to have operated', () => {
  assert.equal(eligibleTrip(trip({ passengers: [] }), 'driver-a', T).role, 'driver')
  const request = trip({ historySource: 'request', historyRole: 'passenger_create', driverOpenid: '', passengerID: [] })
  assert.equal(eligibleTrip(request, 'driver-a', T).role, 'passenger')
})

test('the latest departure plus four hours controls eligibility without a next-morning delay', () => {
  const due = at('2026-09-22', '18:00') + 4 * 3600000
  assert.equal(eligibleTrip(trip(), 'driver-a', due - 1), null)
  assert.ok(eligibleTrip(trip(), 'driver-a', due))
  const multiple = trip({ departures: [{ date: '2026-09-21', time: '10:00' }, { date: '2026-09-23', time: '00:30' }] })
  assert.equal(eligibleTrip(multiple, 'driver-a', at('2026-09-23', '04:29')), null)
  assert.ok(eligibleTrip(multiple, 'driver-a', at('2026-09-23', '04:30')))
  for (const date of ['2026-03-07', '2026-10-31']) {
    const item = trip({ departures: [{ date, time: '23:30' }] })
    const due = at(date, '23:30') + 4 * 3600000
    assert.equal(eligibleTrip(item, 'driver-a', due - 1), null)
    assert.ok(eligibleTrip(item, 'driver-a', due))
  }
})

test('missing, future, stale, cancelled and no-longer-participating records never become questions', () => {
  for (const patch of [{ missing: true }, { _id: '../trip' }, { status: 'ongoing' }, { cancelled: true },
    { deletedAt: 123 }, { historySource: 'unknown' }, { departures: [] },
    { departures: [{ date: '2026-09-23', time: '20:00' }] }, { _openid: 'other-driver' }]) {
    assert.equal(eligibleTrip(trip(patch), 'driver-a', T), null, JSON.stringify(patch))
  }
  const departureAt = at('2026-09-16', '09:00')
  const item = trip({ departures: [], departureAtMs: departureAt })
  assert.ok(eligibleTrip(item, 'driver-a', departureAt + 7 * DAY))
  assert.equal(eligibleTrip(item, 'driver-a', departureAt + 7 * DAY + 1), null)
  assert.equal(eligibleTrip(trip(), '', T), null)
})

test('yes/no use role-specific meanings, capture only listed reference price, and immediately finish', () => {
  for (const role of ['driver', 'passenger']) {
    for (const outcome of ['yes', 'no']) {
      const h = harness()
      const item = trip({ historyRole: role === 'driver' ? 'driver_create' : 'passenger' })
      if (role === 'passenger') h.store.openid = 'passenger-a'
      assert.equal(h.controller.considerTrips(h.page, [item]), true)
      assert.equal(h.page.data.followupQuestion, role === 'driver' ? '您接到乘客了吗？' : '您坐上车了吗？')
      assert.equal(h.controller.answer(h.page, outcome).ok, true)
      assert.equal(h.page.data.followupVisible, false)
      const answer = h.state.events[1]
      assert.equal(answer.eventName, 'followup_answer')
      assert.equal(answer.data.outcome, outcome)
      assert.equal(answer.data.outcomeScope, role === 'driver' ? 'driver_any_passenger' : 'respondent_booking')
      assert.equal(answer.data.referencePriceCents, 2000)
      assert.equal(answer.data.priceKind, 'listed_reference')
      assert.equal('actualAmountCents' in answer.data, false)
      assert.equal('priceStatus' in answer.data, false)
      assert.notEqual(answer.eventId, answer.data.followupId)
      assert.equal(h.controller.answer(h.page, outcome).ok, false)
      assert.equal(h.state.events.length, 2)
      assert.equal(JSON.stringify(h.state.events).includes('driver-a'), false)
      assert.equal(JSON.stringify(h.state.events).includes('fixture origin'), false)
      const saved = Object.entries(h.store).filter(([key]) => key.startsWith(STORAGE_PREFIX))
      assert.equal(saved.length, 1)
      assert.equal(JSON.stringify(saved).includes('driver-a'), false)
    }
  }
})

test('unknown or price-range references stay absent rather than becoming a zero fare', () => {
  for (const value of [undefined, null, '', '待定', '$20-30', '电话议价', '-2', NaN, Infinity]) {
    assert.deepEqual(referencePrice({ price: value }), {})
    const h = harness(); h.controller.considerTrips(h.page, [trip({ price: value })]); h.controller.answer(h.page, 'yes')
    assert.equal('referencePriceCents' in h.state.events[1].data, false)
  }
  assert.deepEqual(referencePrice({ price: 0 }), { referencePriceCents: 0, currency: 'USD', priceKind: 'listed_reference' })
  assert.equal(referencePrice({ price: '12.34 USD/人' }).referencePriceCents, 1234)
})

test('queue rejection leaves answer available; retry keeps event ID and occurredAt and only success marks done', () => {
  const h = harness(); h.controller.considerTrips(h.page, [trip()]); h.state.rejectAnswer = true
  assert.equal(h.controller.answer(h.page, 'yes').ok, false)
  assert.equal(h.page.data.followupVisible, true)
  const saved = Object.values(h.store).find(value => value && value.entries)
  assert.equal(Object.values(saved.entries)[0].status, 'shown')
  h.state.now += 2000; h.state.rejectAnswer = false
  assert.equal(h.controller.answer(h.page, 'yes').ok, true)
  assert.deepEqual(h.state.attempts[1], h.state.attempts[2])
  assert.equal(h.state.events.length, 2)
  assert.equal(Object.values(Object.values(h.store).find(value => value && value.entries).entries)[0].status, 'answered')
})

test('a rejected presented event never consumes the chance of a prompt that was not displayed', () => {
  const h = harness(); h.state.rejectPresented = true
  assert.equal(h.controller.considerTrips(h.page, [trip()]), false)
  assert.notEqual(h.page.data.followupVisible, true)
  assert.equal(h.state.events.length, 0)
  const restarted = harness({ store: h.store })
  assert.equal(restarted.controller.considerTrips(restarted.page, [trip()]), true)
  assert.equal(restarted.page.data.followupVisible, true)
})

test('closing assumes completion with a separate source, never asks that trip again, and keeps one foreground limit', () => {
  const h = harness(); assert.equal(h.controller.considerTrips(h.page, [trip()]), true)
  assert.equal(h.controller.canConsider(), false)
  assert.equal(h.controller.considerTrips(h.page, [trip()]), false)
  h.controller.dismiss(h.page)
  assert.deepEqual(h.state.events.map(e => e.eventName), ['followup_presented', 'followup_dismissed'])
  assert.equal(h.state.events[1].data.assumedOutcome, 'yes')
  assert.equal(h.state.events[1].data.dismissalReason, 'close')
  assert.equal(h.state.events[1].data.outcomeScope, 'driver_any_passenger')
  assert.equal(h.state.events[1].data.referencePriceCents, 2000)
  assert.equal('outcome' in h.state.events[1].data, false, 'no false user answer')
  const second = trip({ _id: 'trip_2' })
  assert.equal(h.controller.considerTrips(h.page, [second]), false)
  h.controller.beginForeground()
  assert.equal(h.controller.considerTrips(h.page, [second]), false, 'duplicate begin cannot reset budget')
  h.controller.endForeground(); h.controller.beginForeground()
  assert.equal(h.controller.considerTrips(h.page, [trip()]), false, 'dismissal is terminal')
  assert.equal(h.controller.canConsider(), true)
  assert.equal(h.controller.considerTrips(h.page, [second]), true, 'another trip does not wait 24 hours')
  h.controller.hide(h.page)
  const restarted = harness({ store: h.store, now: T + DAY })
  assert.equal(restarted.controller.considerTrips(restarted.page, [trip(), second]), false)
})

test('old shown/dismissed entries survive restart and never get rewritten into assumed answers', () => {
  for (const status of ['shown', 'dismissed']) {
    const h = harness(); h.controller.considerTrips(h.page, [trip()])
    const saved = Object.values(h.store).find(value => value && value.entries)
    Object.values(saved.entries)[0].status = status
    const restarted = harness({ store: h.store, now: T + DAY, scope: 'real:participant_00000001:2' })
    assert.equal(restarted.controller.considerTrips(restarted.page, [trip()]), false)
    assert.equal(restarted.state.events.length, 0)
  }
})

test('dismissal only defaults a live matching account and never changes a submitted answer', () => {
  const passenger = harness(); passenger.store.openid = 'passenger-a'
  passenger.controller.considerTrips(passenger.page, [trip({ historyRole: 'passenger' })])
  passenger.controller.dismiss(passenger.page)
  assert.equal(passenger.state.events[1].data.outcomeScope, 'respondent_booking')
  passenger.controller.dismiss(passenger.page)
  assert.equal(passenger.state.events.length, 2)
  const answered = harness(); answered.controller.considerTrips(answered.page, [trip()])
  answered.controller.answer(answered.page, 'no'); answered.controller.dismiss(answered.page)
  assert.equal(answered.state.events.length, 2)
  assert.equal(answered.state.events[1].data.outcome, 'no')
  const changed = harness(); changed.controller.considerTrips(changed.page, [trip()])
  changed.store.openid = 'other'; changed.controller.dismiss(changed.page)
  assert.equal(changed.state.events.length, 1)
})

test('saved answer survives SDK restart and authorization-version change; test and real scopes stay separate', () => {
  const h = harness(); h.controller.considerTrips(h.page, [trip()]); h.controller.answer(h.page, 'yes')
  const restarted = harness({ store: h.store, now: T + DAY, scope: 'real:participant_00000001:3' })
  assert.equal(restarted.controller.considerTrips(restarted.page, [trip()]), false)
  const synthetic = harness({ store: h.store, now: T + DAY, scope: 'test:participant_00000001:1' })
  assert.equal(synthetic.controller.considerTrips(synthetic.page, [trip()]), true)
  assert.notEqual(synthetic.state.events[0].data.followupId, h.state.events[0].data.followupId)
})

test('identity, environment or authorization changes invalidate an open question before recording', () => {
  for (const mutate of [h => { h.store.openid = 'other-user' }, h => { h.store.isGuest = true },
    h => { h.state.scope = '' }, h => { h.state.scope = 'test:participant_00000001:1' },
    h => { h.state.scope = 'real:participant_00000001:2' }]) {
    const h = harness(); h.controller.considerTrips(h.page, [trip()]); mutate(h)
    assert.equal(h.controller.answer(h.page, 'yes').ok, false)
    assert.equal(h.page.data.followupVisible, false)
    assert.equal(h.state.events.length, 1)
  }
  const h = harness(); h.controller.considerTrips(h.page, [trip()]); h.state.scope = ''
  h.controller.considerTrips(h.page, [trip()])
  assert.equal(h.page.data.followupVisible, false, 'authorization subscriber closes a stale question')
})

test('unavailable storage, malformed state, guest mode or missing grant fail closed', () => {
  const key = STORAGE_PREFIX + sha256('real:participant_00000001')
  for (const setup of [h => { h.state.failStorage = true }, h => { h.store.isGuest = true },
    h => { h.state.scope = '' }, h => { h.store[key] = { version: 99, entries: {} } },
    h => { h.store[key] = { version: 1, entries: {}, lastPromptAt: T + DAY } }]) {
    const h = harness(); setup(h)
    assert.equal(h.controller.considerTrips(h.page, [trip()]), false)
    assert.equal(h.state.events.length, 0)
  }
})

test('hide/background emits at most one dismissal and disposed pages can never show a later question', () => {
  const h = harness(); h.controller.considerTrips(h.page, [trip()])
  h.controller.endForeground(); h.controller.hide(h.page); h.controller.dispose(h.page)
  assert.deepEqual(h.state.events.map(e => e.eventName), ['followup_presented', 'followup_dismissed'])
  assert.equal(h.state.events[1].data.dismissalReason, 'hidden')
  assert.equal('assumedOutcome' in h.state.events[1].data, false)
  h.state.now += DAY; h.controller.beginForeground()
  assert.equal(h.controller.considerTrips(h.page, [trip()]), false)
})
