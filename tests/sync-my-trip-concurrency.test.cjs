const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const NOW = Date.parse('2026-09-25T16:00:00Z')
const OPENID = 'sync-fixture-owner'
const FIELDS = ['tripDriver', 'tripDriverJoin', 'tripPassenger', 'tripPassengerCreate']
const copy = value => structuredClone(value)
const complete = () => ({ ok: true, eligible: true, reason: 'already_settled', alreadyCountedUsers: 2 })
const trip = (id, overrides = {}) => ({
  _id: id, _openid: OPENID, status: 'past',
  departureAtMs: NOW - 24 * 60 * 60 * 1000,
  latestDepartureAtMs: NOW - 24 * 60 * 60 * 1000,
  departures: [{ date: '2026-09-24', time: '12:00' }], ...overrides
})
const profile = overrides => ({
  _id: 'owner-doc', _openid: OPENID,
  ...Object.fromEntries(FIELDS.flatMap(field => [[field, []], [field + 'History', []]])),
  ...overrides
})

// Execute the actual entry point with staged document transactions. External
// writes increment a document revision; a stale transaction cannot commit.
// Completion counting is replaced at its tested boundary so these fixtures
// exercise only the final user-index transaction and its retry behavior.
function harness(initialUser, options = {}) {
  const tables = {
    userInfo: [copy(initialUser)],
    Carpool: options.carpool || [trip('finished')],
    CarpoolRequest: options.requests || []
  }
  let revision = 0
  const committed = []
  const state = { attempts: 0, completionCalls: 0 }
  const mutateUser = mutate => { mutate(tables.userInfo[0]); revision++ }
  const db = {
    command: { in: ids => ({ $in: ids }) },
    collection(name) {
      const query = {
        condition: {},
        where(condition) { this.condition = condition; return this },
        field() { return this },
        limit() { return this },
        async get() {
          return { data: copy((tables[name] || []).filter(row =>
            Object.entries(this.condition).every(([key, value]) => value?.$in ? value.$in.includes(row[key]) : row[key] === value))) }
        },
        doc() { throw new Error('user indexes must be written through a transaction') }
      }
      return query
    },
    async runTransaction(callback) {
      const attempt = ++state.attempts
      const baseRevision = revision
      const snapshot = copy(tables.userInfo[0])
      let patch
      const result = await callback({
        collection(name) {
          assert.equal(name, 'userInfo')
          return { doc(id) {
            assert.equal(id, 'owner-doc')
            return {
              async get() { return { data: copy(snapshot) } },
              async update({ data }) {
                if (options.failWrite) throw new Error('simulated archive write failure')
                patch = copy(data)
              }
            }
          } }
        }
      })
      if (options.beforeCommit) await options.beforeCommit({ attempt, mutateUser, patch, state })
      if (patch && revision !== baseRevision) {
        const error = new Error('transaction was superseded')
        error.code = 'DATABASE_TRANSACTION_CONFLICT'
        throw error
      }
      if (patch) {
        Object.assign(tables.userInfo[0], patch)
        revision++
        committed.push(patch)
      }
      return options.wrapResult ? { result } : result
    }
  }
  const cloud = {
    init() {}, database: () => db,
    getWXContext: () => ({ OPENID })
  }
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])) }
    static now() { return NOW }
  }
  const filename = path.join(__dirname, '../cloudfunctions/syncMyTripStatus/index.js')
  const exported = {}
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    exports: exported,
    require(name) {
      if (name === 'wx-server-sdk') return cloud
      if (name === './businessLedger') return require('../cloudfunctions/syncMyTripStatus/businessLedger')
      if (name === './rideCompletion') return { createRideCompletionCounter: () => async event => {
        state.completionCalls++
        return options.ensure ? options.ensure({ event, mutateUser, state }) : complete()
      } }
      throw new Error(`unexpected dependency: ${name}`)
    },
    Date: FixedDate, console: { error() {} }
  }, { filename })
  return { main: exported.main, tables, state, committed }
}

test('archive merges all four current role arrays and histories after a concurrent join', async () => {
  const ids = ['driver-finished', 'joined-finished', 'passenger-finished', 'created-finished']
  const initial = profile(Object.fromEntries(FIELDS.map((field, index) => [field, [ids[index]]])))
  const h = harness(initial, {
    carpool: [trip(ids[0]), trip(ids[2])], requests: [trip(ids[1]), trip(ids[3])],
    ensure({ mutateUser, state }) {
      if (state.completionCalls === 1) mutateUser(current => {
        FIELDS.forEach(field => {
          current[field].push(`${field}-new`)
          current[field + 'History'].push(`${field}-other-history`)
        })
        current.rideStats = { completedTrips: 17 }
      })
      return complete()
    }
  })
  const result = await h.main()
  assert.equal(result.ok, true)
  assert.equal(result.movedTotal, 4)
  FIELDS.forEach((field, index) => {
    assert.deepEqual(h.tables.userInfo[0][field], [`${field}-new`])
    assert.deepEqual(h.tables.userInfo[0][field + 'History'], [`${field}-other-history`, ids[index]])
  })
  assert.deepEqual(h.tables.userInfo[0].rideStats, { completedTrips: 17 })
})

test('a concurrent removal cannot be resurrected in history from the first query', async () => {
  const h = harness(profile({ tripDriver: ['finished'] }), {
    ensure({ mutateUser }) {
      mutateUser(current => { current.tripDriver = ['new-trip'] })
      return complete()
    }
  })
  const result = await h.main()
  assert.equal(result.ok, true)
  assert.equal(result.movedTotal, 0)
  assert.equal(h.committed.length, 0)
  assert.deepEqual(h.tables.userInfo[0].tripDriver, ['new-trip'])
  assert.deepEqual(h.tables.userInfo[0].tripDriverHistory, [])
})

test('a commit conflict retries using the current arrays and wrapped SDK result', async () => {
  const h = harness(profile({ tripDriver: ['finished'] }), {
    wrapResult: true,
    beforeCommit({ attempt, mutateUser }) {
      if (attempt === 1) mutateUser(current => {
        current.tripDriver.push('concurrent-join')
        current.tripDriverHistory.push('concurrent-history')
        current.tripPassenger = ['unrelated-passenger']
      })
    }
  })
  const result = await h.main()
  assert.equal(result.ok, true)
  assert.equal(result.movedTotal, 1)
  assert.equal(h.state.attempts, 2)
  assert.equal(h.committed.length, 1)
  assert.deepEqual(h.tables.userInfo[0].tripDriver, ['concurrent-join'])
  assert.deepEqual(h.tables.userInfo[0].tripDriverHistory, ['concurrent-history', 'finished'])
  assert.deepEqual(h.tables.userInfo[0].tripPassenger, ['unrelated-passenger'])
  assert.deepEqual(Object.keys(h.committed[0]).sort(), ['tripDriver', 'tripDriverHistory', 'updateTime'])
})

test('overlapping syncs move one ID exactly once and retry does not duplicate history', async () => {
  let release
  const bothReady = new Promise(resolve => { release = resolve })
  const h = harness(profile({ tripDriver: ['finished', 'finished'] }), {
    async beforeCommit({ attempt }) {
      if (attempt > 2) return
      if (attempt === 2) release()
      await bothReady
    }
  })
  const results = await Promise.all([h.main(), h.main()])
  assert.equal(results.every(result => result.ok), true)
  assert.equal(results.reduce((sum, result) => sum + result.movedTotal, 0), 1)
  assert.equal(h.state.attempts, 3)
  assert.equal(h.committed.length, 1)
  assert.deepEqual(h.tables.userInfo[0].tripDriver, [])
  assert.deepEqual(h.tables.userInfo[0].tripDriverHistory, ['finished'])
})

test('completion failure leaves current IDs available to retry without starting archival', async () => {
  const initial = profile({ tripDriver: ['finished'] })
  const h = harness(initial, { ensure() { throw new Error('simulated completion failure') } })
  assert.equal((await h.main()).ok, false)
  assert.equal(h.state.attempts, 0)
  assert.deepEqual(h.tables.userInfo[0], initial)
})

test('a failed archive write leaves active and historical indexes unchanged', async () => {
  const initial = profile({ tripDriver: ['finished'], tripDriverHistory: ['older'] })
  const h = harness(initial, { failWrite: true })
  assert.equal((await h.main()).ok, false)
  assert.equal(h.state.attempts, 1, 'non-conflict errors must not be blindly retried')
  assert.equal(h.committed.length, 0)
  assert.deepEqual(h.tables.userInfo[0], initial)
})

test('exhausted conflicts retain the candidate and every concurrent addition', async () => {
  const h = harness(profile({ tripDriver: ['finished'] }), {
    beforeCommit({ attempt, mutateUser }) {
      mutateUser(current => { current.tripDriver.push(`join-${attempt}`) })
    }
  })
  assert.equal((await h.main()).ok, false)
  assert.equal(h.state.attempts, 3)
  assert.equal(h.committed.length, 0)
  assert.deepEqual(h.tables.userInfo[0].tripDriver, ['finished', 'join-1', 'join-2', 'join-3'])
  assert.deepEqual(h.tables.userInfo[0].tripDriverHistory, [])
})

test('cancelled and newly postponed trips are not archived using stale expiry candidates', async () => {
  for (const reason of ['not_due', 'not_completed', 'invalid_trip']) {
    const initial = profile({ tripDriver: ['finished'] })
    const h = harness(initial, { ensure: () => ({ ok: true, eligible: false, reason }) })
    const result = await h.main()
    assert.equal(result.ok, true)
    assert.equal(result.movedTotal, 0)
    assert.equal(h.state.attempts, 0)
    assert.deepEqual(h.tables.userInfo[0], initial)
  }
  const initial = profile({ tripDriver: ['finished'] })
  const h = harness(initial, { carpool: [trip('finished', { status: 'cancelled' })] })
  assert.equal((await h.main()).movedTotal, 0)
  assert.equal(h.state.completionCalls, 0)
  assert.deepEqual(h.tables.userInfo[0], initial)
})
