import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseListedPrice } from '../src/prices.ts';

test('converts established USD listed-price forms without inventing a unit', () => {
  for (const label of ['15.20', '15.20$/人', '$15.20', '15.20$', '15.20 USD', '15.20usd', '15.20美元', '15.20美金', '15.20刀', '$ 15.20 /人', '15.20 USD / 人']) {
    assert.deepEqual(parseListedPrice(label), { classification: 'priced', cents: 1520, label });
  }
  assert.deepEqual(parseListedPrice(15.2), { classification: 'priced', cents: 1520, label: '15.2' });
  assert.deepEqual(parseListedPrice('00015.2'), { classification: 'priced', cents: 1520, label: '00015.2' });
});

test('keeps the exact original string label, while only the recognition copy is trimmed', () => {
  const label = '  $ 12.30  ';
  assert.deepEqual(parseListedPrice(label), { classification: 'priced', cents: 1230, label });
  const unresolved = '  12-20 USD  ';
  assert.deepEqual(parseListedPrice(unresolved), { classification: 'unresolved', cents: null, label: unresolved });
});

test('uses exact integer cents and enforces the database integer boundary', () => {
  for (const [label, cents] of [['0.29', 29], ['1.01', 101], ['21474836.47$', 2_147_483_647]] as const) {
    assert.deepEqual(parseListedPrice(label), { classification: 'priced', cents, label });
  }
  for (const label of ['21474836.48$', '99999999.99', '100000000', '0.001', '15.200', '1e2', '1,000', '-1', '+1', '.5', '15.']) {
    assert.deepEqual(parseListedPrice(label), { classification: 'unresolved', cents: null, label });
  }
});

test('only explicit free labels or zero amounts become zero', () => {
  for (const label of ['免费', 'free', 'FREE', ' 免费 ', '0', '$0.00']) {
    assert.deepEqual(parseListedPrice(label), { classification: 'priced', cents: 0, label });
  }
  assert.deepEqual(parseListedPrice(0), { classification: 'priced', cents: 0, label: '0' });
  for (const label of ['不免费', 'free if available', '价格待定', '协商', '司机确认']) {
    assert.deepEqual(parseListedPrice(label), { classification: 'unpriced', cents: null, label });
  }
});

test('built-in reference-price placeholders remain unknown and keep their exact meaning', () => {
  const createPage = readFileSync(new URL('../../../pages/home/newTrip/newTrip.js', import.meta.url), 'utf8');
  const displayHelper = readFileSync(new URL('../../../utils/tripManage.js', import.meta.url), 'utf8');
  // Guard the audited built-in examples against drifting away from the actual UI.
  assert.match(createPage, /referencePrice:\s*"参考打车价格"/);
  for (const label of ['参考打车价格', '请参考打车价格', '价格以司机确认为准']) {
    assert.ok(displayHelper.includes(label));
    assert.deepEqual(parseListedPrice(label), { classification: 'unpriced', cents: null, label });
  }
});

test('missing values and ordinary nonnumeric text do not invent an amount', () => {
  for (const value of [null, undefined]) assert.deepEqual(parseListedPrice(value), { classification: 'unpriced', cents: null, label: null });
  for (const label of ['', '  ', '请先联系', '任意无金额备注']) {
    assert.deepEqual(parseListedPrice(label), { classification: 'unpriced', cents: null, label });
  }
});

test('ranges, multiple amounts, conditions, unknown units and other currencies stay unresolved', () => {
  for (const label of ['15-20$/人', '2人共30', '$15另加$5', '$15起', '15 USD if shared', '15USD备注', '15/人', '15每人', '15美元/车', '15 USD/hour', '15元', '15 CAD', '€15', '15\nUSD']) {
    assert.deepEqual(parseListedPrice(label), { classification: 'unresolved', cents: null, label });
  }
});

test('unsupported numeric notation is not mistaken for an unpriced text label', () => {
  for (const label of ['十五美元', '拾伍美金', '两刀', '半价', '０．５美元', '１２刀', '١٥ USD', '½ USD', '①美元']) {
    assert.deepEqual(parseListedPrice(label), { classification: 'unresolved', cents: null, label });
  }
});

test('malformed types cannot stringify themselves into accepted amounts', () => {
  for (const value of [true, false, [], [15], {}, { toString: () => '15' }, new Number(15)]) {
    assert.deepEqual(parseListedPrice(value), { classification: 'unresolved', cents: null, label: null });
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.deepEqual(parseListedPrice(value), { classification: 'unresolved', cents: null, label: String(value) });
  }
});
