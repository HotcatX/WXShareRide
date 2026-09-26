import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import type { Pool } from 'pg';
import { createTestDatabase } from './helpers/database.ts';
import { createTemplate, deleteTemplate, listTemplates, updateTemplate } from '../src/templates/service.ts';
import { registerTemplateRoutes } from '../src/templates/routes.ts';
import { sessionService } from '../src/auth/session.ts';
import { AppError } from '../src/errors.ts';
import { nextWeeklyOccurrence } from '../src/templates/time.ts';
import { templateDefinitionSchema } from '../src/templates/schemas.ts';
import { rideStopsSchema } from '../src/rides/schemas.ts';

const input = (patch = {}) => ({ name: 'Tuesday class', weekday: 2, localTime: '15:00', timeZone: 'America/New_York',
  definition: { kind: 'offer', cityKey: 'ny_nj', stops: [
    { kind: 'departure', address: 'Fort Lee', placeId: 'fort_lee', offsetMinutes: 0 },
    { kind: 'destination', address: 'Columbia', placeId: 'columbia' },
  ], seatCapacity: 3, listedPriceCents: 1500, note: 'After class' }, ...patch });
async function user(pool: Pool, openid: string) { return (await pool.query("INSERT INTO users(app_id,openid) VALUES ('templates-test',$1) RETURNING id", [openid])).rows[0].id as string; }
const hasCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

test('templates: real PostgreSQL owner isolation, concurrent retries, partial updates and deletion', { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const [owner, stranger] = await Promise.all([user(db.pool, 'owner'), user(db.pool, 'stranger')]);
  const [first, retry] = await Promise.all([createTemplate(db.pool, owner, 'create-template-01', input()), createTemplate(db.pool, owner, 'create-template-01', input())]);
  assert.deepEqual(first, retry);
  assert.equal(first.status, 201);
  const id = first.data.id;
  assert.equal((await db.pool.query('SELECT count(*)::integer AS count FROM ride_templates')).rows[0].count, 1);
  await assert.rejects(createTemplate(db.pool, owner, 'create-template-01', input({ name: 'Changed' })), hasCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(updateTemplate(db.pool, stranger, 'update-template-01', id, { name: 'Stolen' }), hasCode('TEMPLATE_NOT_FOUND'));
  await assert.rejects(deleteTemplate(db.pool, stranger, 'delete-template-01', id), hasCode('TEMPLATE_NOT_FOUND'));
  assert.deepEqual((await listTemplates(db.pool, stranger, {})).items, []);

  // Concurrent independent fields are merged after FOR UPDATE re-read, not lost.
  await Promise.all([updateTemplate(db.pool, owner, 'update-template-name', id, { name: 'Updated name' }), updateTemplate(db.pool, owner, 'update-template-time', id, { localTime: '16:00' })]);
  const list = await listTemplates(db.pool, owner, {}, Date.parse('2026-09-24T16:00:00Z'));
  assert.equal(list.items[0].name, 'Updated name');
  assert.equal(list.items[0].localTime, '16:00');
  assert.deepEqual(list.items[0].nextOccurrence, { stops: [
    { kind: 'departure', address: 'Fort Lee', placeId: 'fort_lee', departureAt: '2026-09-29T20:00:00.000Z' },
    { kind: 'destination', address: 'Columbia', placeId: 'columbia' },
  ] });
  assert.doesNotMatch(JSON.stringify(list), /openid|user_id/);
  const deleted = await deleteTemplate(db.pool, owner, 'delete-template-02', id);
  assert.deepEqual(await deleteTemplate(db.pool, owner, 'delete-template-02', id), deleted);
  assert.equal((await listTemplates(db.pool, owner, {})).items.length, 0);
  assert.equal((await db.pool.query('SELECT count(*)::integer AS count FROM rides')).rows[0].count, 0, 'template CRUD never auto-publishes a ride');
});

test('templates: an edit waiting for the previous writer cannot move updatedAt backwards', { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const owner = await user(db.pool, 'owner');
  const created = await createTemplate(db.pool, owner, 'timestamp-create', input());
  const id = created.data.id;
  const writer = await db.pool.connect();
  await writer.query('BEGIN');
  await writer.query('SELECT id FROM ride_templates WHERE id=$1 FOR UPDATE', [id]);
  let started!: (pid: number) => void;
  const reading = new Promise<number>(resolve => { started = resolve; });
  const observingPool = { async connect() {
    const client = await db.pool.connect();
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    return {
      async query(sql: string, values?: unknown[]) {
        if (sql.includes('FOR UPDATE')) started(pid);
        return client.query(sql, values);
      },
      release() { client.release(); },
    };
  } } as unknown as Pool;
  const pending = updateTemplate(observingPool, owner, 'timestamp-waited-edit', id, { name: 'After waiting' });
  let previousUpdatedAt = 0;
  try {
    const pid = await reading;
    let waiting = false;
    for (let i = 0; i < 200; i++) {
      if ((await db.pool.query('SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted', [pid])).rowCount) { waiting = true; break; }
      await db.pool.query('SELECT pg_sleep(0.005)');
    }
    assert.equal(waiting, true, 'the second edit must be blocked by the first writer');
    const began = (await db.pool.query<{ xact_start: Date }>('SELECT xact_start FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0].xact_start;
    // Use the database clock and a real lock wait, not racing JS scheduling or
    // synthetic future timestamps. The old now() update must fail this fixture.
    await writer.query('SELECT pg_sleep(0.01)');
    previousUpdatedAt = (await writer.query<{ updated_at: Date }>(
      'UPDATE ride_templates SET local_time=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING updated_at', [id, '16:00'])).rows[0].updated_at.getTime();
    assert.ok(previousUpdatedAt > began.getTime());
  } finally { await writer.query('COMMIT'); writer.release(); }
  const result = await pending;
  assert.ok(Date.parse(result.data.updatedAt as string) >= previousUpdatedAt);
  assert.equal(result.data.name, 'After waiting');
  assert.equal(result.data.localTime, '16:00', 'the preceding writer’s independent edit survives');
  const stored = (await db.pool.query<{ updated_at: Date }>('SELECT updated_at FROM ride_templates WHERE id=$1', [id])).rows[0].updated_at;
  assert.equal(stored.toISOString(), result.data.updatedAt);
  assert.deepEqual(await updateTemplate(db.pool, owner, 'timestamp-waited-edit', id, { name: 'After waiting' }), result);
});

test('templates: weekday ordering is Monday-first for display, pagination is explicit and stable', { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  const owner = await user(db.pool, 'owner');
  await Promise.all([createTemplate(db.pool, owner, 'sort-sunday', input({ name: 'Sunday', weekday: 0 })), createTemplate(db.pool, owner, 'sort-monday', input({ name: 'Monday', weekday: 1 })), createTemplate(db.pool, owner, 'sort-tuesday', input())]);
  const first = await listTemplates(db.pool, owner, { limit: 2 });
  const second = await listTemplates(db.pool, owner, { limit: 2, page: 2 });
  assert.deepEqual(first.items.map(row => row.weekday), [1, 2]); assert.equal(first.hasMore, true);
  assert.deepEqual(second.items.map(row => row.weekday), [0]); assert.equal(second.hasMore, false);
});

test('templates: rejects absolute time, old aliases, redundant profile copies, request templates and invalid edits', { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
  const db = await createTestDatabase(); t.after(() => db.close()); const owner = await user(db.pool, 'owner');
  const valid = input();
  for (const invalid of [input({ weekday: 7 }), input({ weekdayIndex: 1 }), input({ localTime: '3:00' }), input({ timeZone: 'UTC' }),
    input({ definition: { ...valid.definition, departureAt: '2026-09-29T19:00:00Z' } }),
    input({ definition: { ...valid.definition, departures: [{ address: 'A' }, { address: 'B' }] } }),
    input({ definition: { ...valid.definition, origin: { address: 'A' }, destination: { address: 'B' } } }),
    input({ definition: { ...valid.definition, kind: 'request', partySize: 2 } }),
    input({ definition: { ...valid.definition, vehicle: { plate: 'SYNTHETIC', brand: 'Synthetic', model: 'Synthetic' } } }),
    input({ definition: { ...valid.definition, zelleDisplay: true } }),
    input({ definition: { ...valid.definition, zelle: 'yes' } }),
    input({ definition: { ...valid.definition, timeZone: 'America/New_York' } }),
    input({ definition: { ...valid.definition, stops: [{ kind: 'departure', address: 'A', offsetMinutes: 0 }, { kind: 'destination', address: 'B', departureAt: '2026-09-29T19:00:00Z' }] } })]) {
    await assert.rejects(createTemplate(db.pool, owner, 'invalid-template', invalid), ZodError);
  }
  const created = await createTemplate(db.pool, owner, 'valid-template', valid);
  await assert.rejects(updateTemplate(db.pool, owner, 'invalid-update-1', created.data.id, {}), ZodError);
  await assert.rejects(updateTemplate(db.pool, owner, 'invalid-update-2', created.data.id, { definition: { note: 'Nested partial must fail' } }), ZodError);
  assert.equal((await listTemplates(db.pool, owner, {})).items[0].definition.note, 'After class');
  await assert.rejects(db.pool.query('UPDATE ride_templates SET weekday=7 WHERE id=$1', [created.data.id]), { code: '23514' });
  await assert.rejects(db.pool.query("UPDATE ride_templates SET local_time='25:00' WHERE id=$1", [created.data.id]), { code: '23514' });
});

test('templates: multi-stop definitions persist once and list uses the same complete DST instantiation', { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
  const db = await createTestDatabase(); t.after(() => db.close()); const owner = await user(db.pool, 'owner');
  const original = input();
  const payload = input({ weekday: 0, localTime: '01:30', definition: { ...original.definition, stops: [
    { kind: 'departure', address: 'Pickup A', offsetMinutes: 0 },
    { kind: 'departure', address: 'Pickup B', placeId: 'pickup_b', offsetMinutes: 60 },
    { kind: 'departure', address: 'Pickup C', offsetMinutes: 120 },
    { kind: 'destination', address: 'Destination A' },
    { kind: 'destination', address: 'Destination B', placeId: 'destination_b' },
  ] } });
  const created = await createTemplate(db.pool, owner, 'multi-template', payload);
  assert.equal('nextOccurrence' in created.data, false, 'idempotent write responses must not contain time-dependent previews');
  const stored = (await db.pool.query('SELECT definition FROM ride_templates WHERE id=$1', [created.data.id])).rows[0].definition;
  assert.deepEqual(stored, payload.definition);
  assert.doesNotMatch(JSON.stringify(stored), /departureAt|vehicle|zelle/);
  const now = Date.parse('2026-03-06T17:00:00Z');
  const item = (await listTemplates(db.pool, owner, {}, now)).items[0];
  assert.deepEqual(item.nextOccurrence, nextWeeklyOccurrence(item, item.definition.stops, now));
  assert.deepEqual(item.nextOccurrence!.stops, [
    { kind: 'departure', address: 'Pickup A', departureAt: '2026-03-15T05:30:00.000Z' },
    { kind: 'departure', address: 'Pickup B', placeId: 'pickup_b', departureAt: '2026-03-15T06:30:00.000Z' },
    { kind: 'departure', address: 'Pickup C', departureAt: '2026-03-15T07:30:00.000Z' },
    { kind: 'destination', address: 'Destination A' },
    { kind: 'destination', address: 'Destination B', placeId: 'destination_b' },
  ]);
  assert.equal(rideStopsSchema.safeParse(item.nextOccurrence!.stops).success, true);
  const changedDefinition = structuredClone(payload.definition);
  changedDefinition.stops[1].offsetMinutes = 90;
  await assert.rejects(createTemplate(db.pool, owner, 'multi-template', { ...payload, definition: changedDefinition }), hasCode('IDEMPOTENCY_CONFLICT'));
  const updated = await updateTemplate(db.pool, owner, 'multi-template-update', created.data.id, { definition: changedDefinition });
  const updatedDefinition = templateDefinitionSchema.parse(updated.data.definition);
  assert.equal(updatedDefinition.stops.length, 5);
  assert.deepEqual(updatedDefinition, changedDefinition);
  assert.equal((await db.pool.query('SELECT count(*)::integer AS count FROM rides')).rows[0].count, 0);
});

test('template HTTP contract requires a session and owner-scoped idempotent operations', { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
  const db = await createTestDatabase();
  const app = Fastify();
  const sessions = sessionService(db.pool, { databaseUrl: '', host: '127.0.0.1', port: 3100, appId: 'templates-test', sessionTtlSeconds: 3600 }, async code => ({ openid: code }));
  app.setErrorHandler((error, request, reply) => reply.code(error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500).send({ ok: false, error: { code: error instanceof AppError ? error.code : 'INVALID_INPUT' }, requestId: request.id }));
  registerTemplateRoutes(app, { pool: db.pool, requireUser: sessions.requireUser });
  t.after(async () => { await app.close(); await db.close(); });
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/templates', headers: { 'x-openid': 'owner' } })).statusCode, 401);
  const { token } = await sessions.login('owner');
  const headers = { authorization: `Bearer ${token}`, 'idempotency-key': 'http-template-01' };
  const created = await app.inject({ method: 'POST', url: '/api/v1/templates', headers, payload: input() });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().data.id;
  const changed = await app.inject({ method: 'PATCH', url: `/api/v1/templates/${id}`, headers: { ...headers, 'idempotency-key': 'http-template-02' }, payload: { localTime: '16:00' } });
  assert.equal(changed.statusCode, 200, changed.body);
  const listed = await app.inject({ method: 'GET', url: '/api/v1/templates', headers });
  assert.equal(listed.json().ok, true); assert.equal(listed.json().data.items[0].localTime, '16:00');
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/templates', headers: { authorization: headers.authorization }, payload: input() })).statusCode, 400);
  const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/templates/${id}`, headers: { ...headers, 'idempotency-key': 'http-template-03' } });
  assert.equal(deleted.statusCode, 200, deleted.body); assert.equal(deleted.json().data.deleted, true);
});
