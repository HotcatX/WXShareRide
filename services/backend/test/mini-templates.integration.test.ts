import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { createTemplateSchema } from '../src/templates/schemas.ts';
import { nextWeeklyOccurrence } from '../src/templates/time.ts';
import { registerTemplateRoutes } from '../src/templates/routes.ts';
import { sessionService } from '../src/auth/session.ts';
import { AppError } from '../src/errors.ts';
import { parseListedPrice } from '../src/prices.ts';
import { createTestDatabase } from './helpers/database.ts';

const require = createRequire(import.meta.url);
const { createRideTemplateClient, toTemplateInput, toLegacyTemplate, listedPrice } = require('../../../utils/compat/rideTemplates.js');
const { createBackendClient } = require('../../../utils/backendClient.js');
const rideTime = require('../../../utils/rideTime.js');
const id = '00000000-0000-4000-8000-000000000001';
const form = (extra = {}) => ({ templateName: '周二 Fort Lee→哥大', weekdayIndex: 1, weekdayText: '周二',
  departureTime: '15:00', departureAddress: 'Fort Lee', destinationAddress: '哥大', passengerCount: '3',
  referencePrice: '8$/人', comment: '下课回程', carNumber: 'PRIVATE-PLATE', zelle: 'yes', ...extra });

test('mini template price mapping passes the real template schema without first-number guessing or float rounding', () => {
  for (const label of ['8', ' 8.50 USD ', '$9.01/人', '8$/人', '12刀', '免费', 'Free', '11-13$', '价格私议',
    '8 /人', '1.005', '8元', '八美元', '２', '', '1000000', '21474836.48']) {
    const actual = toTemplateInput(form({ referencePrice: label }));
    assert.equal(actual.definition.listedPriceCents, parseListedPrice(label).cents, label);
    assert.equal(actual.definition.listedPriceLabel, label);
    assert.equal(createTemplateSchema.safeParse(actual).success, true, label);
    assert.deepEqual(listedPrice(label), { listedPriceCents: parseListedPrice(label).cents, listedPriceLabel: label });
  }
  for (const patch of [{ weekdayIndex: 7 }, { weekdayIndex: 1.2 }, { departureTime: '25:00' },
    { passengerCount: '3abc' }, { passengerCount: 9 }, { referencePrice: '1000000.01' }]) assert.throws(() => toTemplateInput(form(patch)));
  assert.equal(JSON.stringify(toTemplateInput(form())).includes('PRIVATE-PLATE'), false);
  assert.equal('zelle' in toTemplateInput(form()).definition, false);
});

test('mini template roundtrip retains every stop, offset, unknown-price label and existing weekday/DST policy', () => {
  const definition = toTemplateInput(form({ referencePrice: '11-13$' })).definition;
  definition.stops.splice(1, 0, { kind: 'departure', address: 'Pickup B', placeId: 'pickup_b', offsetMinutes: 60 });
  definition.stops.push({ kind: 'destination', address: 'Destination B' });
  const row = { id, ...toTemplateInput(form({ referencePrice: '11-13$' })), definition };
  const legacy = toLegacyTemplate(row, 'owner');
  assert.deepEqual(toTemplateInput(legacy, row), createTemplateSchema.parse(rowWithoutId(row)));
  assert.equal(legacy.weekdayIndex, 1); assert.equal(legacy.referencePrice, '11-13$');
  const updated = toTemplateInput({ ...legacy, departureAddress: 'JFK', comment: 'Only note and first address change' }, row);
  assert.equal(updated.definition.stops[0].placeId, 'jfk');
  assert.deepEqual(updated.definition.stops.slice(1), row.definition.stops.slice(1));
  assert.equal(updated.definition.listedPriceCents, null);
  for (const [now, weekdayIndex, localTime, expected] of [
    ['2026-09-29T19:00:00Z', 1, '15:00', '2026-10-06T19:00:00.000Z'],
    ['2026-03-06T17:00:00Z', 6, '02:30', '2026-03-15T06:30:00.000Z'],
    ['2026-10-30T16:00:00Z', 6, '01:30', '2026-11-01T05:30:00.000Z'],
  ] as const) {
    const payload = createTemplateSchema.parse(toTemplateInput(form({ weekdayIndex, departureTime: localTime })));
    const next = nextWeeklyOccurrence(payload, payload.definition.stops, Date.parse(now));
    assert.equal(next!.stops[0].kind, 'departure');
    assert.equal((next!.stops[0] as { departureAt: string }).departureAt, expected);
    const asLegacy = toLegacyTemplate({ id, ...payload }, 'owner');
    const local = rideTime.getRideDateTime(Date.parse(expected));
    assert.equal(rideTime.getNextWeeklyRideDate(asLegacy.weekdayIndex, asLegacy.departureTime, { now: Date.parse(now) }), local.date);
  }
  assert.throws(() => toLegacyTemplate({ ...row, timeZone: 'Asia/Shanghai' }, 'owner'));
  assert.throws(() => toLegacyTemplate({ ...row, definition: { ...definition, listedPriceCents: 1100 } }, 'owner'));
});
function rowWithoutId(row: any) { const { id: _id, ...rest } = row; return rest; }

test('real mini template adapter and SDK cross owner-scoped HTTP/PG with durable retries and exact stored quotes',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
    const db = await createTestDatabase(), app = Fastify();
    const sessions = sessionService(db.pool, { databaseUrl: '', host: '127.0.0.1', port: 3100,
      appId: 'mini-templates-test', sessionTtlSeconds: 3600 }, async openid => ({ openid }));
    app.setErrorHandler((error, request, reply) => reply.code(error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500)
      .send({ ok: false, error: { code: error instanceof AppError ? error.code : 'INVALID_INPUT' }, requestId: request.id }));
    registerTemplateRoutes(app, { pool: db.pool, requireUser: sessions.requireUser });
    t.after(async () => { await app.close(); await db.close(); });
    const local = new Map<string, any>([['openid', 'synthetic-template-owner'], ['isGuest', false]]);
    const requests: any[] = []; let loseAck = true;
    const wx = {
      getStorageSync: (key: string) => structuredClone(local.get(key)),
      setStorageSync: (key: string, value: unknown) => { local.set(key, structuredClone(value)); },
      removeStorageSync: (key: string) => { local.delete(key); },
      cloud: { async callFunction() { return { result: { ok: true, data: await sessions.login(local.get('openid')) } }; },
        database() { throw new Error('server mode must not access CloudBase'); } },
      request(options: any) {
        requests.push(options);
        void app.inject({ method: options.method, url: options.url.replace('https://collect.linkx.ink', ''), headers: options.header,
          ...(options.data === undefined ? {} : { payload: options.data }) }).then(result => {
          if (options.method === 'POST' && result.statusCode === 201 && loseAck) { loseAck = false; options.fail({}); }
          else options.success({ statusCode: result.statusCode, data: result.json() });
        }).catch(error => options.fail(error));
        return { abort() {} };
      },
    };
    const factory = () => createRideTemplateClient({ wx, backend: createBackendClient({ wx, config: { mode: 'server' } }) });
    let api = factory();
    await assert.rejects(api.saveRideTemplate(form()), { code: 'NETWORK_ERROR' });
    api = factory();
    const changedForm = form({ comment: 'Edited after restart' });
    await assert.rejects(api.saveRideTemplate(changedForm), { code: 'PENDING_OPERATION' });
    const recovered = await api.recoverRideTemplate();
    assert.equal(requests[0].header['Idempotency-Key'], requests[1].header['Idempotency-Key']);
    const saved = await api.saveRideTemplate(changedForm, { id: recovered._id, previous: recovered });
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM ride_templates')).rows[0].n, 1);
    const [item] = await api.loadRideTemplates();
    assert.equal(item.referencePrice, '8$/人'); assert.equal(item.weekdayIndex, 1);
    assert.deepEqual(await api.getRideTemplate(saved._id), item);
    const edited = await api.saveRideTemplate({ ...item, departureTime: '16:00' }, { id: item._id, previous: item });
    assert.deepEqual(requests.at(-1).data, { localTime: '16:00' }, 'unchanged definition is not rewritten');
    const stored = (await db.pool.query('SELECT definition,local_time FROM ride_templates WHERE id=$1', [saved._id])).rows[0];
    assert.equal(stored.definition.listedPriceLabel, '8$/人'); assert.equal(stored.definition.listedPriceCents, 800); assert.equal(stored.local_time, '16:00');
    local.set('openid', 'synthetic-template-stranger'); api = factory();
    assert.deepEqual(await api.loadRideTemplates(), []);
    await assert.rejects(api.getRideTemplate(saved._id), { code: 'TEMPLATE_NOT_FOUND' });
    await assert.rejects(api.deleteRideTemplate(saved._id), { code: 'TEMPLATE_NOT_FOUND' });
    await assert.rejects(api.saveRideTemplate({ ...edited, comment: 'foreign' }, { id: edited._id, previous: edited }), { code: 'INVALID_TEMPLATE' });
    local.set('openid', 'synthetic-template-owner'); api = factory();
    await api.deleteRideTemplate(saved._id);
    assert.deepEqual(await api.loadRideTemplates(), []);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM rides')).rows[0].n, 0);
  });
