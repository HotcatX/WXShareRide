import { z } from 'zod';
import type { Pool } from 'pg';
import { listRidesSchema } from './schemas.ts';
import { publicProjection } from './service.ts';
import { formatDriverStatistics } from '../statistics/service.ts';
import type { StatisticsFacts } from '../statistics/service.ts';
import catalog from '../locations/catalog.generated.json' with { type: 'json' };

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const at = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
});
const place = z.string().trim().max(200).refine(value => !/[\u0000-\u001f]/.test(value));
const presets = z.preprocess(value => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}, z.array(place).max(100)).default([]);
const filters = { fromPlace: place.optional(), toPlace: place.optional(), fromPresets: presets,
  toPresets: presets, keyword: place.optional() };
const searchSchema = listRidesSchema.extend({ ...filters, startDate: date.optional(), endDateExclusive: date.optional() })
  .refine(value => {
    if (value.startDate === undefined && value.endDateExclusive === undefined) return true;
    if (!value.startDate || !value.endDateExclusive) return false;
    const days = (Date.parse(value.endDateExclusive) - Date.parse(value.startDate)) / 86400000;
    return days === 1 || days === 2;
  }, { message: '日期范围必须为一至两天' });
const calendarSchema = listRidesSchema.pick({ cityKey: true, kind: true }).extend({ ...filters,
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).refine(value => date.safeParse(`${value}-01`).success && value < '9999-12') });

// Match the published picker categories, including older stops without a place
// ID. User text is a literal substring; it never becomes a SQL regular expression.
const patterns: Record<string, string> = {
  fort_lee: 'fort\\s*lee', columbia: '哥大|columbia',
  ewr: '(^|[^a-z])ewr($|[^a-z])|newark\\s+(liberty\\s+)?(international\\s+)?airport|纽瓦克(自由)?(国际)?机场',
  jfk: '(^|[^a-z])jfk($|[^a-z])|john\\s*f\\.?\\s*kennedy|肯尼迪',
  lga: '(^|[^a-z])lga($|[^a-z])|la\\s*guardia|拉瓜[迪地]亚', flushing: 'flushing|法拉盛',
  lic: '(^|[^a-z])lic($|[^a-z])|long\\s+island\\s+city|长岛市',
  jsq: '(^|[^a-z])jsq($|[^a-z])|journal\\s+square',
  inwood: '(^|[^a-z])(inwood(\\s*manhattan)?|manhattan\\s*inwood)($|[^a-z])',
  midtown: '(^|[^a-z])(midtown\\s*manhattan|manhattan\\s*midtown|midtown\\s+(east|west))($|[^a-z])|中城|^\\s*midtown\\s*$',
  downtown: '(^|[^a-z])(lower\\s*manhattan|downtown\\s*manhattan|manhattan\\s*downtown)($|[^a-z])|下城|^\\s*downtown\\s*$',
  queens: '(^|[^a-z])queens($|[^a-z])|皇后[区區]',
};
const compact = (value: string) => value.toLowerCase().replace(/\s+/g, '');
export function publicRideArea(address: string): string {
  const place = catalog.fixedPlaces.find(p => patterns[p.placeId] && new RegExp(patterns[p.placeId]!, 'i').test(address));
  return place?.label ?? '纽约/新泽西';
}
function conditions(input: z.infer<typeof calendarSchema> | z.infer<typeof searchSchema>, viewerId?: string, appId?: string) {
  const values: unknown[] = [];
  const param = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const where = [`r.city_key=${param(input.cityKey)}`, "r.status='open'", 'r.departure_at>statement_timestamp()'];
  if (appId) where.push(`EXISTS(SELECT 1 FROM users owner WHERE owner.id=r.creator_id AND owner.app_id=${param(appId)})`);
  if (input.kind) where.push(`r.kind=${param(input.kind)}`);
  if (viewerId) {
    const me = `${param(viewerId)}::uuid`;
    where.push(`(r.creator_id=${me} OR NOT EXISTS(SELECT 1 FROM ride_members member JOIN user_blocks b ON b.active AND
      ((b.blocker_id=${me} AND b.target_id=member.user_id) OR (b.target_id=${me} AND b.blocker_id=member.user_id))
      WHERE member.ride_id=r.id AND member.state='active' AND member.user_id<>${me}))`);
  }
  function matches(value: string) {
    const key = compact(value);
    const fixed = catalog.fixedPlaces.find(p => p.placeId === key || p.aliases.includes(key) || compact(p.label) === key);
    const pattern = fixed && patterns[fixed.placeId];
    return pattern ? `s.address ~* ${param(pattern)}` : `strpos(lower(s.address),lower(${param(value)}))>0`;
  }
  for (const [kind, selected, choices] of [['departure', input.fromPlace, input.fromPresets],
    ['destination', input.toPlace, input.toPresets]] as const) {
    if (!selected || selected === '全部') continue;
    const known = choices.filter(p => p && p !== '全部' && p !== '其他');
    const match = selected === '其他' ? `NOT (${(known.length ? known : ['Fort Lee', 'Columbia']).map(matches).join(' OR ')})` : matches(selected);
    where.push(`EXISTS(SELECT 1 FROM ride_stops s WHERE s.ride_id=r.id AND s.kind='${kind}' AND btrim(s.address)<>'' AND (${match}))`);
  }
  if (input.keyword) where.push(`EXISTS(SELECT 1 FROM ride_stops s WHERE s.ride_id=r.id AND strpos(lower(s.address),lower(${param(input.keyword)}))>0)`);
  return { where, values, param };
}
// Date bounds use New York wall-clock midnights, so DST days are 23/25 hours.
const localDate = "(r.departure_at AT TIME ZONE 'America/New_York')::date";

export async function listRides(pool: Pool, query: unknown, viewerId?: string, appId?: string) {
  const input = searchSchema.parse(query), q = conditions(input, viewerId, appId);
  const base = q.where.join(' AND ');
  let next = 'NULL::text';
  if (input.startDate && input.endDateExclusive) {
    const start = q.param(input.startDate), end = q.param(input.endDateExclusive);
    next = `(SELECT min(${localDate})::text FROM rides r WHERE ${base} AND ${localDate}>=${end}::date)`;
    q.where.push(`r.departure_at>=(${start}::date::timestamp AT TIME ZONE 'America/New_York')`,
      `r.departure_at<(${end}::date::timestamp AT TIME ZONE 'America/New_York')`);
  }
  const limit = q.param(input.limit + 1), offset = q.param((input.page - 1) * input.limit);
  // One statement also returns nextDate for an empty selected day.
  const result = (await pool.query<{ rides: { id: string; driverStatistics: StatisticsFacts | null; [key: string]: unknown }[]; nextDate: string | null }>(`SELECT
    coalesce((SELECT jsonb_agg(page) FROM (SELECT ${publicProjection} FROM rides r
      WHERE ${q.where.join(' AND ')} ORDER BY r.departure_at,r.id LIMIT ${limit} OFFSET ${offset}) page),'[]'::jsonb) AS rides,
    ${next} AS "nextDate"`, q.values)).rows[0]!;
  return { rides: result.rides.slice(0, input.limit).map(formatDriverStatistics),
    nextPage: input.page < 1000 && result.rides.length > input.limit ? input.page + 1 : null,
    ...(input.startDate ? { nextDate: result.nextDate } : {}) };
}

export async function rideCalendar(pool: Pool, query: unknown, viewerId?: string, appId?: string) {
  const input = calendarSchema.parse(query), q = conditions(input, viewerId, appId);
  const start = q.param(`${input.month}-01`);
  q.where.push(`r.departure_at>=(${start}::date::timestamp AT TIME ZONE 'America/New_York')`,
    `r.departure_at<((${start}::date+interval '1 month') AT TIME ZONE 'America/New_York')`);
  const days = (await pool.query(`SELECT ${localDate}::text AS date,
    count(*) FILTER(WHERE r.kind='offer')::int AS "offerCount",count(*) FILTER(WHERE r.kind='request')::int AS "requestCount"
    FROM rides r WHERE ${q.where.join(' AND ')} GROUP BY ${localDate} ORDER BY ${localDate}`, q.values)).rows;
  return { month: input.month, days };
}
