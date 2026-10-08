const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { feedbackView, rateDriver, ratingError } = require('../utils/tripFeedback')

const DRIVER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_DRIVER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SOURCE = path.resolve(__dirname, '../components/trip-feedback/index.js')
const plain = value => JSON.parse(JSON.stringify(value))
const trip = (patch = {}) => ({ _id: 'ride-1', _sourceType: 'carpool', _roleKind: 'passenger',
  driverUserId: DRIVER, _myRating: 0, ...patch })
const outcome = (value = 'yes', source = 'self_report') => ({ outcome: value, source, occurredAt: 123 })
const view = (patch = {}, value = outcome()) => feedbackView(trip(patch), value)
const tap = dataset => ({ currentTarget: { dataset } })

function component(initialTrip) {
  let definition
  vm.runInNewContext(fs.readFileSync(SOURCE, 'utf8'), { Component(value) { definition = value } }, { filename: SOURCE })
  const events = []
  const instance = { properties: { trip: initialTrip }, data: plain(definition.data),
    triggerEvent(name, detail) { events.push({ name, detail: plain(detail) }) } }
  Object.assign(instance, definition.methods)
  return { instance, events }
}

test('shared feedback uses the history questions and preserves the source trip', () => {
  const passenger = trip({ _feedbackBusy: true, _feedbackError: 'old error' })
  const original = plain(passenger)
  const passengerView = feedbackView(passenger, outcome())
  assert.equal(passengerView._feedbackQuestion, '您是否上车？')
  assert.equal(view({ _roleKind: 'driver' })._feedbackQuestion, '预约的乘客都上车了吗？')
  assert.equal(passengerView._feedbackReady, true)
  assert.equal(passengerView._feedbackBusy, false)
  assert.equal(passengerView._feedbackError, '')
  assert.equal(passengerView._feedbackOccurredAt, 123)
  assert.deepEqual(passenger, original)
})

test('only a confirmed yes from a passenger with a driver opens rating', () => {
  const passenger = view()
  assert.equal(passenger._showRating, true)
  assert.equal(passenger._feedbackStatus, '待评分')
  assert.equal(passenger._feedbackTone, 'rating')
  assert.equal(passenger._feedbackAssumed, false)
  for (const candidate of [view({}, outcome('no')), view({ _roleKind: 'driver' }),
    view({ _roleKind: 'unknown' }), view({ driverUserId: '' })]) {
    assert.equal(candidate._showRating, false)
    assert.equal(candidate._feedbackStatus, '已完成')
    assert.equal(candidate._feedbackTone, 'done')
  }
  for (const candidate of [view({}, outcome('yes', 'dismissed_default')),
    view({}, outcome(null, 'unanswered'))]) {
    assert.equal(candidate._showRating, false)
    assert.equal(candidate._feedbackStatus, '待确认')
    assert.equal(candidate._feedbackTone, 'pending')
  }
  assert.equal(view({}, outcome('yes', 'dismissed_default'))._feedbackAssumed, true)
})

test('an existing rating remains visible as completed and cannot be submitted again', async () => {
  const candidate = view({ _myRating: 3 })
  assert.equal(candidate._showRating, true)
  assert.equal(candidate._myRating, 3)
  assert.equal(candidate._feedbackStatus, '已完成')
  assert.equal(candidate._feedbackTone, 'done')
  let calls = 0
  await assert.rejects(rateDriver(candidate, 5, async () => { calls++ }), /INVALID_RATING/)
  assert.equal(calls, 0)
})

test('rating reuses the canonical target and renders the actual receipt score for offers and requests', async () => {
  for (const type of ['carpool', 'request']) {
    const candidate = view({ _sourceType: type })
    const calls = []
    const actual = await rateDriver(candidate, 5, async input => {
      calls.push(input)
      return { ok: true, data: { rideId: 'ride-1', targetId: DRIVER, score: 3 } }
    })
    assert.equal(actual, 3, 'an uncertain earlier submission may be recovered with a different score')
    assert.deepEqual(calls, [{ action: 'rateUser', type, tripId: 'ride-1', targetUserId: DRIVER, targetRole: 'driver', score: 5 }])
    assert.equal(candidate._myRating, 0, 'the caller owns view updates after checking its current page and account')
  }
})

test('invalid rating input, driver actions and unconfirmed answers never invoke the API', async () => {
  const invalid = [[null, 5], [view({ _roleKind: 'driver' }), 5],
    [view({}, outcome('no')), 5], [view({}, outcome('yes', 'dismissed_default')), 5],
    [view({ driverUserId: '' }), 5], [view({ _sourceType: 'unknown' }), 5],
    [view({ _showRating: false }, outcome(null, 'unanswered')), 5],
    ...[0, 6, 1.5, '5', undefined, NaN, Infinity].map(score => [view(), score])]
  let calls = 0
  for (const [candidate, score] of invalid) {
    await assert.rejects(rateDriver(candidate, score, async () => { calls++ }), /INVALID_RATING/)
  }
  assert.equal(calls, 0)
})

test('rating rejects a missing or mismatched receipt instead of treating the tapped score as saved', async () => {
  const data = { rideId: 'ride-1', targetId: DRIVER, score: 4 }
  const receipts = [null, { ok: false, data }, { ok: true },
    { ok: true, data: { ...data, rideId: 'other-ride' } },
    { ok: true, data: { ...data, targetId: OTHER_DRIVER } },
    ...[0, 6, 4.5, '4', undefined, NaN].map(score => ({ ok: true, data: { ...data, score } }))]
  for (const receipt of receipts) {
    let calls = 0
    await assert.rejects(rateDriver(view(), 5, async () => { calls++; return receipt }), /INVALID_RESPONSE/)
    assert.equal(calls, 1)
  }
})

test('API failures remain available to the caller and have the shared retry wording', async () => {
  const failure = Object.assign(new Error('earlier rating exists'), { code: 'ALREADY_RATED' })
  await assert.rejects(rateDriver(view(), 5, async () => { throw failure }), error => error === failure)
  assert.equal(ratingError(failure), '您已评价，请刷新查看')
  assert.equal(ratingError(new Error('offline')), '评价暂未保存，请重试')
})

test('component answer detail uses its own trip ID and rejects late taps after confirmation', () => {
  for (const answer of ['yes', 'no']) {
    const h = component(view({}, outcome(null, 'unanswered')))
    h.instance.onAnswer(tap({ id: 'forged-ride', outcome: answer }))
    assert.deepEqual(h.events, [{ name: 'answer', detail: { id: 'ride-1', outcome: answer } }])
    h.instance.properties.trip = view({}, outcome(answer))
    h.instance.onAnswer(tap({ outcome: 'yes' }))
    h.instance.onAnswer(tap({ outcome: 'no' }))
    assert.equal(h.events.length, 1)
  }
})

test('component permits a default-close correction but blocks disabled and malformed answers', () => {
  const correction = component(view({}, outcome('yes', 'dismissed_default')))
  correction.instance.onAnswer(tap({ outcome: 'no' }))
  assert.deepEqual(correction.events, [{ name: 'answer', detail: { id: 'ride-1', outcome: 'no' } }])
  correction.instance.properties.trip = view({}, outcome('no'))
  correction.instance.onAnswer(tap({ outcome: 'yes' }))
  assert.equal(correction.events.length, 1)

  for (const candidate of [null, view({ _id: '' }, outcome(null, 'unanswered')),
    { ...view({}, outcome(null, 'unanswered')), _feedbackBusy: true },
    { ...view({}, outcome(null, 'unanswered')), _feedbackReady: false }]) {
    const h = component(candidate)
    h.instance.onAnswer(tap({ outcome: 'yes' }))
    assert.deepEqual(h.events, [])
  }
  const malformed = component(view({}, outcome(null, 'unanswered')))
  for (const value of [undefined, {}, tap({}), tap({ outcome: 'maybe' }), tap({ outcome: true })]) {
    malformed.instance.onAnswer(value)
  }
  assert.deepEqual(malformed.events, [])
})

test('component rating detail identifies the current trip and pending or saved ratings reject duplicate taps', () => {
  const h = component(view())
  h.instance.onRate(tap({ id: 'forged-ride', score: '4' }))
  assert.deepEqual(h.events, [{ name: 'rate', detail: { id: 'ride-1', score: 4 } }])
  h.instance.properties.trip = { ...view(), _feedbackBusy: true }
  h.instance.onRate(tap({ score: 5 }))
  h.instance.properties.trip = view({ _myRating: 4 })
  h.instance.onRate(tap({ score: 3 }))
  assert.equal(h.events.length, 1)
})

test('component never emits ratings for unavailable, negative, assumed or invalid-score states', () => {
  const disabled = [null, view({ _id: '' }), view({ _roleKind: 'driver' }), view({ driverUserId: '' }),
    view({}, outcome('no')), view({}, outcome('yes', 'dismissed_default')),
    { ...view(), _feedbackOutcome: 'no' }, { ...view(), _feedbackOutcome: null }, { ...view(), _feedbackAssumed: true },
    { ...view(), _feedbackReady: false }, { ...view(), _feedbackBusy: true }, { ...view(), _showRating: false }]
  for (const candidate of disabled) {
    const h = component(candidate)
    h.instance.onRate(tap({ score: 5 }))
    assert.deepEqual(h.events, [])
  }
  const h = component(view())
  for (const score of [undefined, null, '', 0, 6, 1.5, NaN, Infinity, 'invalid']) h.instance.onRate(tap({ score }))
  h.instance.onRate()
  h.instance.onRate({})
  assert.deepEqual(h.events, [])
})

test('component retry only emits for a failed read while its controls are available', () => {
  const pending = { ...view({}, outcome(null, 'unanswered')), _feedbackReady: false, _feedbackError: '读取失败' }
  const h = component(pending)
  h.instance.onRetry()
  assert.deepEqual(h.events, [{ name: 'retry', detail: { id: 'ride-1' } }])
  for (const candidate of [null, { ...pending, _feedbackBusy: true },
    { ...pending, _feedbackReady: true }, { ...pending, _feedbackError: '' }]) {
    h.instance.properties.trip = candidate
    h.instance.onRetry()
  }
  assert.equal(h.events.length, 1)
})
