import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { ZodError } from 'zod';
import { AppError } from '../src/errors.ts';
import { sessionService } from '../src/auth/session.ts';
import { closeDueRides } from '../src/rides/completion.ts';
import { rateRide } from '../src/ratings/service.ts';
import { getRide, listRides } from '../src/rides/service.ts';
import { getRideParticipants, listMyRides } from '../src/rides/participants.ts';
import { formatStatistics, publicStatistics, statisticsProjection, userStatistics } from '../src/statistics/service.ts';
import { registerStatisticsRoutes } from '../src/statistics/routes.ts';
import { createTestDatabase } from './helpers/database.ts';

const enabled = { skip: !process.env.BACKEND_TEST_DATABASE_URL };
const appId = 'statistics-test';
const empty = { completedTrips: 0, ratingCount: 0, averageRating: null, weightedRating: null };
const hasCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
const account = async (pool: Pool) => (await pool.query(`INSERT INTO users(app_id,openid,name,profile)
  VALUES($1,$2,'Public name',$3) RETURNING id`, [appId, `private-${randomUUID()}`,
  { phone: 'private-contact', location: { address: 'private-home' }, rideStats: { ratingCount: 9999, ratingAvg: 1 } }])).rows[0].id as string;

async function ride(pool: Pool, creator: string, status = 'closed', kind = 'offer') {
  const id = randomUUID();
  await pool.query(`INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone)
    VALUES($1,$2,$3,'ny_nj',$4,4,clock_timestamp()+$5::interval,'America/New_York')`,
  [id, kind, creator, status, status === 'open' ? '1 day' : '-1 day']);
  await pool.query(`INSERT INTO ride_stops(ride_id,position,kind,address,departure_at)
    SELECT id,0,'departure','Fort Lee',departure_at FROM rides WHERE id=$1
    UNION ALL SELECT id,1,'destination','Columbia',NULL FROM rides WHERE id=$1`, [id]);
  return id;
}

async function member(pool: Pool, rideId: string, userId: string, role: 'driver' | 'passenger', state = 'active') {
  await pool.query(`INSERT INTO ride_members(ride_id,user_id,role,seat_count,state,left_at)
    VALUES($1,$2,$3,$4,$5,CASE WHEN $5='left' THEN clock_timestamp() ELSE NULL END)`,
  [rideId, userId, role, role === 'driver' ? 0 : 1, state]);
}

async function ratings(pool: Pool, rideId: string, target: string, role: 'driver' | 'passenger', scores: number[]) {
  for (const score of scores) {
    const rater = await account(pool);
    await pool.query(`INSERT INTO ride_ratings(id,ride_id,rater_id,target_id,rater_role,target_role,score)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), rideId, rater, target, role === 'driver' ? 'passenger' : 'driver', role, score]);
  }
}

async function history(pool: Pool, userId: string) {
  const first = await ride(pool, userId), second = await ride(pool, userId), third = await ride(pool, userId);
  await pool.query(`INSERT INTO ride_completions(ride_id,user_id,role)
    VALUES($1,$4,'driver'),($2,$4,'driver'),($3,$4,'passenger')`, [first, second, third, userId]);
  // Historical counting and received ratings survive a departed relationship.
  await member(pool, first, userId, 'driver', 'left');
  await member(pool, third, userId, 'passenger', 'left');
  await ratings(pool, first, userId, 'driver', [...Array.from({ length: 19 }, () => 2), 5]);
  await ratings(pool, third, userId, 'passenger', [5, 1]);
  return {
    all: { completedTrips: 3, ratingCount: 22, averageRating: 2.2, weightedRating: 2.5 },
    driver: { completedTrips: 2, ratingCount: 20, averageRating: 2.1, weightedRating: 2.5 },
    passenger: { completedTrips: 1, ratingCount: 2, averageRating: 3, weightedRating: 4 },
  };
}

test('one formatter preserves legacy JS rounding and distinguishes unknown scores from zero', () => {
  assert.deepEqual(formatStatistics({ completedTrips: 0, ratingCount: 0, ratingSum: 0 }), empty);
  assert.deepEqual(formatStatistics({ completedTrips: 7, ratingCount: 20, ratingSum: 43 }), {
    completedTrips: 7, ratingCount: 20, averageRating: 2.1, weightedRating: 2.5,
  });
  assert.deepEqual(formatStatistics({ completedTrips: 1, ratingCount: 1, ratingSum: 5 }), {
    completedTrips: 1, ratingCount: 1, averageRating: 5, weightedRating: 4.8,
  });
  for (const bad of [
    { completedTrips: -1, ratingCount: 0, ratingSum: 0 },
    { completedTrips: 0, ratingCount: Number.MAX_SAFE_INTEGER + 1, ratingSum: 1 },
    { completedTrips: 0, ratingCount: 0, ratingSum: 1 },
    { completedTrips: 0, ratingCount: 1, ratingSum: 6 },
  ]) assert.throws(() => formatStatistics(bad), hasCode('STATISTICS_OUT_OF_RANGE'));
  for (const source of ['m.user_id; DROP TABLE users;', 'toString', '__proto__']) {
    assert.throws(() => statisticsProjection(source as Parameters<typeof statisticsProjection>[0]), /Unknown statistics projection/);
  }
});

test('personal statistics derive all and each historical target role from facts without member or profile-cache filtering', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const subject = await account(db.pool), stranger = await account(db.pool);
  assert.deepEqual(await userStatistics(db.pool, subject), { all: empty, driver: empty, passenger: empty });
  const expected = await history(db.pool, subject);
  assert.deepEqual(await userStatistics(db.pool, subject), expected);
  assert.deepEqual(await userStatistics(db.pool, stranger), { all: empty, driver: empty, passenger: empty });
  await assert.rejects(userStatistics(db.pool, randomUUID()), hasCode('USER_NOT_FOUND'));
  const rows = await db.pool.query("SELECT user_id FROM ride_members WHERE user_id=$1 AND state='active'", [subject]);
  assert.equal(rows.rowCount, 0, 'historical receipts must not recreate membership');
  assert.equal(JSON.stringify(expected).includes('ratingSum'), false);
});

test('every ride projection exposes only the correct role aggregate in one authorized SQL snapshot', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const driver = await account(db.pool), passenger = await account(db.pool), outsider = await account(db.pool);
  const driverStats = await history(db.pool, driver), passengerStats = await history(db.pool, passenger);
  const rideId = await ride(db.pool, driver, 'open');
  await member(db.pool, rideId, driver, 'driver'); await member(db.pool, rideId, passenger, 'passenger');
  const requestId = await ride(db.pool, passenger, 'open', 'request');
  await member(db.pool, requestId, passenger, 'passenger');
  let statements = 0;
  const observed = { async query(sql: string, values: unknown[]) { statements++; return db.pool.query(sql, values); } } as unknown as Pool;
  async function single<T>(work: () => Promise<T>) {
    statements = 0;
    try { return await work(); } finally { assert.equal(statements, 1); }
  }
  const detail = await single(() => getRide(observed, rideId));
  assert.deepEqual(detail.driverStatistics, driverStats.driver);
  const listing = await single(() => listRides(observed, {}));
  assert.deepEqual(listing.rides.find(row => row.id === rideId)?.driverStatistics, driverStats.driver);
  assert.equal(listing.rides.find(row => row.id === requestId)?.driverStatistics, null);
  const mine = await single(() => listMyRides(observed, passenger, {}));
  assert.deepEqual(mine.rides.find(row => row.id === rideId)?.driverStatistics, driverStats.driver);
  assert.equal(mine.rides.find(row => row.id === requestId)?.driverStatistics, null);
  const participants = await single(() => getRideParticipants(observed, passenger, rideId));
  assert.deepEqual(participants.participants.find(row => row.id === driver)?.statistics, driverStats.driver);
  assert.deepEqual(participants.participants.find(row => row.id === passenger)?.statistics, passengerStats.passenger);
  await single(() => userStatistics(observed, passenger));
  await assert.rejects(single(() => getRideParticipants(observed, outsider, rideId)), hasCode('RIDE_NOT_FOUND'));
  for (const result of [detail, listing, mine]) {
    const serialized = JSON.stringify(result);
    for (const forbidden of [driver, passenger, outsider, 'private-', 'ratingSum', 'targetId', 'raterId', 'all', 'profile']) {
      assert.equal(serialized.includes(forbidden), false, `public projection must exclude ${forbidden}`);
    }
  }
  const serializedParticipants = JSON.stringify(participants);
  for (const forbidden of ['ratingSum', 'targetId', 'raterId', 'all', 'private-home', 'openid']) {
    assert.equal(serializedParticipants.includes(forbidden), false);
  }
  // New members keep explicit null averages instead of losing keys to the
  // surrounding private projection's recursive jsonb_strip_nulls.
  const emptyRide = await ride(db.pool, outsider, 'open'); await member(db.pool, emptyRide, outsider, 'driver');
  assert.deepEqual((await getRideParticipants(db.pool, outsider, emptyRide)).participants[0]!.statistics, empty);
  assert.deepEqual((await getRide(db.pool, emptyRide)).driverStatistics, empty);
});

test('closure and rating commits appear immediately without updating a summary cache', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const driver = await account(db.pool), passenger = await account(db.pool);
  const rideId = await ride(db.pool, driver);
  await member(db.pool, rideId, driver, 'driver'); await member(db.pool, rideId, passenger, 'passenger');
  await db.pool.query("UPDATE rides SET status='open' WHERE id=$1", [rideId]);
  await db.pool.query('INSERT INTO public_statistics(app_id,served_count,coverage_text) VALUES($1,100,$2)', [appId, 'NY / NJ']);
  assert.deepEqual((await userStatistics(db.pool, driver)).driver, empty);
  await closeDueRides(db.pool, appId);
  assert.deepEqual((await userStatistics(db.pool, driver)).driver, { ...empty, completedTrips: 1 });
  assert.deepEqual((await userStatistics(db.pool, passenger)).passenger, { ...empty, completedTrips: 1 });
  assert.deepEqual(await publicStatistics(db.pool, appId), { servedCount: 102, coverageText: 'NY / NJ' });
  await rateRide(db.pool, passenger, 'statistics.live.rating', rideId, { targetId: driver, score: 5 });
  const expected = { completedTrips: 1, ratingCount: 1, averageRating: 5, weightedRating: 4.8 };
  assert.deepEqual((await userStatistics(db.pool, driver)).driver, expected);
  assert.deepEqual((await getRide(db.pool, rideId)).driverStatistics, expected);
  assert.deepEqual((await getRideParticipants(db.pool, passenger, rideId)).participants.find(row => row.id === driver)?.statistics, expected);
  assert.deepEqual((await listMyRides(db.pool, passenger, { scope: 'history' })).rides[0]?.driverStatistics, expected);
  const profile = (await db.pool.query('SELECT profile FROM users WHERE id=$1', [driver])).rows[0].profile;
  assert.deepEqual(profile.rideStats, { ratingCount: 9999, ratingAvg: 1 }, 'legacy profile fields are neither authority nor write targets');
});

test('public statistics require the configured baseline and preserve bigint boundaries and unknown coverage', enabled, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  await db.pool.query("INSERT INTO public_statistics(app_id,served_count,coverage_text) VALUES('other-app',9876,'Elsewhere')");
  await assert.rejects(publicStatistics(db.pool, appId), hasCode('STATISTICS_NOT_INITIALIZED'));
  await db.pool.query('INSERT INTO public_statistics(app_id,served_count) VALUES($1,0)', [appId]);
  assert.deepEqual(await publicStatistics(db.pool, appId), { servedCount: 0, coverageText: null });
  for (const count of [2147483648n, BigInt(Number.MAX_SAFE_INTEGER)]) {
    await db.pool.query('UPDATE public_statistics SET served_count=$2,coverage_text=$3 WHERE app_id=$1', [appId, count.toString(), 'NY / NJ']);
    assert.deepEqual(await publicStatistics(db.pool, appId), { servedCount: Number(count), coverageText: 'NY / NJ' });
  }
  for (const count of [BigInt(Number.MAX_SAFE_INTEGER) + 1n, 9223372036854775807n]) {
    await db.pool.query('UPDATE public_statistics SET served_count=$2 WHERE app_id=$1', [appId, count.toString()]);
    await assert.rejects(publicStatistics(db.pool, appId), hasCode('STATISTICS_OUT_OF_RANGE'));
  }
});

test('statistics HTTP endpoints prevent identity/app overrides and distinguish private reads from the public aggregate', enabled, async t => {
  const db = await createTestDatabase();
  const sessions = sessionService(db.pool, {
    databaseUrl: process.env.BACKEND_TEST_DATABASE_URL!, host: '127.0.0.1', port: 3100,
    appId, sessionTtlSeconds: 3600,
  }, async code => ({ openid: `statistics-http-${code}` }));
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500)
    .send({ ok: false, error: { code: error instanceof AppError ? error.code : error instanceof ZodError ? 'INVALID_INPUT' : 'INTERNAL_ERROR' } }));
  registerStatisticsRoutes(app, { pool: db.pool, appId, requireUser: sessions.requireUser });
  t.after(async () => { await app.close(); await db.close(); });
  const owner = await sessions.login('owner'), stranger = await sessions.login('stranger');
  const headers = { authorization: `Bearer ${owner.token}` };
  const expected = await history(db.pool, owner.user.id);
  const privateUrl = '/api/v1/me/statistics', publicUrl = '/api/v1/statistics/public';
  const anonymous = await app.inject({ method: 'GET', url: privateUrl });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.headers['cache-control'], 'private, no-store');
  const mine = await app.inject({ method: 'GET', url: privateUrl, headers });
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.headers['cache-control'], 'private, no-store');
  assert.deepEqual(mine.json().data, expected);
  assert.equal(typeof mine.json().requestId, 'string');
  const theirs = await app.inject({ method: 'GET', url: privateUrl, headers: { authorization: `Bearer ${stranger.token}` } });
  assert.deepEqual(theirs.json().data, { all: empty, driver: empty, passenger: empty });
  for (const query of [`userId=${owner.user.id}`, `openid=${owner.user.openid}`, 'role=driver', 'appId=other-app']) {
    assert.equal((await app.inject({ method: 'GET', url: `${privateUrl}?${query}`, headers })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: `${publicUrl}?${query}` })).statusCode, 400);
  }
  const missing = await app.inject({ method: 'GET', url: publicUrl });
  assert.equal(missing.statusCode, 503);
  assert.equal(missing.json().error.code, 'STATISTICS_NOT_INITIALIZED');
  assert.equal(missing.headers['cache-control'], 'no-store');
  await db.pool.query('INSERT INTO public_statistics(app_id,served_count,coverage_text) VALUES($1,8875,$2)', [appId, 'NY / NJ']);
  await db.pool.query("INSERT INTO public_statistics(app_id,served_count,coverage_text) VALUES('other-app',999,'Elsewhere')");
  const visible = await app.inject({ method: 'GET', url: publicUrl });
  assert.equal(visible.statusCode, 200);
  assert.deepEqual(visible.json().data, { servedCount: 8875, coverageText: 'NY / NJ' });
  assert.equal(visible.headers['cache-control'], 'no-store');
  for (const forbidden of [owner.token, owner.user.openid, owner.user.id, stranger.user.id, 'ratingSum', 'profile', 'private-']) {
    assert.equal(mine.body.includes(forbidden), false);
    assert.equal(visible.body.includes(forbidden), false);
  }
  assert.equal((await app.inject({ method: 'GET', url: `/api/v1/users/${owner.user.id}/statistics`, headers })).statusCode, 404);
  await db.pool.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 minute' WHERE user_id=$1", [owner.user.id]);
  assert.equal((await app.inject({ method: 'GET', url: privateUrl, headers })).statusCode, 401);
});
