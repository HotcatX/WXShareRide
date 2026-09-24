const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const defaults = require('../utils/placeCatalog').fixedPlaceValues()
const plain = value => JSON.parse(JSON.stringify(value))

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness() {
  const state = {
    now: 1800000000000, reads: [], queues: new Map(),
    documents: {
      Departure: [{ _id: 'from', jfk: 'JFK机场', plaza: '广场', flushing: 'Flushing', lga: 'LGA', campus: '哥大', ewr: 'Newark Airport', fortLee: 'Fort Lee 核心区' }],
      Arrival: [{ _id: 'to', custom: '博物馆', airport: 'EWR机场', campus: '哥大', fortLee: 'Fort Lee' }]
    }
  }
  class Clock extends Date { static now() { return state.now } }
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/rideAddressConfig.js'), 'utf8'), {
    module, Date: Clock,
    require: name => require('../utils/' + (name.includes('placeCatalog') ? 'placeCatalog' : 'ridePlaceOptions')),
    wx: { cloud: { database: () => ({ collection(name) {
      assert.ok(['Departure', 'Arrival'].includes(name))
      return { get() {
        state.reads.push(name)
        const queue = state.queues.get(name)
        if (queue?.length) return queue.shift().promise
        return Promise.resolve({ data: plain(state.documents[name]) })
      } }
    } }) } }
  })
  const hold = name => {
    const held = deferred()
    const queue = state.queues.get(name) || []
    queue.push(held)
    state.queues.set(name, queue)
    return held
  }
  return { api: module.exports, state, hold }
}

test('shared fixed configuration reads existing collection values and keeps the fixed catalog, shared order and configured price keys', async () => {
  const { api, state } = harness()
  const result = await api.loadRideAddressConfig()
  assert.deepEqual(plain(result), {
    fromPlaces: ['Fort Lee 核心区', '哥大', 'Flushing', 'JFK机场', 'Newark Airport', 'LGA', 'LIC', 'JSQ', 'Inwood', '中城', '下城', 'Queens', '广场'],
    toPlaces: ['Fort Lee', '哥大', '法拉盛', 'JFK', 'EWR机场', 'LGA 机场', 'LIC', 'JSQ', 'Inwood', '中城', '下城', 'Queens', '博物馆']
  })
  assert.deepEqual(state.reads, ['Departure', 'Arrival'])
  assert.equal(api.ADDRESS_CONFIG_CACHE_MS, 300000)
  state.documents.Departure = [{ _id: 'from', jfk: 'JFK', plaza: '新广场' }]
  state.documents.Arrival = [{ _id: 'to', last: '新地点' }]
  const replaced = await api.loadRideAddressConfig({ force: true })
  assert.deepEqual(plain(replaced), { fromPlaces: [...defaults, '新广场'], toPlaces: [...defaults, '新地点'] }, 'curated fixed places survive configuration gaps; removed custom places do not')
})

test('pages share in-flight reads, receive independent arrays and reuse successful configuration for exactly five minutes', async () => {
  const { api, state, hold } = harness()
  const from = hold('Departure'), to = hold('Arrival')
  const first = api.loadRideAddressConfig()
  const second = api.loadRideAddressConfig({ force: true })
  assert.deepEqual(state.reads, ['Departure', 'Arrival'])
  assert.equal(api.getCachedRideAddressConfig(), null)
  from.resolve({ data: [{ airport: 'EWR', duplicate: '纽瓦克' }] })
  to.resolve({ data: [{ campus: '哥大' }] })
  const [a, b] = await Promise.all([first, second])
  a.fromPlaces.push('local edit')
  assert.deepEqual(plain(b), { fromPlaces: defaults.map(value => value === 'EWR 机场' ? 'EWR' : value), toPlaces: defaults })
  const cached = api.getCachedRideAddressConfig()
  cached.toPlaces.push('another local edit')
  state.now += 299999
  assert.deepEqual(plain(await api.loadRideAddressConfig()), { fromPlaces: defaults.map(value => value === 'EWR 机场' ? 'EWR' : value), toPlaces: defaults })
  assert.equal(state.reads.length, 2)
  state.now++
  assert.equal(api.getCachedRideAddressConfig(), null)
  await api.loadRideAddressConfig()
  assert.equal(state.reads.length, 4)
})

test('failed or incomplete configuration is not cached and the next page can retry both collections', async () => {
  for (const invalid of [[], [null], [{}], [{ _id: 'no-places' }], [{ bad: [] }], [{ bad: true }], [{ bad: ' ' }]]) {
    const { api, state } = harness()
    state.documents.Arrival = invalid
    await assert.rejects(api.loadRideAddressConfig())
    assert.equal(api.getCachedRideAddressConfig(), null)
    state.documents.Arrival = [{ good: '哥大' }]
    assert.deepEqual(plain((await api.loadRideAddressConfig()).toPlaces), defaults)
    assert.equal(state.reads.length, 4)
  }
  const { api, state, hold } = harness()
  const from = hold('Departure')
  const failed = api.loadRideAddressConfig()
  from.reject(new Error('offline'))
  await assert.rejects(failed, /offline/)
  assert.equal(api.getCachedRideAddressConfig(), null)
  await api.loadRideAddressConfig()
  assert.equal(state.reads.length, 4)
})

test('clock rollback forces a fresh configuration read and failure cannot replace a completed cache with partial data', async () => {
  const { api, state, hold } = harness()
  const original = plain(await api.loadRideAddressConfig())
  const failedArrival = hold('Arrival')
  state.documents.Departure = [{ replacement: '未完成更新' }]
  const failed = api.loadRideAddressConfig({ force: true })
  failedArrival.reject(new Error('offline'))
  await assert.rejects(failed)
  assert.deepEqual(plain(api.getCachedRideAddressConfig()), original)
  state.now--
  assert.equal(api.getCachedRideAddressConfig(), null)
  await api.loadRideAddressConfig()
  assert.equal(state.reads.length, 6)
  assert.deepEqual(plain(api.getCachedRideAddressConfig().fromPlaces), [...defaults, '未完成更新'])
})
