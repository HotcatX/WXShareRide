import { AppError } from '../errors.ts';
import { marketDateOnlySchema } from './schemas.ts';
import type { MarketListingContent } from './schemas.ts';

const dayMilliseconds = 86_400_000;
const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function localParts(instant: number) {
  return Object.fromEntries(formatter.formatToParts(new Date(instant))
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}
function utcWall(year: number, month: number, day: number, hour = 0, minute = 0, second = 0) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}
function dateWall(value: string) {
  if (!marketDateOnlySchema.safeParse(value).success) throw new AppError(400, 'INVALID_DATE_WINDOW', '日期格式无效');
  const [year, month, day] = value.split('-').map(Number);
  return utcWall(year, month, day);
}

/** Calendar-month limit, measured from today's New York date; no host TZ. */
export function validateMarketListingDateWindow(
  listing: Pick<MarketListingContent, 'listingType' | 'startDate' | 'endDate'>,
  now: Date,
): void {
  if (!Number.isFinite(now.getTime())) throw new AppError(500, 'INVALID_CLOCK', '服务器时间无效');
  const start = dateWall(listing.startDate);
  const end = dateWall(listing.endDate);
  if (listing.listingType !== 'goods' && listing.listingType !== 'sublet') throw new AppError(400, 'INVALID_DATE_WINDOW', '发布类型无效');
  const today = localParts(now.getTime());
  const month = new Date(utcWall(today.year, today.month + (listing.listingType === 'sublet' ? 18 : 2), 1));
  const lastDay = new Date(utcWall(month.getUTCFullYear(), month.getUTCMonth() + 2, 0)).getUTCDate();
  const maximum = utcWall(month.getUTCFullYear(), month.getUTCMonth() + 1, Math.min(today.day, lastDay));
  // The old service allows already-started windows. Start does not gate public
  // visibility, and editing unrelated content must not extend an expired ad.
  if (end < start || end > maximum) throw new AppError(400, 'INVALID_DATE_WINDOW', '日期范围无效');
}

/** Only for new listings or an explicit date change, never historical import. */
export function marketListingExpiresAt(endDate: string): Date {
  const nextWall = dateWall(endDate) + dayMilliseconds;
  // Resolve the following New York midnight, then subtract one millisecond.
  // The elapsed day may be 23 or 25 hours across DST; adding 24h to a local
  // midnight would give the wrong expiry. Offsets are learned from the zone.
  const offsets = new Set([-36, 0, 36].map(hours => {
    const instant = nextWall + hours * 3_600_000;
    const p = localParts(instant);
    return utcWall(p.year, p.month, p.day, p.hour, p.minute, p.second) - instant;
  }));
  const candidates = [...offsets].map(offset => nextWall - offset).filter(instant => {
    const p = localParts(instant);
    return utcWall(p.year, p.month, p.day, p.hour, p.minute, p.second) === nextWall;
  }).sort((a, b) => a - b);
  if (!candidates.length) throw new AppError(400, 'INVALID_DATE_WINDOW', '无法解析纽约日期');
  return new Date(candidates[0] - 1);
}
