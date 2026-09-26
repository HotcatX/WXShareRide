import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePublicStatistics } from '../src/migration/public-statistics.ts';
import type { IssueReporter } from '../src/migration/types.ts';

const at = '2026-09-25T12:00:00.000Z';
const fixture = () => ({ _id: 'home', servedTrips: 8875, coverageText: 'NY / NJ', updatedAt: { $date: at },
  lastServedAt: { $date: at }, servedTripsLastDelta: 2, servedTripsLastSource: 'syncTripStatus:carpool',
  servedTripsLastTripId: 'previously-deleted-ride', servedTripsLastCollection: 'Carpool' });
function convert(documents: unknown) {
  const issues: { code: string; field?: string }[] = [];
  const issue: IssueReporter = (_collection, code, field) => issues.push({ code, field });
  return { rows: normalizePublicStatistics(documents, 'app', issue), issues };
}

test('public total and coverage survive exactly, without replaying old deltas or requiring a deleted ride', () => {
  const raw = fixture(), before = structuredClone(raw);
  assert.deepEqual(convert([raw]), { rows: [{ appId: 'app', servedCount: 8875, coverageText: 'NY / NJ', updatedAt: at }], issues: [] });
  assert.deepEqual(raw, before);
});

test('only a single authoritative baseline with a safe integer count is accepted', () => {
  for (const input of [undefined, {}, [], [fixture(), fixture()], [{ ...fixture(), _id: 'other' }]]) assert.deepEqual(convert(input).rows, []);
  for (const value of [null, '8875', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(convert([{ ...fixture(), servedTrips: value }]).rows, []);
  }
  assert.equal(convert([{ _id: 'home', servedTrips: 0, updatedAt: at }]).rows[0]!.servedCount, 0);
});

test('missing coverage stays unknown, and invalid or hidden source values are never exposed', () => {
  assert.equal(convert([{ _id: 'home', servedTrips: 0, updatedAt: at }]).rows[0]!.coverageText, null);
  for (const value of ['bad\ncoverage', 'bad\u0085coverage', 'bad\u009fcoverage', 'x'.repeat(121), {}, 7]) assert.deepEqual(convert([{ ...fixture(), coverageText: value }]).rows, []);
  const result = convert([{ ...fixture(), 'private-unknown-key': 'private-value', servedTripsLastTripId: 'bad private-id' }]);
  assert.deepEqual(result.rows, []);
  assert.doesNotMatch(JSON.stringify(result.issues), /private-/);
  let invoked = false;
  const raw = fixture(); Object.defineProperty(raw, 'coverageText', { enumerable: true, get() { invoked = true; return 'secret'; } });
  assert.deepEqual(convert([raw]).rows, []);
  assert.equal(invoked, false);
});

test('legacy bookkeeping is validated without becoming a second editable statistics model', () => {
  for (const patch of [{ updatedAt: 'bad' }, { createdAt: '2026-09-26T12:00:00Z' }, { lastServedAt: '2026-09-26T12:00:00Z' },
    { servedTripsLastDelta: 0 }, { servedTripsLastDelta: 6 }, { servedTrips: 1 },
    { servedTripsLastSource: 'syncTripStatus:request' }, { servedTripsLastCollection: 'unknown' }]) {
    assert.deepEqual(convert([{ ...fixture(), ...patch }]).rows, []);
  }
  const missing = { ...fixture() } as Record<string, unknown>; delete missing.servedTripsLastDelta;
  assert.deepEqual(convert([missing]).rows, []);
});
