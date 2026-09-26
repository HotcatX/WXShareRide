import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../src/errors.ts';
import { marketListingExpiresAt, validateMarketListingDateWindow } from '../src/market/time.ts';

const invalidWindow = (error: unknown) => error instanceof AppError && error.status === 400 && error.code === 'INVALID_DATE_WINDOW';

test('expiry is the last millisecond of a New York date in summer and winter', () => {
  assert.equal(marketListingExpiresAt('2026-09-25').toISOString(), '2026-09-26T03:59:59.999Z');
  assert.equal(marketListingExpiresAt('2026-01-25').toISOString(), '2026-01-26T04:59:59.999Z');
});

test('expiry resolves DST calendar days rather than assuming 24 elapsed hours', () => {
  const springBefore = marketListingExpiresAt('2026-03-07');
  const springAfter = marketListingExpiresAt('2026-03-08');
  assert.equal(springAfter.toISOString(), '2026-03-09T03:59:59.999Z');
  assert.equal(springAfter.getTime() - springBefore.getTime(), 23 * 3_600_000);
  const fallBefore = marketListingExpiresAt('2026-10-31');
  const fallAfter = marketListingExpiresAt('2026-11-01');
  assert.equal(fallAfter.toISOString(), '2026-11-02T04:59:59.999Z');
  assert.equal(fallAfter.getTime() - fallBefore.getTime(), 25 * 3_600_000);
});

test('calendar upper limits use New York today even near the UTC date boundary', () => {
  const now = new Date('2026-09-26T02:00:00Z'); // Still September 25 in New York.
  assert.doesNotThrow(() => validateMarketListingDateWindow({ listingType: 'goods', startDate: '2026-09-25', endDate: '2026-11-25' }, now));
  assert.throws(() => validateMarketListingDateWindow({ listingType: 'goods', startDate: '2026-09-25', endDate: '2026-11-26' }, now), invalidWindow);
  assert.doesNotThrow(() => validateMarketListingDateWindow({ listingType: 'sublet', startDate: '2026-09-25', endDate: '2028-03-25' }, now));
  assert.throws(() => validateMarketListingDateWindow({ listingType: 'sublet', startDate: '2026-09-25', endDate: '2028-03-26' }, now), invalidWindow);
});

test('adding calendar months clamps to February and respects leap years', () => {
  for (const [listingType, now, maximum, invalid] of [
    ['goods', '2026-12-31T18:00:00Z', '2027-02-28', '2027-03-01'],
    ['goods', '2023-12-31T18:00:00Z', '2024-02-29', '2024-03-01'],
    ['sublet', '2026-08-31T18:00:00Z', '2028-02-29', '2028-03-01'],
  ] as const) {
    assert.doesNotThrow(() => validateMarketListingDateWindow({ listingType, startDate: now.slice(0, 10), endDate: maximum }, new Date(now)));
    assert.throws(() => validateMarketListingDateWindow({ listingType, startDate: now.slice(0, 10), endDate: invalid }, new Date(now)), invalidWindow);
  }
});

test('validation preserves already-started windows and does not rewrite input or original expiry', () => {
  const window = { listingType: 'goods' as const, startDate: '2026-08-01', endDate: '2026-09-26' };
  const before = structuredClone(window);
  assert.doesNotThrow(() => validateMarketListingDateWindow(window, new Date('2026-09-25T16:00:00Z')));
  assert.deepEqual(window, before);
  // Legacy exports used UTC midnight. Conversion must retain that separately;
  // this helper intentionally does not claim that old expiry was New York.
  assert.notEqual(marketListingExpiresAt('2026-09-25').toISOString(), '2026-09-25T23:59:59.999Z');
});

test('malformed dates, reversed windows and invalid clocks fail explicitly', () => {
  for (const value of ['2026-02-30', '2026-03-08T00:00:00Z', 'not-a-date']) {
    assert.throws(() => marketListingExpiresAt(value), invalidWindow);
    assert.throws(() => validateMarketListingDateWindow({ listingType: 'goods', startDate: value, endDate: '2026-10-01' }, new Date('2026-09-25T16:00:00Z')), invalidWindow);
  }
  assert.throws(() => validateMarketListingDateWindow({ listingType: 'goods', startDate: '2026-10-02', endDate: '2026-10-01' }, new Date('2026-09-25T16:00:00Z')), invalidWindow);
  assert.throws(() => validateMarketListingDateWindow({ listingType: 'goods', startDate: '2026-09-25', endDate: '2026-10-01' }, new Date(NaN)),
    (error: unknown) => error instanceof AppError && error.status === 500 && error.code === 'INVALID_CLOCK');
});
