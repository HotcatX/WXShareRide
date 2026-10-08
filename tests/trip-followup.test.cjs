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
    rejectAnswer: false, rejectPresented: false, failStorage: false, id: 0, vibrations: [] }
  const wx = {
    getStorageSync(key) { if (state.failStorage) throw new Error('storage unavailable'); return copy(store[key]) },
    setStorageSync(key, value) { if (state.failStorage) throw new Error('storage unavailable'); store[key] = copy(value) },
    vibrateShort(input) { state.vibrations.push(input.type) }
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
  const controller = createFollowupController({ wx, analytics, now: () => state.now,
    rateDriver: options.rateDriver, loadRideHistory: options.loadRideHistory })
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

test('the latest departure plus one hour controls eligibility without a next-morning delay', () => {
  const due = at('2026-09-22', '18:00') + 3600000
  assert.equal(eligibleTrip(trip(), 'driver-a', due - 1), null)
  assert.ok(eligibleTrip(trip(), 'driver-a', due))
  const multiple = trip({ departures: [{ date: '2026-09-21', time: '10:00' }, { date: '2026-09-23', time: '00:30' }] })
  assert.equal(eligibleTrip(multiple, 'driver-a', at('2026-09-23', '01:29')), null)
  assert.ok(eligibleTrip(multiple, 'driver-a', at('2026-09-23', '01:30')))
  for (const date of ['2026-03-07', '2026-10-31']) {
    const item = trip({ departures: [{ date, time: '23:30' }] })
    const due = at(date, '23:30') + 3600000
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
      assert.equal(h.page.data.followupTrip._feedbackQuestion, role === 'driver' ? '预约的乘客都上车了吗？' : '您是否上车？')
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

test('history keeps completed trips beyond seven days and merges queued corrections without repeating home prompts', async () => {
  const h = harness({ now: T + 30 * DAY })
  const old = trip()
  assert.equal(eligibleTrip(old, 'driver-a', h.state.now), null)
  assert.equal(eligibleTrip(old, 'driver-a', h.state.now, true).role, 'driver')
  h.analytics.requestFollowupOutcomes = async payload => ({ ok: true, outcomes: payload.trips.map(value => ({ ...value, outcome: 'yes', source: 'dismissed_default', occurredAt: h.state.now - 100 })) })
  let flushes = 0; h.analytics.flush = async () => { flushes++; return { ok: false } }
  const before = await h.controller.readHistoryOutcomes([old])
  assert.equal(before[0].source, 'dismissed_default')
  const answer = h.controller.reportHistory(old, 'no', h.page)
  assert.equal(answer.ok, true); assert.equal(flushes, 1)
  const after = await h.controller.readHistoryOutcomes([old])
  assert.equal(after[0].source, 'self_report'); assert.equal(after[0].outcome, 'no')
  assert.equal(h.state.events[0].eventName, 'followup_answer')
  assert.equal(h.state.events[0].data.outcomeScope, 'driver_any_passenger')
  assert.equal(Object.keys(h.store).filter(key => key.startsWith(STORAGE_PREFIX)).length, 1)
  assert.equal(h.controller.considerTrips(h.page, [old]), false)
})
test('history query rejects missing/duplicate/wrong-scope response rows and never infers an outcome on failure', async () => {
  const h = harness(), current = trip()
  const good = { tripKey: 'trip_1', tripType: 'carpool', role: 'driver', outcome: null, source: 'unanswered', occurredAt: 0 }
  for (const value of [null, { ok: true, outcomes: [] }, { ok: true, outcomes: [good, good] },
    { ok: true, outcomes: [{ ...good, role: 'passenger' }] }, { ok: true, outcomes: [{ ...good, outcome: 'yes' }] },
    { ok: true, outcomes: [{ ...good, source: 'dismissed_default', outcome: 'no', occurredAt: T }] }]) {
    h.analytics.requestFollowupOutcomes = async () => value
    assert.equal(await h.controller.readHistoryOutcomes([current]), null)
  }
  h.analytics.requestFollowupOutcomes = async () => ({ ok: true, outcomes: [good] })
  assert.deepEqual(await h.controller.readHistoryOutcomes([current]), [good])
  h.analytics.requestFollowupOutcomes = async () => { h.store.openid = 'other-account'; return { ok: true, outcomes: [good] } }
  assert.equal(await h.controller.readHistoryOutcomes([current]), null)
})
test('history uses accepted local choices only and short thanks remain nonblocking and throttled', () => {
  const h = harness(); h.state.rejectAnswer = true
  assert.equal(h.controller.reportHistory(trip(), 'yes', h.page).ok, false)
  assert.equal(h.page.data.feedbackThanks, undefined)
  h.state.rejectAnswer = false
  assert.equal(h.controller.reportHistory(trip(), 'no', h.page).ok, true)
  assert.equal(h.page.data.feedbackThanks, true)
  assert.deepEqual(h.state.vibrations, [])
  h.page.data.feedbackThanks = false
  h.state.now += 1
  assert.equal(h.controller.reportHistory(trip({ _id: 'trip_2' }), 'yes', h.page).ok, true)
  assert.equal(h.page.data.feedbackThanks, false)
  h.state.now += 10000
  h.controller.thank(h.page, false)
  assert.deepEqual(h.state.vibrations, [])
  h.state.now += 10000
  h.controller.thank(h.page)
  assert.deepEqual(h.state.vibrations, ['light'])
})

test('history accepts a presented or hidden unanswered timestamp, and a late query cannot overwrite a queued correction', async () => {
  const h = harness(), current = trip()
  let resolve
  const pending = new Promise(done => { resolve = done })
  h.analytics.requestFollowupOutcomes = async () => pending
  const read = h.controller.readHistoryOutcomes([current])
  assert.equal(h.controller.reportHistory(current, 'no', h.page).ok, true)
  resolve({ ok: true, outcomes: [{ tripKey: 'trip_1', tripType: 'carpool', role: 'driver', outcome: null, source: 'unanswered', occurredAt: T - 1000 }] })
  const result = await read
  assert.equal(result[0].outcome, 'no'); assert.equal(result[0].source, 'self_report')
  const initial = h.state.events[0].occurredAt
  const corrected = h.controller.reportHistory(current, 'yes', h.page)
  assert.ok(corrected.occurredAt > initial, 'same-millisecond corrections have a definite latest outcome')
  const remote = { tripKey: 'trip_1', tripType: 'carpool', role: 'driver', outcome: null, source: 'unanswered', occurredAt: T - 500 }
  const fresh = harness(); fresh.analytics.requestFollowupOutcomes = async () => ({ ok: true, outcomes: [remote] })
  assert.deepEqual(await fresh.controller.readHistoryOutcomes([current]), [remote])
})
test('an explicit remote answer beats a newer local close assumption', async () => {
  const h = harness(); h.controller.considerTrips(h.page, [trip()]); h.controller.dismiss(h.page)
  const remote = { tripKey: 'trip_1', tripType: 'carpool', role: 'driver', outcome: 'no', source: 'self_report', occurredAt: T - 500 }
  h.analytics.requestFollowupOutcomes = async () => ({ ok: true, outcomes: [remote] })
  assert.deepEqual(await h.controller.readHistoryOutcomes([trip()]), [remote])
})

test('legacy outcome-less prompt cache cannot hide an accepted old-version queue answer, and cross-device correction wins', async () => {
  const h = harness(), current = trip()
  h.controller.considerTrips(h.page, [current]); h.controller.answer(h.page, 'no')
  const saved = Object.values(h.store).find(value => value && value.entries)
  for (const entry of Object.values(saved.entries)) delete entry.outcome // deployed 5.1 cache shape
  const queued = { tripKey: 'trip_1', tripType: 'carpool', role: 'driver', outcome: 'no', source: 'self_report', occurredAt: T }
  h.analytics.getPendingFollowupOutcomes = () => [queued]
  h.analytics.requestFollowupOutcomes = async () => ({ ok: true, outcomes: [{ ...queued, outcome: null, source: 'unanswered', occurredAt: 0 }] })
  assert.deepEqual(await h.controller.readHistoryOutcomes([current]), [queued])
  const remoteAt = T + 10000
  const result = h.controller.reportHistory({ ...current, _feedbackOccurredAt: remoteAt }, 'yes', h.page)
  assert.equal(result.ok, true); assert.equal(result.occurredAt, remoteAt + 1)
  assert.equal(h.state.events.at(-1).occurredAt, remoteAt + 1)
})

test('an upload ACK during an older query cannot erase a legacy queued answer', async () => {
  const h = harness(), current = trip()
  h.controller.considerTrips(h.page, [current]); h.controller.answer(h.page, 'no')
  const saved = Object.values(h.store).find(value => value && value.entries)
  for (const entry of Object.values(saved.entries)) delete entry.outcome
  let queued = [{ tripKey: 'trip_1', tripType: 'carpool', role: 'driver', outcome: 'no', source: 'self_report', occurredAt: T }]
  h.analytics.getPendingFollowupOutcomes = () => queued
  let resolve
  h.analytics.requestFollowupOutcomes = async () => new Promise(done => { resolve = done })
  const pending = h.controller.readHistoryOutcomes([current])
  queued = [] // batch ACK arrives before the earlier unanswered query response
  resolve({ ok: true, outcomes: [{ tripKey: 'trip_1', tripType: 'carpool', role: 'driver', outcome: null, source: 'unanswered', occurredAt: 0 }] })
  const result = await pending
  assert.equal(result[0].outcome, 'no'); assert.equal(result[0].source, 'self_report')
})

test('a fresh device only prompts when the collector proves the trip has never been presented or answered', async () => {
  const current = trip()
  for (const remote of [
    { source: 'self_report', outcome: 'yes', occurredAt: T - 1 },
    { source: 'self_report', outcome: 'no', occurredAt: T - 1 },
    { source: 'dismissed_default', outcome: 'yes', occurredAt: T - 1 },
    { source: 'unanswered', outcome: null, occurredAt: T - 1 },
    { source: 'unanswered', outcome: null, occurredAt: 0 }
  ]) {
    const h = harness()
    h.analytics.requestFollowupOutcomes = async payload => ({ ok: true,
      outcomes: payload.trips.map(value => ({ ...value, ...remote })) })
    const candidates = await h.controller.readUnpromptedTrips([current])
    assert.deepEqual(candidates, remote.occurredAt === 0 ? [current] : [])
    assert.equal(h.controller.considerTrips(h.page, candidates), remote.occurredAt === 0)
    assert.equal(h.state.events.length, remote.occurredAt === 0 ? 1 : 0)
    assert.equal(Object.keys(h.store).filter(key => key.startsWith(STORAGE_PREFIX)).length, remote.occurredAt === 0 ? 1 : 0,
      'reading remote history does not invent a local answer or default')
  }
})

test('home only prompts for seven-day trips but reads the full pending history for its badge', async () => {
  const h = harness(), current = trip(), no = trip({ _id: 'answered-trip' })
  const old = trip({ _id: 'old-trip', departures: [], departureAtMs: T - 8 * DAY })
  const cancelled = trip({ _id: 'cancelled-trip', cancelled: true })
  const queried = []
  h.analytics.requestFollowupOutcomes = async payload => {
    queried.push(payload)
    return { ok: true, outcomes: payload.trips.slice().reverse().map(value => ({ ...value,
      source: value.tripKey === no._id ? 'self_report' : 'unanswered', outcome: value.tripKey === no._id ? 'no' : null,
      occurredAt: value.tripKey === no._id ? T - 1 : 0 })) }
  }
  assert.deepEqual(await h.controller.readUnpromptedTrips([old, current, cancelled, no]), [current])
  assert.deepEqual(queried[0].trips.map(row => row.tripKey), [old._id, current._id, no._id])
  assert.deepEqual(await h.controller.readUnpromptedTrips([old, cancelled]), [])
  assert.equal(queried.length, 2)
})

test('failed, incomplete, or account/scope-stale remote history never makes home infer an unasked trip', async () => {
  for (const response of [null, { ok: true, outcomes: [] }, { ok: false, outcomes: [] }]) {
    const h = harness(); h.analytics.requestFollowupOutcomes = async () => response
    assert.equal(await h.controller.readUnpromptedTrips([trip()]), null)
    assert.equal(h.state.events.length, 0)
  }
  for (const change of [h => { h.store.openid = 'other' }, h => { h.state.scope = SCOPE.replace(':1', ':2') }]) {
    const h = harness(); h.analytics.requestFollowupOutcomes = async payload => {
      change(h); return { ok: true, outcomes: payload.trips.map(value => ({ ...value, outcome: null, source: 'unanswered', occurredAt: 0 })) }
    }
    assert.equal(await h.controller.readUnpromptedTrips([trip()]), null)
  }
})

test('an accepted local answer pending upload suppresses home even when the server read predates its ACK', async () => {
  const h = harness(), current = trip(); let resolve
  let queued = [{ tripKey: 'trip_1', tripType: 'carpool', role: 'driver', outcome: 'no', source: 'self_report', occurredAt: T }]
  h.analytics.getPendingFollowupOutcomes = () => queued
  h.analytics.requestFollowupOutcomes = async () => new Promise(done => { resolve = done })
  const pending = h.controller.readUnpromptedTrips([current]); queued = []
  resolve({ ok: true, outcomes: [{ tripKey: 'trip_1', tripType: 'carpool', role: 'driver', outcome: null, source: 'unanswered', occurredAt: 0 }] })
  assert.deepEqual(await pending, [])
  assert.equal(h.state.events.length, 0)
})

function passengerPrompt(options = {}, patch = {}) {
  const h = harness(options)
  h.store.openid = 'passenger-a'
  h.controller.considerTrips(h.page, [trip({ historyRole: 'passenger',
    driverUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', myRating: 0, ...patch })])
  return h
}
function ratingFlight() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('passenger yes replaces the question in the same prompt, persists once and rates via its exact trip', async () => {
  const calls = []
  const h = passengerPrompt({ rateDriver: async (item, score) => { calls.push({ id: item._id, score }); return 3 } })
  assert.equal(h.page.data.followupTrip._feedbackQuestion, '您是否上车？')
  assert.equal(h.controller.answer(h.page, 'yes', 'another-trip').ok, false)
  assert.equal(h.controller.answer(h.page, 'yes', 'trip_1').ok, true)
  assert.equal(h.page.data.followupVisible, true)
  assert.equal(h.page.data.followupTrip._feedbackOutcome, 'yes')
  assert.equal(h.page.data.followupTrip._showRating, true)
  assert.equal(h.controller.answer(h.page, 'no').ok, false)
  assert.equal((await h.controller.rate(h.page, 5, 'another-trip')).ok, false)
  assert.equal((await h.controller.rate(h.page, 6, 'trip_1')).ok, false)
  const result = await h.controller.rate(h.page, 5, 'trip_1')
  assert.deepEqual(result, { ok: true, score: 3 })
  assert.deepEqual(calls, [{ id: 'trip_1', score: 5 }])
  assert.equal(h.page.data.followupVisible, false)
  assert.equal(h.page.data.feedbackThanks, true)
  assert.deepEqual(h.state.vibrations, [])
  assert.deepEqual(h.state.events.map(item => item.eventName), ['followup_presented', 'followup_answer'])
  assert.equal((await h.controller.rate(h.page, 4, 'trip_1')).ok, false)
  assert.equal(h.controller.canConsider(), false)
})

test('no, unmatched and previously rated passengers finish without inviting a new rating', async () => {
  for (const [outcome, patch] of [['no', {}], ['yes', { driverUserId: '' }], ['yes', { myRating: 4 }]]) {
    const h = passengerPrompt({ rateDriver: () => assert.fail('no rating should be requested') }, patch)
    assert.equal(h.controller.answer(h.page, outcome).ok, true)
    assert.equal(h.page.data.followupVisible, false)
    assert.equal((await h.controller.rate(h.page, 5, 'trip_1')).ok, false)
  }
})

test('rejected yes remains a question; an accepted retry alone advances to rating', () => {
  const h = passengerPrompt()
  h.state.rejectAnswer = true
  assert.equal(h.controller.answer(h.page, 'yes').ok, false)
  assert.equal(h.page.data.followupTrip._showRating, false)
  assert.equal(h.page.data.followupTrip._feedbackOutcome, null)
  assert.equal(h.page.data.followupTrip._feedbackBusy, false)
  h.state.rejectAnswer = false
  assert.equal(h.controller.answer(h.page, 'yes').ok, true)
  assert.equal(h.page.data.followupTrip._showRating, true)
  assert.deepEqual(h.state.attempts[1], h.state.attempts[2])
})

test('failed ratings keep explicit yes and allow retry without a second followup answer', async () => {
  let attempts = 0
  const h = passengerPrompt({ rateDriver: async () => {
    if (++attempts === 1) throw new Error('offline')
    return 4
  } })
  h.controller.answer(h.page, 'yes')
  assert.equal((await h.controller.rate(h.page, 5, 'trip_1')).ok, false)
  assert.equal(h.page.data.followupVisible, true)
  assert.equal(h.page.data.followupTrip._feedbackOutcome, 'yes')
  assert.equal(h.page.data.followupTrip._feedbackBusy, false)
  assert.equal(h.page.data.followupTrip._feedbackError, '评价暂未保存，请重试')
  assert.equal((await h.controller.rate(h.page, 4, 'trip_1')).ok, true)
  assert.equal(h.state.events.length, 2)
})

test('busy ratings reject duplicate taps and closing their prompt never assumes another answer', async () => {
  const pending = ratingFlight(); let calls = 0
  const h = passengerPrompt({ rateDriver: () => { calls++; return pending.promise } })
  h.controller.answer(h.page, 'yes')
  const first = h.controller.rate(h.page, 5, 'trip_1')
  assert.equal((await h.controller.rate(h.page, 2, 'trip_1')).ok, false)
  assert.equal(calls, 1)
  h.controller.dismiss(h.page)
  pending.resolve(5); assert.equal((await first).ok, false)
  assert.equal(h.page.data.feedbackThanks, undefined)
  assert.equal(h.page.data.followupVisible, false)
  assert.equal(h.state.events.length, 2)
  assert.equal(h.state.events[1].data.outcome, 'yes')
})

test('late rating success or failure cannot update hidden, disposed, reauthorized or changed accounts', async () => {
  const changes = [h => h.controller.hide(h.page), h => h.controller.dispose(h.page),
    h => h.controller.endForeground(), h => { h.store.openid = 'other' }, h => { h.store.isGuest = true },
    h => { h.state.scope = '' }, h => { h.state.scope = 'test:participant_00000001:1' },
    h => { h.state.scope = 'real:participant_00000001:2' }]
  for (const change of changes) for (const rejected of [false, true]) {
    const pending = ratingFlight(), h = passengerPrompt({ rateDriver: () => pending.promise })
    h.controller.answer(h.page, 'yes')
    const task = h.controller.rate(h.page, 4, 'trip_1')
    change(h)
    const before = copy(h.page.data)
    rejected ? pending.reject(new Error('late failure')) : pending.resolve(4)
    assert.equal((await task).ok, false)
    assert.deepEqual(h.page.data, before)
    assert.equal(h.state.events.length, 2)
    assert.equal(h.page.data.feedbackThanks, undefined)
  }
})

test('an old rating receipt cannot replace a new prompt on the same page and same account', async () => {
  for (const rejected of [false, true]) {
    const pending = ratingFlight(), h = passengerPrompt({ rateDriver: () => pending.promise })
    h.controller.answer(h.page, 'yes')
    const task = h.controller.rate(h.page, 4, 'trip_1')
    h.controller.endForeground(); h.controller.beginForeground()
    assert.equal(h.controller.considerTrips(h.page, [trip({ _id: 'trip_2', historyRole: 'passenger' })]), true)
    const before = copy(h.page.data)
    rejected ? pending.reject(new Error('late failure')) : pending.resolve(4)
    await task
    assert.deepEqual(h.page.data, before)
    assert.equal(h.page.data.followupTrip._id, 'trip_2')
    assert.equal(h.state.events.length, 3)
  }
})

test('seven-day pause persists across restarts and authorization refresh, then resumes at its precise deadline', () => {
  const h = passengerPrompt()
  assert.equal(h.controller.pause(h.page).ok, true)
  assert.equal(h.page.data.followupVisible, false)
  assert.equal(h.state.events[1].eventName, 'followup_dismissed')
  assert.equal('assumedOutcome' in h.state.events[1].data, false)
  const before = harness({ store: h.store, now: T + 7 * DAY - 1, scope: 'real:participant_00000001:2' })
  assert.equal(before.controller.canConsider(), false)
  const resumed = harness({ store: h.store, now: T + 7 * DAY })
  assert.equal(resumed.controller.canConsider(), true)
  const recent = trip({ _id: 'recent', historyRole: 'passenger', departures: [], departureAtMs: resumed.state.now - 3600000 })
  assert.equal(resumed.controller.considerTrips(resumed.page, [recent]), true)
  const independent = harness({ store: h.store, now: T + DAY, scope: 'real:participant_00000002:1' })
  assert.equal(independent.controller.canConsider(), true)
  const testScope = harness({ store: h.store, now: T + DAY, scope: 'test:participant_00000001:1' })
  assert.equal(testScope.controller.canConsider(), true)
})

test('pausing after yes preserves the explicit answer and history remains usable during the pause', () => {
  const h = passengerPrompt(); h.controller.answer(h.page, 'yes')
  assert.equal(h.controller.pause(h.page).ok, true)
  assert.equal(h.state.events.length, 2)
  assert.equal(h.state.events[1].data.outcome, 'yes')
  h.controller.endForeground(); h.controller.beginForeground()
  assert.equal(h.controller.canConsider(), false)
  const history = trip({ _id: 'history-2', historyRole: 'passenger' })
  assert.equal(h.controller.reportHistory(history, 'no', h.page).ok, true)
})

function badgeHarness(options = {}) {
  const reads = { history: 0, outcomes: 0 }, rows = options.trips || [trip()]
  const h = harness({ ...options, loadRideHistory: async account => {
    reads.history++
    if (options.readHistory) return options.readHistory(account)
    return { result: { ok: true, data: rows } }
  } })
  h.analytics.requestFollowupOutcomes = async payload => {
    reads.outcomes++
    if (options.readOutcomes) return options.readOutcomes(payload)
    return { ok: true, outcomes: payload.trips.map(value => ({ ...value, source: 'unanswered', outcome: null, occurredAt: 0 })) }
  }
  const values = []
  const unsubscribe = h.controller.subscribePendingFollowup(value => values.push(value))
  return { ...h, reads, values, unsubscribe, rows }
}

test('badge shares history and outcome flights across entrances and expires its short cache without polling', async () => {
  const h = badgeHarness()
  await Promise.all([h.controller.refreshPendingFollowup(), h.controller.refreshPendingFollowup(), h.controller.loadHistory()])
  assert.deepEqual(h.reads, { history: 1, outcomes: 1 })
  assert.equal(h.values.at(-1), true)
  await h.controller.readUnpromptedTrips(h.rows)
  await h.controller.readHistoryOutcomes(h.rows, true)
  assert.deepEqual(h.reads, { history: 1, outcomes: 1 })
  h.state.now += 29999
  await h.controller.refreshPendingFollowup()
  assert.deepEqual(h.reads, { history: 1, outcomes: 1 })
  h.state.now++
  await h.controller.refreshPendingFollowup()
  assert.deepEqual(h.reads, { history: 2, outcomes: 2 })
  await h.controller.refreshPendingFollowup(true)
  assert.deepEqual(h.reads, { history: 3, outcomes: 3 })
  h.unsubscribe()
})

test('badge covers old history and seven-day pauses but not optional driver ratings', async () => {
  const old = trip({ _id: 'old-trip', departures: [], departureAtMs: T - 30 * DAY })
  const current = trip({ historyRole: 'passenger', driverUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
  const h = badgeHarness({ trips: [old, current] })
  h.store.openid = 'passenger-a'; old.historyRole = 'passenger'
  h.controller.considerTrips(h.page, [current])
  assert.equal(h.controller.pause(h.page).ok, true)
  assert.equal(h.controller.canConsider(), false)
  await h.controller.refreshPendingFollowup()
  assert.equal(h.values.at(-1), true)
  assert.equal(h.controller.reportHistory(old, 'no', h.page).ok, true)
  assert.equal(h.values.at(-1), true, 'the other unanswered ride keeps the dot')
  assert.equal(h.controller.reportHistory(current, 'yes', h.page).ok, true)
  assert.equal(h.values.at(-1), false, 'an optional rating is not an unanswered boarding question')
  const cached = await h.controller.readHistoryOutcomes(h.rows, true)
  assert.equal(cached.find(row => row.tripKey === current._id).source, 'self_report')
  assert.equal(h.reads.outcomes, 1, 'accepted choices update the cache without another request')
  h.unsubscribe()
})

test('default boarding remains pending; partial reads cannot clear a different unanswered trip', async () => {
  const h = badgeHarness({ trips: [trip(), trip({ _id: 'second-trip' })] })
  h.analytics.requestFollowupOutcomes = async payload => ({ ok: true, outcomes: payload.trips.map(value => ({ ...value,
    source: 'dismissed_default', outcome: 'yes', occurredAt: T - 1 })) })
  await h.controller.refreshPendingFollowup()
  assert.equal(h.values.at(-1), true)
  h.controller.reportHistory(h.rows[0], 'no', h.page)
  await h.controller.readHistoryOutcomes([h.rows[0]])
  assert.equal(h.values.at(-1), true)
  h.state.rejectAnswer = true
  assert.equal(h.controller.reportHistory(h.rows[1], 'yes', h.page).ok, false)
  assert.equal(h.values.at(-1), true)
  h.state.rejectAnswer = false
  h.controller.reportHistory(h.rows[1], 'yes', h.page)
  assert.equal(h.values.at(-1), false)
  h.unsubscribe()
})

test('one-hour eligibility, cancelled rides and full empty history control the badge', async () => {
  const notDue = trip({ departures: [], departureAtMs: T - 3600000 + 1 })
  const cancelled = trip({ _id: 'cancelled-trip', cancelled: true })
  const h = badgeHarness({ trips: [notDue, cancelled] })
  await h.controller.refreshPendingFollowup()
  assert.equal(h.values.at(-1), false)
  assert.equal(h.reads.outcomes, 0)
  h.state.now++
  await h.controller.readHistoryOutcomes(h.rows, true)
  assert.equal(h.values.at(-1), true)
  await h.controller.readHistoryOutcomes([], true)
  assert.equal(h.values.at(-1), false)
  h.unsubscribe()
})

test('badge failures keep a known pending state and do not consume the next retry', async () => {
  const h = badgeHarness()
  await h.controller.refreshPendingFollowup()
  h.state.now += 30000
  h.analytics.requestFollowupOutcomes = async () => { h.reads.outcomes++; throw new Error('offline') }
  await h.controller.refreshPendingFollowup()
  assert.equal(h.values.at(-1), true)
  await h.controller.refreshPendingFollowup()
  assert.equal(h.reads.outcomes, 3, 'failed outcome reads are immediately retryable')
  assert.equal(h.state.events.length, 0)
  h.unsubscribe()
})

test('guest, account, collection mode and authorization changes clear old badge results and reject stale reads', async () => {
  for (const change of [h => { h.store.isGuest = true }, h => { h.store.openid = 'other' },
    h => { h.state.scope = SCOPE.replace('real:', 'test:') }, h => { h.state.scope = SCOPE.replace(':1', ':2') }]) {
    let resolve
    const h = badgeHarness({ readOutcomes: async () => new Promise(done => { resolve = done }) })
    const read = h.controller.refreshPendingFollowup()
    await new Promise(done => setImmediate(done))
    change(h)
    resolve({ ok: true, outcomes: [{ tripKey: 'trip_1', tripType: 'carpool', role: 'driver', source: 'unanswered', outcome: null, occurredAt: 0 }] })
    await read
    assert.equal(h.values.at(-1), false)
    assert.equal(h.state.events.length, 0)
    h.unsubscribe()
  }
})

test('an A-to-B-to-A return cannot adopt the first account generation result', async () => {
  let resolve
  const h = badgeHarness({ readOutcomes: async () => new Promise(done => { resolve = done }) })
  const read = h.controller.refreshPendingFollowup()
  await new Promise(done => setImmediate(done))
  h.store.openid = 'other'
  const temporary = h.controller.subscribePendingFollowup(() => {})
  h.store.openid = 'driver-a'
  const resumed = h.controller.subscribePendingFollowup(() => {})
  resolve({ ok: true, outcomes: [{ tripKey: 'trip_1', tripType: 'carpool', role: 'driver', source: 'unanswered', outcome: null, occurredAt: 0 }] })
  await read
  assert.equal(h.values.at(-1), false)
  temporary(); resumed(); h.unsubscribe()
})

test('lazy scope initialization keeps the same account history request valid', async () => {
  const h = badgeHarness()
  h.state.scope = ''
  h.analytics.requestFollowupOutcomes = async (payload, beforeRequest) => {
    h.state.scope = SCOPE
    beforeRequest()
    return { ok: true, outcomes: payload.trips.map(value => ({ ...value, source: 'unanswered', outcome: null, occurredAt: 0 })) }
  }
  const result = await h.controller.readHistoryOutcomes(h.rows, true)
  assert.equal(result[0].source, 'unanswered')
  assert.equal(h.values.at(-1), true)
  h.unsubscribe()
})

test('failed pause storage and stale account never falsely acknowledge a seven-day pause', () => {
  const h = passengerPrompt(); h.state.failStorage = true
  assert.equal(h.controller.pause(h.page).ok, false)
  assert.equal(h.page.data.followupVisible, true)
  assert.equal(h.state.events.length, 1)
  const switched = passengerPrompt(); switched.store.openid = 'other'
  assert.equal(switched.controller.pause(switched.page).ok, false)
  assert.equal(switched.state.events.length, 1)
})
