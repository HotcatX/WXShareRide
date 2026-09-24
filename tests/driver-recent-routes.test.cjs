const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { execFileSync } = require('node:child_process')

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

test('loads only own published driver routes with bounded query and keeps service dates without participant details', async () => {
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
  assert.deepEqual(Object.keys(rows[0]).sort(), ['_id', 'departureAddress', 'destinationAddress', 'departureDate', 'departureTime', 'weekdayIndex', 'weekdayText',
    'passengerCount', 'referencePrice', 'comment', 'cityKey', 'shortcutTitle', 'lastPublishedAt'].sort())
  assert.equal(rows[0].shortcutTitle, '去学校')
  assert.equal(rows[0].lastPublishedAt, BASE_NOW - DAY_MS)
  assert.equal(rows[0].referencePrice, '8$/人')
  assert.equal(rows[0].departureDate, '2026-09-20')
  assert.equal(rows[0].weekdayIndex, 6)
  assert.equal(rows[0].weekdayText, '周日')
  assert.equal(storage.get(CACHE_PREFIX + 'driver-a').version, 2)
  const saved = JSON.stringify(storage.get(CACHE_PREFIX + 'driver-a'))
  for (const privateText of ['someone-else', 'private', 'passengers', 'carNumber', 'zelle']) {
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

test('deduplicates the same weekday across weeks but keeps different class weekdays separate', async () => {
  const { api, state } = harness()
  state.rows = [
    trip({ departures: [{ address: 'Fort Lee', date: '2026-09-15', time: '15:00' }], createdAt: BASE_NOW - 5000 }),
    trip({ departures: [{ address: 'Fort Lee', date: '2026-09-22', time: '15:00' }],
      referencePrice: '10', passengerCount: 2, comment: '周二最近发布', createdAt: BASE_NOW - 1000 }),
    trip({ departures: [{ address: 'Fort Lee', date: '2026-09-24', time: '15:00' }], createdAt: BASE_NOW - 2000 })
  ]
  const rows = plain(await api.loadRecentDriverRoutes('driver-a'))
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(row => row.weekdayIndex), [1, 3])
  assert.deepEqual(rows.map(row => row.weekdayText), ['周二', '周四'])
  assert.equal(rows[0].departureDate, '2026-09-22')
  assert.equal(rows[0].referencePrice, '10')
  assert.equal(rows[0].passengerCount, 2)
  assert.equal(rows[0].comment, '周二最近发布')
  assert.notEqual(rows[0]._id, rows[1]._id)
})

test('service calendar weekday is the same in New York, Los Angeles and Shanghai device timezones', () => {
  const script = `
    global.wx = { getStorageSync: () => undefined, setStorageSync: () => {} };
    const api = require(${JSON.stringify(SOURCE_PATH)});
    const rows = api.recordRecentDriverRoute('driver-a', {
      departureAddress: 'Fort Lee', destinationAddress: '哥大', departureDate: '2026-09-22',
      departureTime: '00:15', passengerCount: 4,
      createdAt: ${BASE_NOW}
    });
    process.stdout.write(JSON.stringify({ date: rows[0].departureDate, weekday: rows[0].weekdayIndex, label: rows[0].weekdayText }));
  `
  for (const timezone of ['America/New_York', 'America/Los_Angeles', 'Asia/Shanghai']) {
    const result = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ: timezone }, encoding: 'utf8'
    }))
    assert.deepEqual(result, { date: '2026-09-22', weekday: 1, label: '周二' })
  }
})

test('v1 cache refreshes despite a recent sync, replaces obsolete undated shortcut, then caches for a day', async () => {
  const storage = new Map([
    ['openid', 'driver-a'],
    [CACHE_PREFIX + 'driver-a', { version: 1, syncedAt: BASE_NOW - 1000, routes: [
      { departureAddress: 'Fort Lee', destinationAddress: '哥大', departureTime: '15:00',
        passengerCount: 4, lastPublishedAt: BASE_NOW - 2000 }
    ] }]
  ])
  const { api, state } = harness({ storage })
  const fallback = api.readRecentDriverRoutes('driver-a')
  assert.equal(fallback[0].weekdayIndex, null)
  assert.equal(fallback[0].departureDate, '')
  state.rows = [trip({ departures: [{ address: 'Fort Lee', date: '2026-09-22', time: '15:00' }] })]
  const upgraded = plain(await api.loadRecentDriverRoutes('driver-a'))
  assert.equal(state.queries.length, 1)
  assert.equal(upgraded.length, 1)
  assert.equal(upgraded[0].weekdayIndex, 1)
  assert.equal(storage.get(CACHE_PREFIX + 'driver-a').version, 2)
  await api.loadRecentDriverRoutes('driver-a')
  assert.equal(state.queries.length, 1)
  const reopened = harness({ storage })
  assert.deepEqual(plain(await reopened.api.loadRecentDriverRoutes('driver-a')), upgraded)
  assert.equal(reopened.state.queries.length, 0)
})

test('offline v1 migration keeps undated fallback and never infers weekday from publication timestamp', async () => {
  const storage = new Map([
    ['openid', 'driver-a'],
    [CACHE_PREFIX + 'driver-a', { version: 1, syncedAt: BASE_NOW - 1000, routes: [
      { departureAddress: 'Fort Lee', destinationAddress: '哥大', departureTime: '15:00', passengerCount: 4,
        createdAt: BASE_NOW, lastPublishedAt: BASE_NOW }
    ] }]
  ])
  const { api, state } = harness({ storage, state: { failRead: true } })
  await assert.rejects(api.loadRecentDriverRoutes('driver-a'), /offline/)
  let rows = api.readRecentDriverRoutes('driver-a')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].weekdayIndex, null)
  assert.equal(rows[0].weekdayText, '')
  assert.equal(rows[0].departureDate, '')
  assert.equal(storage.get(CACHE_PREFIX + 'driver-a').version, 1)
  state.failRead = false
  await api.loadRecentDriverRoutes('driver-a')
  assert.equal(state.queries.length, 2)
  rows = api.readRecentDriverRoutes('driver-a')
  assert.equal(rows[0].weekdayIndex, null)
})

test('offline legacy shortcuts recover distinct Tuesday and Thursday schedules on reconnect without guessing unrelated weekdays', async () => {
  const undated = { departureAddress: 'Fort Lee', destinationAddress: '哥大', departureTime: '15:00',
    passengerCount: 4, lastPublishedAt: BASE_NOW - 1000 }
  const storage = new Map([
    ['openid', 'driver-a'],
    [CACHE_PREFIX + 'driver-a', { version: 1, syncedAt: BASE_NOW - 500, routes: [
      undated,
      { ...undated, departureTime: '19:00' },
      { ...undated, cityKey: 'other-city' }
    ] }]
  ])
  const { api, state } = harness({ storage, state: { failRead: true } })
  await assert.rejects(api.loadRecentDriverRoutes('driver-a'), /offline/)
  assert.equal(api.readRecentDriverRoutes('driver-a').length, 3)
  assert.ok(api.readRecentDriverRoutes('driver-a').every(row => row.weekdayIndex === null))
  state.failRead = false
  state.rows = [
    trip({ departures: [{ address: 'Fort Lee', date: '2026-09-22', time: '15:00' }] }),
    trip({ departures: [{ address: 'Fort Lee', date: '2026-09-24', time: '15:00' }] })
  ]
  const rows = plain(await api.loadRecentDriverRoutes('driver-a'))
  assert.equal(rows.length, 4)
  assert.deepEqual(rows.filter(row => row.cityKey === 'ny_nj' && row.departureTime === '15:00')
    .map(row => row.weekdayIndex).sort(), [1, 3])
  assert.equal(rows.find(row => row.departureTime === '19:00').weekdayIndex, null)
  assert.equal(rows.find(row => row.cityKey === 'other-city').weekdayIndex, null)
  assert.equal(storage.get(CACHE_PREFIX + 'driver-a').version, 2)
  await api.loadRecentDriverRoutes('driver-a')
  assert.equal(state.queries.length, 2)
})

test('accepts explicit valid weekday without date, ignores invalid weekdays, and prefers service date', () => {
  const { api, state } = harness()
  const base = { departureAddress: 'Fort Lee', destinationAddress: '哥大', departureTime: '15:00', passengerCount: 4 }
  let rows = api.recordRecentDriverRoute('driver-a', { ...base, weekdayIndex: 1 })
  assert.equal(rows[0].weekdayIndex, 1)
  assert.equal(rows[0].weekdayText, '周二')
  assert.equal(rows[0].departureDate, '')
  for (const invalid of ['1', -1, 7, 1.5, true, null]) {
    state.now++
    rows = api.recordRecentDriverRoute('driver-a', { ...base, weekdayIndex: invalid })
    assert.equal(rows[0].weekdayIndex, null)
  }
  state.now++
  rows = api.recordRecentDriverRoute('driver-a', { ...base, weekdayIndex: 4, departureDate: '2026-09-22' })
  assert.equal(rows[0].weekdayIndex, 1)
  assert.equal(rows[0].departureDate, '2026-09-22')
})
