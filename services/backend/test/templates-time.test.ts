import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { nextWeeklyOccurrence } from '../src/templates/time.ts';
import { templateStopsSchema } from '../src/templates/schemas.ts';
import type { TemplateStop } from '../src/templates/schemas.ts';
import { rideStopsSchema } from '../src/rides/schemas.ts';

const schedule = (weekday: number, localTime: string) => ({ weekday, localTime, timeZone: 'America/New_York' as const });
const route = (offsets = [0]): TemplateStop[] => [
  ...offsets.map((offsetMinutes, index) => ({ kind: 'departure' as const, address: `Pickup ${index}`, placeId: `pickup-${index}`, offsetMinutes })),
  { kind: 'destination', address: 'Destination', placeId: 'destination' },
];
const expected = (...times: string[]) => ({ stops: [
  ...times.map((departureAt, index) => ({ kind: 'departure', address: `Pickup ${index}`, placeId: `pickup-${index}`, departureAt })),
  { kind: 'destination', address: 'Destination', placeId: 'destination' },
] });
const next = (weekday: number, localTime: string, now: string, offsets = [0]) => nextWeeklyOccurrence(schedule(weekday, localTime), route(offsets), Date.parse(now));
const firstTime = (value: ReturnType<typeof next>) => {
  const first = value?.stops[0];
  return first?.kind === 'departure' ? first.departureAt : null;
};

test('weekly template uses Sunday=0 and returns canonical full ride stops without duplicate time fields', () => {
  assert.deepEqual(next(2, '15:00', '2026-09-24T16:00:00Z'), expected('2026-09-29T19:00:00.000Z'));
  assert.deepEqual(next(0, '20:00', '2026-09-24T16:00:00Z'), expected('2026-09-28T00:00:00.000Z'));
  const value = next(2, '15:00', '2026-09-24T16:00:00Z', [0, 20, 20])!;
  assert.deepEqual(Object.keys(value), ['stops']);
  assert.equal(rideStopsSchema.safeParse(value.stops).success, true);
  assert.doesNotMatch(JSON.stringify(value), /offsetMinutes|localDate|localTime/);
});

test('15-minute lead is inclusive; elapsed or barely-too-near templates advance the whole route one week', () => {
  assert.equal(firstTime(next(2, '15:00', '2026-09-22T18:45:00Z', [0, 30])), '2026-09-22T19:00:00.000Z');
  assert.deepEqual(next(2, '15:00', '2026-09-22T18:45:01Z', [0, 30]), expected('2026-09-29T19:00:00.000Z', '2026-09-29T19:30:00.000Z'));
  assert.equal(firstTime(next(2, '15:00', '2026-09-22T19:00:00Z')), '2026-09-29T19:00:00.000Z');
});

test('a spring gap in any later departure skips the entire week, including cross-midnight routes', () => {
  assert.deepEqual(next(0, '02:30', '2026-03-06T17:00:00Z'), expected('2026-03-15T06:30:00.000Z'));
  assert.deepEqual(next(0, '01:30', '2026-03-06T17:00:00Z', [0, 60, 120]), expected('2026-03-15T05:30:00.000Z', '2026-03-15T06:30:00.000Z', '2026-03-15T07:30:00.000Z'));
  assert.deepEqual(next(6, '23:30', '2026-03-06T17:00:00Z', [0, 180]), expected('2026-03-15T03:30:00.000Z', '2026-03-15T06:30:00.000Z'));
});

test('wall-minute offsets crossing spring DST are not added as elapsed UTC minutes', () => {
  assert.deepEqual(next(0, '01:30', '2026-03-06T17:00:00Z', [0, 120]), expected('2026-03-08T06:30:00.000Z', '2026-03-08T07:30:00.000Z'));
  assert.deepEqual(next(0, '15:00', '2026-03-06T17:00:00Z'), expected('2026-03-08T19:00:00.000Z'));
});

test('fall repeated times use the earlier instant for each stop, without switching fold to meet lead time', () => {
  assert.deepEqual(next(0, '01:30', '2026-10-30T16:00:00Z'), expected('2026-11-01T05:30:00.000Z'));
  assert.deepEqual(next(0, '01:30', '2026-11-01T05:16:00Z'), expected('2026-11-08T06:30:00.000Z'));
  assert.deepEqual(next(0, '00:30', '2026-10-30T16:00:00Z', [0, 60, 120]), expected('2026-11-01T04:30:00.000Z', '2026-11-01T05:30:00.000Z', '2026-11-01T07:30:00.000Z'));
});

test('midnight, the 1440-minute inclusive bound, and multiple destinations preserve every stop', () => {
  const stops = [...route([0, 60, 1440]), { kind: 'destination' as const, address: 'Second destination' }];
  const original = structuredClone(stops);
  const value = nextWeeklyOccurrence(schedule(2, '23:30'), stops, Date.parse('2026-09-24T16:00:00Z'))!;
  const result = expected('2026-09-30T03:30:00.000Z', '2026-09-30T04:30:00.000Z', '2026-10-01T03:30:00.000Z');
  assert.deepEqual(value, { stops: [...result.stops, { kind: 'destination', address: 'Second destination' }] });
  value.stops[0].address = 'Mutated result';
  assert.deepEqual(stops, original, 'instantiation must not mutate the saved definition');
});

test('year and leap-day boundaries retain weekday and local time', () => {
  assert.deepEqual(next(2, '15:00', '2026-12-30T17:00:00Z'), expected('2027-01-05T20:00:00.000Z'));
  assert.deepEqual(next(2, '15:00', '2028-02-25T17:00:00Z'), expected('2028-02-29T20:00:00.000Z'));
});

test('invalid route times, ordering and fields cannot produce a partial or truncated occurrence', () => {
  const invalids: unknown[] = [[], route([1]), route([-1]), route([0, 1441]), route([0, 0.5]), route([0, 30, 20]),
    route(Array.from({ length: 11 }, (_, index) => index)),
    [...route(), ...Array.from({ length: 10 }, () => ({ kind: 'destination', address: 'D' }))],
    [route()[1], route()[0]],
    [route()[0], route()[1], { ...route()[0], offsetMinutes: 30 }],
    [{ ...route()[0], departureAt: '2026-09-29T19:00:00Z' }, route()[1]],
    [route()[0], { ...route()[1], offsetMinutes: 0 }],
    [{ ...route()[0], address: '' }, route()[1]],
  ];
  for (const invalid of invalids) {
    assert.equal(templateStopsSchema.safeParse(invalid).success, false);
    assert.equal(nextWeeklyOccurrence(schedule(2, '15:00'), invalid as TemplateStop[], Date.parse('2026-09-24T16:00:00Z')), null);
  }
});

test('invalid weekday, local clock and now never produce a guessed schedule', () => {
  for (const day of [-1, 7, 1.5, NaN]) assert.equal(nextWeeklyOccurrence(schedule(day, '15:00'), route()), null);
  for (const time of ['', '3:00', '24:00', '15:60', '15:00:00', ' 15:00 ']) assert.equal(nextWeeklyOccurrence(schedule(2, time), route()), null);
  for (const now of [NaN, Infinity, -Infinity, 1e30]) assert.equal(nextWeeklyOccurrence(schedule(2, '15:00'), route(), now), null);
});

test('every returned departure remains ordered and inside the actual 15-minute to 30-day window', () => {
  for (const date of ['2026-03-07', '2026-03-08', '2026-10-31', '2026-11-01', '2026-12-31']) {
    const now = Date.parse(`${date}T05:15:30Z`);
    for (let weekday = 0; weekday < 7; weekday++) {
      const value = nextWeeklyOccurrence(schedule(weekday, '01:30'), route([0, 30, 90, 1440]), now)!;
      assert.ok(value);
      let previous = -Infinity;
      for (const stop of value.stops) {
        if (stop.kind !== 'departure') continue;
        const at = Date.parse(stop.departureAt);
        assert.ok(at >= now + 15 * 60_000 && at <= now + 30 * 86_400_000);
        assert.ok(at >= previous); previous = at;
      }
    }
  }
});

test('host timezone cannot change multi-stop occurrence or DST handling', () => {
  const source = `import {nextWeeklyOccurrence} from ${JSON.stringify(new URL('../src/templates/time.ts', import.meta.url).href)};
    const stops = ${JSON.stringify(route([0, 60, 120]))};
    console.log(JSON.stringify([
      nextWeeklyOccurrence({weekday:2,localTime:'15:00',timeZone:'America/New_York'},stops,Date.parse('2026-09-24T16:00:00Z')),
      nextWeeklyOccurrence({weekday:0,localTime:'01:30',timeZone:'America/New_York'},stops,Date.parse('2026-03-06T17:00:00Z')),
      nextWeeklyOccurrence({weekday:0,localTime:'00:30',timeZone:'America/New_York'},stops,Date.parse('2026-10-30T16:00:00Z'))
    ]));`;
  let expected = '';
  for (const zone of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Pacific/Honolulu', 'America/New_York']) {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env: { ...process.env, TZ: zone } });
    if (!expected) expected = output;
    assert.equal(output, expected, zone);
  }
});
