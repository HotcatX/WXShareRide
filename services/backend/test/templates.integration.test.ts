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

const input = (patch = {}) => ({ name: 'Tuesday class', weekday: 2, localTime: '15:00', timeZone: 'America/New_York',
  definition: { kind: 'offer', cityKey: 'ny_nj', origin: { address: 'Fort Lee', placeId: 'fort_lee' }, destination: { address: 'Columbia', placeId: 'columbia' }, seatCapacity: 3, listedPriceCents: 1500, note: 'After class' }, ...patch });
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
  assert.deepEqual(list.items[0].nextOccurrence, { localDate: '2026-09-29', departureAt: '2026-09-29T20:00:00.000Z' });
  assert.doesNotMatch(JSON.stringify(list), /openid|user_id/);
  const deleted = await deleteTemplate(db.pool, owner, 'delete-template-02', id);
  assert.deepEqual(await deleteTemplate(db.pool, owner, 'delete-template-02', id), deleted);
  assert.equal((await listTemplates(db.pool, owner, {})).items.length, 0);
  assert.equal((await db.pool.query('SELECT count(*)::integer AS count FROM rides')).rows[0].count, 0, 'template CRUD never auto-publishes a ride');
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

test('templates: rejects absolute time, old aliases, multi-stop truncation, request templates and invalid edits', { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
  const db = await createTestDatabase(); t.after(() => db.close()); const owner = await user(db.pool, 'owner');
  const valid = input();
  for (const invalid of [input({ weekday: 7 }), input({ weekdayIndex: 1 }), input({ localTime: '3:00' }), input({ timeZone: 'UTC' }),
    input({ definition: { ...valid.definition, departureAt: '2026-09-29T19:00:00Z' } }),
    input({ definition: { ...valid.definition, departures: [{ address: 'A' }, { address: 'B' }] } }),
    input({ definition: { ...valid.definition, kind: 'request', partySize: 2 } }),
    input({ definition: { ...valid.definition, zelle: 'yes' } })]) {
    await assert.rejects(createTemplate(db.pool, owner, 'invalid-template', invalid), ZodError);
  }
  const created = await createTemplate(db.pool, owner, 'valid-template', valid);
  await assert.rejects(updateTemplate(db.pool, owner, 'invalid-update-1', created.data.id, {}), ZodError);
  await assert.rejects(updateTemplate(db.pool, owner, 'invalid-update-2', created.data.id, { definition: { note: 'Nested partial must fail' } }), ZodError);
  assert.equal((await listTemplates(db.pool, owner, {})).items[0].definition.note, 'After class');
  await assert.rejects(db.pool.query('UPDATE ride_templates SET weekday=7 WHERE id=$1', [created.data.id]), { code: '23514' });
  await assert.rejects(db.pool.query("UPDATE ride_templates SET local_time='25:00' WHERE id=$1", [created.data.id]), { code: '23514' });
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
