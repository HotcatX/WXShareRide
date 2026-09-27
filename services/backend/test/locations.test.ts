import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import Fastify from 'fastify';
import { getLocationCatalog, locationCatalogSchema, registerLocationRoutes } from '../src/locations/routes.ts';
import { marketStateSchema } from '../src/market/schemas.ts';

const require = createRequire(import.meta.url);
test('location assets match their single editable source and existing picker catalog exactly', () => {
  execFileSync(process.execPath, [new URL('../scripts/sync-location-catalog.mjs', import.meta.url).pathname, '--check']);
  const source = require('../../../config/locationCatalog.json');
  const mini = require('../../../utils/locationCatalog.generated.js');
  const catalog = require('../../../utils/placeCatalog.js');
  assert.deepEqual(getLocationCatalog(), source);
  assert.deepEqual(mini, source);
  assert.deepEqual(catalog.FIXED_PLACES, source.fixedPlaces);
  assert.equal(catalog.CATALOG_VERSION, source.placeCatalogVersion);
});

test('offer/request options preserve fixed order and scoped extras; profile and market regions remain distinct', () => {
  const data = getLocationCatalog();
  assert.deepEqual(data.fixedPlaces.slice(0, 3).map(place => place.placeId), ['fort_lee', 'columbia', 'flushing']);
  assert.equal(data.requestPrices.length, 16);
  assert.ok(data.requestPrices.some(row => /包车/.test(row.label)));
  assert.ok(data.requestPrices.every(row => Object.keys(row).sort().join(',') === 'fromAddress,label,toAddress'));
  assert.ok(data.rideAddresses.request.fromPlaces.includes('JC'));
  assert.ok(!data.rideAddresses.offer.fromPlaces.includes('JC'));
  for (const options of Object.values(data.rideAddresses)) {
    assert.equal(options.fromPlaces[0], 'Fort Lee'); assert.equal(options.fromPlaces[1], '哥大');
    for (const name of ['Inwood', '中城', '下城', 'Queens']) assert.ok(options.fromPlaces.includes(name));
    assert.ok(!options.fromPlaces.includes('纽瓦克'));
  }
  assert.deepEqual(data.regionTree.map(state => state.key), ['NY', 'NJ', 'OTHER']);
  assert.ok(data.regionTree.find(state => state.key === 'NJ')!.groups.find(group => group.key === 'Fort Lee')!.areas.includes('Fort Lee 核心区'));
  for (const state of data.marketRegionTree.states) assert.equal(marketStateSchema.parse(state.key), state.key);
  assert.ok(!new Set<string>(data.marketRegionTree.states.map(state => state.key)).has('OTHER'));
  data.regionTree.length = 0;
  assert.equal(getLocationCatalog().regionTree.length, 3, 'one consumer cannot edit the shared response');
});

test('empty or contradictory static configuration is rejected rather than published as a successful fallback', () => {
  for (const edit of [
    (value: any) => { value.regionTree = []; },
    (value: any) => { value.rideAddresses.offer.fromPlaces = []; },
    (value: any) => { value.requestPrices.push(value.requestPrices[0]); },
    (value: any) => { value.requestPrices[0].label = ""; },
    (value: any) => { value.marketRegionTree.states[0].areas = []; },
    (value: any) => { value.fixedPlaces.push(value.fixedPlaces[0]); },
    (value: any) => { value.internalSecret = 'must-not-appear'; },
  ]) {
    const value = getLocationCatalog(); edit(value);
    assert.equal(locationCatalogSchema.safeParse(value).success, false);
  }
});

test('public location HTTP route returns the validated catalog and rejects selector/query injection', async t => {
  const app = Fastify(); t.after(() => app.close());
  app.setErrorHandler((error, _request, reply) => reply.code(400).send({ ok: false }));
  registerLocationRoutes(app);
  const result = await app.inject({ method: 'GET', url: '/api/v1/locations' });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json().data, getLocationCatalog());
  assert.equal(result.headers['cache-control'], 'public, max-age=300');
  assert.equal(result.headers['access-control-allow-origin'], '*');
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/locations?collection=userInfo' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/locations', payload: {} })).statusCode, 404);
});
