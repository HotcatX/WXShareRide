import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { ZodError } from 'zod';
import { AppError } from '../src/errors.ts';
import { sessionService } from '../src/auth/session.ts';
import { rateRide, listMyRideRatings } from '../src/ratings/service.ts';
import { registerRatingRoutes } from '../src/ratings/routes.ts';
import { createTestDatabase } from './helpers/database.ts';

const enabled = { skip: !process.env.BACKEND_TEST_DATABASE_URL };
const hasCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
const account = async (pool: Pool) => (await pool.query(
  "INSERT INTO users(app_id,openid) VALUES ('ratings-test',$1) RETURNING id", [randomUUID()])).rows[0].id as string;

async function fixture(pool: Pool, kind: 'offer' | 'request' = 'offer', existing?: string[]) {
  const [driver, passenger, otherPassenger, stranger] = existing ?? await Promise.all(Array.from({ length: 4 }, () => account(pool)));
  const rideId = randomUUID();
  await pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone,details)
    VALUES($1,$2,$3,'ny_nj','closed',3,clock_timestamp()-interval '2 hours','America/New_York','{}')`,
  [rideId, kind, kind === 'offer' ? driver : passenger]);
  await pool.query(`INSERT INTO ride_stops(ride_id,position,kind,address,departure_at) VALUES
    ($1,0,'departure','Fort Lee',clock_timestamp()-interval '2 hours'),
    ($1,1,'departure','Inwood',clock_timestamp()-interval '1 hour'),
    ($1,2,'destination','Columbia',NULL)`, [rideId]);
  await pool.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state,details) VALUES
    ($1,$2,'driver',0,'active','{"privateContact":"driver-private"}'),
    ($1,$3,'passenger',1,'active','{"pickupAddress":"Private pickup"}'),
    ($1,$4,'passenger',1,'active','{}')`, [rideId, driver, passenger, otherPassenger]);
  return { rideId, driver: driver!, passenger: passenger!, otherPassenger: otherPassenger!, stranger: stranger! };
}

async function counts(pool: Pool, rideId: string) {
  return (await pool.query(`SELECT version,
    (SELECT count(*)::int FROM ride_ratings WHERE ride_id=$1) AS ratings,
    (SELECT count(*)::int FROM business_events WHERE ride_id=$1) AS events,
    (SELECT count(*)::int FROM notifications WHERE ride_id=$1) AS notifications,
    (SELECT count(*)::int FROM idempotency_requests WHERE operation='rides.rate') AS receipts
    FROM rides WHERE id=$1`, [rideId])).rows[0];
}

for (const kind of ['offer', 'request'] as const) {
  test(`${kind} driver and passengers rate one another, notify only the target and retain private button state`, enabled, async t => {
    const db = await createTestDatabase(); t.after(() => db.close());
    const f = await fixture(db.pool, kind);
    // Blocking and research follow-up participation do not change this contract.
    await db.pool.query('INSERT INTO user_blocks(blocker_id,target_id) VALUES($1,$2)', [f.driver, f.passenger]);
    const passengerResult = await rateRide(db.pool, f.passenger, 'ratings.passenger.driver', f.rideId, { targetId: f.driver, score: 5 });
    const driverResult = await rateRide(db.pool, f.driver, 'ratings.driver.passenger', f.rideId, { targetId: f.passenger, score: 4 });
    await rateRide(db.pool, f.driver, 'ratings.driver.other', f.rideId, { targetId: f.otherPassenger, score: 3 });
    assert.equal(passengerResult.status, 201);
    assert.deepEqual(Object.keys(passengerResult.data).sort(), ['ratingId', 'rideId', 'score', 'targetId']);
    assert.deepEqual(passengerResult.data, { ratingId: passengerResult.data.ratingId, rideId: f.rideId, targetId: f.driver, score: 5 });
    assert.equal(typeof driverResult.data.ratingId, 'string');
    assert.deepEqual(await listMyRideRatings(db.pool, f.passenger, f.rideId), { ratings: [{ targetId: f.driver, score: 5 }] });
    assert.deepEqual(await listMyRideRatings(db.pool, f.otherPassenger, f.rideId), { ratings: [] });
    assert.deepEqual(await listMyRideRatings(db.pool, f.driver, f.rideId), {
      ratings: [{ targetId: f.passenger, score: 4 }, { targetId: f.otherPassenger, score: 3 }].sort((a, b) => a.targetId.localeCompare(b.targetId)),
    });
    const rows = (await db.pool.query(`SELECT rr.rater_id,rr.target_id,rr.rater_role,rr.target_role,rr.score,rr.created_at,
      e.actor_id,e.action,e.payload,e.ride_version,n.user_id,n.type,n.content
      FROM ride_ratings rr JOIN business_events e ON e.id=rr.event_id JOIN notifications n ON n.event_id=e.id
      WHERE rr.ride_id=$1 ORDER BY e.ride_version`, [f.rideId])).rows;
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.actor_id, row.rater_id);
      assert.equal(row.user_id, row.target_id);
      assert.notEqual(row.rater_role, row.target_role);
      assert.equal(row.action, 'rated');
      assert.equal(row.type, 'ride_rating');
      assert.deepEqual(row.payload, { targetId: row.target_id, score: row.score, raterRole: row.rater_role, targetRole: row.target_role });
      assert.doesNotMatch(row.content, /Private pickup|driver-private/);
      assert.ok(row.created_at instanceof Date);
    }
    assert.deepEqual(await counts(db.pool, f.rideId), { version: 4, ratings: 3, events: 3, notifications: 3, receipts: 3 });
  });
}

test('rating permissions reject strangers, departed members, self-rating and same-role peers without writes', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const f = await fixture(db.pool);
  await assert.rejects(rateRide(db.pool, f.stranger, 'ratings.stranger.actor', f.rideId, { targetId: f.driver, score: 5 }), hasCode('RIDE_NOT_FOUND'));
  await assert.rejects(rateRide(db.pool, f.driver, 'ratings.stranger.target', f.rideId, { targetId: f.stranger, score: 5 }), hasCode('RATING_TARGET_NOT_FOUND'));
  await assert.rejects(rateRide(db.pool, f.driver, 'ratings.missing.target', f.rideId, { targetId: randomUUID(), score: 5 }), hasCode('RATING_TARGET_NOT_FOUND'));
  await assert.rejects(rateRide(db.pool, f.driver, 'ratings.self.target', f.rideId, { targetId: f.driver.toUpperCase(), score: 5 }), hasCode('SELF_RATING_NOT_ALLOWED'));
  await assert.rejects(rateRide(db.pool, f.passenger, 'ratings.same.role', f.rideId, { targetId: f.otherPassenger, score: 5 }), hasCode('RATING_ROLE_MISMATCH'));
  await db.pool.query("UPDATE ride_members SET state='left',left_at=clock_timestamp() WHERE ride_id=$1 AND user_id=$2", [f.rideId, f.passenger]);
  await assert.rejects(rateRide(db.pool, f.passenger, 'ratings.departed.actor', f.rideId, { targetId: f.driver, score: 5 }), hasCode('RIDE_NOT_FOUND'));
  await assert.rejects(rateRide(db.pool, f.driver, 'ratings.departed.target', f.rideId, { targetId: f.passenger, score: 5 }), hasCode('RATING_TARGET_NOT_FOUND'));
  await assert.rejects(listMyRideRatings(db.pool, f.passenger, f.rideId), hasCode('RIDE_NOT_FOUND'));
  await assert.rejects(listMyRideRatings(db.pool, f.stranger, f.rideId), hasCode('RIDE_NOT_FOUND'));
  await assert.rejects(listMyRideRatings(db.pool, f.driver, 'absent-ride'), hasCode('RIDE_NOT_FOUND'));
  await assert.rejects(rateRide(db.pool, f.driver, 'ratings.missing.ride', 'absent-ride', { targetId: f.passenger, score: 5 }), hasCode('RIDE_NOT_FOUND'));
  assert.deepEqual(await counts(db.pool, f.rideId), { version: 1, ratings: 0, events: 0, notifications: 0, receipts: 0 });
});

test('only closed rides whose last departure is strictly in the DB past can be rated', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const f = await fixture(db.pool);
  const attempt = (key: string) => rateRide(db.pool, f.passenger, key, f.rideId, { targetId: f.driver, score: 4 });
  await db.pool.query("UPDATE rides SET status='open' WHERE id=$1", [f.rideId]);
  await assert.rejects(attempt('ratings.time.open'), hasCode('RIDE_NOT_ENDED'));
  assert.deepEqual(await listMyRideRatings(db.pool, f.passenger, f.rideId), { ratings: [] });
  await db.pool.query("UPDATE rides SET status='cancelled' WHERE id=$1", [f.rideId]);
  await assert.rejects(attempt('ratings.time.cancelled'), hasCode('RIDE_NOT_FOUND'));
  await assert.rejects(listMyRideRatings(db.pool, f.passenger, f.rideId), hasCode('RIDE_NOT_FOUND'));
  await db.pool.query("UPDATE rides SET status='closed' WHERE id=$1", [f.rideId]);
  // The ride's first departure is old, but a later pickup is still ahead.
  await db.pool.query("UPDATE ride_stops SET departure_at=clock_timestamp()+interval '1 hour' WHERE ride_id=$1 AND position=1", [f.rideId]);
  await assert.rejects(attempt('ratings.time.last.stop'), hasCode('RIDE_NOT_ENDED'));
  await db.pool.query("DELETE FROM ride_stops WHERE ride_id=$1 AND kind='departure'", [f.rideId]);
  await assert.rejects(attempt('ratings.time.no.stop'), hasCode('RIDE_NOT_ENDED'));
  assert.deepEqual(await counts(db.pool, f.rideId), { version: 1, ratings: 0, events: 0, notifications: 0, receipts: 0 });
});

test('rating eligibility uses clock_timestamp after lock wait instead of transaction start time', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const f = await fixture(db.pool);
  const blocker = await db.pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM rides WHERE id=$1 FOR UPDATE', [f.rideId]);
    // A concurrent update is visible only once this lock is released. A long
    // future time would be denied; a time that passed during the wait is eligible.
    await blocker.query("UPDATE ride_stops SET departure_at=clock_timestamp()+interval '150 milliseconds' WHERE ride_id=$1 AND position=1", [f.rideId]);
    const pending = rateRide(db.pool, f.passenger, 'ratings.time.wait', f.rideId, { targetId: f.driver, score: 4 });
    await blocker.query('SELECT pg_sleep(0.25)');
    await blocker.query('COMMIT');
    assert.equal((await pending).status, 201);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
});

test('same-key concurrent rating retries replay once and a fresh key cannot change the score', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const f = await fixture(db.pool);
  const body = { targetId: f.driver, score: 2 };
  const results = await Promise.all(Array.from({ length: 16 }, () => rateRide(db.pool, f.passenger, 'ratings.concurrent.same', f.rideId, body)));
  for (const result of results) assert.deepEqual(result, results[0]);
  await assert.rejects(rateRide(db.pool, f.passenger, 'ratings.concurrent.same', f.rideId, { ...body, score: 3 }), hasCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(rateRide(db.pool, f.passenger, 'ratings.concurrent.fresh', f.rideId, { ...body, score: 3 }), hasCode('ALREADY_RATED'));
  assert.deepEqual(await counts(db.pool, f.rideId), { version: 2, ratings: 1, events: 1, notifications: 1, receipts: 1 });
  // A committed receipt remains stable if eligibility later changes.
  await db.pool.query("UPDATE rides SET status='cancelled' WHERE id=$1", [f.rideId]);
  assert.deepEqual(await rateRide(db.pool, f.passenger, 'ratings.concurrent.same', f.rideId, body), results[0]);
  await assert.rejects(listMyRideRatings(db.pool, f.passenger, f.rideId), hasCode('RIDE_NOT_FOUND'));
});

test('different keys for one pair race to a single rating; opposite pairs advance distinct versions', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const f = await fixture(db.pool);
  const results = await Promise.allSettled(Array.from({ length: 16 }, (_, index) =>
    rateRide(db.pool, f.passenger, `ratings.concurrent.${index}`, f.rideId, { targetId: f.driver, score: index % 5 + 1 })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results) if (result.status === 'rejected') assert.ok(hasCode('ALREADY_RATED')(result.reason));
  await Promise.all([
    rateRide(db.pool, f.driver, 'ratings.parallel.first', f.rideId, { targetId: f.passenger, score: 5 }),
    rateRide(db.pool, f.driver, 'ratings.parallel.second', f.rideId, { targetId: f.otherPassenger, score: 4 }),
    rateRide(db.pool, f.otherPassenger, 'ratings.parallel.third', f.rideId, { targetId: f.driver, score: 3 }),
  ]);
  assert.deepEqual(await counts(db.pool, f.rideId), { version: 5, ratings: 4, events: 4, notifications: 4, receipts: 4 });
  assert.deepEqual((await db.pool.query('SELECT ride_version FROM business_events WHERE ride_id=$1 ORDER BY ride_version', [f.rideId])).rows,
    [2, 3, 4, 5].map(ride_version => ({ ride_version })));
});

test('event, notification, rating and receipt failures roll the entire rating transaction back', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const f = await fixture(db.pool);
  await db.pool.query(`CREATE FUNCTION reject_rating_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic failure'; END; $$`);
  for (const table of ['business_events', 'notifications', 'ride_ratings', 'idempotency_requests']) {
    await db.pool.query(`CREATE TRIGGER rating_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_rating_write()`);
    await assert.rejects(rateRide(db.pool, f.passenger, 'ratings.rollback.retry', f.rideId, { targetId: f.driver, score: 4 }), /synthetic failure/);
    assert.deepEqual(await counts(db.pool, f.rideId), { version: 1, ratings: 0, events: 0, notifications: 0, receipts: 0 });
    await db.pool.query(`DROP TRIGGER rating_failure ON ${table}`);
  }
  assert.equal((await rateRide(db.pool, f.passenger, 'ratings.rollback.retry', f.rideId, { targetId: f.driver, score: 4 })).status, 201);
  assert.deepEqual(await counts(db.pool, f.rideId), { version: 2, ratings: 1, events: 1, notifications: 1, receipts: 1 });
});

test('rating storage keeps legacy text IDs and defends scores, roles and uniqueness without a cache table', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const f = await fixture(db.pool);
  const insert = (ratingId: string, rater: string, target: string, raterRole: string, targetRole: string, score: number) => db.pool.query(`
    INSERT INTO ride_ratings(id,ride_id,rater_id,target_id,rater_role,target_role,score)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [ratingId, f.rideId, rater, target, raterRole, targetRole, score]);
  for (const score of [0, 6]) await assert.rejects(insert(randomUUID(), f.passenger, f.driver, 'passenger', 'driver', score), /check constraint/);
  await assert.rejects(insert(randomUUID(), f.passenger, f.driver, 'owner', 'driver', 4), /check constraint/);
  await assert.rejects(insert(randomUUID(), f.passenger, f.otherPassenger, 'passenger', 'passenger', 4), /check constraint/);
  await assert.rejects(insert(randomUUID(), f.driver, f.driver, 'driver', 'passenger', 4), /check constraint/);
  await insert('legacy_rating_source_001', f.passenger, f.driver, 'passenger', 'driver', 4);
  await assert.rejects(insert('another_source', f.passenger, f.driver, 'passenger', 'driver', 5), /unique constraint/);
  assert.deepEqual((await db.pool.query('SELECT id,event_id FROM ride_ratings WHERE ride_id=$1', [f.rideId])).rows,
    [{ id: 'legacy_rating_source_001', event_id: null }]);
});

test('rating HTTP routes authenticate and validate strictly while exposing only the caller\'s own choices', enabled, async t => {
  const db = await createTestDatabase();
  const sessions = sessionService(db.pool, {
    databaseUrl: process.env.BACKEND_TEST_DATABASE_URL!, host: '127.0.0.1', port: 3100,
    appId: 'wx-rating-routes', sessionTtlSeconds: 3600,
  }, async code => ({ openid: `rating-http-${code}` }));
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500)
    .send({ ok: false, error: { code: error instanceof AppError ? error.code : error instanceof ZodError ? 'INVALID_INPUT' : 'INTERNAL_ERROR' } }));
  registerRatingRoutes(app, { pool: db.pool, requireUser: sessions.requireUser });
  t.after(async () => { await app.close(); await db.close(); });
  const logins = await Promise.all(['driver', 'passenger', 'other', 'stranger'].map(code => sessions.login(code)));
  const [driver, passenger, other, stranger] = logins;
  const f = await fixture(db.pool, 'offer', logins.map(login => login.user.id));
  const url = `/api/v1/rides/${f.rideId}/ratings`;
  const headers = { authorization: `Bearer ${passenger!.token}`, 'idempotency-key': 'ratings.http.once' };
  const body = { targetId: f.driver, score: 5 };
  for (const method of ['GET', 'POST'] as const) {
    const denied = await app.inject({ method, url, ...(method === 'POST' ? { payload: body } : {}) });
    assert.equal(denied.statusCode, 401);
    assert.equal(denied.headers['cache-control'], 'private, no-store');
    const hidden = await app.inject({ method, url, headers: { ...headers, authorization: `Bearer ${stranger!.token}` }, ...(method === 'POST' ? { payload: body } : {}) });
    assert.equal(hidden.statusCode, 404);
    assert.equal(hidden.json().error.code, 'RIDE_NOT_FOUND');
    assert.equal(hidden.headers['cache-control'], 'private, no-store');
  }
  const missingKey = await app.inject({ method: 'POST', url, headers: { authorization: headers.authorization }, payload: body });
  assert.equal(missingKey.statusCode, 400);
  assert.equal(missingKey.json().error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  for (const score of [0, 6, 1.5, '5', null, true]) {
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: { ...body, score } })).statusCode, 400);
  }
  for (const payload of [{}, { score: 5 }, { ...body, targetId: driver!.user.openid }, { ...body, raterId: f.driver },
    { ...body, openid: passenger!.user.openid }, { ...body, comment: 'extra' }]) {
    assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 400);
  }
  for (const query of [`userId=${f.driver}`, 'unexpected=1']) {
    assert.equal((await app.inject({ method: 'GET', url: `${url}?${query}`, headers })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: `${url}?${query}`, headers, payload: body })).statusCode, 400);
  }
  const response = await app.inject({ method: 'POST', url, headers, payload: body });
  assert.equal(response.statusCode, 201);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.json().ok, true);
  assert.equal(typeof response.json().requestId, 'string');
  const same = await app.inject({ method: 'POST', url, headers, payload: { ...body, targetId: body.targetId.toUpperCase() } });
  assert.deepEqual(same.json().data, response.json().data);
  const duplicate = await app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': 'ratings.http.again' }, payload: body });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().error.code, 'ALREADY_RATED');
  const mine = await app.inject({ method: 'GET', url, headers });
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.headers['cache-control'], 'private, no-store');
  assert.deepEqual(mine.json().data, { ratings: [{ targetId: f.driver, score: 5 }] });
  const theirs = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${other!.token}` } });
  assert.deepEqual(theirs.json().data, { ratings: [] });
  for (const privateValue of [...logins.flatMap(login => [login.token, login.user.openid]), 'Private pickup', 'driver-private']) {
    assert.equal(response.body.includes(privateValue), false);
    assert.equal(mine.body.includes(privateValue), false);
  }
  await db.pool.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 minute' WHERE user_id=$1", [f.passenger]);
  assert.equal((await app.inject({ method: 'GET', url, headers })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: body })).statusCode, 401);
});
