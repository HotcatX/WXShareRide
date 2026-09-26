import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoginAdmission } from '../src/auth/admission.ts';
import { AppError } from '../src/errors.ts';

const errorCode = (status: number, code: string) => (error: unknown) =>
  error instanceof AppError && error.status === status && error.code === code;
function deferred() {
  let resolve!: (value: number) => void;
  const promise = new Promise<number>(done => { resolve = done; });
  return { promise, resolve };
}
const address = (index: number) => `10.${Math.floor(index / 65536)}.${Math.floor(index / 256) % 256}.${index % 256}`;

test('32 simultaneous login attempts execute only eight exchanges, then release every slot', async () => {
  const admission = createLoginAdmission({ now: () => 0 });
  const pending = Array.from({ length: 8 }, deferred);
  let calls = 0;
  const results = Promise.allSettled(Array.from({ length: 32 }, () => admission.run('127.0.0.1', () => pending[calls++]!.promise)));
  assert.equal(calls, 8);
  pending.forEach((held, index) => held.resolve(index));
  const settled = await results;
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 8);
  assert.equal(settled.filter(result => result.status === 'rejected' && errorCode(503, 'LOGIN_BUSY')(result.reason)).length, 24);
  assert.equal(await admission.run('127.0.0.1', async () => 9), 9);
});

test('one source gets 60 attempts per 60-second window, independently of another source', async () => {
  let now = 1000, calls = 0;
  const admission = createLoginAdmission({ now: () => now });
  const work = async () => ++calls;
  for (let index = 0; index < 60; index++) await admission.run('127.0.0.1', work);
  await assert.rejects(admission.run('127.0.0.1', work), errorCode(429, 'RATE_LIMITED'));
  assert.equal(calls, 60);
  await admission.run('127.0.0.2', work);
  now = 60_999;
  await assert.rejects(admission.run('127.0.0.1', work), errorCode(429, 'RATE_LIMITED'));
  now = 61_000;
  await admission.run('127.0.0.1', work);
  assert.equal(calls, 62);
});

test('source tracking stops at 1024 buckets and expires only old buckets', async () => {
  let now = 0, calls = 0;
  const admission = createLoginAdmission({ now: () => now });
  const work = async () => ++calls;
  for (let index = 0; index < 512; index++) await admission.run(address(index), work);
  now = 30_000;
  for (let index = 512; index < 1024; index++) await admission.run(address(index), work);
  await assert.rejects(admission.run(address(1024), work), errorCode(503, 'LOGIN_BUSY'));
  assert.equal(calls, 1024);
  await admission.run(address(0), work); // A full map still serves existing sources.
  now = 60_000;
  for (let index = 1024; index < 1536; index++) await admission.run(address(index), work);
  await assert.rejects(admission.run(address(1536), work), errorCode(503, 'LOGIN_BUSY'));
  now = 90_000;
  await admission.run(address(1536), work);
});

test('clock rollback resets stale rate windows without releasing active exchanges', async () => {
  let now = 120_000;
  const admission = createLoginAdmission({ now: () => now });
  for (let index = 0; index < 60; index++) await admission.run('127.0.0.1', async () => 1);
  const pending = Array.from({ length: 8 }, deferred);
  const active = pending.map((held, index) => admission.run(address(index), () => held.promise));
  now = 1;
  let called = false;
  await assert.rejects(admission.run('127.0.0.1', async () => { called = true; return 1; }), errorCode(503, 'LOGIN_BUSY'));
  assert.equal(called, false);
  pending.forEach(held => held.resolve(1));
  await Promise.all(active);
  assert.equal(await admission.run('127.0.0.1', async () => 2), 2);
});

test('synchronous and asynchronous failures release slots and still consume attempt budgets', async () => {
  const admission = createLoginAdmission({ now: () => 0 });
  const expected = new Error('synthetic exchange failure');
  let calls = 0;
  for (let index = 0; index < 60; index++) {
    const work = index % 2 === 0
      ? () => { calls++; throw expected; }
      : async () => { calls++; throw expected; };
    await assert.rejects(admission.run('127.0.0.1', work), error => error === expected);
  }
  await assert.rejects(admission.run('127.0.0.1', async () => { calls++; return 1; }), errorCode(429, 'RATE_LIMITED'));
  assert.equal(calls, 60);
  assert.equal(await admission.run('127.0.0.2', async () => 2), 2);
});

test('invalid clocks and overlong keys fail closed without poisoning subsequent requests', async () => {
  let now = NaN, called = false;
  const admission = createLoginAdmission({ now: () => now });
  const work = async () => { called = true; return 1; };
  await assert.rejects(admission.run('127.0.0.1', work), errorCode(503, 'LOGIN_BUSY'));
  now = 0;
  await assert.rejects(admission.run('x'.repeat(65), work), errorCode(400, 'INVALID_CLIENT_ADDRESS'));
  assert.equal(called, false);
  assert.equal(await admission.run('127.0.0.1', work), 1);
});
