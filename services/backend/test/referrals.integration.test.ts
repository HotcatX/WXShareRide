import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import type { Pool } from 'pg';
import { ZodError } from 'zod';
import { createApp } from '../src/app.ts';
import { transaction } from '../src/db.ts';
import { bindReferral, ensureReferralCode, getMyReferral } from '../src/referrals/service.ts';
import { createTestDatabase } from './helpers/database.ts';

const errorCode = (code: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code;
const preferredCode = (openid: string) => `ref_${createHash('sha1').update(openid).digest('hex').slice(0, 12)}`;

async function account(pool: Pool, appId = 'referral-fixture') {
  return (await pool.query<{ id: string; openid: string }>(`INSERT INTO users(app_id, openid, profile)
    VALUES ($1, $2, '{"phone":"private-fixture-phone"}'::jsonb) RETURNING id, openid`,
  [appId, `synthetic-openid-${randomUUID()}`])).rows[0]!;
}

// Only scheduling is intercepted. All statements, locks and constraints run
// on real PostgreSQL; the pid allows tests to verify an actual lock wait.
function scheduledPool(pool: Pool, match: (sql: string) => boolean, pauseAfterQuery = false) {
  let reached!: (pid: number) => void;
  const entered = new Promise<number>(resolve => { reached = resolve; });
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  let used = false;
  return { entered, resume, pool: { async connect() {
    const client = await pool.connect();
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    return {
      async query(sql: string, values?: unknown[]) {
        const selected = !used && match(sql);
        if (selected) { used = true; if (!pauseAfterQuery) reached(pid); }
        const result = await client.query(sql, values);
        if (selected && pauseAfterQuery) { reached(pid); await gate; }
        return result;
      },
      release() { client.release(); },
    };
  } } as unknown as Pool };
}

async function assertWaiting(pool: Pool, pid: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await pool.query('SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted', [pid])).rowCount) return;
    await setTimeout(5);
  }
  assert.fail('Expected the competing transaction to wait on a PostgreSQL lock');
}

test('referrals preserve stable public codes and immutable first bindings',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL, timeout: 30000 }, async t => {
    const database = await createTestDatabase();
    const { pool } = database;
    t.after(database.close);

    await t.test('allocation uses the legacy deterministic value and serializes concurrent requests for one owner', async () => {
      const user = await account(pool);
      const first = scheduledPool(pool, sql => sql.startsWith('INSERT INTO referral_codes'), true);
      const second = scheduledPool(pool, sql => sql.includes('FOR NO KEY UPDATE'));
      const creating = transaction(first.pool, client => ensureReferralCode(client, user.id));
      await first.entered;
      const following = transaction(second.pool, client => ensureReferralCode(client, user.id.toUpperCase()));
      try { await assertWaiting(pool, await second.entered); }
      finally { first.resume(); }
      assert.equal(await creating, preferredCode(user.openid));
      assert.equal(await following, preferredCode(user.openid));
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM referral_codes WHERE user_id=$1', [user.id])).rows[0].count, 1);
    });

    await t.test('a global code collision never overwrites its owner and the random fallback remains stable', async () => {
      const [existing, newcomer] = await Promise.all([account(pool, 'another-app'), account(pool)]);
      const collision = preferredCode(newcomer.openid);
      await pool.query('INSERT INTO referral_codes(user_id, code) VALUES ($1, $2)', [existing.id, collision]);
      const issued = await transaction(pool, client => ensureReferralCode(client, newcomer.id));
      assert.match(issued, /^ref_[a-f0-9]{12}$/);
      assert.notEqual(issued, collision);
      assert.equal(await transaction(pool, client => ensureReferralCode(client, newcomer.id)), issued);
      assert.equal(await transaction(pool, client => ensureReferralCode(client, existing.id)), collision);
      const owners = await pool.query('SELECT user_id FROM referral_codes WHERE code=$1', [collision]);
      assert.equal(owners.rows[0].user_id, existing.id);
    });

    await t.test('allocation participates in the caller transaction and cannot fabricate an absent user', async () => {
      const user = await account(pool);
      await assert.rejects(transaction(pool, async client => {
        await ensureReferralCode(client, user.id);
        throw new Error('Synthetic caller failure');
      }), /Synthetic caller failure/);
      assert.equal((await pool.query('SELECT 1 FROM referral_codes WHERE user_id=$1', [user.id])).rowCount, 0);
      await assert.rejects(transaction(pool, client => ensureReferralCode(client, randomUUID())), errorCode('UNAUTHORIZED'));
    });

    await t.test('same-key replay and same-referrer no-op cannot rewrite the first binding or its timestamp', async () => {
      const [referrer, referred, other] = await Promise.all([account(pool), account(pool), account(pool)]);
      const [{ code }, { code: otherCode }] = await Promise.all([getMyReferral(pool, referrer.id), getMyReferral(pool, other.id)]);
      const first = await bindReferral(pool, referred.id, 'binding-first', { code });
      assert.deepEqual(first, { status: 200, data: { changed: true } });
      assert.deepEqual(await bindReferral(pool, referred.id, 'binding-first', { code }), first);
      const original = (await pool.query('SELECT referrer_user_id, bound_at::text FROM referral_bindings WHERE referred_user_id=$1', [referred.id])).rows[0];
      assert.deepEqual(await bindReferral(pool, referred.id, 'binding-repeat', { code }), { status: 200, data: { changed: false } });
      await assert.rejects(bindReferral(pool, referred.id, 'binding-first', { code: otherCode }), errorCode('IDEMPOTENCY_CONFLICT'));
      await assert.rejects(bindReferral(pool, referred.id, 'binding-different', { code: otherCode }), errorCode('REFERRAL_ALREADY_BOUND'));
      assert.deepEqual((await pool.query('SELECT referrer_user_id, bound_at::text FROM referral_bindings WHERE referred_user_id=$1', [referred.id])).rows[0], original);
      assert.deepEqual(await getMyReferral(pool, referrer.id), { code, referralCount: 1 });
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM idempotency_requests WHERE user_id=$1', [referred.id])).rows[0].count, 2);
    });

    await t.test('different concurrent invitations wait for the first transaction and cannot replace its winner', async () => {
      const [referrer, alternate, referred] = await Promise.all([account(pool), account(pool), account(pool)]);
      const [{ code }, { code: otherCode }] = await Promise.all([getMyReferral(pool, referrer.id), getMyReferral(pool, alternate.id)]);
      const first = scheduledPool(pool, sql => sql.startsWith('INSERT INTO referral_bindings'), true);
      const second = scheduledPool(pool, sql => sql.includes('FOR NO KEY UPDATE'));
      const winner = bindReferral(first.pool, referred.id, 'race-first-binding', { code });
      await first.entered;
      const loser = assert.rejects(bindReferral(second.pool, referred.id, 'race-other-binding', { code: otherCode }), errorCode('REFERRAL_ALREADY_BOUND'));
      try { await assertWaiting(pool, await second.entered); }
      finally { first.resume(); }
      assert.equal((await winner).data.changed, true);
      await loser;
      assert.equal((await getMyReferral(pool, referrer.id)).referralCount, 1);
      assert.equal((await getMyReferral(pool, alternate.id)).referralCount, 0);
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM idempotency_requests WHERE user_id=$1', [referred.id])).rows[0].count, 1);
    });

    await t.test('concurrent same-key bindings write one fact and one receipt', async () => {
      const [referrer, referred] = await Promise.all([account(pool), account(pool)]);
      const { code } = await getMyReferral(pool, referrer.id);
      const results = await Promise.all(Array.from({ length: 4 }, () => bindReferral(pool, referred.id, 'parallel-same-key', { code })));
      for (const result of results) assert.deepEqual(result, { status: 200, data: { changed: true } });
      assert.equal((await getMyReferral(pool, referrer.id)).referralCount, 1);
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM idempotency_requests WHERE user_id=$1', [referred.id])).rows[0].count, 1);
    });

    await t.test('mutual first bindings do not deadlock through users foreign-key locks', async () => {
      const [a, b] = await Promise.all([account(pool), account(pool)]);
      const [aReferral, bReferral] = await Promise.all([getMyReferral(pool, a.id), getMyReferral(pool, b.id)]);
      const first = scheduledPool(pool, sql => sql.includes('FOR NO KEY UPDATE'), true);
      const second = scheduledPool(pool, sql => sql.includes('FOR NO KEY UPDATE'), true);
      const bindingA = bindReferral(first.pool, a.id, 'mutual-first-a', { code: bReferral.code });
      const bindingB = bindReferral(second.pool, b.id, 'mutual-first-b', { code: aReferral.code });
      try { await Promise.all([first.entered, second.entered]); }
      finally { first.resume(); second.resume(); }
      const results = await Promise.all([bindingA, bindingB]);
      assert.equal(results.every(result => result.data.changed), true);
      assert.equal((await getMyReferral(pool, a.id)).referralCount, 1);
      assert.equal((await getMyReferral(pool, b.id)).referralCount, 1);
    });

    await t.test('invalid input, unknown or cross-app codes and self-referral leave no bindings or receipts', async () => {
      const [actor, other, foreign] = await Promise.all([account(pool), account(pool), account(pool, 'foreign-app')]);
      const [own, valid, foreignReferral] = await Promise.all([getMyReferral(pool, actor.id), getMyReferral(pool, other.id), getMyReferral(pool, foreign.id)]);
      await assert.rejects(bindReferral(pool, actor.id, 'self-binding', { code: own.code }), errorCode('CANNOT_REFER_SELF'));
      await assert.rejects(bindReferral(pool, actor.id, 'foreign-binding', { code: foreignReferral.code }), errorCode('REFERRAL_CODE_NOT_FOUND'));
      const unknown = preferredCode('missing-synthetic-identity');
      await assert.rejects(bindReferral(pool, actor.id, 'unknown-binding', { code: unknown }), errorCode('REFERRAL_CODE_NOT_FOUND'));
      await assert.rejects(bindReferral(pool, actor.id, undefined, { code: valid.code }), errorCode('IDEMPOTENCY_KEY_REQUIRED'));
      for (const input of [{ code: valid.code, userId: other.id }, { referralCode: valid.code }, { code: valid.code.toUpperCase() },
        { code: ` ${valid.code}` }, { code: `${valid.code}\n` }]) {
        await assert.rejects(bindReferral(pool, actor.id, 'invalid-binding', input), error => error instanceof ZodError);
      }
      assert.equal((await pool.query('SELECT 1 FROM referral_bindings WHERE referred_user_id=$1', [actor.id])).rowCount, 0);
      assert.equal((await pool.query('SELECT 1 FROM idempotency_requests WHERE user_id=$1', [actor.id])).rowCount, 0);
    });

    await t.test('a receipt write failure rolls back the binding as well', async () => {
      const [referrer, referred] = await Promise.all([account(pool), account(pool)]);
      const { code } = await getMyReferral(pool, referrer.id);
      await pool.query(`CREATE FUNCTION reject_referral_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END $$`);
      await pool.query(`CREATE TRIGGER fail_referral_receipt BEFORE INSERT ON idempotency_requests
        FOR EACH ROW EXECUTE FUNCTION reject_referral_receipt()`);
      try { await assert.rejects(bindReferral(pool, referred.id, 'failed-binding', { code }), /synthetic receipt failure/); }
      finally { await pool.query('DROP TRIGGER fail_referral_receipt ON idempotency_requests'); }
      assert.equal((await pool.query('SELECT 1 FROM referral_bindings WHERE referred_user_id=$1', [referred.id])).rowCount, 0);
      assert.equal((await getMyReferral(pool, referrer.id)).referralCount, 0);
      assert.equal((await bindReferral(pool, referred.id, 'failed-binding', { code })).data.changed, true);
    });

    await t.test('database constraints preserve code uniqueness, owner existence and non-self bindings', async () => {
      const [a, b] = await Promise.all([account(pool), account(pool)]);
      await assert.rejects(pool.query('INSERT INTO referral_codes(user_id,code) VALUES ($1,$2)', [a.id, 'invalid-code']), errorCode('23514'));
      const { code } = await getMyReferral(pool, a.id);
      await assert.rejects(pool.query('INSERT INTO referral_codes(user_id,code) VALUES ($1,$2)', [b.id, code]), errorCode('23505'));
      await assert.rejects(pool.query('INSERT INTO referral_codes(user_id,code) VALUES ($1,$2)', [randomUUID(), preferredCode('absent-fixture')]), errorCode('23503'));
      await assert.rejects(pool.query('INSERT INTO referral_bindings(referred_user_id,referrer_user_id) VALUES ($1,$1)', [a.id]), errorCode('23514'));
    });

    await t.test('HTTP routes use authenticated identity, private responses and a bounded owner-only projection', async () => {
      const app = await createApp({ pool,
        config: { databaseUrl: process.env.BACKEND_TEST_DATABASE_URL!, host: '127.0.0.1', port: 3100,
          appId: 'wx1234567890123456', sessionTtlSeconds: 3600 },
        exchange: async code => ({ openid: `private-referral-fixture-${code}` }),
      });
      try {
        const logins = await Promise.all(['referrer', 'referred'].map(code => app.inject({ method: 'POST',
          url: '/api/v1/auth/login', payload: { code } })));
        const [owner, referred] = logins.map(result => result.json().data);
        const headers = { authorization: `Bearer ${owner.token}` };
        const own = await app.inject({ method: 'GET', url: '/api/v1/referrals/me', headers });
        assert.equal(own.statusCode, 200, own.body);
        assert.deepEqual(Object.keys(own.json().data).sort(), ['code', 'referralCount']);
        assert.equal(own.json().data.referralCount, 0);
        const bound = await app.inject({ method: 'POST', url: '/api/v1/referrals/bind',
          headers: { authorization: `Bearer ${referred.token}`, 'idempotency-key': 'http-bind-fixture' }, payload: { code: own.json().data.code } });
        assert.equal(bound.statusCode, 200, bound.body);
        assert.deepEqual(bound.json().data, { changed: true });
        const counted = await app.inject({ method: 'GET', url: '/api/v1/referrals/me', headers });
        assert.equal(counted.json().data.referralCount, 1);
        for (const secret of [referred.user.id, owner.user.id, 'private-referral-fixture', referred.token]) {
          assert.equal(counted.body.includes(secret), false);
        }
        const forbiddenQuery = await app.inject({ method: 'GET', url: `/api/v1/referrals/me?userId=${referred.user.id}`, headers });
        assert.equal(forbiddenQuery.statusCode, 400);
        const noKey = await app.inject({ method: 'POST', url: '/api/v1/referrals/bind', headers,
          payload: { code: own.json().data.code } });
        assert.equal(noKey.statusCode, 400);
        assert.equal(noKey.json().error.code, 'IDEMPOTENCY_KEY_REQUIRED');
        for (const [method, url] of [['GET', '/api/v1/referrals/me'], ['POST', '/api/v1/referrals/bind']] as const) {
          const denied = await app.inject({ method, url, ...(method === 'POST' ? { payload: { code: own.json().data.code } } : {}) });
          assert.equal(denied.statusCode, 401);
          assert.equal(denied.headers['cache-control'], 'private, no-store');
        }
        for (const response of [own, bound, counted, forbiddenQuery, noKey]) {
          assert.equal(response.headers['cache-control'], 'private, no-store');
        }
      } finally { await app.close(); }
    });
  });
