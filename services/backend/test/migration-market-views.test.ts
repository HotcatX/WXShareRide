import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { normalizeMarketViews } from '../src/migration/market-views.ts';
import type { MigrationIssue, UserRow } from '../src/migration/types.ts';

const at = '2026-09-25T12:00:00.000Z';
const later = '2026-09-25T13:00:00.000Z';
const user: UserRow = { id: 'bfbf7e2b-a8b7-4d82-91bf-c03845325d1b', appId: 'views-test', openid: 'fixture-viewer',
  name: 'Fixture', avatarUrl: '', profile: {}, createdAt: at, updatedAt: null };
const context = { appId: user.appId, users: [user] };
function event(patch: Record<string, unknown> = {}): Record<string, unknown> {
  const row = { goodsId: 'fixture-listing', _openid: user.openid, dayKey: '2026-09-25', count: 3,
    createTime: { $date: at }, updateTime: { $date: later }, createTimeMs: Date.parse(at) - 40,
    updateTimeMs: Date.parse(later) - 60, ...patch };
  return { _id: createHash('sha1').update(`${row.goodsId}:${row._openid}:${row.dayKey}`).digest('hex'), ...row };
}
const listing = (patch: Record<string, unknown> = {}) => ({ _id: 'fixture-listing', viewCount: 3,
  lastViewAt: '2026-09-25T13:00:00.035Z', ...patch });
function convert(input: { events: unknown; listings: unknown } = { events: [event()], listings: [listing()] }, ctx = context) {
  const issues: Omit<MigrationIssue, 'count'>[] = [];
  const rows = normalizeMarketViews(input, ctx, (collection, code, field = '-', severity = 'error') => issues.push({ collection, code, field, severity }));
  return { rows, issues, errors: issues.filter(issue => issue.severity === 'error') };
}
function rejects(input: { events: unknown; listings: unknown }, code?: string) {
  const result = convert(input); assert.ok(result.errors.length); assert.deepEqual(result.rows, []);
  if (code) assert.ok(result.errors.some(issue => issue.code === code), `Expected ${code}`);
}

test('daily view buckets preserve count and both primary server times without expanding events or adjusting clocks', () => {
  const input = { events: [event()], listings: [listing()] }, before = JSON.stringify(input), result = convert(input);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows, [{ id: input.events[0]!._id, appId: context.appId, listingId: 'fixture-listing',
    actorUserId: user.id, day: '2026-09-25', count: 3, createdAt: at, updatedAt: later }]);
  assert.ok(result.issues.some(issue => issue.code === 'MARKET_VIEW_DISTINCT_CLOCKS_ARCHIVED'));
  assert.equal(JSON.stringify(input), before);
  assert.equal('createTimeMs' in result.rows[0]!, false);
  assert.equal('lastViewAt' in result.rows[0]!, false);
});

test('deleted listing history and unknown viewers remain separate original buckets without inventing users or listings', () => {
  const events = [event({ goodsId: 'deleted-listing', _openid: 'unknown-first', count: 4 }),
    event({ goodsId: 'deleted-listing', _openid: 'unknown-second', count: 2 })];
  const result = convert({ events, listings: [] });
  assert.deepEqual(result.errors, []); assert.equal(result.rows.length, 2);
  assert.equal(result.rows.reduce((sum, row) => sum + row.count, 0), 6);
  assert.ok(result.rows.every(row => row.actorUserId === null && row.listingId === 'deleted-listing'));
  assert.notEqual(result.rows[0]!.id, result.rows[1]!.id);
  assert.ok(result.issues.some(issue => issue.code === 'MARKET_VIEW_WITHOUT_CURRENT_LISTING' && issue.severity === 'notice'));
  assert.equal(JSON.stringify(result.rows).includes('unknown-first'), false);
});

test('viewCount reconciles for every current listing, including zero, while orphan totals cannot inflate it', () => {
  const events = [event(), event({ _openid: 'other-viewer', count: 2 }), event({ goodsId: 'deleted-listing', count: 8 })];
  const result = convert({ events, listings: [listing({ viewCount: 5 }), listing({ _id: 'zero-listing', viewCount: 0 })] });
  assert.deepEqual(result.errors, []); assert.equal(result.rows.length, 3);
  rejects({ events, listings: [listing({ viewCount: 13 })] }, 'MARKET_VIEW_BASELINE_MISMATCH');
  rejects({ events: [], listings: [listing()] }, 'MARKET_VIEW_BASELINE_MISMATCH');
  const { viewCount: _, ...withoutCounter } = listing();
  rejects({ events: [event()], listings: [withoutCounter] }, 'MARKET_VIEW_BASELINE_MISMATCH');
  assert.deepEqual(convert({ events: [], listings: [withoutCounter] }).errors, []);
});

test('original IDs, daily identities, date syntax and duplicate rows are validated without normalizing source identifiers', () => {
  for (const patch of [{ _id: 'a'.repeat(40) }, { _id: String(event()._id).toUpperCase() },
    { _id: `${event()._id}\n` }, { goodsId: 'trailing\n' }, { _openid: '' }, { _openid: ' padded ' },
    { dayKey: '2026-02-30' }, { dayKey: '0000-01-01' }, { dayKey: '2026-09-25\n' }]) {
    rejects({ events: [event(patch)], listings: [] });
  }
  rejects({ events: [event(), event()], listings: [listing({ viewCount: 6 })] }, 'INVALID_MARKET_VIEW_ID');
  rejects({ events: [], listings: [listing({ viewCount: 0 }), listing({ viewCount: 0 })] }, 'INVALID_MARKET_VIEW_LISTING');
});

test('strict integer counts reject invalid values; a historical race above the former daily limit is preserved with notice', () => {
  for (const count of [0, -1, 1.5, '3', null, true, Number.MAX_SAFE_INTEGER + 1]) {
    rejects({ events: [event({ count })], listings: [] }, 'INVALID_MARKET_VIEW_COUNT');
  }
  for (const count of [11, Number.MAX_SAFE_INTEGER]) {
    const result = convert({ events: [event({ count })], listings: [listing({ viewCount: count })] });
    assert.deepEqual(result.errors, []); assert.equal(result.rows[0]!.count, count);
    assert.ok(result.issues.some(issue => issue.code === 'LEGACY_MARKET_VIEW_LIMIT_EXCEEDED' && issue.severity === 'notice'));
  }
  rejects({ events: [event({ count: Number.MAX_SAFE_INTEGER }), event({ _openid: 'other-viewer', count: 1 })],
    listings: [listing({ viewCount: Number.MAX_SAFE_INTEGER })] }, 'MARKET_VIEW_BASELINE_MISMATCH');
  for (const viewCount of [-1, 1.5, '3', null]) rejects({ events: [], listings: [listing({ viewCount })] }, 'INVALID_MARKET_VIEW_BASELINE');
});

test('missing primary times stay unknown even when millisecond clocks exist; malformed or reversed clocks block', () => {
  const unknownTimes = event({ createTime: null }); delete unknownTimes.updateTime;
  const result = convert({ events: [unknownTimes], listings: [listing()] });
  assert.deepEqual(result.errors, []); assert.equal(result.rows[0]!.createdAt, null); assert.equal(result.rows[0]!.updatedAt, null);
  assert.equal(result.issues.filter(issue => issue.code === 'UNKNOWN_MARKET_VIEW_TIMESTAMP').length, 2);
  for (const patch of [{ createTime: '2026-09-25' }, { createTimeMs: String(Date.parse(at)) }, { updateTimeMs: -1 },
    { updateTime: '2026-09-24T12:00:00Z' }, { updateTimeMs: Date.parse(at) - 1000 }]) {
    rejects({ events: [event(patch)], listings: [listing()] });
  }
  rejects({ events: [], listings: [listing({ viewCount: 0, lastViewAt: 'not-a-date' })] }, 'INVALID_MARKET_VIEW_TIMESTAMP');
});

test('source New York day remains authoritative when midnight passes between selecting the bucket and recording a clock', () => {
  const midnight = '2026-09-26T04:00:00.001Z';
  const result = convert({ events: [event({ createTime: midnight, updateTime: midnight,
    createTimeMs: Date.parse(midnight), updateTimeMs: Date.parse(midnight) })], listings: [listing()] });
  assert.deepEqual(result.errors, []); assert.equal(result.rows[0]!.day, '2026-09-25');
});

test('unknown fields, malformed collections and user mappings block all rows; diagnostics reveal no raw identity or text', () => {
  const raw = event({ private_fixture_field: 'sensitive-fixture' });
  const result = convert({ events: [event({ goodsId: 'other-listing' }), raw], listings: [listing()] });
  assert.deepEqual(result.rows, []); assert.ok(result.errors.some(issue => issue.code === 'UNMAPPED_MARKET_VIEW_FIELD'));
  for (const forbidden of [user.openid, 'sensitive-fixture', 'private_fixture_field', 'fixture-listing', String(raw._id)]) {
    assert.equal(JSON.stringify(result.issues).includes(forbidden), false);
  }
  rejects({ events: {}, listings: [] }, 'INVALID_MARKET_VIEW_COLLECTION');
  rejects({ events: [null], listings: [] }, 'INVALID_MARKET_VIEW_DOCUMENT');
  const badContext = convert(undefined, { ...context, users: [{ ...user, appId: 'other-app' }] });
  assert.deepEqual(badContext.rows, []); assert.ok(badContext.errors.some(issue => issue.code === 'INVALID_USER_MAPPING'));
  let called = false;
  const getter = Object.defineProperty({}, 'count', { get() { called = true; return 3; }, enumerable: true });
  rejects({ events: [getter], listings: [] }, 'INVALID_SOURCE_JSON'); assert.equal(called, false);
});
