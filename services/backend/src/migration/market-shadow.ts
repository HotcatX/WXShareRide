import { isDeepStrictEqual } from 'node:util';
import { serializeSource } from './source.ts';
import type { Document, IssueReporter } from './types.ts';
import { object, parseExportTimestamp } from './values.ts';

/** Preserve historical houseShare membership after the canonical listing passes
 * its converter and all non-view fields match. Never create missing listings. */
export function validateMarketShadow(documents: unknown, goods: unknown, issue: IssueReporter): void {
  const report = (code: string, field = 'content') => issue('other', code, `houseShare.${field}`);
  if (!Array.isArray(documents) || !Array.isArray(goods)) { report('INVALID_MARKET_SHADOW_COLLECTION'); return; }
  const current = new Map<string, Document>();
  for (const raw of goods) {
    try { serializeSource(raw); } catch { report('INVALID_SOURCE_JSON', 'listings'); continue; }
    if (!object(raw) || typeof raw._id !== 'string' || raw._id.trim() !== raw._id || !/^[a-zA-Z0-9:_-]{1,160}$/.test(raw._id) || current.has(raw._id)) {
      report('INVALID_MARKET_SHADOW_LISTING', 'listings'); continue;
    }
    current.set(raw._id, raw);
  }
  const ids = new Set<string>();
  for (const raw of documents) {
    try { serializeSource(raw); } catch { report('INVALID_SOURCE_JSON'); continue; }
    if (!object(raw) || typeof raw._id !== 'string' || raw._id.trim() !== raw._id || !/^[a-zA-Z0-9:_-]{1,160}$/.test(raw._id) || ids.has(raw._id)) {
      report('INVALID_MARKET_SHADOW_ID', 'id'); continue;
    }
    ids.add(raw._id);
    const listing = current.get(raw._id);
    if (!listing) { report('MARKET_SHADOW_WITHOUT_CURRENT_LISTING', 'listing'); continue; }
    if (raw.viewCount !== undefined && (typeof raw.viewCount !== 'number' || !Number.isSafeInteger(raw.viewCount) || raw.viewCount < 0)) {
      report('INVALID_MARKET_SHADOW_VIEW_COUNT', 'views');
    }
    if (raw.lastViewAt !== undefined && !parseExportTimestamp(raw.lastViewAt)) report('INVALID_MARKET_SHADOW_TIMESTAMP', 'lastViewAt');
    const { viewCount: _shadowCount, lastViewAt: _shadowLast, ...shadowBusiness } = raw;
    const { viewCount: _currentCount, lastViewAt: _currentLast, ...currentBusiness } = listing;
    if (!isDeepStrictEqual(shadowBusiness, currentBusiness)) report('MARKET_SHADOW_CONTENT_MISMATCH');
  }
}
