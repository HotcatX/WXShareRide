import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestCounter } from '../src/traffic.mjs';

const minute = 60_000, base = 1_800_000_000_000;

test('collection traffic omits incomplete startup/current minutes instead of fabricating zero coverage', () => {
  let now = base + 15_000;
  const counter = createRequestCounter(() => now);
  counter.record();
  assert.deepEqual(counter.snapshot(), { sampledAt: now, startedAt: now, minutes: [] });
  now = base + minute;
  assert.deepEqual(counter.snapshot().minutes, []);
  now = base + 2 * minute;
  assert.deepEqual(counter.snapshot().minutes, [{ at: base + minute, collection: 0 }]);
});

test('collection traffic places all accepted record calls in one fixed minute and hides the live minute', () => {
  let now = base;
  const counter = createRequestCounter(() => now);
  counter.record(); counter.record();
  now = base + minute - 1;
  counter.record();
  assert.deepEqual(counter.snapshot().minutes, []);
  now = base + minute;
  counter.record();
  assert.deepEqual(counter.snapshot().minutes, [{ at: base, collection: 3 }]);
  now = base + 2 * minute;
  assert.deepEqual(counter.snapshot().minutes, [{ at: base, collection: 3 }, { at: base + minute, collection: 1 }]);
});

test('collection traffic retains six complete minutes and restart gaps remain absent', () => {
  let now = base;
  const counter = createRequestCounter(() => now);
  for (let i = 0; i < 10; i++) {
    now = base + i * minute;
    for (let n = 0; n <= i; n++) counter.record();
  }
  now = base + 10 * minute;
  assert.deepEqual(counter.snapshot().minutes, Array.from({ length: 6 }, (_, i) => ({ at: base + (i + 4) * minute, collection: i + 5 })));
  now += 15_000;
  const restarted = createRequestCounter(() => now);
  restarted.record();
  now = base + 11 * minute;
  assert.deepEqual(restarted.snapshot().minutes, []);
  now = base + 12 * minute;
  assert.deepEqual(restarted.snapshot().minutes, [{ at: base + 11 * minute, collection: 0 }]);
  now = base + 30 * minute;
  assert.deepEqual(counter.snapshot().minutes, Array.from({ length: 6 }, (_, i) => ({ at: base + (i + 24) * minute, collection: 0 })));
});
