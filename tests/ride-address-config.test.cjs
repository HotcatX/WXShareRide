const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createLocationClient } = require('../utils/locationConfig')
const catalog = require('../utils/locationCatalog.generated')
const plain = value => JSON.parse(JSON.stringify(value))
const defaults = require('../utils/placeCatalog').FIXED_PLACES.map(place => place.value)
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function harness() {
  const state = { now: 1000, enabled: true, reads: [], queue: [], catalog: plain(catalog) }
  const backend = { isBackendEnabled: () => state.enabled, async get(url, options) {
    state.reads.push(url)
    assert.equal(url, '/api/v1/locations'); assert.deepEqual(options, { public: true })
    return state.queue.length ? state.queue.shift().promise : plain(state.catalog)
  } }
  const client = createLocationClient(backend, () => state.now)
  class Clock extends Date { static now() { return state.now } }
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/rideAddressConfig.js'), 'utf8'), {
    module, Date: Clock,
    require(name) {
      if (name === './backendClient') return backend
      if (name === './locationConfig') return { loadLocationConfig: options => client.load(options) }
      if (name === './placeCatalog') return require('../utils/placeCatalog')
      throw new Error(name)
    },
    wx: { cloud: { database: () => assert.fail('no direct collection reads') } }
  })
  return { api: module.exports, state, hold() { const value = deferred(); state.queue.push(value); return value } }
}

test('ride options preserve canonical server order and current labels, with a complete fixed offline catalog', async () => {
  const { api, state } = harness()
  state.catalog.rideAddresses.offer.fromPlaces.push('广场')
  state.catalog.rideAddresses.offer.toPlaces.push('博物馆')
  assert.deepEqual(plain(await api.loadRideAddressConfig()), state.catalog.rideAddresses.offer)
  assert.deepEqual(state.reads, ['/api/v1/locations'])
  assert.deepEqual(plain(api.getStaticRideAddressConfig()), { fromPlaces: defaults, toPlaces: defaults })
  assert.equal(api.ADDRESS_CONFIG_CACHE_MS, 300000)
  state.catalog.rideAddresses.offer.fromPlaces = [...defaults, '新广场']
  state.catalog.rideAddresses.offer.toPlaces = [...defaults, '新地点']
  assert.deepEqual(plain(await api.loadRideAddressConfig({ force: true })), state.catalog.rideAddresses.offer)
})

test('pages share in-flight reads, receive independent arrays and reuse verified configuration for exactly five minutes', async () => {
  const { api, state, hold } = harness(), held = hold()
  const first = api.loadRideAddressConfig(), second = api.loadRideAddressConfig({ force: true })
  await Promise.resolve()
  assert.deepEqual(state.reads, ['/api/v1/locations'])
  assert.equal(api.getCachedRideAddressConfig(), null)
  held.resolve(plain(catalog))
  const [a, b] = await Promise.all([first, second])
  a.fromPlaces.push('local edit')
  assert.deepEqual(plain(b), catalog.rideAddresses.offer)
  api.getCachedRideAddressConfig().toPlaces.push('another local edit')
  state.now += 299999
  assert.deepEqual(plain(await api.loadRideAddressConfig()), catalog.rideAddresses.offer)
  assert.equal(state.reads.length, 1)
  state.now++
  assert.equal(api.getCachedRideAddressConfig(), null)
  await api.loadRideAddressConfig()
  assert.equal(state.reads.length, 2)
})

test('invalid and failed responses never become a successful cache and the next page can retry', async () => {
  for (const invalid of [null, {}, { offer: {} }, { offer: { fromPlaces: [], toPlaces: ['哥大'] } },
    { offer: { fromPlaces: ['Fort Lee'], toPlaces: [' '] } }]) {
    const { api, state } = harness()
    state.catalog.rideAddresses = invalid
    await assert.rejects(api.loadRideAddressConfig(), /配置格式/)
    assert.equal(api.getCachedRideAddressConfig(), null)
    state.catalog = plain(catalog)
    assert.deepEqual(plain(await api.loadRideAddressConfig()), catalog.rideAddresses.offer)
    assert.equal(state.reads.length, 2)
  }
  const { api, state, hold } = harness(), held = hold()
  const failed = api.loadRideAddressConfig()
  held.reject(new Error('offline'))
  await assert.rejects(failed, /offline/)
  assert.equal(api.getCachedRideAddressConfig(), null)
  await api.loadRideAddressConfig()
  assert.equal(state.reads.length, 2)
})

test('clock rollback and authority changes cannot reuse stale choices; failed refresh preserves only the completed cache', async () => {
  const { api, state, hold } = harness()
  const original = plain(await api.loadRideAddressConfig())
  const held = hold(), failed = api.loadRideAddressConfig({ force: true })
  held.reject(new Error('offline'))
  await assert.rejects(failed, /offline/)
  assert.deepEqual(plain(api.getCachedRideAddressConfig()), original)
  state.now--
  assert.equal(api.getCachedRideAddressConfig(), null)
  state.catalog.rideAddresses.offer.fromPlaces.push('新地点')
  await api.loadRideAddressConfig()
  assert.equal(state.reads.length, 3)
  assert.ok(api.getCachedRideAddressConfig().fromPlaces.includes('新地点'))
  state.enabled = false
  assert.equal(api.getCachedRideAddressConfig(), null)
  await assert.rejects(api.loadRideAddressConfig(), /地点服务尚未切换/)
  assert.equal(state.reads.length, 3)
})
