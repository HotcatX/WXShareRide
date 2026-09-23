const test = require('node:test')
const assert = require('node:assert/strict')
const loadModules = require('./helpers/load-place-modules.cjs')
const { resolvePlaceId, FIXED_PLACES } = require('../utils/placeCatalog')
const { makeRidePlaceMatcher, ridePlaceAliasPattern } = require('../utils/ridePlaceOptions')
const { validateEvent } = require('../utils/researchSchema')
const plain = value => JSON.parse(JSON.stringify(value))
function held() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function harness() {
  const state = { now: 1800000000000, scope: undefined, storage: { openid: 'user_a' }, calls: [], telemetry: [], response: null }
  class Clock extends Date { static now() { return state.now } }
  const response = () => ({ ok: true, snapshotId: 'snapshot_test_00000001', catalogVersion: 'places-v1', rankingVersion: 'circle-selection-v1', preferenceVersion: 'pref-v1', generatedAt: state.now, circles: [{ circleId: 'fort_lee_columbia', stable: true }], rankingBasis: 'confirmed_selection', places: [{ placeId: 'poi_station_a', label: '公共站点', source: 'circle' }, { placeId: 'poi_library_b', label: '公共图书馆', source: 'new' }] })
  const api = loadModules({ Date: Clock, wx: { getStorageSync: key => state.storage[key], setStorageSync: (key, value) => { state.storage[key] = plain(value) } } }, {
    getCollectionScope: () => state.scope === undefined ? 'test:' + state.storage.openid : state.scope,
    requestPlaceSuggestions: data => { state.calls.push(plain(data)); return state.response || Promise.resolve(response()) },
    recordEvent: (name, data) => { state.telemetry.push({ name, data: plain(data) }); return { ok: true } }
  })
  return { api: api('placeRecommendations'), telemetry: api('placePickerTelemetry'), state, response }
}
const context = { cityKey: 'ny_nj', field: 'departure', mode: 'driver', counterpartPlaceId: 'columbia' }

test('standard IDs and aliases do not conflate Newark city, Jersey City or Long Island with airports/neighborhoods', () => {
  assert.deepEqual(FIXED_PLACES.map(place => place.placeId), ['fort_lee', 'columbia', 'flushing', 'jfk', 'ewr', 'lga', 'lic', 'jsq'])
  for (const value of ['Newark', '纽瓦克', 'Newark Broad Street', 'Long Island', 'Jersey City', 'LIC apt 8', 'EWR Terminal C']) assert.equal(resolvePlaceId(value), 'unknown', value)
  for (const [value, id] of [['Long Island City', 'lic'], ['Journal Square', 'jsq'], ['Newark Airport', 'ewr'], ['哥伦比亚大学', 'columbia']]) assert.equal(resolvePlaceId(value), id)
  assert.equal(makeRidePlaceMatcher('Fort Lee 某公寓')('Fort Lee 另一公寓'), false)
  assert.equal(makeRidePlaceMatcher('哥大图书馆门口')('哥大其他接送点'), false)
  assert.equal(makeRidePlaceMatcher('EWR')('Newark Penn Station'), false)
  assert.equal(makeRidePlaceMatcher('EWR')('EWR Terminal C'), true)
  assert.equal(makeRidePlaceMatcher('LIC')('Long Island'), false)
  assert.equal(makeRidePlaceMatcher('JSQ')('Jersey City'), false)
  assert.equal(new RegExp(ridePlaceAliasPattern('EWR')).test('纽瓦克'), true, 'legacy fare compatibility is limited to the price lookup')
  assert.equal(ridePlaceAliasPattern('纽瓦克'), '', 'an explicit city selection never turns into an airport-price query')
})

test('direct suggestions coalesce, expire after five minutes and isolate field/counterpart/mode/mutation revisions', async () => {
  const { api, state, response } = harness(), wait = held()
  state.response = wait.promise
  const first = api.loadPlaceRecommendations(context), second = api.loadPlaceRecommendations({ ...context, force: true })
  assert.equal(state.calls.length, 1)
  assert.deepEqual(state.calls[0], { schemaVersion: 1, ...context })
  wait.resolve(response())
  const [one, two] = await Promise.all([first, second])
  one.places[0].label = 'changed locally'
  assert.equal(two.places[0].label, '公共站点')
  state.response = null
  state.now += 299999
  await api.loadPlaceRecommendations(context)
  assert.equal(state.calls.length, 1)
  state.now += 1
  await api.loadPlaceRecommendations(context)
  for (const extra of [{ field: 'destination' }, { counterpartPlaceId: 'flushing' }, { mode: 'passenger' }, { revision: 9 }]) await api.loadPlaceRecommendations({ ...context, ...extra })
  assert.equal(state.calls.length, 6)
})

test('own recent addresses persist per account, exclude fixed duplicates and never appear in telemetry payloads or requests', async () => {
  const { api, state } = harness()
  for (const text of ['Apt 1 private', 'Apt 2 private', 'Apt 3 private', 'Fort Lee', '哥大', 'JFK']) { api.rememberPlace(text, context); state.now++ }
  assert.deepEqual(plain(api.getCachedPlaceRecommendations(context).places.map(row => row.value)), ['Apt 3 private', 'Apt 2 private', 'Apt 1 private'])
  api.rememberPlace('Apt 4 private', context)
  await api.loadPlaceRecommendations(context)
  assert.equal(JSON.stringify(state.calls).includes('private'), false)
  state.storage.openid = 'user_b'
  assert.deepEqual(plain(api.getCachedPlaceRecommendations(context).places), [])
  state.storage.openid = 'user_a'
  assert.equal(api.getCachedPlaceRecommendations(context).places[0].value, 'Apt 4 private')
  state.storage.isGuest = true
  assert.deepEqual(plain(api.getCachedPlaceRecommendations(context).places), [])
  const calls = state.calls.length
  await api.loadPlaceRecommendations(context)
  assert.equal(state.calls.length, calls)
})

test('old-account responses, malformed service results and offline failures fall back without leaking candidates', async () => {
  const { api, state, response } = harness(), wait = held()
  state.response = wait.promise
  const old = api.loadPlaceRecommendations(context)
  state.storage.openid = 'user_b'
  api.getCachedPlaceRecommendations(context)
  wait.resolve(response())
  assert.deepEqual(plain((await old).places), [])
  for (const result of [null, { ok: true, places: [{}] }, { ...response(), circles: {} }, { ...response(), catalogVersion: 'invalid version with spaces' }, { ...response(), generatedAt: -1 }, { ...response(), places: [{ placeId: 'custom', label: 'private', source: 'circle' }] }]) {
    state.response = Promise.resolve(result)
    const data = await api.loadPlaceRecommendations({ ...context, force: true })
    assert.deepEqual(plain(data.places), [])
  }
  state.response = Promise.reject(new Error('offline'))
  assert.deepEqual(plain((await api.loadPlaceRecommendations({ ...context, force: true })).places), [])
  state.response = null
  assert.equal((await api.loadPlaceRecommendations(context)).places.length, 2, 'failure was not cached as a successful public list')
})

test('picker telemetry records separate render/visible stages and never emits private labels; close/identity prevent late events', () => {
  const { api, telemetry, state } = harness()
  const session = telemetry.createPlacePickerSession(context, api.getCachedPlaceRecommendations(context))
  const rows = [{ placeId: 'fort_lee', value: 'Fort Lee', source: 'fixed' }, { placeId: 'custom', value: 'Apt 123 private', source: 'personal' }]
  telemetry.renderPlaces(session, rows)
  telemetry.renderPlaces(session, rows)
  telemetry.renderPlaces(session, [rows[0]], 'visible')
  telemetry.selectPlace(session, rows[1], 1)
  telemetry.closePlacePicker(session, 'close')
  assert.deepEqual(state.telemetry.map(event => event.name), ['place_picker_open', 'place_picker_rendered', 'place_picker_rendered', 'place_picker_selected'])
  assert.equal(JSON.stringify(state.telemetry).includes('private'), false)
  for (const [index, event] of state.telemetry.entries()) {
    assert.equal(validateEvent({ eventId: 'test_event_0000000' + index, eventName: event.name, schemaVersion: 1, occurredAt: state.now, data: event.data }, state.now), true, event.name)
  }
  const second = telemetry.createPlacePickerSession(context, api.getCachedPlaceRecommendations(context))
  const count = state.telemetry.length
  state.storage.openid = 'different_user'
  telemetry.selectPlace(second, rows[0], 0)
  assert.equal(state.telemetry.length, count)
})

test('All and Other filter controls do not masquerade as place impressions or ranking votes', () => {
  const { api, telemetry, state } = harness()
  const session = telemetry.createPlacePickerSession(context, api.getCachedPlaceRecommendations(context))
  const rows = [{ value: '', placeId: 'unknown', source: 'fixed', filterToken: true, position: 0 },
    { value: 'Fort Lee', placeId: 'fort_lee', source: 'fixed', position: 1 },
    { value: '其他', placeId: 'unknown', source: 'fixed', filterToken: true, position: 2 }]
  telemetry.renderPlaces(session, rows)
  assert.deepEqual(state.telemetry.at(-1).data.items, [{ placeId: 'fort_lee', source: 'fixed', position: 1 }])
  telemetry.selectPlace(session, rows[0], 0)
  assert.equal(state.telemetry.some(event => event.name === 'place_picker_selected'), false)
})

test('cold authorization migrates one cached response to the ready scope without a second server request', async () => {
  const { api, state, response } = harness(), pending = held()
  state.scope = ''
  state.response = pending.promise
  const first = api.loadPlaceRecommendations(context)
  assert.equal(state.calls.length, 1)
  state.scope = 'test:participant_12345678:1'
  const joining = api.loadPlaceRecommendations(context)
  assert.equal(state.calls.length, 1, 'a second caller shares the pending cold-authorized request')
  pending.resolve(response())
  await Promise.all([first, joining])
  assert.equal(api.getCachedPlaceRecommendations(context).places[0].placeId, 'poi_station_a')
  await api.loadPlaceRecommendations(context)
  assert.equal(state.calls.length, 1, 'reopening uses the grant-scoped result from the first request')
  state.scope = ''
  assert.equal(api.getCachedPlaceRecommendations(context).places.length, 0, 'the pre-auth key does not retain the personalized response')
})

test('grant changes discard pending and cached personalized responses and stop old picker telemetry', async () => {
  const { api, telemetry, state, response } = harness(), pending = held()
  state.scope = 'test:participant_12345678:1'
  const session = telemetry.createPlacePickerSession(context, api.getCachedPlaceRecommendations(context))
  state.response = pending.promise
  const first = api.loadPlaceRecommendations(context), joining = api.loadPlaceRecommendations(context)
  state.scope = 'test:participant_12345678:3'
  pending.resolve(response())
  const values = await Promise.all([first, joining])
  for (const value of values) assert.equal(value.places.length, 0)
  assert.equal(api.getCachedPlaceRecommendations(context).places.length, 0)
  const count = state.telemetry.length
  telemetry.selectPlace(session, { placeId: 'fort_lee', source: 'fixed' }, 0)
  assert.equal(state.telemetry.length, count)
})
