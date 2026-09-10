const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..')
const NOW = Date.parse('2026-09-09T16:00:00Z')
const OWNER = 'integration-user'
const HOUR = 60 * 60 * 1000

function copy(value) { return structuredClone(value) }
function plain(value) { return JSON.parse(JSON.stringify(value)) }

function matches(row, condition) {
  if (!condition) return true
  if (condition.$and) return condition.$and.every(part => matches(row, part))
  if (condition.$or) return condition.$or.some(part => matches(row, part))
  return Object.entries(condition).every(([key, expected]) => {
    const actual = row[key]
    if (expected && typeof expected === 'object') {
      if ('$in' in expected) return expected.$in.includes(actual)
      if ('$neq' in expected) return actual !== expected.$neq
      if ('$exists' in expected) return (actual !== undefined) === expected.$exists
      if ('$gt' in expected) return actual > expected.$gt
      if ('$gte' in expected) return actual >= expected.$gte
      if ('$lt' in expected) return actual < expected.$lt
      if ('$lte' in expected) return actual <= expected.$lte
    }
    return actual === expected
  })
}

function applyData(row, data) {
  for (const [key, value] of Object.entries(data)) {
    const parts = key.split('.')
    let owner = row
    for (const part of parts.slice(0, -1)) owner = owner[part] ||= {}
    const field = parts.at(-1)
    if (value && typeof value === 'object' && '$inc' in value) owner[field] = Number(owner[field] || 0) + value.$inc
    else if (value && typeof value === 'object' && '$addToSet' in value) owner[field] = [...new Set([...(owner[field] || []), value.$addToSet])]
    else if (value && typeof value === 'object' && '$pull' in value) owner[field] = (owner[field] || []).filter(item => item !== value.$pull)
    else owner[field] = copy(value)
  }
}

function carpool(id, overrides = {}) {
  return {
    _id: id, _openid: OWNER, status: 'past',
    departures: [{ date: '2026-09-08', time: '12:00' }],
    departureAtMs: NOW - 24 * HOUR, latestDepartureAtMs: NOW - 24 * HOUR,
    firstDepartureDate: '2026-09-08', firstDepartureTime: '12:00',
    passengers: [{ _openid: 'integration-passenger' }],
    passengerCount: 3, availSeatNum: 2, servedStatsCounted: true,
    ...overrides
  }
}

function request(id, overrides = {}) {
  const doc = carpool(id)
  delete doc.passengers
  return { ...doc, _openid: 'integration-creator', driverOpenid: OWNER, passengerID: ['integration-creator'], passengerCount: 1, ...overrides }
}

function user(overrides = {}) {
  return {
    _id: 'user-doc', _openid: OWNER,
    tripDriver: [], tripDriverJoin: [], tripPassenger: [], tripPassengerCreate: [],
    tripDriverHistory: [], tripDriverJoinHistory: [], tripPassengerHistory: [], tripPassengerCreateHistory: [],
    ...overrides
  }
}

// Execute the actual cloud-function entry with an observable in-memory SDK.
// Most cases replace the counter at its boundary to isolate entry-point wiring.
// realCounter cases execute the actual helper too; concurrent/rollback semantics
// remain covered by the separate completion-counter transaction tests.
function harness(functionName, initial = {}, options = {}) {
  const tables = copy({ PublicStats: [{ _id: 'home', servedTrips: 50 }], ...initial })
  const trace = []
  const reads = []
  const writes = []
  const ensureCalls = []
  const db = {
    command: {
      in: value => ({ $in: value }), neq: value => ({ $neq: value }),
      and: value => ({ $and: value }), or: value => ({ $or: value }),
      exists: value => ({ $exists: value }), gt: value => ({ $gt: value }),
      gte: value => ({ $gte: value }), lt: value => ({ $lt: value }), lte: value => ({ $lte: value }),
      inc: value => ({ $inc: value }), addToSet: value => ({ $addToSet: value }), pull: value => ({ $pull: value })
    },
    serverDate: () => new Date(NOW),
    async runTransaction(callback) {
      // Sufficient for the serial real-helper wiring cases below. This harness
      // does not claim to emulate the cloud database's conflict detection.
      return callback({ collection: name => db.collection(name) })
    },
    collection(name) {
      const rows = () => tables[name] ||= []
      const query = {
        condition: null, projection: null, offset: 0, count: 100,
        where(value) { this.condition = value; return this },
        field(value) { this.projection = value; return this },
        skip(value) { this.offset = value; return this },
        limit(value) { this.count = value; return this },
        async get() {
          reads.push({ name, where: plain(this.condition), offset: this.offset, limit: this.count })
          if (options.failRead && options.failRead(name, this.condition)) throw new Error('simulated read failure')
          const selected = rows().filter(row => matches(row, this.condition)).slice(this.offset, this.offset + this.count)
          return { data: selected.map(row => this.projection
            ? copy(Object.fromEntries(Object.entries(row).filter(([key]) => this.projection[key])))
            : copy(row)) }
        },
        async update({ data }) {
          const entry = { name, where: plain(this.condition), data: copy(data) }
          if (options.failWrite && options.failWrite(entry)) throw new Error('simulated write failure')
          writes.push(entry)
          trace.push({ operation: 'write', ...entry })
          const selected = rows().filter(row => matches(row, this.condition))
          selected.forEach(row => applyData(row, data))
          return { stats: { updated: selected.length } }
        },
        async add({ data }) {
          const entry = { name, data: copy(data), operation: 'add' }
          if (options.failWrite && options.failWrite(entry)) throw new Error('simulated write failure')
          if (rows().some(row => row._id === data._id)) throw new Error('duplicate document')
          rows().push(copy(data))
          writes.push(entry)
          trace.push(entry)
          return { _id: data._id }
        },
        doc(id) {
          return {
            async get() {
              reads.push({ name, id })
              const row = rows().find(item => item._id === id)
              return { data: row ? copy(row) : null }
            },
            update: args => db.collection(name).where({ _id: id }).update(args)
          }
        }
      }
      return query
    }
  }
  const counterFactory = (args, actualFactory) => {
    assert.equal(args.db, db, 'the completion helper must receive the same database')
    const actual = options.realCounter ? actualFactory({ ...args, now: () => NOW }) : null
    return async event => {
      const key = `${event.type}:${event.id}`
      const collection = event.type === 'request' ? 'CarpoolRequest' : 'Carpool'
      const snapshot = tables[collection]?.find(row => row._id === event.id)
      const record = { ...plain(event), key, snapshot: snapshot ? copy(snapshot) : null }
      ensureCalls.push(record)
      trace.push({ operation: 'ensure', ...record })
      if (actual) return actual(event)
      if (options.ensure) return options.ensure(event, snapshot)
      return { ok: true, eligible: true, reason: 'eligible', dryRun: event.dryRun === true,
        countedUsers: 2, countedDriverTrips: 1, countedPassengerTrips: 1,
        alreadyCountedUsers: 0, missingUsers: 0, duplicateUsers: 0, legacyUsers: 0 }
    }
  }
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test-env', init() {}, database: () => db,
    getWXContext: () => ({ OPENID: options.openid === undefined ? OWNER : options.openid }),
    callFunction() { throw new Error('sync entry must not delegate to another cloud function') }
  }
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])) }
    static now() { return NOW }
  }
  const filename = path.join(ROOT, 'cloudfunctions', functionName, 'index.js')
  const exported = {}
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    exports: exported, module: { exports: exported },
    require(name) {
      if (name === 'wx-server-sdk') return cloud
      if (name.startsWith('./')) {
        const actual = require(path.resolve(path.dirname(filename), name))
        if (typeof actual.createRideCompletionCounter === 'function') return { ...actual, createRideCompletionCounter: args => counterFactory(args, actual.createRideCompletionCounter) }
        return actual
      }
      throw new Error(`Unexpected import: ${name}`)
    },
    Date: FixedDate, console: { log() {}, warn() {}, error() {} }, Intl, Set, Map, Promise, Object, Array,
    process, Buffer
  }, { filename })
  return { main: exported.main, tables, reads, writes, ensureCalls, trace }
}

function ensureKeys(h) { return h.ensureCalls.map(call => call.key) }
function assertNoPlatformWrites(h) {
  assert.equal(h.writes.filter(write => write.name === 'PublicStats').length, 0)
  assert.equal(h.tables.PublicStats[0].servedTrips, 50)
}

test('ordinary explicit sync ensures old past records even when status and departure metadata are unchanged', async () => {
  const h = harness('syncTripStatus', { Carpool: [carpool('old-past')] })
  const result = await h.main({ type: 'carpool', ids: ['old-past'] })
  assert.equal(result.ok, true)
  assert.deepEqual(ensureKeys(h), ['carpool:old-past'])
  assert.equal(h.writes.length, 0, 'an unchanged record must not need a dummy status write')
  assertNoPlatformWrites(h)
})

test('ordinary transition retains platform service counting and ensures only after the trip becomes past', async () => {
  const h = harness('syncTripStatus', { Carpool: [carpool('new-past', { status: 'open', servedStatsCounted: false })] })
  const result = await h.main({ type: 'carpool', ids: ['new-past'] })
  assert.equal(result.ok, true)
  assert.deepEqual(ensureKeys(h), ['carpool:new-past'])
  assert.equal(h.ensureCalls[0].snapshot.status, 'past')
  assert.equal(h.tables.PublicStats[0].servedTrips, 52)
  const writeIndex = h.trace.findIndex(entry => entry.operation === 'write' && entry.name === 'Carpool')
  const ensureIndex = h.trace.findIndex(entry => entry.operation === 'ensure')
  assert.ok(writeIndex >= 0 && ensureIndex > writeIndex)
})

test('servedStatsCounted does not suppress personal completion recovery', async () => {
  const h = harness('syncTripStatus', { Carpool: [carpool('already-platform', { status: 'open' })] })
  const result = await h.main({ type: 'carpool', ids: ['already-platform'] })
  assert.equal(result.ok, true)
  assert.equal(h.tables.Carpool[0].status, 'past')
  assert.deepEqual(ensureKeys(h), ['carpool:already-platform'])
  assertNoPlatformWrites(h)
})

test('failed ordinary status mutation does not invoke completion counting for that trip', async () => {
  const h = harness('syncTripStatus', { Carpool: [carpool('write-fails', { status: 'open', servedStatsCounted: false })] }, {
    failWrite: entry => entry.name === 'Carpool'
  })
  const result = await h.main({ type: 'carpool', ids: ['write-fails'] })
  assert.equal(result.ok, false)
  assert.equal(h.ensureCalls.length, 0)
  assertNoPlatformWrites(h)
})

for (const type of ['carpool', 'request']) {
  test(`ordinary ${type} sync never revives cancelled, deleted or unknown terminal statuses`, async () => {
    const make = type === 'carpool' ? carpool : request
    const rows = ['cancelled', 'canceled', 'deleted', 'closed', 'unknown'].flatMap(status => [
      make(`${status}-past`, { status }),
      make(`${status}-future`, { status, departureAtMs: NOW + HOUR, latestDepartureAtMs: NOW + HOUR, departures: [] })
    ])
    const collection = type === 'carpool' ? 'Carpool' : 'CarpoolRequest'
    const h = harness('syncTripStatus', { [collection]: rows })
    const result = await h.main({ type, ids: rows.map(row => row._id) })
    assert.equal(result.ok, true)
    assert.deepEqual(h.tables[collection], rows)
    assert.equal(h.writes.length, 0)
    assert.equal(h.ensureCalls.length, 0)
  })
}

test('deletion and cancellation flags prevent ordinary sync from writing a past status', async () => {
  const rows = [
    carpool('deleted-flag', { status: 'open', isDeleted: true }),
    carpool('cancelled-flag', { status: 'full', cancelled: true }),
    carpool('canceled-flag', { status: 'open', isCanceled: true, servedStatsCounted: false }),
    carpool('deleted-time', { status: 'open', deletedAt: new Date(NOW - HOUR) }),
    carpool('cancelled-time', { status: 'past', cancelledAt: new Date(NOW - HOUR) })
  ]
  const h = harness('syncTripStatus', { Carpool: rows })
  const result = await h.main({ type: 'carpool', ids: rows.map(row => row._id) })
  assert.equal(result.ok, true)
  assert.deepEqual(h.tables.Carpool, rows)
  assert.equal(h.writes.length, 0)
  assert.equal(h.ensureCalls.length, 0)
})

test('retired backfill and unknown actions cannot fall through into normal status synchronization', async () => {
  const events = [
    { action: 'backfillPersonalStats', type: 'carpool', ids: ['retired-action'], dryRun: false },
    { action: 'backfillPersonalStats', type: 'carpool', ids: ['retired-action'], dryRun: true },
    { action: 'backfillPersonalStats', type: 'all', fullScan: true },
    { action: 'backfillPersonalStats', type: 'request', requestIds: ['retired-action'], fullScan: true },
    { action: 'unknown', type: 'carpool', ids: ['retired-action'] },
    { action: 'backfillPersonalStat', fullScan: true },
    { action: '', type: 'carpool', ids: ['retired-action'] }
  ]
  for (const event of events) {
    const h = harness('syncTripStatus', {
      Carpool: [carpool('retired-action', { status: 'open', servedStatsCounted: false })],
      CarpoolRequest: [request('retired-action', { status: 'open', servedStatsCounted: false })]
    })
    const original = copy(h.tables)
    const result = await h.main(event)
    assert.equal(result.ok, false, JSON.stringify(event))
    assert.equal(result.success, false)
    assert.equal(h.ensureCalls.length, 0)
    assert.equal(h.reads.length, 0)
    assert.equal(h.writes.length, 0)
    assert.deepEqual(h.tables, original)
  }
})

test('ordinary future routes retain availability status without personal or public completion counting', async () => {
  const rows = [carpool('future-open', {
    status: 'open', servedStatsCounted: false, departures: [{ date: '2026-09-10', time: '12:00' }],
    departureAtMs: NOW + 24 * HOUR, latestDepartureAtMs: NOW + 24 * HOUR,
    firstDepartureDate: '2026-09-10', firstDepartureTime: '12:00'
  })]
  const h = harness('syncTripStatus', { Carpool: rows })
  const result = await h.main({ type: 'carpool', ids: ['future-open'] })
  assert.equal(result.ok, true)
  assert.equal(h.tables.Carpool[0].status, 'open')
  assert.equal(h.ensureCalls.length, 0)
  assertNoPlatformWrites(h)
})

test('syncMy processes current IDs without rescanning four History arrays on every normal refresh', async () => {
  const h = harness('syncMyTripStatus', {
    userInfo: [user({
      tripDriver: ['driver-current'],
      tripDriverHistory: ['driver-history'], tripDriverJoinHistory: ['request-driver-history'],
      tripPassengerHistory: ['carpool-passenger-history', 'request-passenger-history'],
      tripPassengerCreateHistory: ['request-created-history']
    })],
    Carpool: [carpool('driver-current'), carpool('driver-history'), carpool('carpool-passenger-history', { _openid: 'another-driver', passengers: [{ _openid: OWNER }] })],
    CarpoolRequest: [request('request-driver-history'), request('request-passenger-history', { driverOpenid: 'another-driver', passengerID: ['integration-creator', OWNER] }), request('request-created-history', { _openid: OWNER, driverOpenid: 'another-driver', passengerID: [OWNER] })]
  })
  const result = await h.main()
  assert.equal(result.ok, true)
  assert.deepEqual(ensureKeys(h), ['carpool:driver-current'])
  assert.equal(h.reads.some(read => read.name !== 'userInfo' && JSON.stringify(read.where).includes('history')), false)
  assertNoPlatformWrites(h)
})

test('syncMy migration to History and duplicate role arrays do not skip or double-call completion', async () => {
  const h = harness('syncMyTripStatus', {
    userInfo: [user({ tripDriver: ['driver-current'], tripDriverHistory: ['driver-current'], tripPassenger: ['request-current'], tripPassengerCreate: ['request-current'] })],
    Carpool: [carpool('driver-current')],
    CarpoolRequest: [request('request-current', { _openid: OWNER, driverOpenid: 'another-driver', passengerID: [OWNER] })]
  })
  const result = await h.main()
  assert.equal(result.ok, true)
  assert.deepEqual(ensureKeys(h).sort(), ['carpool:driver-current', 'request:request-current'])
  assert.deepEqual(h.tables.userInfo[0].tripDriver, [])
  assert.deepEqual(h.tables.userInfo[0].tripPassenger, [])
  assert.deepEqual(h.tables.userInfo[0].tripPassengerCreate, [])
  assert.deepEqual(h.tables.userInfo[0].tripDriverHistory, ['driver-current'])
  assert.deepEqual(h.tables.userInfo[0].tripPassengerHistory, ['request-current'])
  assert.deepEqual(h.tables.userInfo[0].tripPassengerCreateHistory, ['request-current'])
  assertNoPlatformWrites(h)
})

test('syncMy reaches all four current role arrays, including both collections for passenger IDs', async () => {
  const h = harness('syncMyTripStatus', {
    userInfo: [user({ tripDriver: ['driver'], tripDriverJoin: ['request-driver'], tripPassenger: ['carpool-passenger', 'request-passenger'], tripPassengerCreate: ['request-creator'] })],
    Carpool: [carpool('driver'), carpool('carpool-passenger', { _openid: 'another-driver', passengers: [{ _openid: OWNER }] })],
    CarpoolRequest: [request('request-driver'), request('request-passenger', { driverOpenid: 'another-driver', passengerID: ['integration-creator', OWNER] }), request('request-creator', { _openid: OWNER, driverOpenid: 'another-driver', passengerID: [OWNER] })]
  })
  const result = await h.main()
  assert.equal(result.ok, true)
  assert.deepEqual(ensureKeys(h).sort(), ['carpool:driver', 'carpool:carpool-passenger', 'request:request-driver', 'request:request-passenger', 'request:request-creator'].sort())
  assert.equal(result.personalStats.processedTrips, 5)
  assertNoPlatformWrites(h)
})

test('syncMy completion failure retains current IDs instead of migrating them beyond the normal retry path', async () => {
  const initialUser = user({ tripDriver: ['retry-personal'], tripPassengerCreate: ['retry-request'] })
  const h = harness('syncMyTripStatus', {
    userInfo: [initialUser], Carpool: [carpool('retry-personal')],
    CarpoolRequest: [request('retry-request', { _openid: OWNER, driverOpenid: 'another-driver', passengerID: [OWNER] })]
  }, { ensure: async () => { throw new Error('simulated completion failure') } })
  const result = await h.main()
  assert.equal(result.ok, false)
  assert.deepEqual(h.tables.userInfo[0], initialUser)
  assert.equal(h.writes.filter(write => write.name === 'userInfo').length, 0)
  assert.ok(h.ensureCalls.length >= 1)
})

test('syncMy failed status mutation also keeps expired current IDs available for retry', async () => {
  const initialUser = user({ tripDriver: ['retry-status'] })
  const h = harness('syncMyTripStatus', {
    userInfo: [initialUser], Carpool: [carpool('retry-status', { status: 'open', servedStatsCounted: false })]
  }, { failWrite: entry => entry.name === 'Carpool' })
  const result = await h.main()
  assert.equal(result.ok, false)
  assert.deepEqual(h.tables.userInfo[0], initialUser)
  assert.equal(h.ensureCalls.length, 0)
  assertNoPlatformWrites(h)
})

test('syncMy writes the active-to-History migration only after completion has succeeded', async () => {
  const h = harness('syncMyTripStatus', {
    userInfo: [user({ tripDriver: ['ordered-migration'] })], Carpool: [carpool('ordered-migration')]
  })
  const result = await h.main()
  assert.equal(result.ok, true)
  const ensureIndex = h.trace.findIndex(entry => entry.operation === 'ensure')
  const migrateIndex = h.trace.findIndex(entry => entry.operation === 'write' && entry.name === 'userInfo')
  assert.ok(ensureIndex >= 0 && migrateIndex > ensureIndex)
  assert.deepEqual(h.tables.userInfo[0].tripDriverHistory, ['ordered-migration'])
})

test('syncMy preserves terminal route state even when those IDs appear in active and History arrays', async () => {
  const h = harness('syncMyTripStatus', {
    userInfo: [user({ tripDriver: ['cancelled-route', 'canceled-flag-route'], tripDriverHistory: ['closed-route', 'deleted-route'] })],
    Carpool: [carpool('cancelled-route', { status: 'cancelled' }), carpool('canceled-flag-route', { status: 'open', isCanceled: true, servedStatsCounted: false }), carpool('closed-route', { status: 'closed' }), carpool('deleted-route', { isDeleted: true })]
  })
  const before = copy(h.tables.Carpool)
  const result = await h.main()
  assert.equal(result.ok, true)
  assert.deepEqual(h.tables.Carpool, before)
  assert.equal(h.writes.filter(write => write.name === 'Carpool').length, 0)
  assert.equal(h.ensureCalls.length, 0)
  assertNoPlatformWrites(h)
})

test('syncMy still requires a trusted logged-in user and no-user requests perform no counting', async () => {
  const anonymous = harness('syncMyTripStatus', {}, { openid: '' })
  assert.equal((await anonymous.main()).ok, false)
  assert.equal(anonymous.reads.length, 0)
  assert.equal(anonymous.ensureCalls.length, 0)
  const absent = harness('syncMyTripStatus')
  assert.equal((await absent.main()).ok, true)
  assert.equal(absent.ensureCalls.length, 0)
  assert.equal(absent.writes.length, 0)
})

test('actual syncMy counting followed by ordinary syncTripStatus counts each person once and preserves ratings', async () => {
  const h = harness('syncMyTripStatus', {
    userInfo: [
      user({ tripDriver: ['end-to-end'], rideStats: { driverRatingAvg: 4.8, driverRatingCount: 6 } }),
      { _id: 'passenger-doc', _openid: 'integration-passenger', rideStats: { passengerRatingAvg: 4.6, passengerRatingCount: 2 } }
    ],
    Carpool: [carpool('end-to-end')]
  }, { realCounter: true })
  const first = await h.main()
  assert.equal(first.ok, true)
  assert.equal(first.personalStats.countedUsers, 2)
  assert.equal(first.personalStats.countedDriverTrips, 1)
  assert.equal(first.personalStats.countedPassengerTrips, 1)
  assert.equal(h.tables.userInfo[0].rideStats.completedDriverTrips, 1)
  assert.equal(h.tables.userInfo[1].rideStats.completedPassengerTrips, 1)
  assert.equal(h.tables.userInfo[0].rideStats.driverRatingAvg, 4.8)
  assert.equal(h.tables.userInfo[1].rideStats.passengerRatingCount, 2)
  assert.deepEqual(h.tables.userInfo[0].tripDriverHistory, ['end-to-end'])
  assertNoPlatformWrites(h)

  const replay = harness('syncTripStatus', h.tables, { realCounter: true })
  const second = await replay.main({ type: 'carpool', ids: ['end-to-end'] })
  assert.equal(second.ok, true)
  assert.equal(second.personalStats.countedUsers, 0)
  assert.equal(second.personalStats.alreadyCountedUsers, 2)
  assert.equal(replay.tables.userInfo[0].rideStats.completedDriverTrips, 1)
  assert.equal(replay.tables.userInfo[1].rideStats.completedPassengerTrips, 1)
  assert.equal(replay.writes.length, 0)
  assertNoPlatformWrites(replay)
})

test('retired dryRun action is rejected with the actual helper and leaves all stored records unchanged', async () => {
  const h = harness('syncTripStatus', {
    userInfo: [user(), { _id: 'passenger-doc', _openid: 'integration-passenger' }],
    Carpool: [carpool('dry-end-to-end')]
  }, { realCounter: true })
  const original = copy(h.tables)
  const result = await h.main({ action: 'backfillPersonalStats', type: 'carpool', ids: ['dry-end-to-end'], dryRun: true })
  assert.equal(result.ok, false)
  assert.equal(result.success, false)
  assert.deepEqual(h.tables, original)
  assert.equal(h.ensureCalls.length, 0)
  assert.equal(h.reads.length, 0)
  assert.equal(h.writes.length, 0)
})
