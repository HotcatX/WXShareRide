import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestCounter } from '../src/admin/traffic.ts';

const minute = 60_000, base = 1_800_000_000_000;

test('traffic omits the first partial and current minutes, and reports only observed complete idle minutes as zero', () => {
  let now = base + 15_000;
  const counter = createRequestCounter(() => now);
  counter.record('GET', '/api/v1/rides');
  assert.deepEqual(counter.snapshot(), { sampledAt: now, startedAt: now, minutes: [] });
  now = base + minute;
  assert.deepEqual(counter.snapshot().minutes, []);
  now = base + 2 * minute;
  assert.deepEqual(counter.snapshot().minutes, [{ at: base + minute, direct: 0, bridge: 0, collection: 0 }]);
});

test('traffic classifies completed calls at fixed minute boundaries and excludes nonbusiness traffic', () => {
  let now = base;
  const counter = createRequestCounter(() => now);
  counter.record('GET', '/api/v1/rides');
  counter.record('PATCH', '/api/v1/me');
  counter.record('POST', '/internal/v1/auth/cloudbase');
  counter.record('POST', '/internal/v1/compat/cloudbase');
  counter.record('GET', '/api/v1/analytics/session');
  for (const route of ['/api/v1/rides', '/api/v1/analytics/session', '/internal/v1/auth/cloudbase']) counter.record('OPTIONS', route);
  for (const route of ['/api/v1/admin/session', '/api/v1/admin/console/status', '/healthz', '/internal/v1/monitor', undefined]) counter.record('GET', route);
  now = base + minute - 1;
  counter.record('GET', '/api/v1/previews/rides/:rideId');
  assert.deepEqual(counter.snapshot().minutes, []);
  now = base + minute;
  counter.record('GET', '/api/v1/rides');
  assert.deepEqual(counter.snapshot().minutes, [{ at: base, direct: 3, bridge: 2, collection: 1 }]);
  now = base + 2 * minute;
  assert.deepEqual(counter.snapshot().minutes, [
    { at: base, direct: 3, bridge: 2, collection: 1 },
    { at: base + minute, direct: 1, bridge: 0, collection: 0 },
  ]);
});

test('traffic retains six complete minutes and a restarted process cannot invent earlier coverage', () => {
  let now = base;
  const counter = createRequestCounter(() => now);
  for (let i = 0; i < 10; i++) {
    now = base + i * minute;
    for (let n = 0; n <= i; n++) counter.record('GET', '/api/v1/rides');
  }
  now = base + 10 * minute;
  assert.deepEqual(counter.snapshot().minutes, Array.from({ length: 6 }, (_, i) => ({
    at: base + (i + 4) * minute, direct: i + 5, bridge: 0, collection: 0,
  })));
  now += 15_000;
  const restarted = createRequestCounter(() => now);
  restarted.record('GET', '/api/v1/rides');
  now = base + 11 * minute;
  assert.deepEqual(restarted.snapshot().minutes, []);
  now = base + 12 * minute;
  assert.deepEqual(restarted.snapshot().minutes, [{ at: base + 11 * minute, direct: 0, bridge: 0, collection: 0 }]);
  now = base + 30 * minute;
  assert.deepEqual(counter.snapshot().minutes, Array.from({ length: 6 }, (_, i) => ({
    at: base + (i + 24) * minute, direct: 0, bridge: 0, collection: 0,
  })));
});
