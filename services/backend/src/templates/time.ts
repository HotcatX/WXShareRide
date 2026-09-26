const zone = 'America/New_York';
const dayMs = 86_400_000;
const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function localParts(instant: number) {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute };
}

export type WeeklySchedule = { weekday: number; localTime: string; timeZone: 'America/New_York' };
export type WeeklyOccurrence = { departureAt: string; localDate: string };

/** Match the current product: next usable weekday, 15-minute lead, at most 30 elapsed days. */
export function nextWeeklyOccurrence(schedule: WeeklySchedule, now = Date.now()): WeeklyOccurrence | null {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime()) || !Number.isInteger(schedule.weekday) || schedule.weekday < 0 || schedule.weekday > 6 ||
    schedule.timeZone !== zone || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.localTime)) return null;
  const today = localParts(now);
  const midnight = Date.UTC(today.year, today.month - 1, today.day);
  const weekday = new Date(midnight).getUTCDay();
  const firstDay = midnight + ((schedule.weekday - weekday + 7) % 7) * dayMs;
  const [hour, minute] = schedule.localTime.split(':').map(Number);
  for (let day = firstDay; day <= midnight + 30 * dayMs; day += 7 * dayMs) {
    const date = new Date(day);
    const wall = day + hour * 3_600_000 + minute * 60_000;
    // Derive possible offsets from IANA data on both sides of a DST boundary.
    const offsets = new Set([-36, 0, 36].map(hours => {
      const at = wall + hours * 3_600_000;
      const p = localParts(at);
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - at;
    }));
    const candidates = [...offsets].map(offset => wall - offset).filter(instant => {
      const actual = localParts(instant);
      return actual.year === date.getUTCFullYear() && actual.month === date.getUTCMonth() + 1 &&
        actual.day === date.getUTCDate() && actual.hour === hour && actual.minute === minute;
    }).sort((a, b) => a - b);
    // Existing template policy explicitly uses the EARLIER fall occurrence.
    // A spring gap skips this week; never shift the selected local clock.
    const instant = candidates[0];
    if (instant !== undefined && instant >= now + 15 * 60_000 && instant <= now + 30 * dayMs) {
      return { departureAt: new Date(instant).toISOString(), localDate: date.toISOString().slice(0, 10) };
    }
  }
  return null;
}
