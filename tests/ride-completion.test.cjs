const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createRideCompletionCounter, getCompletionFacts } = require('../cloudfunctions/syncTripStatus/rideCompletion')
const secondModule = require('../cloudfunctions/syncMyTripStatus/rideCompletion')
const NOW = Date.parse('2026-09-11T16:00:00Z')

const trip = (overrides = {}) => ({ _id: 'trip-1', _openid: 'driver', status: 'past', latestDepartureAtMs: NOW - 3600000, passengers: [{ _openid: 'passenger' }], ...overrides })
const request = (overrides = {}) => ({ _id: 'request-1', _openid: 'creator', driverOpenid: 'driver', status: 'past', latestDepartureAtMs: NOW - 3600000, passengerID: ['creator', 'passenger'], ...overrides })
const user = (openid, overrides = {}) => ({ _id: `user-${openid}`, _openid: openid, ...overrides })
const copy = value => structuredClone(value)

// Snapshot isolation mock: only documents actually written conflict at commit.
// It deliberately does not reject stale reads of an otherwise unwritten trip.
function database(rows = {}, options = {}) {
  const documents = new Map()
  const versions = new Map()
  const calls = { transactions: 0, conflicts: 0, queries: 0, outerGets: 0, updates: [], commits: 0 }
  const key = (collection, id) => `${collection}/${id}`
  for (const [collection, docs] of Object.entries(rows)) for (const doc of docs) {
    documents.set(key(collection, doc._id), copy(doc))
    versions.set(key(collection, doc._id), 1)
  }
  function apply(doc, patch) {
    const result = copy(doc)
    for (const [field, value] of Object.entries(patch)) {
      const path = field.split('.')
      let target = result
      while (path.length > 1) {
        const part = path.shift()
        if (!target[part] || typeof target[part] !== 'object') target[part] = {}
        target = target[part]
      }
      target[path[0]] = copy(value)
    }
    return result
  }
  const direct = (collection, id, patch) => {
    const name = key(collection, id)
    documents.set(name, apply(documents.get(name), patch))
    versions.set(name, (versions.get(name) || 0) + 1)
  }
  const db = {
    collection(collection) {
      return {
        doc(id) { return { async get() {
          calls.outerGets++
          if (options.failOuterGet) throw options.failOuterGet
          return { data: copy(documents.get(key(collection, id)) || null) }
        } } },
        where(condition) {
          calls.queries++
          let limit = 100
          return {
            limit(n) { limit = n; return this },
            async get() {
              if (options.failQuery) throw options.failQuery
              return { data: [...documents.entries()].filter(([name, doc]) => name.startsWith(`${collection}/`) && doc._openid === condition._openid).slice(0, limit).map(([, doc]) => copy(doc)) }
            }
          }
        }
      }
    },
    async runTransaction(callback) {
      calls.transactions++
      const snapshot = new Map([...documents].map(([name, doc]) => [name, copy(doc)]))
      const startVersions = new Map(versions)
      const writes = new Map()
      let updateNumber = 0
      const transaction = { collection(collection) { return {
        where() { throw new Error('Transaction where is unsupported') },
        doc(id) {
          const name = key(collection, id)
          return {
            async get() {
              if (options.failTransactionGet) throw options.failTransactionGet
              return { data: copy(writes.get(name) || snapshot.get(name) || null) }
            },
            async update({ data }) {
              updateNumber++
              if (options.failUpdateAt === updateNumber) throw new Error('injected update failure')
              assert.ok(snapshot.has(name), `update target must exist: ${name}`)
              calls.updates.push({ name, data: copy(data) })
              writes.set(name, apply(writes.get(name) || snapshot.get(name), data))
              return { stats: { updated: 1 } }
            }
          }
        }
      } } }
      const result = await callback(transaction)
      if (options.beforeCommit) await options.beforeCommit({ direct, documents, calls, writes })
      for (const name of writes.keys()) {
        if ((versions.get(name) || 0) !== (startVersions.get(name) || 0)) {
          calls.conflicts++
          const error = new Error('DATABASE_TRANSACTION_CONFLICT')
          error.code = 'DATABASE_TRANSACTION_CONFLICT'
          throw error
        }
      }
      for (const [name, doc] of writes) {
        documents.set(name, doc)
        versions.set(name, (versions.get(name) || 0) + 1)
      }
      calls.commits++
      if (options.afterCommitError) throw options.afterCommitError
      return options.wrapResult ? { result, errMsg: 'runTransaction:ok' } : result
    }
  }
  return {
    db, calls, options, direct,
    read: (collection, id) => copy(documents.get(key(collection, id))),
    insert: (collection, doc) => { documents.set(key(collection, doc._id), copy(doc)); versions.set(key(collection, doc._id), 1) },
    counter: createRideCompletionCounter({ db, now: () => NOW })
  }
}

test('both deployed function modules remain byte-for-byte identical', () => {
  assert.equal(fs.readFileSync(require.resolve('../cloudfunctions/syncTripStatus/rideCompletion'), 'utf8'), fs.readFileSync(require.resolve('../cloudfunctions/syncMyTripStatus/rideCompletion'), 'utf8'))
})

test('completion facts require finished due matched trips and canonical membership wins', () => {
  assert.equal(getCompletionFacts('carpool', trip(), NOW).eligible, true)
  assert.equal(getCompletionFacts('carpool', trip({ status: 'close' }), NOW).eligible, true)
  for (const status of ['open', 'full', 'cancelled', 'deleted', '']) assert.equal(getCompletionFacts('carpool', trip({ status }), NOW).eligible, false)
  assert.equal(getCompletionFacts('carpool', trip({ cancelledAt: NOW - 1 }), NOW).eligible, false)
  assert.equal(getCompletionFacts('carpool', trip({ latestDepartureAtMs: NOW + 1 }), NOW).reason, 'not_due')
  assert.equal(getCompletionFacts('carpool', trip({ latestDepartureAtMs: NOW }), NOW).eligible, true)
  assert.equal(getCompletionFacts('carpool', trip({ passengers: [], passengerID: ['old-passenger'], passengerCount: 4, availSeatNum: 0 }), NOW).reason, 'unmatched')
  assert.equal(getCompletionFacts('carpool', trip({ passengers: null, passengerID: ['old-passenger'] }), NOW).reason, 'unmatched')
  assert.equal(getCompletionFacts('carpool', trip({ _openid: '', driverOpenid: 'old-driver' }), NOW).reason, 'unmatched')
  assert.equal(getCompletionFacts('carpool', trip({ passengers: [{ _openid: '', openid: 'stale-id' }] }), NOW).reason, 'unmatched')
  const oldTrip = trip({ driverOpenid: 'driver', passengerID: ['passenger', 'driver', 'passenger'] })
  delete oldTrip._openid
  delete oldTrip.passengers
  assert.deepEqual(getCompletionFacts('carpool', oldTrip, NOW).passengerOpenids, ['passenger'])
})

test('request creator is a passenger independently of passengerID, with identities deduplicated', () => {
  const facts = getCompletionFacts('request', request({ passengerID: ['creator', 'passenger', 'passenger', 'driver'] }), NOW)
  assert.equal(facts.key, 'CarpoolRequest|request-1')
  assert.deepEqual(facts.passengerOpenids, ['creator', 'passenger'])
  assert.deepEqual(getCompletionFacts('request', request({ passengerID: [] }), NOW).passengerOpenids, ['creator'])
  assert.equal(getCompletionFacts('request', request({ driverOpenid: '' }), NOW).eligible, false)
  assert.equal(getCompletionFacts('request', request({ driverOpenid: 'creator', passengerID: ['creator'] }), NOW).eligible, false)
})

test('legacy manual completion needs an explicit valid completedAt or valid NY departure time', () => {
  assert.equal(getCompletionFacts('carpool', trip({ latestDepartureAtMs: 0 }), NOW).reason, 'missing_completion_time')
  assert.equal(getCompletionFacts('carpool', trip({ status: 'close', latestDepartureAtMs: 0, completedAt: new Date(NOW - 1) }), NOW).eligible, true)
  assert.equal(getCompletionFacts('carpool', trip({ latestDepartureAtMs: 0, updatedAt: new Date(NOW - 1) }), NOW).eligible, false)
  assert.equal(getCompletionFacts('carpool', trip({ latestDepartureAtMs: 0, departures: [{ date: '2026-09-11', time: '12:01' }] }), NOW).reason, 'not_due')
  assert.equal(getCompletionFacts('carpool', trip({ latestDepartureAtMs: 0, departures: [{ date: '2026-09-11', time: '11:59' }] }), NOW).eligible, true)
  assert.equal(getCompletionFacts('carpool', trip({ latestDepartureAtMs: 0, departures: [{ date: '2026-02-30', time: '11:59' }] }), NOW).eligible, false)
  assert.equal(getCompletionFacts('carpool', trip({ latestDepartureAtMs: 0, departures: [{ date: '2026-03-08', time: '02:30' }] }), NOW).eligible, false)
  assert.equal(getCompletionFacts('carpool', trip({ departures: [{ date: '2026-10-01', time: '12:00' }] }), NOW).reason, 'not_due')
})

test('one completion atomically updates private role keys and dotted stats without changing ratings', async () => {
  const f = database({ Carpool: [trip()], userInfo: [user('driver', { rideStats: { ratingAvg: 4.9, driverRatingCount: 5 } }), user('passenger')] })
  const result = await f.counter({ type: 'carpool', id: 'trip-1' })
  assert.equal(result.countedUsers, 2)
  assert.equal(result.countedDriverTrips, 1)
  assert.equal(result.countedPassengerTrips, 1)
  const driver = f.read('userInfo', 'user-driver')
  assert.deepEqual(driver._rideCompletionV1, { version: 1, driverKeys: ['Carpool|trip-1'], passengerKeys: [] })
  assert.deepEqual(driver.rideStats, { ratingAvg: 4.9, driverRatingCount: 5, completedDriverTrips: 1, completedPassengerTrips: 0, completedTrips: 1 })
  assert.ok(!Object.keys(driver.rideStats).some(key => /key|completionv/i.test(key)))
  assert.equal(f.read('Carpool', 'trip-1')._rideCompletionVersion, 1)
  assert.ok(f.calls.updates.filter(update => update.name.startsWith('userInfo/')).every(update => !Object.hasOwn(update.data, 'rideStats')))
  assert.ok(!JSON.stringify(result).includes('trip-1'))
  assert.ok(!JSON.stringify(result).includes('user-driver'))
})

test('both sync functions and repeated historical replay race but count each role exactly once', async () => {
  const f = database({ Carpool: [trip()], userInfo: [user('driver'), user('passenger')] })
  const other = secondModule.createRideCompletionCounter({ db: f.db, now: () => NOW })
  const results = await Promise.all([f.counter({ type: 'carpool', id: 'trip-1' }), other({ type: 'carpool', id: 'trip-1' }), f.counter({ type: 'carpool', id: 'trip-1' })])
  assert.equal(results.reduce((sum, result) => sum + result.countedUsers, 0), 2)
  assert.ok(f.calls.conflicts >= 1)
  for (let i = 0; i < 3; i++) assert.equal((await other({ type: 'carpool', id: 'trip-1' })).alreadyCountedUsers, 2)
  assert.equal(f.read('userInfo', 'user-driver').rideStats.completedTrips, 1)
  assert.equal(f.read('userInfo', 'user-passenger').rideStats.completedTrips, 1)
})

test('different trips concurrently counting the same user preserve both events', async () => {
  const f = database({ Carpool: [trip(), trip({ _id: 'trip-2' })], userInfo: [user('driver'), user('passenger')] })
  const results = await Promise.all(['trip-1', 'trip-2'].map(id => f.counter({ type: 'carpool', id })))
  assert.equal(results.reduce((sum, result) => sum + result.countedDriverTrips, 0), 2)
  assert.equal(f.read('userInfo', 'user-driver').rideStats.completedTrips, 2)
  assert.deepEqual(f.read('userInfo', 'user-driver')._rideCompletionV1.driverKeys.sort(), ['Carpool|trip-1', 'Carpool|trip-2'])
})

test('a failure after staging trip marker rolls back all changes, and later retry succeeds once', async () => {
  const f = database({ Carpool: [trip()], userInfo: [user('driver'), user('passenger')] }, { failUpdateAt: 2 })
  await assert.rejects(f.counter({ type: 'carpool', id: 'trip-1' }), /injected update failure/)
  assert.equal(f.calls.transactions, 1)
  assert.equal(f.read('Carpool', 'trip-1')._rideCompletionVersion, undefined)
  assert.equal(f.read('userInfo', 'user-driver').rideStats, undefined)
  f.options.failUpdateAt = 0
  assert.equal((await f.counter({ type: 'carpool', id: 'trip-1' })).countedUsers, 2)
  assert.equal((await f.counter({ type: 'carpool', id: 'trip-1' })).alreadyCountedUsers, 2)
})

test('uncertain response after commit is safe to retry without duplicating counts', async () => {
  const f = database({ Carpool: [trip()], userInfo: [user('driver'), user('passenger')] }, { afterCommitError: new Error('transport disconnected after commit') })
  await assert.rejects(f.counter({ type: 'carpool', id: 'trip-1' }), /transport disconnected/)
  assert.equal(f.calls.transactions, 1)
  f.options.afterCommitError = null
  const replay = await f.counter({ type: 'carpool', id: 'trip-1' })
  assert.equal(replay.countedUsers, 0)
  assert.equal(replay.alreadyCountedUsers, 2)
})

test('concurrent cancellation conflicts through the trip write and leaves all users uncounted', async () => {
  let changed = false
  const f = database({ Carpool: [trip()], userInfo: [user('driver'), user('passenger')] }, {
    beforeCommit({ direct }) { if (!changed) { changed = true; direct('Carpool', 'trip-1', { status: 'cancelled' }) } }
  })
  const result = await f.counter({ type: 'carpool', id: 'trip-1' })
  assert.equal(result.eligible, false)
  assert.equal(f.calls.conflicts, 1)
  assert.equal(f.read('userInfo', 'user-driver').rideStats, undefined)
  assert.equal(f.read('userInfo', 'user-passenger').rideStats, undefined)
})

test('missing and duplicate profiles are skipped independently and missing users can be replayed later', async () => {
  const f = database({ Carpool: [trip({ passengers: [{ _openid: 'missing' }, { _openid: 'duplicate' }] })], userInfo: [user('driver'), user('duplicate'), user('duplicate', { _id: 'duplicate-profile-2' })] })
  const result = await f.counter({ type: 'carpool', id: 'trip-1' })
  assert.equal(result.countedUsers, 1)
  assert.equal(result.missingUsers, 1)
  assert.equal(result.duplicateUsers, 1)
  f.insert('userInfo', user('missing'))
  const replay = await f.counter({ type: 'carpool', id: 'trip-1' })
  assert.equal(replay.countedPassengerTrips, 1)
  assert.equal(replay.alreadyCountedUsers, 1)
  assert.equal(replay.duplicateUsers, 1)
  assert.equal(f.read('userInfo', 'user-duplicate').rideStats, undefined)
})

test('legacy nonzero, malformed markers and inconsistent keys/counters are never blindly incremented', async () => {
  for (const fields of [
    { rideStats: { completedDriverTrips: 4, completedTrips: 4 } },
    { rideStats: { completedTrips: 1 } },
    { _rideCompletionV1: { version: 0, driverKeys: [], passengerKeys: [] } },
    { rideStats: { completedDriverTrips: 1, completedTrips: 1 }, _rideCompletionV1: { version: 1, driverKeys: [], passengerKeys: [] } },
    { rideStats: { completedDriverTrips: '3', completedTrips: '3' } }
  ]) {
    const f = database({ Carpool: [trip()], userInfo: [user('driver', fields), user('passenger')] })
    const before = f.read('userInfo', 'user-driver')
    const result = await f.counter({ type: 'carpool', id: 'trip-1' })
    assert.equal(result.legacyUsers, 1)
    assert.equal(result.countedUsers, 1)
    assert.deepEqual(f.read('userInfo', 'user-driver'), before)
  }
})

test('dry run reports projected additions but writes neither trip nor users; wrapped SDK result is supported', async () => {
  const f = database({ CarpoolRequest: [request()], userInfo: [user('driver'), user('creator'), user('passenger')] }, { wrapResult: true })
  const result = await f.counter({ type: 'request', id: 'request-1', dryRun: true })
  assert.equal(result.countedDriverTrips, 1)
  assert.equal(result.countedPassengerTrips, 2)
  assert.equal(result.dryRun, true)
  assert.equal(f.calls.updates.length, 0)
  assert.equal(f.read('userInfo', 'user-driver').rideStats, undefined)
  assert.equal((await f.counter({ type: 'request', id: 'request-1' })).countedUsers, 3)
})

test('source and profile read failures are propagated instead of being treated as missing users', async () => {
  for (const field of ['failOuterGet', 'failQuery', 'failTransactionGet']) {
    const f = database({ Carpool: [trip()], userInfo: [user('driver'), user('passenger')] }, { [field]: new Error('permission denied') })
    await assert.rejects(f.counter({ type: 'carpool', id: 'trip-1' }), /permission denied/)
    assert.ok(f.calls.transactions <= 1)
    assert.equal(f.calls.updates.length, 0)
  }
})

test('only exact transaction conflict identifiers retry, with an upper bound', async () => {
  const conflict = new Error('wrapped database.get: DATABASE_TRANSACTION_CONFLICT')
  const f = database({ Carpool: [trip()], userInfo: [user('driver'), user('passenger')] }, { failTransactionGet: conflict })
  await assert.rejects(f.counter({ type: 'carpool', id: 'trip-1' }), /DATABASE_TRANSACTION_CONFLICT/)
  assert.equal(f.calls.transactions, 3)
  const generic = database({ Carpool: [trip()], userInfo: [user('driver'), user('passenger')] }, { failTransactionGet: new Error('some conflict') })
  await assert.rejects(generic.counter({ type: 'carpool', id: 'trip-1' }), /some conflict/)
  assert.equal(generic.calls.transactions, 1)
})

test('removing participants after an established completion does not retrospectively subtract counts', async () => {
  const f = database({ Carpool: [trip()], userInfo: [user('driver'), user('passenger')] })
  await f.counter({ type: 'carpool', id: 'trip-1' })
  f.direct('Carpool', 'trip-1', { passengers: [] })
  assert.equal((await f.counter({ type: 'carpool', id: 'trip-1' })).alreadyCountedUsers, 2)
  assert.equal(f.read('userInfo', 'user-passenger').rideStats.completedPassengerTrips, 1)
})

test('a later role change preserves the first completion role instead of counting the person twice', async () => {
  const f = database({ Carpool: [trip()], userInfo: [user('driver'), user('passenger')] })
  await f.counter({ type: 'carpool', id: 'trip-1' })
  f.direct('Carpool', 'trip-1', { _openid: 'passenger', passengers: [{ _openid: 'driver' }] })
  const replay = await f.counter({ type: 'carpool', id: 'trip-1' })
  assert.equal(replay.alreadyCountedUsers, 2)
  assert.equal(replay.countedUsers, 0)
  assert.equal(replay.legacyUsers, 0)
  assert.deepEqual(f.read('userInfo', 'user-driver')._rideCompletionV1, { version: 1, driverKeys: ['Carpool|trip-1'], passengerKeys: [] })
  assert.deepEqual(f.read('userInfo', 'user-passenger')._rideCompletionV1, { version: 1, driverKeys: [], passengerKeys: ['Carpool|trip-1'] })
})

test('settled replay reads the trip once without profile queries or transactions, including dry run', async () => {
  const f = database({ Carpool: [trip()], userInfo: [user('driver'), user('passenger')] })
  await f.counter({ type: 'carpool', id: 'trip-1' })
  const stored = f.read('Carpool', 'trip-1')
  assert.equal(stored._rideCompletionSettled, true)
  assert.equal(stored._rideCompletionParticipantCount, 2)
  const before = { queries: f.calls.queries, transactions: f.calls.transactions, updates: f.calls.updates.length }
  const readsBefore = f.calls.outerGets
  for (const dryRun of [false, true]) {
    const result = await f.counter({ type: 'carpool', id: 'trip-1', dryRun })
    assert.equal(result.alreadyCountedUsers, 2)
    assert.equal(result.countedUsers, 0)
    assert.equal(result.reason, 'already_settled')
    assert.equal(result.dryRun, dryRun)
  }
  assert.deepEqual({ queries: f.calls.queries, transactions: f.calls.transactions, updates: f.calls.updates.length }, before)
  assert.equal(f.calls.outerGets - readsBefore, 2)
})

test('a partial completion remains replayable and settles only after its missing profile is counted', async () => {
  const f = database({ Carpool: [trip()], userInfo: [user('driver')] })
  const first = await f.counter({ type: 'carpool', id: 'trip-1' })
  assert.equal(first.missingUsers, 1)
  assert.notEqual(f.read('Carpool', 'trip-1')._rideCompletionSettled, true)
  f.insert('userInfo', user('passenger'))
  const second = await f.counter({ type: 'carpool', id: 'trip-1' })
  assert.equal(second.countedUsers, 1)
  assert.equal(second.alreadyCountedUsers, 1)
  assert.equal(f.read('Carpool', 'trip-1')._rideCompletionSettled, true)
  const transactions = f.calls.transactions
  assert.equal((await f.counter({ type: 'carpool', id: 'trip-1' })).alreadyCountedUsers, 2)
  assert.equal(f.calls.transactions, transactions)
})

test('invalid or incomplete settled markers never bypass user verification', async () => {
  const completeMarker = { _rideCompletionVersion: 1, _rideCompletionSettled: true, _rideCompletionParticipantCount: 2, _rideCompletionCheckedAt: new Date(NOW) }
  for (const invalid of [
    { _rideCompletionVersion: 0 }, { _rideCompletionVersion: '1' }, { _rideCompletionSettled: 'true' },
    { _rideCompletionParticipantCount: 1 }, { _rideCompletionParticipantCount: 41 },
    { _rideCompletionParticipantCount: 2.5 }, { _rideCompletionParticipantCount: '2' },
    { _rideCompletionCheckedAt: null }, { _rideCompletionCheckedAt: 'yesterday' }
  ]) {
    const f = database({ Carpool: [trip({ ...completeMarker, ...invalid })], userInfo: [user('driver'), user('passenger')] })
    const result = await f.counter({ type: 'carpool', id: 'trip-1' })
    assert.equal(result.countedUsers, 2)
    assert.ok(f.calls.queries > 0)
    assert.equal(f.calls.transactions, 1)
  }
})

test('legacy and duplicate participants prevent settling, and dry-run never creates a settled marker', async () => {
  for (const profiles of [
    [user('driver', { rideStats: { completedTrips: 5 } }), user('passenger')],
    [user('driver'), user('passenger'), user('passenger', { _id: 'duplicate' })]
  ]) {
    const f = database({ Carpool: [trip()], userInfo: profiles })
    await f.counter({ type: 'carpool', id: 'trip-1' })
    assert.notEqual(f.read('Carpool', 'trip-1')._rideCompletionSettled, true)
  }
  const f = database({ Carpool: [trip()], userInfo: [user('driver'), user('passenger')] })
  await f.counter({ type: 'carpool', id: 'trip-1', dryRun: true })
  assert.equal(f.read('Carpool', 'trip-1')._rideCompletionSettled, undefined)
})

test('partial repair clears stale settled fields instead of legitimizing an incomplete marker', async () => {
  const f = database({ Carpool: [trip({ _rideCompletionVersion: 0, _rideCompletionSettled: true, _rideCompletionParticipantCount: 2 })], userInfo: [user('driver')] })
  const first = await f.counter({ type: 'carpool', id: 'trip-1' })
  assert.equal(first.missingUsers, 1)
  assert.equal(f.read('Carpool', 'trip-1')._rideCompletionSettled, false)
  f.insert('userInfo', user('passenger'))
  const retry = await f.counter({ type: 'carpool', id: 'trip-1' })
  assert.equal(retry.countedUsers, 1)
  assert.equal(f.read('Carpool', 'trip-1')._rideCompletionSettled, true)
})

test('previously counted user keys can establish settlement without incrementing users again', async () => {
  const f = database({ Carpool: [trip()], userInfo: [user('driver'), user('passenger')] })
  await f.counter({ type: 'carpool', id: 'trip-1' })
  f.direct('Carpool', 'trip-1', { _rideCompletionSettled: false, _rideCompletionParticipantCount: 0 })
  const before = f.calls.updates.length
  const result = await f.counter({ type: 'carpool', id: 'trip-1' })
  assert.equal(result.alreadyCountedUsers, 2)
  assert.equal(result.countedUsers, 0)
  assert.equal(f.read('Carpool', 'trip-1')._rideCompletionSettled, true)
  assert.deepEqual(f.calls.updates.slice(before).map(update => update.name), ['Carpool/trip-1'])
})
