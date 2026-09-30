import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { z, ZodError } from 'zod';
import { AppError } from '../errors.ts';
import { getMarketListing } from '../market/read.ts';
import { getRidePreview, previewDepartureSql, previewLastDepartureSql } from '../rides/preview.ts';
import { authorizeFileReads } from '../files/read.ts';
import type { FileStorage } from '../files/routes.ts';

// TEMPORARY COMPATIBILITY — old public websites retain their wire contracts,
// but every listing/ride/image is read from the canonical PostgreSQL services.
// There is deliberately no CloudBase read fallback after the writer handoff.
export const publicWebPath = '/api/v1/compat/public-web';
export const houseSharePath = '/api/v1/compat/house-share';
export const defaultHouseShareOrigins = ['https://linkxweb.xshawh.workers.dev', 'http://127.0.0.1:5174', 'http://localhost:5174'];
type Dependencies = { pool: Pool; appId: string; storage?: Pick<FileStorage, 'readUrl'>;
  publicWebSecret?: string; houseShareOrigins?: string[]; houseShareCurrency?: string };
const id = z.string().regex(/^[a-z\d_-]{1,128}$/i);
const cities = ['all', 'ny_nj', 'ny', 'nj', 'boston', 'philadelphia', 'dc', 'la', 'bay_area',
  'san_diego', 'seattle', 'chicago', 'champaign', 'ann_arbor', 'columbus', 'dallas', 'houston',
  'austin', 'atlanta', 'miami', 'orlando'] as const;
const states: Record<string, string> = { boston:'MA', philadelphia:'PA', dc:'DC', la:'CA', bay_area:'CA',
  san_diego:'CA', seattle:'WA', chicago:'IL', champaign:'IL', ann_arbor:'MI', columbus:'OH',
  dallas:'TX', houston:'TX', austin:'TX', atlanta:'GA', miami:'FL', orlando:'FL' };
const listFields = { locale: z.literal('en').optional(), limit: z.number().int().min(1).max(20).default(20),
  offset: z.number().int().min(0).max(80).default(0), cityKey: z.enum(cities).optional() };
const publicInput = z.discriminatedUnion('operation', [
  z.strictObject({ operation:z.literal('marketList'), kind:z.enum(['goods','sublet','all']).default('goods'), ...listFields }),
  z.strictObject({ operation:z.literal('tripList'), kind:z.enum(['carpool','request','all']).default('all'), ...listFields }),
  z.strictObject({ operation:z.literal('marketDetail'), kind:z.enum(['goods','sublet']), id, locale:z.literal('en').optional() }),
  z.strictObject({ operation:z.literal('tripDetail'), kind:z.enum(['carpool','request']), id, locale:z.literal('en').optional() }),
]);
const houseInput = z.discriminatedUnion('operation', [
  z.strictObject({ operation:z.literal('marketList'), kind:z.literal('sublet').optional(), cursor:id.optional(),
    limit:z.string().regex(/^\d{1,2}$/).transform(Number).pipe(z.number().min(1).max(20)).default(20) }),
  z.strictObject({ operation:z.literal('marketDetail'), kind:z.literal('sublet').optional(), id }),
]);
type Market = Awaited<ReturnType<typeof getMarketListing>>;
const notFound = () => new AppError(404, 'PUBLIC_NOT_FOUND', 'not_found');
const localized = (value: string) => value.replace(/\[(?:已隐藏|链接已隐藏|联系方式已隐藏|地址已隐藏|位置已隐藏)\]/g, '[redacted]');
const areaEnglish: Record<string, string> = { '哥大':'Columbia University', '法拉盛':'Flushing',
  '纽约/新泽西':'New York / New Jersey', '中城':'Midtown Manhattan', '下城':'Lower Manhattan' };
const tagsEnglish: Record<string,string> = { '家具':'Furniture', '数码':'Electronics', '电子产品':'Electronics',
  '电器':'Appliances', '家电':'Appliances', '日用品':'Home essentials', '服饰':'Clothing', '书籍':'Books',
  '其他':'Other', '全新':'New', '9成新':'Like new', '九成新':'Like new', '8成新':'Good condition', '八成新':'Good condition' };
function money(label: string | null, cents: number | null, kind: string) {
  const value = label?.trim() || (cents === null ? '' : String(cents / 100));
  if (value === '免费' || /^free$/i.test(value)) return 'Free';
  // Never expose arbitrary legacy price labels: they can contain contact data.
  const match = /^\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:美元|元|USD|\$)?\s*(?:[-–~至]\s*\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:美元|元|USD|\$)?)?\s*(?:\/人|每人|\/月|\/person|\/month)?$/i.exec(value);
  if (!match || +match[1]! > 1000000 || (match[2] && (+match[2] > 1000000 || +match[2] < +match[1]!))) {
    return kind === 'sublet' ? 'Rent to be confirmed' : 'Price to be confirmed';
  }
  return `$${Number(match[1])}${match[2] ? `–$${Number(match[2])}` : ''}${kind === 'sublet' ? '/month' : ['carpool','request'].includes(kind) ? '/person' : ''}`;
}
function safeImage(value: string) {
  try {
    const url = new URL(value);
    return value.length <= 4096 && !/[\u0000-\u0020\u007f]/.test(value) && url.protocol === 'https:' && !url.username && !url.password &&
      !url.hash && (!url.port || url.port === '443') && ['tcb.qcloud.la','tcloudbaseapp.com','myqcloud.com','tencentcos.cn','qcloud.com']
        .some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.href : '';
  } catch { return ''; }
}
async function images(deps: Dependencies, value: Market, detail: boolean, maximum = 4) {
  const ids = [...new Set(value.images.flatMap(image => detail ? [image.fileId] : [image.thumbFileId ?? image.fileId]))].slice(0, detail ? maximum : 1);
  if (!ids.length || !deps.storage) return [];
  try {
    // Archived membership never authorizes a file; public visibility is checked
    // again by the canonical file service immediately before URL signing.
    const files = await authorizeFileReads(deps.pool, deps.appId, ids);
    return (await Promise.all(files.map(file => deps.storage!.readUrl(file, 300)))).map(safeImage).filter(Boolean);
  } catch { return []; } // The existing public web contract keeps text available.
}
async function marketItem(deps: Dependencies, value: Market, detail: boolean, house = false) {
  return { id:value.id, kind:value.listingType,
    title:house ? value.title || '房源 / Rental' : localized(value.title) || (value.listingType === 'sublet' ? 'Sublet listing' : 'Secondhand item'),
    description:house ? value.description : localized(value.description),
    priceText:house ? `${deps.houseShareCurrency ? `${deps.houseShareCurrency.slice(0,12)} ` : ''}${(value.priceCents / 100).toLocaleString('en-US', { maximumFractionDigits:2 })}` : money(null, value.priceCents, value.listingType),
    regionText:value.region.state === 'NY_NJ' && !house ? 'New York / New Jersey' : value.region.state,
    timeText:[value.startDate,value.endDate].filter(Boolean).join(house ? ' — ' : ' to '),
    availabilityText:house ? '在租 / Available' : 'Available', images:await images(deps,value,detail,house ? 12 : 4),
    tags:[value.category, ...(house ? [] : [value.condition])].filter(Boolean).map(tag => house ? tag : tagsEnglish[tag] ?? localized(tag)) };
}
type RideCandidate = { id:string; kind:'offer'|'request'; priceLabel:string|null; wantedSeats:number };
async function rideItem(deps: Dependencies, candidate: RideCandidate) {
  const value = await getRidePreview(deps.pool, deps.appId, candidate.id);
  const kind = value.kind === 'offer' ? 'carpool' : 'request';
  const from = areaEnglish[value.fromArea] ?? value.fromArea, to = areaEnglish[value.toArea] ?? value.toArea;
  const route = `${from} → ${to}`;
  const at = new Date(value.departureAt);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', year:'numeric', month:'2-digit',
    day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23' }).formatToParts(at).map(p => [p.type,p.value]));
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  const seats = kind === 'carpool' ? Math.max(0,value.availableSeats) : candidate.wantedSeats;
  const full = kind === 'carpool' && seats === 0;
  return { id:value.id,kind,title:`${kind === 'carpool' ? 'Ride offered' : 'Ride wanted'} · ${route}`,
    description:kind === 'carpool' ? 'A community member is offering seats. Confirm availability and pickup arrangements in the WeChat mini-program.' : 'A community member is looking for a ride. Arrange the details in the WeChat mini-program.',
    priceText:money(candidate.priceLabel,value.listedPriceCents,kind),regionText:route,timeText:`${dateKey} ${parts.hour}:${parts.minute}`,
    availabilityText:full ? 'Full' : `${seats} seat${seats === 1 ? '' : 's'} ${kind === 'carpool' ? 'left' : 'wanted'}`,
    images:[],tags:[kind === 'carpool' ? 'Ride offered' : 'Ride wanted'],fromLabel:from,toLabel:to,dateKey,departureAtMs:at.getTime(),seats,full };
}
async function visible<T>(work: () => Promise<T>): Promise<T|null> {
  try { return await work(); } catch (error) { if (error instanceof AppError && error.status === 404) return null; throw error; }
}
async function publicRead(deps: Dependencies, raw: unknown) {
  const query = publicInput.parse(raw);
  const detail = 'id' in query, market = query.operation.startsWith('market');
  const kind = query.kind === 'all' ? null : query.kind;
  const city = !detail && query.cityKey && query.cityKey !== 'all' ? query.cityKey : null;
  const offset = detail ? 0 : query.offset, limit = detail ? 1 : query.limit;
  if (market) {
    const cityStates = !city ? null : ['ny','nj','ny_nj'].includes(city) ? ['NY','NJ','NY_NJ'] : [states[city]];
    // This selector adds only the old cross-state city filter/pagination. Each
    // result then goes through the canonical guest reader and image permissions.
    const rows = (await deps.pool.query<{id:string}>(`SELECT l.id FROM market_listings l WHERE l.app_id=$1
      AND l.status='online' AND l.expires_at>statement_timestamp() AND ($2::text IS NULL OR l.content->>'listingType'=$2)
      AND ($3::text IS NULL OR l.id=$3) AND ($4::text[] IS NULL OR l.content->'region'->>'state'=ANY($4))
      ORDER BY l.created_at DESC,l.content->>'listingType',l.id LIMIT $5 OFFSET $6`,
    [deps.appId,kind,detail ? query.id : null,cityStates,limit+1,offset])).rows;
    const items = (await Promise.all(rows.slice(0,limit).map(row => visible(async () => marketItem(deps,
      await getMarketListing(deps.pool,deps.appId,row.id),detail))))).filter(value => value !== null);
    if (detail) { if (!items.length) throw notFound(); return { ok:true,item:items[0] }; }
    const nextOffset = offset+Math.min(rows.length,limit);
    return { ok:true,items,hasMore:items.length > 0 && rows.length > limit && nextOffset <= 80,nextOffset };
  }
  const cityKeys = !city ? null : ['ny','nj','ny_nj'].includes(city) ? ['ny','nj','ny_nj'] : [city];
  const rows = (await deps.pool.query<RideCandidate>(`SELECT r.id,r.kind,r.listed_price_label AS "priceLabel",
    coalesce((SELECT sum(m.seat_count) FROM ride_members m WHERE m.ride_id=r.id AND m.state='active' AND m.role='passenger'),0)::int AS "wantedSeats"
    FROM rides r JOIN users owner ON owner.id=r.creator_id WHERE owner.app_id=$1 AND r.status='open'
    AND ${previewDepartureSql}>statement_timestamp() AND ($2::text IS NULL OR r.kind=$2) AND ($3::text IS NULL OR r.id=$3)
    AND ($4::text[] IS NULL OR r.city_key=ANY($4)) ORDER BY ${previewLastDepartureSql},r.kind,r.id LIMIT $5 OFFSET $6`,
  [deps.appId,kind === 'carpool' ? 'offer' : kind,detail ? query.id : null,cityKeys,limit+1,offset])).rows;
  const items = (await Promise.all(rows.slice(0,limit).map(row => visible(() => rideItem(deps,row))))).filter(value => value !== null);
  if (detail) { if (!items.length) throw notFound(); return { ok:true,item:items[0] }; }
  const nextOffset = offset+Math.min(rows.length,limit);
  return { ok:true,items,hasMore:items.length > 0 && rows.length > limit && nextOffset <= 80,nextOffset };
}
async function houseRead(deps: Dependencies, raw: unknown) {
  const query = houseInput.parse(raw), detail = 'id' in query;
  // Only membership comes from the immutable import archive. Never read its
  // document_json as live business data or widen the old collection to all sublets.
  const rows = (await deps.pool.query<{id:string}>(`SELECT l.id FROM market_listings l WHERE l.app_id=$1
    AND l.status='online' AND l.content->>'listingType'='sublet'
    AND EXISTS(SELECT 1 FROM migration_sources s JOIN migration_batches b ON b.id=s.batch_id
      WHERE b.app_id=l.app_id AND s.collection='houseShare' AND s.source_id=l.id)
    AND l.id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND ($2::text IS NULL OR l.id=$2) AND ($3::text IS NULL OR l.id COLLATE "C">$3 COLLATE "C")
    ORDER BY l.id COLLATE "C" LIMIT $4`, [deps.appId,detail ? query.id : null,detail ? null : query.cursor ?? null,detail ? 1 : query.limit+1])).rows;
  const page = rows.slice(0,detail ? 1 : query.limit);
  const items = (await Promise.all(page.map(row => visible(async () => marketItem(deps,
    await getMarketListing(deps.pool,deps.appId,row.id),detail,true))))).filter(value => value !== null);
  if (detail) { if (!items.length) throw notFound(); return { ok:true,item:items[0] }; }
  // Legacy cursor advances over an expired page even if all its items are hidden.
  const hasMore = rows.length > query.limit;
  return { ok:true,items,hasMore,nextCursor:hasMore ? page.at(-1)!.id : null };
}
function headers(reply: FastifyReply) { return reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff'); }
function fail(reply: FastifyReply, status: number, error: string) { return headers(reply).code(status).send({ok:false,error}); }

export function registerLegacyPublicRoutes(app: FastifyInstance, deps: Dependencies) {
  app.register(async scope => {
    // An isolated parser preserves the legacy 2 KiB body limit and error DTO.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', {parseAs:'buffer',bodyLimit:2048}, (_request,body,done) => done(null,body));
    scope.setErrorHandler((error,_request,reply) => {
      const status = (error as {statusCode?:number}).statusCode;
      return fail(reply,status === 413 ? 413 : 503,status === 413 ? 'invalid_request' : 'service_unavailable');
    });
    scope.all(publicWebPath, {bodyLimit:2048}, async (request,reply) => {
      if (request.method !== 'POST') return fail(reply,405,'method_not_allowed');
      if (!deps.publicWebSecret || !/^[A-Za-z\d_-]{32,128}$/.test(deps.publicWebSecret)) return fail(reply,503,'service_unavailable');
      const authorization = request.headers.authorization;
      const authCount = request.raw.rawHeaders.filter((value,i) => i%2 === 0 && value.toLowerCase() === 'authorization').length;
      if (authCount !== 1 || typeof authorization !== 'string' || !/^Bearer [A-Za-z\d_-]{32,128}$/.test(authorization) ||
        !timingSafeEqual(createHash('sha256').update(authorization.slice(7)).digest(),createHash('sha256').update(deps.publicWebSecret).digest())) {
        return fail(reply,401,'authentication_required');
      }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) return fail(reply,415,'invalid_content_type');
      if (Object.keys(request.query as object).length) return fail(reply,400,'invalid_request');
      let input: unknown;
      try { input = JSON.parse((request.body as Buffer).toString('utf8')); } catch { return fail(reply,400,'invalid_json'); }
      try { return headers(reply).send(await publicRead(deps,input)); }
      catch (error) { return fail(reply,error instanceof ZodError ? 400 : error instanceof AppError && error.status === 404 ? 404 : 503,
        error instanceof ZodError ? 'invalid_request' : error instanceof AppError && error.status === 404 ? 'not_found' : 'service_unavailable'); }
    });
  });
  const origins = new Set(deps.houseShareOrigins ?? defaultHouseShareOrigins);
  app.all(houseSharePath, async (request,reply) => {
    headers(reply).header('Vary','Origin');
    const origin = request.headers.origin;
    if (origin && !origins.has(origin)) return fail(reply,403,'origin_not_allowed');
    if (origin) reply.header('Access-Control-Allow-Origin',origin);
    if (request.method === 'OPTIONS') return reply.header('Access-Control-Allow-Methods','GET, OPTIONS')
      .header('Access-Control-Allow-Headers','Accept').header('Access-Control-Max-Age','600').code(204).send();
    if (request.method !== 'GET') return reply.header('Allow','GET, OPTIONS').code(405).send({ok:false,error:'method_not_allowed'});
    try { return await houseRead(deps,request.query); }
    catch (error) { return fail(reply,error instanceof ZodError ? 400 : error instanceof AppError && error.status === 404 ? 404 : 503,
      error instanceof ZodError ? 'invalid_query' : error instanceof AppError && error.status === 404 ? 'not_found' : 'service_unavailable'); }
  });
}
