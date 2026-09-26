import { createHash } from 'node:crypto';
import { z } from 'zod';
import { serializeSource } from './source.ts';
import type { IssueReporter, UserRow } from './types.ts';
import { indexMigrationUsers, object, parseExportTimestamp } from './values.ts';

export type MarketViewRow = {
  id: string; appId: string; listingId: string; actorUserId: string | null;
  day: string; count: number; createdAt: string | null; updatedAt: string | null;
};
type Context = { appId: string; users: readonly UserRow[] };
const fields = new Set(['_id', '_openid', 'goodsId', 'dayKey', 'count',
  'createTime', 'createTimeMs', 'updateTime', 'updateTimeMs']);
const identity = (value: unknown): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= 160 && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const listingId = (value: unknown): value is string => typeof value === 'string' && value.trim() === value && /^[a-zA-Z0-9:_-]{1,160}$/.test(value);
const date = z.iso.date().length(10).refine(value => !value.startsWith('0000-'));

/** These are daily counted-view buckets, not individual events or distinct
 * people. Keep orphan listing IDs and unknown actors without creating either.
 * The caller archives every original document and supplies market_goods that
 * also passes normalizeMarketListings. Any error rejects all view candidates.
 * DB server timestamps remain primary; the function's millisecond clock and
 * the listing's later lastViewAt write are independent source facts. */
export function normalizeMarketViews(
  input: { events: unknown; listings: unknown }, context: Context, issue: IssueReporter,
): MarketViewRow[] {
  let failed = false;
  const report = (code: string, field = 'content', severity: 'error' | 'notice' = 'error') => {
    if (severity === 'error') failed = true;
    issue('other', code, `market_view_events.${field}`, severity);
  };
  if (!input || !Array.isArray(input.events) || !Array.isArray(input.listings)) {
    report('INVALID_MARKET_VIEW_COLLECTION'); return [];
  }
  if (!context || !identity(context.appId) || !Array.isArray(context.users)) {
    report('INVALID_MARKET_VIEW_CONTEXT'); return [];
  }
  const users = indexMigrationUsers(context.users, context.appId, (collection, code, field, severity) => {
    failed = true; issue(collection, code, field, severity);
  });
  if (failed) return [];
  const listings = new Map<string, number>();
  for (const raw of input.listings) {
    try { serializeSource(raw); } catch { report('INVALID_SOURCE_JSON', 'listings'); continue; }
    if (!object(raw) || !listingId(raw._id) || listings.has(raw._id)) {
      report('INVALID_MARKET_VIEW_LISTING', 'listings'); continue;
    }
    // The legacy response displays a missing counter as zero. A missing
    // positive baseline still fails reconciliation below; it is never rebuilt.
    const count = raw.viewCount === undefined ? 0 : raw.viewCount;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      report('INVALID_MARKET_VIEW_BASELINE', 'listings'); continue;
    }
    if (raw.lastViewAt !== undefined && !parseExportTimestamp(raw.lastViewAt)) {
      report('INVALID_MARKET_VIEW_TIMESTAMP', 'lastViewAt');
    }
    listings.set(raw._id, count);
  }
  const stamp = (value: unknown, field: string, milliseconds = false) => {
    if (value === undefined || value === null) {
      report('UNKNOWN_MARKET_VIEW_TIMESTAMP', field, 'notice'); return null;
    }
    const result = milliseconds && typeof value !== 'number' ? null : parseExportTimestamp(value);
    if (!result) report('INVALID_MARKET_VIEW_TIMESTAMP', field);
    return result;
  };
  const ids = new Set<string>(), dailyKeys = new Set<string>();
  const totals = new Map<string, bigint>();
  const rows: MarketViewRow[] = [];
  for (const raw of input.events) {
    try { serializeSource(raw); } catch { report('INVALID_SOURCE_JSON'); continue; }
    if (!object(raw)) { report('INVALID_MARKET_VIEW_DOCUMENT'); continue; }
    for (const key of Object.keys(raw)) if (!fields.has(key)) report('UNMAPPED_MARKET_VIEW_FIELD');
    if (typeof raw._id !== 'string' || raw._id.length !== 40 || !/^[a-f0-9]{40}$/.test(raw._id) || ids.has(raw._id)) {
      report('INVALID_MARKET_VIEW_ID', 'id'); continue;
    }
    ids.add(raw._id);
    if (!listingId(raw.goodsId) || !identity(raw._openid) || !date.safeParse(raw.dayKey).success) {
      report('INVALID_MARKET_VIEW_IDENTITY', 'identity'); continue;
    }
    const day = raw.dayKey as string;
    const dailyKey = JSON.stringify([raw.goodsId, raw._openid, day]);
    if (dailyKeys.has(dailyKey)) { report('DUPLICATE_MARKET_VIEW_DAY', 'identity'); continue; }
    dailyKeys.add(dailyKey);
    if (raw._id !== createHash('sha1').update(`${raw.goodsId}:${raw._openid}:${day}`).digest('hex')) {
      report('MARKET_VIEW_ID_MISMATCH', 'id');
    }
    if (typeof raw.count !== 'number' || !Number.isSafeInteger(raw.count) || raw.count < 1) {
      report('INVALID_MARKET_VIEW_COUNT', 'count'); continue;
    }
    // The legacy read/check/increment was not transactional. Preserve a real
    // over-limit counter with a notice instead of truncating historical views.
    if (raw.count > 10) report('LEGACY_MARKET_VIEW_LIMIT_EXCEEDED', 'count', 'notice');
    if (!listings.has(raw.goodsId)) report('MARKET_VIEW_WITHOUT_CURRENT_LISTING', 'listing', 'notice');
    const actorUserId = users.get(raw._openid)?.id.toLowerCase() ?? null;
    if (actorUserId === null) report('UNMATCHED_MARKET_VIEW_ACTOR_ARCHIVED', 'actor', 'notice');
    const createdAt = stamp(raw.createTime, 'createdAt'), updatedAt = stamp(raw.updateTime, 'updatedAt');
    const firstMs = stamp(raw.createTimeMs, 'createTimeMs', true), lastMs = stamp(raw.updateTimeMs, 'updateTimeMs', true);
    if (createdAt && updatedAt && createdAt > updatedAt || firstMs && lastMs && firstMs > lastMs) {
      report('INVALID_MARKET_VIEW_TIMESTAMP_ORDER', 'timestamps');
    }
    if (createdAt && firstMs && createdAt !== firstMs || updatedAt && lastMs && updatedAt !== lastMs) {
      report('MARKET_VIEW_DISTINCT_CLOCKS_ARCHIVED', 'timestamps', 'notice');
    }
    // dayKey was chosen just before Date.now() and before asynchronous writes;
    // midnight can lie between those calls. Preserve the validated source day.
    totals.set(raw.goodsId, (totals.get(raw.goodsId) ?? 0n) + BigInt(raw.count));
    rows.push({ id: raw._id, appId: context.appId, listingId: raw.goodsId, actorUserId, day,
      count: raw.count, createdAt, updatedAt });
  }
  for (const [id, baseline] of listings) {
    if ((totals.get(id) ?? 0n) !== BigInt(baseline)) report('MARKET_VIEW_BASELINE_MISMATCH', 'listings');
  }
  return failed ? [] : rows;
}
