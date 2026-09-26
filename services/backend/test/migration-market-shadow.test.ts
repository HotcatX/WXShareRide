import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMarketShadow } from '../src/migration/market-shadow.ts';
import type { MigrationIssue } from '../src/migration/types.ts';

const listing = () => ({ _id: 'fixture-sublet', _openid: 'fixture-owner', listingType: 'sublet', title: 'Fixture listing',
  location: { displayName: 'Fixture', lat: null, lng: null }, imageFileIDs: ['cloud://fixture/market/a.jpg'],
  viewCount: 3, lastViewAt: { $date: '2026-09-25T13:00:00Z' } });
function validate(documents: unknown, goods: unknown = [listing()]) {
  const issues: Omit<MigrationIssue, 'count'>[] = [];
  const result = validateMarketShadow(documents, goods, (collection, code, field = '-', severity = 'error') => issues.push({ collection, code, field, severity }));
  assert.equal(result, undefined); return issues;
}

test('matching shadow is archive-only despite older view count or missing lastViewAt; input is unchanged', () => {
  const { lastViewAt: _, ...raw } = listing(); raw.viewCount = 0;
  const before = JSON.stringify(raw);
  assert.deepEqual(validate([raw]), []); assert.equal(JSON.stringify(raw), before);
  assert.deepEqual(validate([Object.fromEntries(Object.entries(raw).reverse())]), []);
  assert.deepEqual(validate([]), []);
});

test('every non-view field including nested values and missing properties must exactly match canonical source', () => {
  for (const patch of [{ title: 'Changed' }, { location: { displayName: 'Different', lat: null, lng: null } },
    { imageFileIDs: [] }, { extra_business_field: 'sensitive-fixture' }, { _openid: 'other-fixture-owner' }]) {
    const issues = validate([{ ...listing(), ...patch }]);
    assert.ok(issues.some(issue => issue.code === 'MARKET_SHADOW_CONTENT_MISMATCH'));
    assert.equal(JSON.stringify(issues).includes('sensitive-fixture'), false);
    assert.equal(JSON.stringify(issues).includes('extra_business_field'), false);
  }
  const raw: Record<string, unknown> = listing(); delete raw.title;
  assert.ok(validate([raw]).some(issue => issue.code === 'MARKET_SHADOW_CONTENT_MISMATCH'));
});

test('orphan or duplicate shadows cannot create listings or be silently collapsed', () => {
  assert.ok(validate([listing()], []).some(issue => issue.code === 'MARKET_SHADOW_WITHOUT_CURRENT_LISTING'));
  assert.ok(validate([listing(), listing()]).some(issue => issue.code === 'INVALID_MARKET_SHADOW_ID'));
  assert.ok(validate([listing()], [listing(), listing()]).some(issue => issue.code === 'INVALID_MARKET_SHADOW_LISTING'));
  assert.ok(validate([{ ...listing(), _id: 'fixture-sublet\n' }]).some(issue => issue.code === 'INVALID_MARKET_SHADOW_ID'));
});

test('the two allowed differences still require valid count and recorded timestamp types', () => {
  for (const viewCount of [-1, 1.5, null, '0', Number.MAX_SAFE_INTEGER + 1]) {
    assert.ok(validate([{ ...listing(), viewCount }]).some(issue => issue.code === 'INVALID_MARKET_SHADOW_VIEW_COUNT'));
  }
  assert.ok(validate([{ ...listing(), lastViewAt: 'not-a-time' }]).some(issue => issue.code === 'INVALID_MARKET_SHADOW_TIMESTAMP'));
  assert.deepEqual(validate([{ ...listing(), viewCount: 11, lastViewAt: '2026-09-26T00:00:00Z' }]), []);
});

test('non-JSON records are rejected without invoking getters or exposing source content', () => {
  assert.ok(validate({}).some(issue => issue.code === 'INVALID_MARKET_SHADOW_COLLECTION'));
  assert.ok(validate([null]).some(issue => issue.code === 'INVALID_MARKET_SHADOW_ID'));
  let called = false;
  const raw = Object.defineProperty({}, '_id', { enumerable: true, get() { called = true; return 'secret-fixture'; } });
  const issues = validate([raw]);
  assert.ok(issues.some(issue => issue.code === 'INVALID_SOURCE_JSON')); assert.equal(called, false);
  assert.equal(JSON.stringify(issues).includes('secret-fixture'), false);
});
