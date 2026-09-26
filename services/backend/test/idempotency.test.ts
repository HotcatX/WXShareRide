import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withIdempotency } from '../src/db.ts';
import { createTestDatabase } from './helpers/database.ts';

test('real DB: concurrent identical requests commit once; errors roll back without receipt', { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
  const db = await createTestDatabase();
  t.after(db.close);
  const user = (await db.pool.query("INSERT INTO users(app_id,openid) VALUES('test-app','test-user') RETURNING id")).rows[0].id;
  const write = (payload = { name: 'One', amount: 1 }) => withIdempotency(db.pool, user, 'test.update', 'test-key-001', payload, async client => {
    await client.query("UPDATE users SET name=name||'x' WHERE id=$1", [user]);
    return { status: 201, data: { completed: true } };
  });
  const responses = await Promise.all(Array.from({ length: 12 }, () => write()));
  assert.ok(responses.every(response => response.status === 201));
  assert.equal((await db.pool.query('SELECT name FROM users WHERE id=$1', [user])).rows[0].name, 'x');
  const reordered = await write({ amount: 1, name: 'One' });
  assert.deepEqual(reordered, responses[0]);
  await assert.rejects(write({ name: 'One', amount: 2 }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(withIdempotency(db.pool, user, 'test.fail', 'test-key-fail', {}, async client => {
    await client.query("UPDATE users SET name='should roll back' WHERE id=$1", [user]);
    throw new Error('synthetic failure');
  }), /synthetic failure/);
  assert.equal((await db.pool.query('SELECT name FROM users WHERE id=$1', [user])).rows[0].name, 'x');
  assert.equal((await db.pool.query('SELECT count(*) FROM idempotency_requests')).rows[0].count, '1');
  const retry = await withIdempotency(db.pool, user, 'test.fail', 'test-key-fail', {}, async () => ({ status: 200, data: { recovered: true } }));
  assert.equal(retry.data.recovered, true);
  const isolated = await withIdempotency(db.pool, user, 'test.other', 'test-key-001', {}, async () => ({ status: 200, data: { isolated: true } }));
  assert.equal(isolated.data.isolated, true);
});
