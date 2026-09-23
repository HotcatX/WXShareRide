const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const SOURCE_PATH = path.join(__dirname, '../utils/driverRecentRoutes.js')
const DAY_MS = 24 * 60 * 60 * 1000
const BASE_NOW = Date.parse('2026-09-23T00:00:00Z')
const CACHE_PREFIX = 'driver_recent_routes_v1:'
const plain = value => JSON.parse(JSON.stringify(value))

function harness(options = {}) {
  const state = {
    now: BASE_NOW, rows: [], queries: [], failRead: false, failWrite: false,
    ...(options.state || {})
  }
  const storage = options.storage || new Map([['openid', 'driver-a']])
  const chain = {
    where(value) { state.query.where = value; return this },
    field(value) { state.query.field = value; return this },
    orderBy(...value) { state.query.orderBy = value; return this },
    limit(value) { state.query.limit = value; return this },
    get() {
      state.queries.push(plain(state.query))
      if (state.deferred) return state.deferred
      return state.failRead ? Promise.reject(new Error('offline')) : Promise.resolve({ data: state.rows })
    }
  }
  const wx = {
    getStorageSync(key) { if (state.failReadStorage) throw new Error('unavailable'); return storage.get(key) },
    setStorageSync(key, value) {
      if (state.failWrite) throw new Error('quota exceeded')
      storage.set(key, plain(value))
    },
    cloud: { database: () => ({ collection(name) { state.query = { collection: name }; return chain } }) }
  }
  class FakeDate extends Date { static now() { return state.now } }
  const context = {
    wx, Date: FakeDate, console, module: { exports: {} },
    require(name) { return require(path.resolve(path.dirname(SOURCE_PATH), name)) }
  }
  vm.runInNewContext(fs.readFileSync(SOURCE_PATH, 'utf8'), context, { filename: SOURCE_PATH })
  return { api: context.module.exports, state, storage }
}

function trip(overrides = {}) {
  return {
    _id: 'trip-1', _openid: 'driver-a', cityKey: 'ny_nj',
    departures: [{ address: 'Fort Lee', date: '2026-09-20', time: '08:00' }],
    destinations: [{ address: '哥大' }], passengerCount: 4,
    referencePrice: '8$/人', comment: '正门见', createdAt: BASE_NOW - DAY_MS,
    ...overrides
  }
}

test('loads only own published driver routes with bounded query, no old dates or participant details', async () => {
  const { api, state, storage } = harness()
  state.rows = [trip({ passengers: ['passenger'], phone: 'private', zelle: 'yes', carNumber: 'ABC' }), trip({ _openid: 'someone-else' })]
  const rows = plain(await api.loadRecentDriverRoutes('driver-a'))
  assert.equal(rows.length, 1)
  assert.deepEqual(state.queries[0], {
    collection: 'Carpool', where: { _openid: 'driver-a' },
    field: { _id: true, _openid: true, departures: true, destinations: true, passengerCount: true,
      referencePrice: true, comment: true, createdAt: true, cityKey: true },
    orderBy: ['createdAt', 'desc'], limit: 20
  })
  assert.deepEqual(Object.keys(rows[0]).sort(), ['_id', 'departureAddress', 'destinationAddress', 'departureTime',
    'passengerCount', 'referencePrice', 'comment', 'cityKey', 'shortcutTitle', 'lastPublishedAt'].sort())
  assert.equal(rows[0].shortcutTitle, '去学校')
  assert.equal(rows[0].lastPublishedAt, BASE_NOW - DAY_MS)
  assert.equal(rows[0].referencePrice, '8$/人')
  const saved = JSON.stringify(storage.get(CACHE_PREFIX + 'driver-a'))
  for (const privateText of ['someone-else', 'private', 'passengers', 'carNumber', 'zelle', '2026-09-20']) {
    assert.equal(saved.includes(privateText), false)
  }
})

test('deduplicates direction and time, retains latest fare, seats and comment, keeps reverse and other time', async () => {
  const { api, state } = harness()
  state.rows = [
    trip({ referencePrice: '10', passengerCount: 2, comment: '最新', createdAt: BASE_NOW - 1000 }),
    trip({ createdAt: BASE_NOW - 10000 }),
    trip({ departures: [{ address: '哥大', date: '2026-09-20', time: '08:00' }], destinations: [{ address: 'Fort Lee' }] }),
    trip({ departures: [{ address: 'Fort Lee', date: '2026-09-20', time: '09:00' }] })
  ]
  const rows = await api.loadRecentDriverRoutes('driver-a')
  assert.equal(rows.length, 3)
  assert.equal(rows[0].referencePrice, '10')
  assert.equal(rows[0].passengerCount, 2)
  assert.equal(rows[0].comment, '最新')
  assert.ok(rows.some(row => row.shortcutTitle === '回程'))
  assert.equal(rows.filter(row => row.departureTime === '09:00').length, 1)
})

test('persistent cache avoids another query for 24 hours and does not renew original publish times', async () => {
  const first = harness()
  first.state.rows = [trip()]
  const expected = plain(await first.api.loadRecentDriverRoutes('driver-a'))
  first.state.now += DAY_MS - 1
  assert.deepEqual(plain(await first.api.loadRecentDriverRoutes('driver-a')), expected)
  assert.equal(first.state.queries.length, 1)
  const reopened = harness({ storage: first.storage, state: { now: BASE_NOW + DAY_MS - 1 } })
  assert.deepEqual(plain(await reopened.api.loadRecentDriverRoutes('driver-a')), expected)
  assert.equal(reopened.state.queries.length, 0)
  reopened.state.now += 1
  await reopened.api.loadRecentDriverRoutes('driver-a')
  assert.equal(reopened.state.queries.length, 1)
  assert.deepEqual(plain(reopened.api.readRecentDriverRoutes('driver-a')), expected)
})

test('coalesces loads and preserves a publication added while the database read is pending', async () => {
  const { api, state } = harness()
  let resolve
  state.deferred = new Promise(done => { resolve = done })
  const first = api.loadRecentDriverRoutes('driver-a')
  const second = api.loadRecentDriverRoutes('driver-a')
  assert.equal(first, second)
  await Promise.resolve()
  assert.equal(state.queries.length, 1)
  api.recordRecentDriverRoute('driver-a', trip({ referencePrice: '12', comment: '刚发布' }))
  resolve({ data: [trip()] })
  const rows = await first
  assert.equal(rows.length, 1)
  assert.equal(rows[0].referencePrice, '12')
  assert.equal(rows[0].comment, '刚发布')
  assert.equal(rows[0].lastPublishedAt, BASE_NOW)
})

test('late account responses cannot populate a different account or return data after logout', async () => {
  const { api, state, storage } = harness()
  let resolve
  state.deferred = new Promise(done => { resolve = done })
  const loading = api.loadRecentDriverRoutes('driver-a')
  await Promise.resolve()
  storage.set('openid', 'driver-b')
  resolve({ data: [trip()] })
  assert.deepEqual(plain(await loading), [])
  assert.deepEqual(plain(api.readRecentDriverRoutes('driver-b')), [])
  assert.equal(storage.has(CACHE_PREFIX + 'driver-a'), false)
  assert.deepEqual(plain(await api.loadRecentDriverRoutes('driver-a')), [])

  storage.set('openid', 'driver-a')
  state.deferred = new Promise(done => { resolve = done })
  const logoutLoad = api.loadRecentDriverRoutes('driver-a')
  await Promise.resolve()
  storage.delete('openid')
  resolve({ data: [trip()] })
  assert.deepEqual(plain(await logoutLoad), [])
})

test('records snapshots safely, caps unique routes, and does not expose mutable cached objects', () => {
  const { api, state } = harness()
  for (let i = 0; i < 20; i++) {
    state.now++
    api.recordRecentDriverRoute('driver-a', {
      departureAddress: 'Fort Lee', destinationAddress: '哥大', departureTime: `${String(i).padStart(2, '0')}:00`,
      passengerCount: 4, referencePrice: 8, comment: 'x'.repeat(700), cityKey: 'ny_nj'
    })
  }
  const rows = api.readRecentDriverRoutes('driver-a')
  assert.equal(rows.length, 12)
  assert.equal(rows[0].departureTime, '19:00')
  assert.equal(rows[0].comment.length, 100)
  rows[0].departureAddress = 'mutated'
  assert.equal(api.readRecentDriverRoutes('driver-a')[0].departureAddress, 'Fort Lee')
  assert.equal(api.readRecentDriverRoutes('driver-b').length, 0)
})

test('rejects malformed locations, invalid times, dates, seat counts and foreign snapshots', () => {
  const { api } = harness()
  const base = { departureAddress: 'Fort Lee', destinationAddress: '哥大', departureTime: '08:00', passengerCount: 4 }
  const invalid = [
    { departureAddress: '' }, { destinationAddress: {} }, { destinationAddress: 'FORT LEE' },
    { departureAddress: 'x'.repeat(121) },
    { departureTime: '24:00' }, { departureTime: '08:60' }, { departureTime: '8:00' },
    { departureDate: '2026-02-30' }, { passengerCount: 0 }, { passengerCount: 8 },
    { passengerCount: 1.5 }, { passengerCount: '4x' }, { passengerCount: true }, { _openid: 'other-driver' }
  ]
  for (const patch of invalid) assert.equal(api.recordRecentDriverRoute('driver-a', { ...base, ...patch }).length, 0)
  assert.equal(api.recordRecentDriverRoute('', base).length, 0)
  assert.equal(api.recordRecentDriverRoute('driver-a', null).length, 0)
})

test('storage quota and network errors preserve successful publish flow and available local rows', async () => {
  const { api, state } = harness()
  state.failWrite = true
  assert.doesNotThrow(() => api.recordRecentDriverRoute('driver-a', trip()))
  state.failRead = true
  await assert.rejects(api.loadRecentDriverRoutes('driver-a'), /offline/)
  const rows = api.readRecentDriverRoutes('driver-a')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].lastPublishedAt, BASE_NOW)
  state.failRead = false
  state.rows = [trip()]
  assert.equal((await api.loadRecentDriverRoutes('driver-a')).length, 1)
  assert.equal(state.queries.length, 2)
})

test('database dates retain their creation time across Date and cloud JSON representations', async () => {
  const { api, state } = harness()
  const createdAt = BASE_NOW - 123456
  state.rows = [
    trip({ createdAt: new Date(createdAt) }),
    trip({ departures: [{ address: 'Fort Lee', date: '2026-09-20', time: '09:00' }], createdAt: { $date: new Date(createdAt - 1).toISOString() } }),
    trip({ departures: [{ address: 'Fort Lee', date: '2026-09-20', time: '10:00' }], createdAt: { seconds: (createdAt - 2) / 1000 } })
  ]
  const rows = await api.loadRecentDriverRoutes('driver-a')
  assert.deepEqual(plain(rows.map(row => row.lastPublishedAt)), [createdAt, createdAt - 1, createdAt - 2])
})
