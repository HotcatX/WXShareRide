import type { Pool } from 'pg';
import { z } from 'zod';
import { AppError } from '../errors.ts';
import { marketStateSchema } from './schemas.ts';
import type { MarketImage, MarketListingContent } from './schemas.ts';

const idSchema = z.string().regex(/^[a-zA-Z0-9:_-]{1,160}$/);
const text = z.string().trim().min(1).max(240).refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const integer = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int());
const coordinate = z.union([z.number(), z.string().regex(/^-?\d+(?:\.\d+)?$/).transform(Number)]).pipe(z.number().finite());
const querySchema = z.strictObject({
  listingType: z.enum(['goods', 'sublet', 'all']).default('goods'),
  category: text.optional(), regionState: marketStateSchema.optional(),
  regionCounty: text.optional(), regionArea: text.optional(), keyword: text.optional(),
  sort: z.enum(['created', 'distance']).default('created'),
  latitude: coordinate.pipe(z.number().min(-90).max(90)).optional(),
  longitude: coordinate.pipe(z.number().min(-180).max(180)).optional(),
  offset: integer.pipe(z.number().min(0).max(Number.MAX_SAFE_INTEGER)).default(0),
  limit: integer.pipe(z.number().min(1).max(50)).default(20),
}).superRefine((value, context) => {
  const located = value.latitude !== undefined && value.longitude !== undefined;
  if (value.sort === 'distance' ? !located : value.latitude !== undefined || value.longitude !== undefined) {
    context.addIssue({ code: 'custom', path: ['sort'], message: '距离排序须同时提供经纬度' });
  }
});

type Row = {
  id: string; owner_user_id: string | null; managed: boolean; content: MarketListingContent;
  status: 'online' | 'offline' | 'sold'; version: string; expires_at: Date; created_at: Date; updated_at: Date | null;
  images: MarketImage[]; distance_miles: number | null;
  view_count: string;
  seller_name: string | null; seller_avatar: string | null; seller_openid: string | null;
  seller_region: string | null; seller_residence: string | null; seller_bio: string | null;
  seller_wechat: string | null; seller_phone: string | null;
};

// Select only used seller fields, never an unrestricted profile. File locators
// remain internal; the client URL adapter is deliberately not implemented here.
const projection = `l.id,l.owner_user_id,(l.admin_owner_key IS NOT NULL OR l.shared_admin_management) AS managed,
  l.content,l.status,l.version,l.expires_at,l.created_at,l.updated_at,
  u.name AS seller_name,u.avatar_url AS seller_avatar,u.openid AS seller_openid,
  coalesce(nullif(u.profile->'region'->>'area',''),u.profile->'region'->>'label') AS seller_region,
  u.profile->'location'->>'residence' AS seller_residence,u.profile->>'bio' AS seller_bio,
  u.profile->>'wechatId' AS seller_wechat,u.profile->>'phone' AS seller_phone,
  (SELECT coalesce(sum(v.count),0)::text FROM market_views v WHERE v.app_id=l.app_id AND v.listing_id=l.id) AS view_count,
  coalesce((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('fileId',r.file_id,'thumbFileId',tf.id))
    ORDER BY split_part(r.slot,'.',2)::integer)
    FROM file_references r JOIN files f ON f.app_id=r.app_id AND f.id=r.file_id AND f.status='ready'
    LEFT JOIN file_references tr ON tr.app_id=r.app_id AND tr.resource_kind='listing' AND tr.resource_id=r.resource_id
      AND tr.slot='thumbnail.' || split_part(r.slot,'.',2)
    LEFT JOIN files tf ON tf.app_id=tr.app_id AND tf.id=tr.file_id AND tf.status='ready'
    WHERE r.app_id=l.app_id AND r.resource_kind='listing' AND r.resource_id=l.id AND r.slot ~ '^image[.][0-5]$'), '[]'::jsonb) AS images`;
const source = 'FROM market_listings l LEFT JOIN users u ON u.app_id=l.app_id AND u.id=l.owner_user_id';
const notFound = () => new AppError(404, 'LISTING_NOT_FOUND', '商品不存在');

/** Preserve the existing guest preview's text redaction. This is a limited
 * display projection, not a claim to remove personal data from arbitrary prose. */
function guestText(value: string, row: Row, maximum: number) {
  const content = row.content;
  const privateValues = [row.seller_openid, content.sellerContact?.name, content.sellerContact?.wechat,
    content.sellerContact?.phone, content.sellerContact?.note, content.buildingName,
    content.location?.address, content.location?.displayName]
    .filter((entry): entry is string => typeof entry === 'string' && entry.length >= 2).sort((a, b) => b.length - a.length);
  let result = value.slice(0, 6000).replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').replace(/<[^>]*>/g, '');
  for (const secret of privateValues) {
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = /^[a-z\d]/i.test(secret) && /[a-z\d]$/i.test(secret);
    result = result.replace(new RegExp(boundary ? `(^|[^a-z\\d])${escaped}(?=$|[^a-z\\d])` : escaped, 'gi'), boundary ? '$1[已隐藏]' : '[已隐藏]');
  }
  return result.replace(/https?:\/\/\S+|www\.\S+/gi, '[链接已隐藏]')
    .replace(/[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d.-]+\.[a-z]{2,}/gi, '[联系方式已隐藏]')
    // Coordinates must be removed before phone matching can consume one side
    // together with digits on the next line and leave a partial location.
    .replace(/-?\d{1,3}\.\d{4,}\s*[,，/]\s*-?\d{1,3}\.\d{4,}/g, '[位置已隐藏]')
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, match => /^\d{4}-\d{2}-\d{2}$/.test(match.trim()) || match.replace(/\D/g, '').length < 9 ? match : '[联系方式已隐藏]')
    .replace(/(?:微信|微\s*信|加[微vV]|联系方式|联系(?:电话|微信)|手机号|电话|邮箱|收款|付款账号|\b(?:wechat|weixin|wx|vx|phone|tel|email|zelle|venmo|paypal)\b)[^\n。；;]*/gi, '[联系方式已隐藏]')
    .replace(/(?:详细地址|地址|门牌|室号|\b(?:address|apartment|apt|suite|unit)\b)[^\n。；;]*/gi, '[地址已隐藏]')
    .replace(/\b\d{1,6}\s+(?:[a-z\d.-]+\s+){0,5}(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|place|pl)\b[^\n。；;,]*/gi, '[地址已隐藏]')
    .replace(/[\p{Script=Han}]{0,12}(?:路|街|巷)\s*\d+\s*号[^\n。；;]*/gu, '[地址已隐藏]')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, maximum);
}

function item(row: Row, viewerId?: string, detail = false) {
  const c = row.content;
  const viewCount = Number(row.view_count);
  if (!Number.isSafeInteger(viewCount) || viewCount < 0) throw new AppError(500, 'INVALID_VIEW_COUNT', '浏览统计暂不可用');
  const common = { id: row.id, listingType: c.listingType, priceCents: c.priceCents,
    startDate: c.startDate, endDate: c.endDate, status: row.status, expiresAt: row.expires_at,
    createdAt: row.created_at, images: row.images, viewCount };
  if (!viewerId) return { ...common, title: guestText(c.title, row, 90),
    description: guestText(c.description, row, detail ? 1200 : 180),
    category: guestText(c.category, row, 30), condition: guestText(c.condition, row, 30), region: { state: c.region.state } };
  // Explicit nested projections prevent future DB/import fields from silently
  // becoming part of the public response, even inside JSON content.
  const contact = c.sellerContact ? { name: c.sellerContact.name, wechat: c.sellerContact.wechat,
    phone: c.sellerContact.phone, avatar: c.sellerContact.avatar, note: c.sellerContact.note } : null;
  return { ...common, title: c.title, description: c.description, category: c.category, condition: c.condition,
    region: { state: c.region.state, county: c.region.county, area: c.region.area }, buildingName: c.buildingName,
    location: c.location ? { displayName: c.location.displayName, address: c.location.address,
      latitude: c.location.latitude, longitude: c.location.longitude } : null,
    sellerContact: contact,
    sublet: c.sublet ? { housingType: c.sublet.housingType, depositCents: c.sublet.depositCents,
      furnished: c.sublet.furnished, utilitiesIncluded: c.sublet.utilitiesIncluded,
      genderPreference: c.sublet.genderPreference, roommateCount: c.sublet.roommateCount } : null,
    version: Number(row.version), updatedAt: row.updated_at, isOwner: row.owner_user_id === viewerId,
    distanceMiles: row.distance_miles,
    seller: { userId: row.owner_user_id,
      name: row.managed ? contact?.name ?? '' : row.seller_name ?? '',
      avatarUrl: row.managed ? contact?.avatar ?? '' : row.seller_avatar ?? '',
      regionLabel: row.managed ? c.region.area : row.seller_region ?? '',
      residence: row.managed ? '' : row.seller_residence ?? '', bio: row.managed ? contact?.note ?? '' : row.seller_bio ?? '',
      wechatId: contact?.wechat || (!row.managed ? row.seller_wechat ?? '' : ''),
      phone: contact?.phone || (!row.managed ? row.seller_phone ?? '' : '') } };
}

async function list(pool: Pool, appId: string, raw: unknown, viewerId?: string, ownerId?: string, mine = false) {
  const query = querySchema.parse(raw);
  if (!viewerId && (query.keyword || query.regionCounty || query.regionArea || query.sort === 'distance')) {
    throw new AppError(401, 'UNAUTHORIZED', '请登录后使用详细筛选');
  }
  const values: unknown[] = [appId];
  const param = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const where = ['l.app_id=$1', "l.status!='deleted'"];
  if (!mine) where.push("l.status='online'", 'l.expires_at>statement_timestamp()');
  if (ownerId) where.push(`l.owner_user_id=${param(ownerId)}::uuid`);
  if (query.listingType !== 'all') where.push(`l.content->>'listingType'=${param(query.listingType)}`);
  if (query.category) where.push(`l.content->>'category'=${param(query.category)}`);
  for (const [key, value] of [['state', query.regionState], ['county', query.regionCounty], ['area', query.regionArea]] as const) {
    if (value) where.push(`l.content->'region'->>'${key}'=${param(value)}`);
  }
  if (query.keyword) {
    const keyword = param(query.keyword);
    where.push(`(strpos(lower(l.content->>'title'),lower(${keyword}))>0 OR strpos(lower(l.content->>'description'),lower(${keyword}))>0)`);
  }
  let distance = 'NULL::double precision';
  if (query.sort === 'distance') {
    const latitude = param(query.latitude), longitude = param(query.longitude);
    // Haversine uses the same mile radius as the current client; clamp rounding
    // at identical/antipodal points and keep missing coordinates last.
    distance = `CASE WHEN jsonb_typeof(l.content->'location'->'latitude')='number'
      AND jsonb_typeof(l.content->'location'->'longitude')='number' THEN 3958.8*2*asin(sqrt(least(1.0,greatest(0.0,
        power(sin(radians((l.content->'location'->>'latitude')::double precision-${latitude})/2),2)
        +cos(radians(${latitude}))*cos(radians((l.content->'location'->>'latitude')::double precision))
        *power(sin(radians((l.content->'location'->>'longitude')::double precision-${longitude})/2),2))))) END`;
  }
  const rows = (await pool.query<Row>(`SELECT ${projection},${distance} AS distance_miles ${source}
    WHERE ${where.join(' AND ')} ORDER BY ${query.sort === 'distance' ? 'distance_miles ASC NULLS LAST,' : ''}l.created_at DESC,l.id
    LIMIT ${param(query.limit + 1)} OFFSET ${param(query.offset)}`, values)).rows;
  const selected = rows.slice(0, query.limit);
  return { items: selected.map(row => item(row, viewerId)), offset: query.offset, limit: query.limit,
    nextOffset: query.offset + selected.length, hasMore: rows.length > query.limit };
}

export function listMarketListings(pool: Pool, appId: string, query: unknown, viewerId?: string) {
  return list(pool, appId, query, viewerId);
}
export function listSellerMarketListings(pool: Pool, appId: string, sellerId: unknown, query: unknown, viewerId?: string) {
  return list(pool, appId, query, viewerId, z.uuid().parse(sellerId));
}
export function listMyMarketListings(pool: Pool, appId: string, userId: string, query: unknown) {
  return list(pool, appId, query, userId, userId, true);
}
export async function getMarketListing(pool: Pool, appId: string, rawId: unknown, viewerId?: string) {
  const id = idSchema.parse(rawId);
  const row = (await pool.query<Row>(`SELECT ${projection},NULL::double precision AS distance_miles ${source}
    WHERE l.app_id=$1 AND l.id=$2 AND l.status!='deleted'
      AND ((l.status='online' AND l.expires_at>statement_timestamp()) OR l.owner_user_id=$3::uuid)`,
  [appId, id, viewerId ?? null])).rows[0];
  if (!row) throw notFound();
  return item(row, viewerId, true);
}
