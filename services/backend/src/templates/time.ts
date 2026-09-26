import type { z } from 'zod';
import type { rideStopSchema } from '../rides/schemas.ts';
import { templateStopsSchema, weeklyScheduleSchema } from './schemas.ts';
import type { TemplateStop, WeeklySchedule } from './schemas.ts';

const zone = 'America/New_York';
const minuteMs = 60_000;
const dayMs = 86_400_000;
const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function localParts(instant: number) {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute };
}

/** wall encodes a New York local calendar minute, not an absolute UTC instant. */
function earliestInstant(wall: number): number | null {
  const date = new Date(wall);
  if (!Number.isFinite(date.getTime())) return null;
  const offsets = new Set([-36, 0, 36].map(hours => {
    const at = wall + hours * 3_600_000;
    const p = localParts(at);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - at;
  }));
  const candidates = [...offsets].map(offset => wall - offset).filter(instant => {
    const actual = localParts(instant);
    return actual.year === date.getUTCFullYear() && actual.month === date.getUTCMonth() + 1 &&
      actual.day === date.getUTCDate() && actual.hour === date.getUTCHours() && actual.minute === date.getUTCMinutes();
  }).sort((a, b) => a - b);
  // This is the existing template policy, not a guess for historical imports:
  // skipped spring minutes have no candidate; repeated fall minutes use earlier.
  return candidates[0] ?? null;
}

export type WeeklyOccurrence = { stops: z.infer<typeof rideStopSchema>[] };

/**
 * Return all stops for the next usable weekly occurrence. Every departure keeps
 * its New York wall-clock offset, including across midnight and DST. A gap in
 * any stop skips the whole week; each instant must fit the same 15-minute lead
 * and 30-elapsed-day window. The returned stops are ready for the ride DTO and
 * contain no duplicate anchor/localDate or template offset fields.
 */
export function nextWeeklyOccurrence(schedule: WeeklySchedule, stops: readonly TemplateStop[], now = Date.now()): WeeklyOccurrence | null {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) return null;
  const parsedSchedule = weeklyScheduleSchema.safeParse({ weekday: schedule?.weekday, localTime: schedule?.localTime, timeZone: schedule?.timeZone });
  const parsedStops = templateStopsSchema.safeParse(stops);
  if (!parsedSchedule.success || !parsedStops.success) return null;
  const { weekday, localTime } = parsedSchedule.data;
  const today = localParts(now);
  const midnight = Date.UTC(today.year, today.month - 1, today.day);
  const firstDay = midnight + ((weekday - new Date(midnight).getUTCDay() + 7) % 7) * dayMs;
  const [hour, minute] = localTime.split(':').map(Number);
  const earliest = now + 15 * minuteMs;
  const latest = now + 30 * dayMs;
  for (let day = firstDay; day <= midnight + 30 * dayMs; day += 7 * dayMs) {
    const result: WeeklyOccurrence = { stops: [] };
    let previous = -Infinity;
    let valid = true;
    for (const stop of parsedStops.data) {
      if (stop.kind === 'destination') {
        result.stops.push({ ...stop });
        continue;
      }
      const { offsetMinutes, ...place } = stop;
      const wall = day + (hour * 60 + minute + offsetMinutes) * minuteMs;
      const instant = earliestInstant(wall);
      if (instant === null || instant < earliest || instant > latest || instant < previous) {
        valid = false;
        break;
      }
      result.stops.push({ ...place, departureAt: new Date(instant).toISOString() });
      previous = instant;
    }
    if (valid) return result;
  }
  return null;
}
