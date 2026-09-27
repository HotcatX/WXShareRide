import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { createRideSchema } from '../src/rides/schemas.ts';
import { registerRideRoutes } from '../src/rides/routes.ts';
import { nextWeeklyOccurrence } from '../src/templates/time.ts';
import { sessionService } from '../src/auth/session.ts';
import { AppError } from '../src/errors.ts';
import { parseListedPrice } from '../src/prices.ts';
import { createTestDatabase } from './helpers/database.ts';
const require = createRequire(import.meta.url);
const { createRidePublishClient, toRideInput, templateOccurrence } = require('../../../utils/compat/ridePublish.js');
const { toTemplateInput } = require('../../../utils/compat/rideTemplates.js');
const { createBackendClient } = require('../../../utils/backendClient.js');
const rideTime = require('../../../utils/rideTime.js');
const id = '00000000-0000-4000-8000-000000000001';
const clock = Date.parse('2026-10-30T16:00:00Z');
const draft = (extra = {}) => ({ kind: 'offer', cityKey: 'ny_nj', openid: 'synthetic-publish-owner',
  departureAddress: 'Fort Lee', destinationAddress: '哥大', departureDate: '2026-11-01', departureTime: '01:30',
  passengerCount: 3, referencePrice: '8$/人', comment: '', ...extra });

test('publish adapter produces the real ride schema, preserves quoted labels and never carries profile or identity payloads', () => {
  for (const kind of ['offer', 'request']) for (const label of ['8', '$9.01/人', '免费', '包车110USD', '30-40$', '参考打车价格', '8元', '1.005']) {
    const body = toRideInput(draft({ kind, referencePrice: label, phone: 'PRIVATE', showZelle: true }), clock);
    assert.equal(createRideSchema.safeParse(body).success, true, label);
    assert.equal(body.listedPriceCents, parseListedPrice(label).cents);
    assert.equal(body.listedPriceLabel, label);
    assert.equal(body.stops[0].departureAt, '2026-11-01T05:30:00.000Z');
    for (const secret of ['openid', 'phone', 'showZelle']) assert.equal(secret in body, false);
  }
  for (const patch of [{ kind: 'request', passengerCount: 5 }, { passengerCount: '2.5' }, { passengerCount: 9 },
    { cityKey: 'invalid' }, { departureTime: '25:00' }, { departureDate: '2026-10-29' }, { departureDate: '2026-12-01' }]) {
    assert.throws(() => toRideInput(draft(patch), clock));
  }
});

test('weekly publish preserves all stops and wall-clock offsets across DST and rejects a gap at any departure', () => {
  const template = { id, ...toTemplateInput({ ...draft(), templateName: '每周日', weekdayIndex: 6 }) };
  template.definition.stops.splice(1, 0, { kind: 'departure', address: 'Pickup B', offsetMinutes: 60 });
  template.definition.stops.push({ kind: 'destination', address: 'Destination B' });
  for (const [now, localTime] of [['2026-03-06T17:00:00Z', '01:30'], ['2026-10-30T16:00:00Z', '01:30']] as const) {
    template.localTime = localTime;
    const expected = nextWeeklyOccurrence(template, template.definition.stops, Date.parse(now));
    const occurrence = templateOccurrence(template, Date.parse(now));
    assert.deepEqual(occurrence.stops, expected!.stops);
    const body = toRideInput(draft({ template, departureDate: occurrence.date, departureTime: localTime }), Date.parse(now));
    assert.deepEqual(body.stops, expected!.stops);
    assert.equal(createRideSchema.safeParse(body).success, true);
    assert.equal(body.stops.length, 4);
  }
  assert.throws(() => toRideInput(draft({ template, departureDate: '2026-03-08' }), Date.parse('2026-03-06T17:00:00Z')));
  template.definition.stops[1].offsetMinutes = -1;
  assert.throws(() => templateOccurrence(template, clock));
});

test('real publish SDK and HTTP/PG recover original intent after lost or malformed ACK without a second ride',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
    const db = await createTestDatabase(), app = Fastify();
    const sessions = sessionService(db.pool, { databaseUrl: '', host: '127.0.0.1', port: 3100,
      appId: 'mini-publish-test', sessionTtlSeconds: 3600 }, async openid => ({ openid }));
    app.setErrorHandler((error, request, reply) => reply.code(error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500)
      .send({ ok: false, error: { code: error instanceof AppError ? error.code : 'INVALID_INPUT' }, requestId: request.id }));
    registerRideRoutes(app, { pool: db.pool, requireUser: sessions.requireUser });
    t.after(async () => { await app.close(); await db.close(); });
    const local = new Map<string, any>([['openid', 'synthetic-publish-owner'], ['isGuest', false]]);
    const requests: any[] = []; let responseMode = 'drop';
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
          if (result.statusCode === 201 && responseMode === 'drop') { responseMode = ''; options.fail({}); }
          else if (result.statusCode === 201 && responseMode === 'malformed') { responseMode = ''; options.success({ statusCode: 201, data: { ok: true, data: { rideId: 'bad' } } }); }
          else options.success({ statusCode: result.statusCode, data: result.json() });
        }).catch(error => options.fail(error));
        return { abort() {} };
      },
    };
    const factory = () => createRidePublishClient({ wx, backend: createBackendClient({ wx, config: { mode: 'server' } }) });
    let api = factory();
    const future = rideTime.getRideDateTime(Date.now() + 2 * 86400000);
    const original = draft({ departureDate: future.date, departureTime: future.time, referencePrice: '包车110USD' });
    await assert.rejects(api.publishRide(original), { code: 'NETWORK_ERROR' });
    api = factory();
    // Even an expired/invalid replacement form confirms the exact old intent.
    const recovered = await api.publishRide(draft({ kind: 'request', departureDate: '2000-01-01' }));
    assert.equal(recovered.recovered, true); assert.equal(recovered.payload, undefined);
    assert.equal(requests[0].header['Idempotency-Key'], requests[1].header['Idempotency-Key']);
    let rows = (await db.pool.query('SELECT id,kind,listed_price_cents,listed_price_label FROM rides')).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].id, recovered.id); assert.equal(rows[0].kind, 'offer');
    assert.equal(rows[0].listed_price_cents, null); assert.equal(rows[0].listed_price_label, '包车110USD');
    responseMode = 'malformed';
    await assert.rejects(api.publishRide({ ...original, kind: 'request', passengerCount: 2 }), { code: 'INVALID_RESPONSE' });
    api = factory(); const confirmed = await api.recoverPublishedRide();
    assert.equal(confirmed.recovered, true);
    rows = (await db.pool.query('SELECT id,kind FROM rides ORDER BY created_at')).rows;
    assert.equal(rows.length, 2); assert.equal(rows[1].kind, 'request'); assert.equal(rows[1].id, confirmed.id);
    assert.equal(await api.recoverPublishedRide(), null);
    assert.equal(requests[2].header['Idempotency-Key'], requests[3].header['Idempotency-Key']);
  });
