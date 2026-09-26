import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import type { Pool } from 'pg';
import { createApp } from '../src/app.ts';
import { createTestDatabase } from './helpers/database.ts';

test('profile HTTP responses stay private and waiting updates preserve timestamp order',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL, timeout: 15000 }, async t => {
    const database = await createTestDatabase();
    const { pool } = database;
    let reached!: (pid: number) => void;
    const locking = new Promise<number>(resolve => { reached = resolve; });
    // Observe transaction scheduling only; authentication and every SQL query
    // still use real PostgreSQL and the application's normal route handler.
    const observedPool = {
      query: pool.query.bind(pool),
      async connect() {
        const client = await pool.connect();
        const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        return {
          async query(sql: string, values?: unknown[]) {
            if (sql.includes('FROM users WHERE id=$1 FOR UPDATE')) reached(pid);
            return client.query(sql, values);
          },
          release() { client.release(); },
        };
      },
    } as unknown as Pool;
    const app = await createApp({
      pool: observedPool,
      config: { databaseUrl: process.env.BACKEND_TEST_DATABASE_URL!, host: '127.0.0.1', port: 3100,
        appId: 'wx1234567890123456', sessionTtlSeconds: 3600 },
      exchange: async code => ({ openid: `private-profile-fixture-${code}` }),
    });
    t.after(async () => { await app.close(); await database.close(); });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { code: 'owner' } });
    const { token, user } = login.json().data;
    const headers = { authorization: `Bearer ${token}`, 'idempotency-key': 'profile.waiting-update' };

    await t.test('a transaction that waits for a newer profile write cannot move updatedAt backwards', async () => {
      const writer = await pool.connect();
      await writer.query('BEGIN');
      await writer.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      const response = app.inject({ method: 'PATCH', url: '/api/v1/me', headers,
        payload: { profile: { phone: 'synthetic-phone' } } }).then(result => result);
      let committedAt = '';
      try {
        const pid = await locking;
        let waiting = false;
        for (let i = 0; i < 200; i++) {
          if ((await pool.query('SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted', [pid])).rowCount) {
            waiting = true;
            break;
          }
          await setTimeout(5);
        }
        assert.equal(waiting, true, 'PATCH must actually wait for the row lock');
        // This update happens after the HTTP transaction started. A later use
        // of now() in that HTTP transaction would restore its older start time.
        const updated = await writer.query<{ updated_at: string }>(`UPDATE users
          SET profile='{"bio":"Concurrent fixture"}'::jsonb, updated_at=clock_timestamp()
          WHERE id=$1 RETURNING updated_at::text`, [user.id]);
        committedAt = updated.rows[0].updated_at;
      } finally {
        await writer.query('COMMIT');
        writer.release();
      }
      const result = await response;
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.headers['cache-control'], 'private, no-store');
      assert.deepEqual(result.json().data.profile, { bio: 'Concurrent fixture', phone: 'synthetic-phone' });
      // Compare in PostgreSQL so JavaScript's millisecond truncation cannot
      // conceal an ordering error between sub-millisecond timestamps.
      const stored = await pool.query('SELECT updated_at >= $2::timestamptz AS monotonic FROM users WHERE id=$1', [user.id, committedAt]);
      assert.equal(stored.rows[0].monotonic, true);
    });

    await t.test('GET and PATCH prevent caching on success, replay, validation errors and unauthorized access', async () => {
      const success = await app.inject({ method: 'GET', url: '/api/v1/me', headers });
      assert.equal(success.statusCode, 200);
      assert.equal(success.headers['cache-control'], 'private, no-store');
      const replay = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers, payload: { profile: { phone: 'synthetic-phone' } } });
      assert.equal(replay.statusCode, 200);
      assert.equal(replay.headers['cache-control'], 'private, no-store');
      const invalid = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers, payload: { unrecognized: 'field' } });
      assert.equal(invalid.statusCode, 400);
      assert.equal(invalid.headers['cache-control'], 'private, no-store');
      for (const method of ['GET', 'PATCH'] as const) {
        const denied = await app.inject({ method, url: '/api/v1/me',
          ...(method === 'PATCH' ? { payload: { name: 'Unauthenticated fixture' } } : {}) });
        assert.equal(denied.statusCode, 401);
        assert.equal(denied.headers['cache-control'], 'private, no-store');
        assert.equal(denied.body.includes('synthetic-phone'), false);
      }
    });
  });
