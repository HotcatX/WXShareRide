import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { nextWeeklyOccurrence } from '../src/templates/time.ts';

const schedule = (weekday: number, localTime: string) => ({ weekday, localTime, timeZone: 'America/New_York' as const });
const next = (weekday: number, localTime: string, now: string) => nextWeeklyOccurrence(schedule(weekday, localTime), Date.parse(now));

test('weekly template uses canonical Sunday=0 and next New York weekday at the same local time', () => {
  assert.deepEqual(next(2, '15:00', '2026-09-24T16:00:00Z'), { localDate: '2026-09-29', departureAt: '2026-09-29T19:00:00.000Z' });
  assert.deepEqual(next(0, '20:00', '2026-09-24T16:00:00Z'), { localDate: '2026-09-27', departureAt: '2026-09-28T00:00:00.000Z' });
});

test('15-minute lead is inclusive; elapsed or barely-too-near templates advance a whole week', () => {
  assert.equal(next(2, '15:00', '2026-09-22T18:45:00Z')!.localDate, '2026-09-22');
  assert.equal(next(2, '15:00', '2026-09-22T18:45:01Z')!.localDate, '2026-09-29');
  assert.equal(next(2, '15:00', '2026-09-22T19:00:00Z')!.localDate, '2026-09-29');
});

test('spring skipped clock advances to next week without silently changing 02:30 to 03:30', () => {
  assert.deepEqual(next(0, '02:30', '2026-03-06T17:00:00Z'), { localDate: '2026-03-15', departureAt: '2026-03-15T06:30:00.000Z' });
  assert.deepEqual(next(0, '15:00', '2026-03-06T17:00:00Z'), { localDate: '2026-03-08', departureAt: '2026-03-08T19:00:00.000Z' });
});

test('fall repeated clock explicitly chooses the earlier occurrence, matching the current app', () => {
  assert.deepEqual(next(0, '01:30', '2026-10-30T16:00:00Z'), { localDate: '2026-11-01', departureAt: '2026-11-01T05:30:00.000Z' });
  assert.deepEqual(next(0, '01:30', '2026-11-01T05:16:00Z'), { localDate: '2026-11-08', departureAt: '2026-11-08T06:30:00.000Z' });
  assert.deepEqual(next(0, '15:00', '2026-10-30T16:00:00Z'), { localDate: '2026-11-01', departureAt: '2026-11-01T20:00:00.000Z' });
});

test('year and leap-day boundaries retain weekday and local time', () => {
  assert.deepEqual(next(2, '15:00', '2026-12-30T17:00:00Z'), { localDate: '2027-01-05', departureAt: '2027-01-05T20:00:00.000Z' });
  assert.deepEqual(next(2, '15:00', '2028-02-25T17:00:00Z'), { localDate: '2028-02-29', departureAt: '2028-02-29T20:00:00.000Z' });
});

test('invalid weekday, local clock and now never produce a guessed schedule', () => {
  for (const day of [-1, 7, 1.5, NaN]) assert.equal(nextWeeklyOccurrence(schedule(day, '15:00')), null);
  for (const time of ['', '3:00', '24:00', '15:60', '15:00:00', ' 15:00 ']) assert.equal(nextWeeklyOccurrence(schedule(2, time)), null);
  for (const now of [NaN, Infinity, -Infinity, 1e30]) assert.equal(nextWeeklyOccurrence(schedule(2, '15:00'), now), null);
});

test('host timezone cannot change next occurrence or DST handling', () => {
  const source = `import {nextWeeklyOccurrence} from ${JSON.stringify(new URL('../src/templates/time.ts', import.meta.url).href)};
    console.log(JSON.stringify([
      nextWeeklyOccurrence({weekday:2,localTime:'15:00',timeZone:'America/New_York'},Date.parse('2026-09-24T16:00:00Z')),
      nextWeeklyOccurrence({weekday:0,localTime:'02:30',timeZone:'America/New_York'},Date.parse('2026-03-06T17:00:00Z')),
      nextWeeklyOccurrence({weekday:0,localTime:'01:30',timeZone:'America/New_York'},Date.parse('2026-10-30T16:00:00Z'))
    ]));`;
  let expected = '';
  for (const zone of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Pacific/Honolulu', 'America/New_York']) {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env: { ...process.env, TZ: zone } });
    if (!expected) expected = output;
    assert.equal(output, expected, zone);
  }
});
