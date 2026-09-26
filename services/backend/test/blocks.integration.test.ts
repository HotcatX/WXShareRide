import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import type { Pool } from 'pg';
import { createTestDatabase } from './helpers/database.ts';
import { blockUser, listBlocks, lockBlockPairs, unblockUser } from '../src/blocks/service.ts';
import { createRide, joinRide, leaveRide } from '../src/rides/service.ts';

const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
const tripId = (result: { data: object }) => (result.data as { rideId: string }).rideId;
const passenger = { role: 'passenger', seatCount: 1 };

async function account(pool: Pool, appId = 'blocks-fixture') {
  return (await pool.query<{ id: string; openid: string }>(`INSERT INTO users(app_id, openid, name, avatar_url, profile)
    VALUES ($1, $2, 'Fixture person', 'https://example.invalid/avatar.png',
      '{"wechatId":"fixture-wechat","phone":"private-phone","secret":"private-profile"}'::jsonb)
    RETURNING id, openid`, [appId, `private-openid-${randomUUID()}`])).rows[0];
}

async function ride(pool: Pool, creatorId: string, kind = 'offer') {
  return tripId(await createRide(pool, creatorId, randomUUID(), {
    kind, cityKey: 'ny_nj', timeZone: 'America/New_York',
    departureAt: new Date(Date.now() + 86400000).toISOString(),
    origin: { address: 'Synthetic origin' }, destination: { address: 'Synthetic destination' },
    listedPriceCents: 1200, ...(kind === 'offer' ? { seatCapacity: 4 } : { partySize: 1 }),
  }));
}

// Only transaction scheduling is intercepted; every query and constraint runs
// on the real PostgreSQL fixture. The exposed pid lets us verify actual waiting.
function scheduledPool(pool: Pool, match: (sql: string, values: unknown[]) => boolean, pause: boolean) {
  let reached!: (pid: number) => void;
  const entered = new Promise<number>(resolve => { reached = resolve; });
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  let used = false;
  const scheduled = { async connect() {
    const client = await pool.connect();
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    return {
      async query(sql: string, values: unknown[] = []) {
        const selected = !used && match(sql, values);
        if (selected) {
          used = true;
          if (!pause) reached(pid);
        }
        const result = await client.query(sql, values);
        if (selected && pause) { reached(pid); await gate; }
        return result;
      },
      release() { client.release(); },
    };
  } } as unknown as Pool;
  return { pool: scheduled, entered, resume };
}

const pairLock = (sql: string, values: unknown[]) => sql.includes('pg_advisory_xact_lock') &&
  typeof values[0] === 'string' && values[0].includes('user-block-pair');

async function assertWaitingForPair(pool: Pool, pid: number) {
  for (let i = 0; i < 200; i++) {
    const result = await pool.query(`SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted`, [pid]);
    if (result.rowCount) return;
    await setTimeout(5);
  }
  assert.fail('Expected an actual PostgreSQL wait on the competing block pair');
}

test('user blocks preserve relationship semantics and serialize with ride joins',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL, timeout: 30000 }, async t => {
    const database = await createTestDatabase();
    const { pool } = database;
    t.after(database.close);

    await t.test('writes are idempotent; only the owner sees outgoing blocks and approved target fields', async () => {
      const [a, b, c] = await Promise.all([account(pool), account(pool), account(pool)]);
      const input = { targetUserId: b.id.toUpperCase(), reason: 'Scheduling mismatch' };
      const first = await blockUser(pool, a.id, 'block-fixture', input);
      assert.deepEqual(await blockUser(pool, a.id, 'block-fixture', input), first);
      await assert.rejects(blockUser(pool, a.id, 'block-fixture', { ...input, reason: 'Changed content' }), code('IDEMPOTENCY_CONFLICT'));
      await blockUser(pool, c.id, 'incoming-fixture', { targetUserId: a.id, reason: 'Incoming private reason' });
      const list = await listBlocks(pool, a.id, {});
      assert.equal(list.blocks.length, 1);
      assert.equal(list.blocks[0].targetUserId, b.id);
      assert.equal(list.blocks[0].wechatId, 'fixture-wechat');
      assert.deepEqual(Object.keys(list.blocks[0]).sort(), ['targetUserId', 'name', 'avatarUrl', 'wechatId', 'reason', 'blockedAt', 'updatedAt'].sort());
      const serialized = JSON.stringify(list);
      for (const secret of [a.openid, b.openid, c.id, 'private-phone', 'private-profile', 'Incoming private reason']) assert.equal(serialized.includes(secret), false);
      assert.equal((await listBlocks(pool, b.id, {})).blocks.length, 0);
      await blockUser(pool, a.id, 'reason-update', { targetUserId: b.id, reason: 'Updated reason' });
      const updated = (await listBlocks(pool, a.id, {})).blocks[0];
      assert.equal(updated.reason, 'Updated reason');
      assert.deepEqual(updated.blockedAt, list.blocks[0].blockedAt);
      assert.ok(updated.updatedAt >= updated.blockedAt);
      assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM user_blocks WHERE blocker_id=$1`, [a.id])).rows[0].count, 1);
    });

    await t.test('invalid targets, actor aliases and keys cannot write blocks or receipts', async () => {
      const [a, b, foreign] = await Promise.all([account(pool), account(pool), account(pool, 'another-app')]);
      await assert.rejects(blockUser(pool, a.id, 'self-fixture', { targetUserId: a.id.toUpperCase() }), code('CANNOT_BLOCK_SELF'));
      await assert.rejects(blockUser(pool, a.id, 'missing-fixture', { targetUserId: randomUUID() }), code('USER_NOT_FOUND'));
      await assert.rejects(blockUser(pool, a.id, 'foreign-fixture', { targetUserId: foreign.id }), code('USER_NOT_FOUND'));
      await assert.rejects(blockUser(pool, a.id, 'alias-fixture', { targetUserId: b.id, _openid: b.openid }));
      await assert.rejects(blockUser(pool, a.id, undefined, { targetUserId: b.id }), code('IDEMPOTENCY_KEY_REQUIRED'));
      await assert.rejects(unblockUser(pool, a.id, undefined, b.id), code('IDEMPOTENCY_KEY_REQUIRED'));
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM user_blocks WHERE blocker_id=$1', [a.id])).rows[0].count, 0);
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM idempotency_requests WHERE user_id=$1', [a.id])).rows[0].count, 0);
    });

    await t.test('either direction blocks a new offer join; unblock only clears the actor’s direction', async () => {
      const [driver, rider] = await Promise.all([account(pool), account(pool)]);
      const id = await ride(pool, driver.id);
      await blockUser(pool, driver.id, 'driver-block', { targetUserId: rider.id });
      await assert.rejects(joinRide(pool, rider.id, 'join-blocked', id, passenger), code('USER_BLOCKED'));
      await blockUser(pool, rider.id, 'rider-block', { targetUserId: driver.id });
      await unblockUser(pool, driver.id, 'driver-unblock', rider.id);
      await assert.rejects(joinRide(pool, rider.id, 'join-blocked', id, passenger), code('USER_BLOCKED'));
      const result = await unblockUser(pool, rider.id, 'rider-unblock', driver.id);
      assert.equal(result.data.changed, true);
      assert.deepEqual(await unblockUser(pool, rider.id, 'rider-unblock', driver.id), result);
      assert.equal((await unblockUser(pool, rider.id, 'unblock-again', driver.id)).data.changed, false);
      // A replay of an old successful block is a response replay, not a re-block.
      await blockUser(pool, rider.id, 'rider-block', { targetUserId: driver.id });
      assert.equal((await joinRide(pool, rider.id, 'join-blocked', id, passenger)).data.changed, true);
    });

    await t.test('joining passengers and accepting request drivers check every current participant', async () => {
      for (const kind of ['offer', 'request']) {
        const [creator, existing, newcomer] = await Promise.all([account(pool), account(pool), account(pool)]);
        const id = await ride(pool, creator.id, kind);
        await joinRide(pool, existing.id, 'existing-join', id, passenger);
        await blockUser(pool, existing.id, 'member-block', { targetUserId: newcomer.id });
        const role = kind === 'offer' ? passenger : { role: 'driver' };
        await assert.rejects(joinRide(pool, newcomer.id, 'newcomer-join', id, role), code('USER_BLOCKED'));
        assert.equal((await pool.query('SELECT count(*)::integer AS count FROM ride_members WHERE ride_id=$1 AND user_id=$2', [id, newcomer.id])).rows[0].count, 0);
        assert.equal((await pool.query('SELECT version FROM rides WHERE id=$1', [id])).rows[0].version, 2);
      }
    });

    await t.test('a later block keeps existing membership; leaving works and a new join is blocked', async () => {
      const [creator, rider] = await Promise.all([account(pool), account(pool)]);
      const id = await ride(pool, creator.id);
      await joinRide(pool, rider.id, 'first-join', id, passenger);
      await blockUser(pool, creator.id, 'later-block', { targetUserId: rider.id });
      assert.equal((await joinRide(pool, rider.id, 'duplicate-join', id, passenger)).data.changed, false);
      await leaveRide(pool, rider.id, 'leave-fixture', id, {});
      await assert.rejects(joinRide(pool, rider.id, 'rejoin-fixture', id, passenger), code('USER_BLOCKED'));
      const events = await pool.query('SELECT action FROM business_events WHERE ride_id=$1 ORDER BY ride_version', [id]);
      assert.deepEqual(events.rows.map(row => row.action), ['created', 'joined', 'left']);
    });

    await t.test('request passengers respect the accepting driver’s block until that driver leaves', async () => {
      const [creator, driver, rider] = await Promise.all([account(pool), account(pool), account(pool)]);
      const id = await ride(pool, creator.id, 'request');
      await joinRide(pool, driver.id, 'accept-fixture', id, { role: 'driver' });
      await blockUser(pool, driver.id, 'driver-block-fixture', { targetUserId: rider.id });
      await assert.rejects(joinRide(pool, rider.id, 'request-passenger', id, passenger), code('USER_BLOCKED'));
      await leaveRide(pool, driver.id, 'driver-leave-fixture', id, {});
      assert.equal((await joinRide(pool, rider.id, 'request-passenger', id, passenger)).data.changed, true);
    });

    await t.test('a block that locks first commits before a waiting join checks the pair', async () => {
      const [creator, rider] = await Promise.all([account(pool), account(pool)]);
      const id = await ride(pool, creator.id);
      const blocking = scheduledPool(pool, sql => sql.startsWith('INSERT INTO user_blocks'), true);
      const joining = scheduledPool(pool, pairLock, false);
      const blocked = blockUser(blocking.pool, creator.id, 'concurrent-block', { targetUserId: rider.id });
      await blocking.entered;
      const joined = joinRide(joining.pool, rider.id, 'concurrent-join', id, passenger);
      const denied = assert.rejects(joined, code('USER_BLOCKED'));
      try { await assertWaitingForPair(pool, await joining.entered); }
      finally { blocking.resume(); }
      await blocked;
      await denied;
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM ride_members WHERE ride_id=$1', [id])).rows[0].count, 1);
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM business_events WHERE ride_id=$1', [id])).rows[0].count, 1);
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM idempotency_requests WHERE user_id=$1', [rider.id])).rows[0].count, 0);
    });

    await t.test('a join that locks first commits before a waiting block, with no retroactive removal', async () => {
      const [creator, rider] = await Promise.all([account(pool), account(pool)]);
      const id = await ride(pool, creator.id);
      const joining = scheduledPool(pool, sql => sql.startsWith('INSERT INTO ride_members'), true);
      const blocking = scheduledPool(pool, pairLock, false);
      const joined = joinRide(joining.pool, rider.id, 'join-first-fixture', id, passenger);
      await joining.entered;
      const blocked = blockUser(blocking.pool, creator.id, 'block-after-join', { targetUserId: rider.id });
      try { await assertWaitingForPair(pool, await blocking.entered); }
      finally { joining.resume(); }
      await joined;
      await blocked;
      assert.equal((await pool.query(`SELECT state FROM ride_members WHERE ride_id=$1 AND user_id=$2`, [id, rider.id])).rows[0].state, 'active');
      const nextRide = await ride(pool, creator.id);
      await assert.rejects(joinRide(pool, rider.id, 'join-next-fixture', nextRide, passenger), code('USER_BLOCKED'));
    });

    await t.test('a join waits for a concurrent unblock and then reads the committed state', async () => {
      const [creator, rider] = await Promise.all([account(pool), account(pool)]);
      const id = await ride(pool, creator.id);
      await blockUser(pool, creator.id, 'initial-block', { targetUserId: rider.id });
      const unblocking = scheduledPool(pool, sql => sql.startsWith('UPDATE user_blocks'), true);
      const joining = scheduledPool(pool, pairLock, false);
      const unblocked = unblockUser(unblocking.pool, creator.id, 'unblock-first', rider.id);
      await unblocking.entered;
      const joined = joinRide(joining.pool, rider.id, 'join-after-unblock', id, passenger);
      try { await assertWaitingForPair(pool, await joining.entered); }
      finally { unblocking.resume(); }
      await unblocked;
      assert.equal((await joined).data.changed, true);
    });

    await t.test('unrelated pairs keep running while another pair has an open transaction', async () => {
      const [a, b, c, d] = await Promise.all([account(pool), account(pool), account(pool), account(pool)]);
      const blocking = scheduledPool(pool, sql => sql.startsWith('INSERT INTO user_blocks'), true);
      const first = blockUser(blocking.pool, a.id, 'independent-first', { targetUserId: b.id });
      await blocking.entered;
      try {
        const result = await blockUser(pool, c.id, 'independent-other', { targetUserId: d.id });
        assert.equal(result.data.active, true);
      } finally { blocking.resume(); }
      await first;
    });

    await t.test('joins on different rides acquire a shared pair in one direction without deadlock', async () => {
      const users = await Promise.all([account(pool), account(pool), account(pool)]);
      const [a, b, c] = users.sort((left, right) => left.id.localeCompare(right.id));
      const [firstRide, secondRide] = await Promise.all([ride(pool, b.id), ride(pool, a.id)]);
      await joinRide(pool, c.id, 'member-first-ride', firstRide, passenger);
      await joinRide(pool, c.id, 'member-second-ride', secondRide, passenger);
      const firstSchedule = scheduledPool(pool, pairLock, true);
      const secondSchedule = scheduledPool(pool, pairLock, false);
      const first = joinRide(firstSchedule.pool, a.id, 'shared-pair-first', firstRide, passenger);
      await firstSchedule.entered;
      const second = joinRide(secondSchedule.pool, b.id, 'shared-pair-second', secondRide, passenger);
      try { await assertWaitingForPair(pool, await secondSchedule.entered); }
      finally { firstSchedule.resume(); }
      assert.equal((await first).data.changed, true);
      assert.equal((await second).data.changed, true);
    });

    await t.test('reverse-direction concurrent block requests both commit without duplicate rows', async () => {
      const [a, b] = await Promise.all([account(pool), account(pool)]);
      await Promise.all([
        blockUser(pool, a.id, 'forward-block', { targetUserId: b.id }),
        blockUser(pool, b.id, 'reverse-block', { targetUserId: a.id }),
        blockUser(pool, a.id, 'forward-block', { targetUserId: b.id }),
      ]);
      assert.equal((await listBlocks(pool, a.id, {})).blocks.length, 1);
      assert.equal((await listBlocks(pool, b.id, {})).blocks.length, 1);
      assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM idempotency_requests WHERE user_id=ANY($1::uuid[])`, [[a.id, b.id]])).rows[0].count, 2);
    });

    await t.test('a failed block transaction cannot leave an effective block or successful receipt', async () => {
      const [a, b] = await Promise.all([account(pool), account(pool)]);
      await pool.query(`CREATE FUNCTION reject_fixture_block() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic write failure'; END $$`);
      await pool.query('CREATE TRIGGER fail_block BEFORE INSERT ON user_blocks FOR EACH ROW EXECUTE FUNCTION reject_fixture_block()');
      try { await assert.rejects(blockUser(pool, a.id, 'failed-block', { targetUserId: b.id })); }
      finally { await pool.query('DROP TRIGGER fail_block ON user_blocks'); }
      assert.equal((await listBlocks(pool, a.id, {})).blocks.length, 0);
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM idempotency_requests WHERE user_id=$1', [a.id])).rows[0].count, 0);
      const id = await ride(pool, a.id);
      assert.equal((await joinRide(pool, b.id, 'join-after-failure', id, passenger)).data.changed, true);
    });

    await t.test('outgoing lists paginate independently and never advertise an invalid page', async () => {
      const [a, b, c] = await Promise.all([account(pool), account(pool), account(pool)]);
      await blockUser(pool, a.id, 'pagination-first', { targetUserId: b.id });
      await blockUser(pool, a.id, 'pagination-second', { targetUserId: c.id });
      const first = await listBlocks(pool, a.id, { limit: 1 });
      const second = await listBlocks(pool, a.id, { limit: 1, page: first.nextPage });
      assert.equal(first.nextPage, 2);
      assert.equal(second.nextPage, null);
      assert.notEqual(first.blocks[0].targetUserId, second.blocks[0].targetUserId);
      assert.equal((await listBlocks(pool, a.id, { page: 1000 })).nextPage, null);
    });
  });

test('pair locks use canonical case, no self lock, one lock per pair and a fixed order', async () => {
  const actor = randomUUID();
  const others = [randomUUID(), randomUUID(), randomUUID()];
  const calls: unknown[] = [];
  const client = { async query(_sql: string, values: unknown[]) { calls.push(values[0]); } };
  await lockBlockPairs(client as never, actor, [...others, actor, others[0].toUpperCase()]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls, [...calls].sort());
  const reversed: unknown[] = [];
  await lockBlockPairs({ async query(_sql: string, values: unknown[]) { reversed.push(values[0]); } } as never,
    actor.toUpperCase(), [...others].reverse());
  assert.deepEqual(reversed, calls);
});
