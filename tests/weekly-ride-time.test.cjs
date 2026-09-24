const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { getNextWeeklyRideDate } = require('../utils/rideTime')

const at = iso => Date.parse(iso)

test('weekly schedule chooses the next specified weekday at the New York class time', () => {
  assert.equal(getNextWeeklyRideDate(1, '15:00', {
    now: at('2026-09-24T16:00:00Z') // Thursday noon in New York.
  }), '2026-09-29')
  assert.equal(getNextWeeklyRideDate(0, '08:00', {
    now: at('2026-09-27T20:00:00Z')
  }), '2026-09-28')
  assert.equal(getNextWeeklyRideDate(6, '20:00', {
    now: at('2026-09-24T16:00:00Z')
  }), '2026-09-27')
})

test('same weekday is usable at exactly fifteen minutes of lead time', () => {
  assert.equal(getNextWeeklyRideDate(1, '15:00', {
    now: at('2026-09-22T18:45:00Z')
  }), '2026-09-22')
  assert.equal(getNextWeeklyRideDate(1, '15:00', {
    now: at('2026-09-22T18:44:00Z')
  }), '2026-09-22')
})

test('insufficient lead time or an elapsed class time rolls forward a whole week', () => {
  for (const now of ['2026-09-22T18:45:01Z', '2026-09-22T19:00:00Z', '2026-09-22T22:00:00Z']) {
    assert.equal(getNextWeeklyRideDate(1, '15:00', { now: at(now) }), '2026-09-29')
  }
})

test('reusing a history record starts at least one calendar week after its source date', () => {
  assert.equal(getNextWeeklyRideDate(1, '15:00', {
    now: at('2026-09-24T16:00:00Z'), afterDate: '2026-09-22'
  }), '2026-09-29')
  assert.equal(getNextWeeklyRideDate(1, '15:00', {
    now: at('2026-09-24T16:00:00Z'), afterDate: '2026-09-29'
  }), '2026-10-06')
})

test('an old history record advances by full weeks until its class time is usable', () => {
  assert.equal(getNextWeeklyRideDate(1, '15:00', {
    now: at('2026-09-24T16:00:00Z'), afterDate: '2026-08-18'
  }), '2026-09-29')
  assert.equal(getNextWeeklyRideDate(1, '15:00', {
    now: at('2026-09-29T18:46:00Z'), afterDate: '2026-09-22'
  }), '2026-10-06')
})

test('history date is a lower bound even if its weekday differs from the requested schedule', () => {
  assert.equal(getNextWeeklyRideDate(1, '15:00', {
    now: at('2026-09-24T16:00:00Z'), afterDate: '2026-09-25'
  }), '2026-10-06')
})

test('the thirty-day horizon includes its exact instant and excludes one minute beyond it', () => {
  assert.equal(getNextWeeklyRideDate(5, '15:00', {
    now: at('2026-09-24T19:00:00Z'), afterDate: '2026-10-17'
  }), '2026-10-24')
  assert.equal(getNextWeeklyRideDate(5, '15:00', {
    now: at('2026-09-24T18:59:00Z'), afterDate: '2026-10-17'
  }), '')
  assert.equal(getNextWeeklyRideDate(1, '15:00', {
    now: at('2026-09-24T16:00:00Z'), afterDate: '2026-10-20'
  }), '')
})

test('the horizon measures elapsed hours rather than thirty calendar dates across fall DST', () => {
  assert.equal(getNextWeeklyRideDate(6, '01:30', {
    now: at('2026-10-09T05:30:00Z'), afterDate: '2026-11-01'
  }), '') // November 8 01:30 EST is thirty days plus one hour away.
  assert.equal(getNextWeeklyRideDate(6, '01:30', {
    now: at('2026-10-09T06:30:00Z'), afterDate: '2026-11-01'
  }), '2026-11-08')
})

test('the nonexistent spring Sunday 02:30 is skipped instead of changed to a different clock time', () => {
  for (const after of [{}, { afterDate: '2026-03-01' }]) {
    assert.equal(getNextWeeklyRideDate(6, '02:30', {
      now: at('2026-03-06T17:00:00Z'), ...after
    }), '2026-03-15')
  }
})

test('weekly time remains on Sunday through the fall repeated hour', () => {
  assert.equal(getNextWeeklyRideDate(6, '01:30', {
    now: at('2026-10-30T16:00:00Z'), afterDate: '2026-10-25'
  }), '2026-11-01')
  assert.equal(getNextWeeklyRideDate(6, '15:00', {
    now: at('2026-10-30T16:00:00Z'), afterDate: '2026-10-25'
  }), '2026-11-01')
})

test('a weekly date can cross a year or leap-day boundary while retaining its weekday', () => {
  assert.equal(getNextWeeklyRideDate(1, '15:00', {
    now: at('2026-12-30T17:00:00Z'), afterDate: '2026-12-29'
  }), '2027-01-05')
  assert.equal(getNextWeeklyRideDate(1, '15:00', {
    now: at('2028-02-25T17:00:00Z'), afterDate: '2028-02-22'
  }), '2028-02-29')
})

test('unknown or noninteger weekdays and invalid times are rejected without guesses', () => {
  const options = { now: at('2026-09-24T16:00:00Z') }
  for (const weekday of [-1, 7, 1.5, NaN, undefined, null, '1', '周二']) {
    assert.equal(getNextWeeklyRideDate(weekday, '15:00', options), '')
  }
  for (const time of ['', undefined, null, '3:00', '24:00', '15:60', '15:00:00', '下午3点', ' 15:00 ']) {
    assert.equal(getNextWeeklyRideDate(1, time, options), '')
  }
})

test('an explicitly supplied invalid source date never falls back to an ordinary weekly template', () => {
  for (const afterDate of ['', null, '2026-02-30', '2026-9-22', '2026-09-22T15:00:00', 20260922]) {
    assert.equal(getNextWeeklyRideDate(1, '15:00', {
      now: at('2026-09-24T16:00:00Z'), afterDate
    }), '')
  }
  assert.equal(getNextWeeklyRideDate(1, '15:00', {
    now: at('2026-09-24T16:00:00Z'), afterDate: undefined
  }), '2026-09-29')
})

test('an invalid current instant cannot produce a publish date', () => {
  for (const now of [NaN, Infinity, -Infinity, 'not-a-date']) {
    assert.equal(getNextWeeklyRideDate(1, '15:00', { now }), '')
  }
})

test('device timezone has no effect on the weekly date, spring gap, or year boundary', () => {
  const modulePath = path.resolve(__dirname, '../utils/rideTime.js')
  const script = `
    const { getNextWeeklyRideDate } = require(${JSON.stringify(modulePath)});
    process.stdout.write(JSON.stringify([
      getNextWeeklyRideDate(1, '15:00', { now: Date.parse('2026-09-22T18:45:00Z') }),
      getNextWeeklyRideDate(6, '02:30', { now: Date.parse('2026-03-06T17:00:00Z'), afterDate: '2026-03-01' }),
      getNextWeeklyRideDate(1, '15:00', { now: Date.parse('2026-12-30T17:00:00Z'), afterDate: '2026-12-29' })
    ]));
  `
  for (const timezone of ['America/New_York', 'Asia/Shanghai', 'Pacific/Honolulu', 'America/Los_Angeles', 'UTC']) {
    const child = spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ: timezone }, encoding: 'utf8'
    })
    assert.equal(child.status, 0, child.stderr)
    assert.deepEqual(JSON.parse(child.stdout), ['2026-09-22', '2026-03-15', '2027-01-05'], timezone)
  }
})
