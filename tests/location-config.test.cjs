const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { createLocationClient } = require('../utils/locationConfig')
const catalog = require('../utils/locationCatalog.generated')
const copy = value => JSON.parse(JSON.stringify(value))

test('location client shares reads, caches only verified nonempty responses and isolates caller mutations', async () => {
  let now = 1000, calls = 0, release
  const flight = new Promise(resolve => { release = resolve })
  const client = createLocationClient({ isBackendEnabled: () => true,
    get: async (url, options) => { calls++; assert.equal(url, '/api/v1/locations'); assert.deepEqual(options, { public: true }); return calls === 1 ? flight : copy(catalog) } }, () => now)
  const first = client.load(), second = client.load({ force: true })
  release(copy(catalog))
  const [one, two] = await Promise.all([first, second]); assert.equal(calls, 1)
  one.regionTree.length = 0; assert.equal(two.regionTree.length, 3)
  now += 299999; assert.equal((await client.load()).regionTree.length, 3); assert.equal(calls, 1)
  now++; await client.load(); assert.equal(calls, 2)
  now--; await client.load(); assert.equal(calls, 3)
})

test('disabled mode cannot use HTTP, and errors/empty results do not poison the retry cache', async () => {
  const disabled = createLocationClient({ isBackendEnabled: () => false, get: () => assert.fail('unexpected HTTP') })
  await assert.rejects(disabled.load())
  for (const invalid of [null, {}, { ...copy(catalog), regionTree: [] },
    { ...copy(catalog), rideAddresses: { offer: { fromPlaces: [], toPlaces: [] } } },
    { ...copy(catalog), cityTree: { countries: [{ groups: [] }] } },
    { ...copy(catalog), marketRegionTree: { states: [{ areas: [] }] } }]) {
    let calls = 0
    const client = createLocationClient({ isBackendEnabled: () => true, get: async () => ++calls === 1 ? invalid : copy(catalog) })
    await assert.rejects(client.load(), /配置格式/)
    assert.deepEqual(await client.load(), catalog); assert.equal(calls, 2)
  }
  let calls = 0
  const client = createLocationClient({ isBackendEnabled: () => true, get: async () => { if (++calls === 1) throw new Error('offline'); return copy(catalog) } })
  await assert.rejects(client.load(), /offline/); assert.deepEqual(await client.load(), catalog)
})

test('server mode adapts all existing config readers without CloudBase calls and does not hide request errors', async () => {
  const backend = { isBackendEnabled: () => true }
  let error = null, reads = 0, preview = false
  const storage = {}
  const loadLocationConfig = async () => { reads++; if (error) throw error; return copy(catalog) }
  function load(name) {
    const module = { exports: {} }
    const filename = path.join(__dirname, '../utils', name)
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, console, Date,
      require: value => value === './backendClient' ? backend : value === './locationConfig' ? { loadLocationConfig }
        : value === './timeline' ? { isTimelinePreview: () => preview } : require(path.join(path.dirname(filename), value)),
      wx: { cloud: { database: () => assert.fail('unexpected cloud DB'), callFunction: () => assert.fail('unexpected function') },
        getStorageSync: key => storage[key], setStorageSync: (key, value) => { storage[key] = value } } })
    return module.exports
  }
  const address = load('rideAddressConfig.js'), city = load('cityTree.js'), marketRegion = load('regionTree.js'), region = load('Region.js')
  assert.deepEqual(copy(await address.loadRideAddressConfig()), catalog.rideAddresses.offer)
  assert.deepEqual(copy(await city.loadCityTreeConfig()), copy(city.normalizeCityTree(catalog.cityTree)))
  assert.deepEqual(copy((await marketRegion.loadRegionTreeConfig()).tree), copy(marketRegion.normalizeRegionTree(catalog.marketRegionTree)))
  assert.deepEqual(copy((await region.loadRegionTreeConfig()).tree), catalog.regionTree)
  assert.equal(reads, 4)
  error = new Error('offline')
  await assert.rejects(address.loadRideAddressConfig({ force: true }), /offline/)
  await assert.rejects(city.loadCityTreeConfig(), /offline/)
  await assert.rejects(marketRegion.loadRegionTreeConfig(), /offline/)
  const fallback = await region.loadRegionTreeConfig()
  assert.equal(fallback.fromCloud, false); assert.equal(fallback.fromCache, true)
  assert.deepEqual(copy(fallback.tree), catalog.regionTree)
  assert.equal(fallback.error, error, 'existing UI fallback retains an explicit error')
  const fixed = await region.loadRegionTreeConfig({ useCache: false })
  assert.equal(fixed.fromCache, false); assert.deepEqual(copy(fixed.tree), catalog.regionTree)
  preview = true
  const before = reads
  assert.deepEqual(copy(await city.loadCityTreeConfig()), copy(city.normalizeCityTree(city.DEFAULT_CITY_TREE)))
  assert.equal((await marketRegion.loadRegionTreeConfig()).fromCloud, false)
  assert.equal(reads, before, 'timeline preview uses fixed defaults without a server request')
})
