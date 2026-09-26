import { legacyCloudFileIdSchema } from './market-images.ts';
import { serializeSource } from './source.ts';
import type { IssueReporter, UserRow } from './types.ts';
import { indexMigrationUsers, object, parseExportTimestamp } from './values.ts';

export type AdRow = {
  id: string; appId: string; status: 'online' | 'offline' | 'deleted'; placement: string;
  title: string; subtitle: string; badgeText: string; ctaText: string; weight: number; priority: number;
  startAt: string | null; endAt: string | null;
  target: { kind: 'contact'; sessionFrom: string; messageCard: { enabled: boolean; title: string; path: string } };
  createdAt: string | null; updatedAt: string | null;
};
export type AdClickRow = {
  id: string; appId: string; adId: string; type: 'click'; placement: string; listingType: 'goods' | 'sublet';
  actorUserId: string | null; createdAt: string | null;
};
export type AdFileReference = {
  appId: string; resourceKind: 'ad'; resourceId: string; slot: 'image' | 'thumbnail'; locator: string;
};
type Context = { appId: string; users: readonly UserRow[] };
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160 &&
  value.trim() === value && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value);
const adFields = new Set(['_id', 'status', 'placement', 'title', 'subtitle', 'badgeText', 'ctaText', 'weight', 'priority',
  'startAtMs', 'endAtMs', 'startAt', 'endAt', 'imageFileID', 'thumbFileID', 'targetType', 'contactSessionFrom',
  'contactMessageTitle', 'contactMessagePath', 'showMessageCard', 'createTime', 'updateTime']);
const eventFields = new Set(['_id', '_openid', 'adId', 'type', 'placement', 'listingType', 'createTime', 'createTimeMs']);

/** Only the audited contact-ad source is supported. Other target types or
 * unmodeled fields block; this is not a claim that all ad targets migrated.
 * Source documents retain unmatched OpenIDs and independent clock evidence.
 * An orphan click never creates an ad or a user, and never proves an impression,
 * a successful customer-service session, or a completed contact. */
export function normalizeAds(
  input: { ads: unknown; events: unknown }, context: Context, issue: IssueReporter,
): { ads: AdRow[]; events: AdClickRow[]; references: AdFileReference[] } {
  let failed = false;
  const report = (collection: 'market_ads' | 'market_ad_events', code: string, field = 'content', severity: 'error' | 'notice' = 'error') => {
    if (severity === 'error') failed = true;
    issue('other', code, `${collection}.${field}`, severity);
  };
  const empty = () => ({ ads: [] as AdRow[], events: [] as AdClickRow[], references: [] as AdFileReference[] });
  if (!input || !Array.isArray(input.ads) || !Array.isArray(input.events)) { report('market_ads', 'INVALID_AD_COLLECTION'); return empty(); }
  if (!context || !identity(context.appId) || !Array.isArray(context.users)) { report('market_ads', 'INVALID_AD_CONTEXT'); return empty(); }
  const users = indexMigrationUsers(context.users, context.appId, (collection, code, field, severity) => {
    failed = true; issue(collection, code, field, severity);
  });
  if (failed) return empty();
  const text = (value: unknown, limit: number, collection: 'market_ads' | 'market_ad_events', optional = false, fallback = '') => {
    if (value === undefined && optional) return fallback;
    if (typeof value !== 'string' || value.length > limit || value !== value.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
      report(collection, 'INVALID_AD_TEXT'); return '';
    }
    return value || fallback;
  };
  const stamp = (value: unknown, collection: 'market_ads' | 'market_ad_events', field: string) => {
    if (value === undefined || value === null) { report(collection, 'UNKNOWN_AD_TIMESTAMP', field, 'notice'); return null; }
    const result = parseExportTimestamp(value);
    if (!result) report(collection, 'INVALID_AD_TIMESTAMP', field);
    return result;
  };
  const boundary = (raw: Record<string, unknown>, msField: string, dateField: string) => {
    const values = [raw[msField], raw[dateField]].filter(value => value !== undefined && value !== null && value !== '' && value !== 0);
    if (!values.length) return null;
    if (raw[msField] !== undefined && raw[msField] !== null && raw[msField] !== 0 && typeof raw[msField] !== 'number') report('market_ads', 'INVALID_AD_TIMESTAMP', 'window');
    const parsed = values.map(value => parseExportTimestamp(value));
    if (parsed.some(value => !value)) report('market_ads', 'INVALID_AD_TIMESTAMP', 'window');
    else if (parsed.some(value => value !== parsed[0])) report('market_ads', 'CONFLICTING_AD_TIME_ALIASES', 'window');
    return parsed[0] ?? null;
  };
  const ads: AdRow[] = [], events: AdClickRow[] = [], references: AdFileReference[] = [];
  const adIds = new Set<string>();
  for (const raw of input.ads) {
    try { serializeSource(raw); } catch { report('market_ads', 'INVALID_SOURCE_JSON'); continue; }
    if (!object(raw)) { report('market_ads', 'INVALID_AD_DOCUMENT'); continue; }
    for (const key of Object.keys(raw)) if (!adFields.has(key)) report('market_ads', 'UNMAPPED_AD_FIELD');
    if (!id(raw._id) || adIds.has(raw._id)) { report('market_ads', 'INVALID_AD_ID', 'id'); continue; }
    adIds.add(raw._id);
    if (!['online', 'offline', 'deleted'].includes(raw.status as string)) report('market_ads', 'UNSUPPORTED_AD_STATUS', 'status');
    if (raw.targetType !== 'contact') report('market_ads', 'UNSUPPORTED_AD_TARGET', 'target');
    const placement = text(raw.placement, 80, 'market_ads');
    if (!placement) report('market_ads', 'INVALID_AD_PLACEMENT', 'placement');
    const title = text(raw.title, 1000, 'market_ads', false, '校园推荐');
    const subtitle = text(raw.subtitle, 2000, 'market_ads', true);
    const badgeText = text(raw.badgeText, 240, 'market_ads', true, '广告');
    const ctaText = text(raw.ctaText, 240, 'market_ads', true, '查看');
    const sessionFrom = text(raw.contactSessionFrom, 2000, 'market_ads', true);
    const messageTitle = text(raw.contactMessageTitle, 1000, 'market_ads', true, title);
    const path = text(raw.contactMessagePath, 2048, 'market_ads', true);
    if (path && (!path.startsWith('/') || path.startsWith('//') || path.includes('\\'))) report('market_ads', 'INVALID_AD_CONTACT_PATH', 'target');
    if (raw.showMessageCard !== undefined && typeof raw.showMessageCard !== 'boolean') report('market_ads', 'INVALID_AD_CONTACT_CARD', 'target');
    if (typeof raw.weight !== 'number' || !Number.isFinite(raw.weight) || raw.weight < 1 || raw.weight > Number.MAX_SAFE_INTEGER) report('market_ads', 'INVALID_AD_WEIGHT', 'weight');
    if (typeof raw.priority !== 'number' || !Number.isFinite(raw.priority) || Math.abs(raw.priority) > Number.MAX_SAFE_INTEGER) report('market_ads', 'INVALID_AD_PRIORITY', 'priority');
    const startAt = boundary(raw, 'startAtMs', 'startAt'), endAt = boundary(raw, 'endAtMs', 'endAt');
    // Old ad scheduling is inclusive at endAt, unlike community expiration.
    if (startAt && endAt && startAt > endAt) report('market_ads', 'INVALID_AD_WINDOW', 'window');
    const createdAt = stamp(raw.createTime, 'market_ads', 'createdAt'), updatedAt = stamp(raw.updateTime, 'market_ads', 'updatedAt');
    if (createdAt && updatedAt && createdAt > updatedAt) report('market_ads', 'INVALID_AD_TIMESTAMP_ORDER', 'updatedAt');
    ads.push({ id: raw._id, appId: context.appId, status: raw.status as AdRow['status'], placement,
      title, subtitle, badgeText, ctaText, weight: raw.weight as number, priority: raw.priority as number, startAt, endAt,
      target: { kind: 'contact', sessionFrom, messageCard: { enabled: raw.showMessageCard !== false, title: messageTitle, path } }, createdAt, updatedAt });
    for (const [field, slot] of [['imageFileID', 'image'], ['thumbFileID', 'thumbnail']] as const) {
      const value = raw[field];
      if (value === undefined || value === '') continue;
      const parsed = legacyCloudFileIdSchema.safeParse(value);
      if (!parsed.success || Buffer.byteLength(parsed.data, 'utf8') > 1024 || parsed.data.split('/').slice(3).some(part => !part || part === '.' || part === '..')) {
        report('market_ads', 'INVALID_AD_IMAGE', 'references'); continue;
      }
      references.push({ appId: context.appId, resourceKind: 'ad', resourceId: raw._id, slot, locator: parsed.data });
    }
  }
  const eventIds = new Set<string>();
  for (const raw of input.events) {
    try { serializeSource(raw); } catch { report('market_ad_events', 'INVALID_SOURCE_JSON'); continue; }
    if (!object(raw)) { report('market_ad_events', 'INVALID_AD_EVENT_DOCUMENT'); continue; }
    for (const key of Object.keys(raw)) if (!eventFields.has(key)) report('market_ad_events', 'UNMAPPED_AD_EVENT_FIELD');
    if (!id(raw._id) || eventIds.has(raw._id) || !id(raw.adId)) { report('market_ad_events', 'INVALID_AD_EVENT_ID', 'id'); continue; }
    eventIds.add(raw._id);
    if (raw.type !== 'click') report('market_ad_events', 'UNSUPPORTED_AD_EVENT_TYPE', 'type');
    if (raw.listingType !== 'goods' && raw.listingType !== 'sublet') report('market_ad_events', 'INVALID_AD_EVENT_LISTING_TYPE', 'listingType');
    const placement = text(raw.placement, 80, 'market_ad_events');
    if (!placement) report('market_ad_events', 'INVALID_AD_PLACEMENT', 'placement');
    if (!adIds.has(raw.adId)) report('market_ad_events', 'AD_EVENT_WITHOUT_CURRENT_AD', 'adId', 'notice');
    let actorUserId: string | null = null;
    if (raw._openid === undefined || raw._openid === null || raw._openid === '') report('market_ad_events', 'UNKNOWN_AD_EVENT_ACTOR', 'actor', 'notice');
    else if (!identity(raw._openid)) report('market_ad_events', 'INVALID_AD_EVENT_ACTOR', 'actor');
    else {
      actorUserId = users.get(raw._openid)?.id ?? null;
      if (!actorUserId) report('market_ad_events', 'UNMATCHED_AD_EVENT_ACTOR_ARCHIVED', 'actor', 'notice');
    }
    const serverAt = stamp(raw.createTime, 'market_ad_events', 'createdAt');
    let msAt: string | null = null;
    if (raw.createTimeMs !== undefined && raw.createTimeMs !== null) {
      msAt = typeof raw.createTimeMs === 'number' ? parseExportTimestamp(raw.createTimeMs) : null;
      if (!msAt) report('market_ad_events', 'INVALID_AD_TIMESTAMP', 'createTimeMs');
      else if (serverAt && msAt !== serverAt) report('market_ad_events', 'AD_EVENT_DISTINCT_CLOCK_ARCHIVED', 'createTimeMs', 'notice');
      else if (!serverAt) report('market_ad_events', 'AD_EVENT_MILLISECOND_TIMESTAMP_USED', 'createdAt', 'notice');
    }
    events.push({ id: raw._id, appId: context.appId, adId: raw.adId, type: 'click', placement,
      listingType: raw.listingType as AdClickRow['listingType'], actorUserId, createdAt: serverAt ?? msAt });
  }
  return failed ? empty() : { ads, events, references };
}
