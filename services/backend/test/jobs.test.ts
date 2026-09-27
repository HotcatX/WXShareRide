import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRideJobs } from '../src/jobs.ts';

const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test('ride jobs run independently without overlap and shutdown drains current work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let closes = 0, deliveries = 0;
  const stop = startRideJobs({ closeRides: async () => { closes++; await pending; },
    deliverEvents: async () => { deliveries++; } }, () => assert.fail('unexpected job failure'));
  t.mock.timers.tick(0); await settle();
  assert.equal(closes, 1); assert.equal(deliveries, 1);
  for (let i = 0; i < 7; i++) { t.mock.timers.tick(10_000); await settle(); }
  assert.equal(closes, 1, 'a slow close cannot overlap itself');
  assert.equal(deliveries, 8, 'delivery continues while close waits');
  let stopped = false;
  const drained = stop().then(() => { stopped = true; });
  await settle(); assert.equal(stopped, false);
  t.mock.timers.tick(300_000); await settle(); assert.equal(deliveries, 8);
  finish(); await drained;
  t.mock.timers.tick(300_000); await settle();
  assert.equal(closes, 1); assert.equal(deliveries, 8);
  await stop();
});

test('failed delivery backs off to five minutes, reports only safe codes, and resets after success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let deliveries = 0, fail = true;
  const errors: string[] = [];
  const stop = startRideJobs({ closeRides: async () => {}, deliverEvents: async () => {
    deliveries++; if (fail) throw new Error('synthetic sensitive provider detail');
  } }, code => { errors.push(code); throw new Error('broken log sink'); });
  t.mock.timers.tick(0); await settle();
  assert.equal(deliveries, 1);
  for (const wait of [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]) {
    const previous: number = deliveries;
    t.mock.timers.tick(wait - 1); await settle(); assert.equal(deliveries, previous);
    t.mock.timers.tick(1); await settle(); assert.equal(deliveries, previous + 1);
  }
  assert.deepEqual(errors, Array(8).fill('EVENT_DELIVERY_FAILED'));
  fail = false;
  t.mock.timers.tick(300_000); await settle(); const afterSuccess = deliveries;
  t.mock.timers.tick(10_000); await settle(); assert.equal(deliveries, afterSuccess + 1);
  await stop();
});

test('stopping before startup does not call any job', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const unexpected = async () => { assert.fail('job started after stop'); };
  const stop = startRideJobs({ closeRides: unexpected, deliverEvents: unexpected }, () => {});
  await stop(); t.mock.timers.tick(60_000); await settle();
});
