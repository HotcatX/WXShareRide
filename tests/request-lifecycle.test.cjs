const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const NOW = Date.parse('2026-09-15T15:00:00Z')
class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])) } static now() { return NOW } }
const copy = value => structuredClone(value)
function request(overrides = {}) {
  return { _id: 'request-1', _openid: 'creator', passengerID: ['creator'], passengerCount: 1, driverOpenid: '', status: 'open', latestDepartureAtMs: NOW + 3600000,
    departures: [{ address: 'Fort Lee', date: '2026-09-15', time: '12:00' }], destinations: [{ address: '哥大' }], ...overrides }
}
function harness(seed = {}, options = {}) {
  const state = Object.fromEntries(Object.entries(seed).map(([name, rows]) => [name, new Map(rows.map(row => [row._id, copy(row)]))]))
  const operations = []
  let nextId = 0
  let queue = Promise.resolve()
  let failUserWrite = options.failUserWrite
  const command = { addToSet: value => ({ op: 'addToSet', value }), pull: value => ({ op: 'pull', value }), inc: value => ({ op: 'inc', value }) }
  const matches = (row, where) => Object.entries(where || {}).every(([key, value]) => row[key] === value)
  function source(tables, changes) {
    const table = name => tables[name] || (tables[name] = new Map())
    const touch = (name, id) => { if (changes) changes.set(`${name}:${id}`, { name, id }); operations.push({ name, id, transaction: !!changes }) }
    return { collection(name) {
      const document = id => ({
        async get() { return { data: copy(table(name).get(id) || null) } },
        async update({ data }) {
          if (name === 'userInfo' && failUserWrite) { failUserWrite = false; throw new Error('simulated member index failure') }
          const row = table(name).get(id)
          if (!row) throw new Error('missing document')
          for (const [key, value] of Object.entries(data)) {
            if (value && value.op === 'addToSet') row[key] = [...new Set([...(row[key] || []), value.value])]
            else if (value && value.op === 'pull') row[key] = (row[key] || []).filter(entry => entry !== value.value)
            else if (value && value.op === 'inc') row[key] = Number(row[key] || 0) + value.value
            else row[key] = copy(value)
          }
          touch(name, id)
          return { stats: { updated: 1 } }
        },
        async remove() { table(name).delete(id); touch(name, id); return { stats: { removed: 1 } } }
      })
      return {
        doc: document,
        where(condition) {
          if (changes) throw new Error('request transactions must use doc reads, not where queries')
          let limit = Infinity
          return { limit(value) { limit = value; return this }, async get() { return { data: [...table(name).values()].filter(row => matches(row, condition)).slice(0, limit).map(copy) } } }
        },
        async add({ data }) { const id = data._id || `added-${++nextId}`; table(name).set(id, { ...copy(data), _id: id }); touch(name, id); return { _id: id } }
      }
    } }
  }
  function begin() {
    const tables = Object.fromEntries(Object.entries(state).map(([name, rows]) => [name, new Map([...rows].map(([id, row]) => [id, copy(row)]))]))
    const changes = new Map()
    return { ...source(tables, changes), async commit() { for (const { name, id } of changes.values()) { state[name] ||= new Map(); if (tables[name].has(id)) state[name].set(id, copy(tables[name].get(id))); else state[name].delete(id) } }, async rollback() {} }
  }
  const db = { ...source(state), command, serverDate: () => new ClockDate(), async startTransaction() { return begin() }, async runTransaction(callback) {
    const previous = queue
    let release
    queue = new Promise(resolve => { release = resolve })
    await previous
    const tx = begin()
    try { const result = await callback(tx); await tx.commit(); return result } finally { release() }
  } }
  function load(name, openid) {
    const filename = path.resolve(__dirname, `../cloudfunctions/${name}/index.js`)
    const exports = {}
    const cloud = { DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db, getWXContext: () => ({ OPENID: openid }) }
    const helpers = {}
    vm.runInNewContext(fs.readFileSync(path.join(path.dirname(filename), 'requestState.js'), 'utf8'), { module: helpers, Date: ClockDate, Intl, Set, Object, Number, String })
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { exports, Date: ClockDate, console: { error() {} }, require(dependency) { if (dependency === 'wx-server-sdk') return cloud; if (dependency === './requestState') return helpers.exports; throw new Error(dependency) } })
    return exports.main
  }
  function loadCreate(openid) {
    const exports = {}
    const cloud = { DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => db, getWXContext: () => ({ OPENID: openid }) }
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/createTrip/index.js'), 'utf8'), { exports, Date: ClockDate, Intl, console: { error() {} }, require() { return cloud } })
    return exports.main
  }
  return { load, loadCreate, operations, row: (name, id) => copy(state[name] && state[name].get(id)), rows: name => [...(state[name] || new Map()).values()].map(copy) }
}
const action = (name, extra = {}) => ({ action: name, type: 'request', requestId: 'request-1', ...extra })

test('a full group with one creator booking four seats can be accepted; driver index and creator notification are written', async () => {
  const h = harness({ CarpoolRequest: [request({ status: 'full', passengerCount: 4, passengerID: [] })] })
  const accept = h.load('tripManage', 'driver')
  assert.equal((await accept(action('acceptRequest'))).success, true)
  assert.equal(h.row('CarpoolRequest', 'request-1').driverOpenid, 'driver')
  assert.equal(h.row('CarpoolRequest', 'request-1').passengerCount, 4)
  assert.equal(h.row('CarpoolRequest', 'request-1').status, 'full')
  assert.ok(h.rows('userInfo').find(user => user._openid === 'driver').tripDriverJoin.includes('request-1'))
  assert.equal(h.rows('Notifications')[0]._openid, 'creator')
  assert.equal((await accept(action('acceptRequest'))).alreadyAccepted, true)
  assert.equal(h.rows('Notifications').length, 1)
})

test('two drivers cannot win the same request and existing passengers/creator cannot accept it', async () => {
  const h = harness({ CarpoolRequest: [request({ passengerID: ['creator', 'passenger'], passengerCount: 2 })] })
  for (const actor of ['creator', 'passenger']) assert.equal((await h.load('tripManage', actor)(action('acceptRequest'))).success, false)
  const results = await Promise.all(['driver-a', 'driver-b'].map(actor => h.load('tripManage', actor)(action('acceptRequest'))))
  assert.equal(results.filter(result => result.success).length, 1)
  assert.equal(h.rows('userInfo').length, 1)
})

test('closed, cancelled, expired and undated requests reject new passengers and drivers without writes', async () => {
  for (const patch of [{ status: 'close' }, { status: 'past' }, { isCancelled: true }, { deletedAt: NOW }, { latestDepartureAtMs: NOW - 1 }, { latestDepartureAtMs: undefined, departures: [] }]) {
    const h = harness({ CarpoolRequest: [request(patch)] })
    assert.equal((await h.load('joinTrip', 'passenger')({ type: 'request', requestId: 'request-1' })).success, false)
    assert.equal((await h.load('tripManage', 'driver')(action('acceptRequest'))).success, false)
    assert.equal(h.operations.length, 0)
  }
})

test('joining preserves booked seats, retries on a full group succeed, and concurrent last-seat joins cannot overbook', async () => {
  const h = harness({ CarpoolRequest: [request({ passengerCount: 3 })] })
  const results = await Promise.all(['p1', 'p2'].map(actor => h.load('joinTrip', actor)({ type: 'request', requestId: 'request-1' })))
  assert.equal(results.filter(result => result.success).length, 1)
  const row = h.row('CarpoolRequest', 'request-1')
  assert.equal(row.passengerCount, 4)
  assert.equal(row.status, 'full')
  assert.equal(row.passengerID.length, 2)
  const joined = row.passengerID.find(id => id !== 'creator')
  assert.equal((await h.load('joinTrip', joined)({ type: 'request', requestId: 'request-1' })).alreadyJoined, true)
  assert.equal(h.row('CarpoolRequest', 'request-1').passengerCount, 4)
})

test('request member blocks are checked against the transaction-read current participants', async () => {
  const h = harness({ CarpoolRequest: [request({ driverOpenid: 'driver' })], UserBlocks: [{ _id: 'block', _openid: 'driver', targetOpenid: 'passenger', active: true }] })
  assert.equal((await h.load('joinTrip', 'passenger')({ type: 'request', requestId: 'request-1' })).success, false)
  const blockedDriver = harness({ CarpoolRequest: [request({ passengerID: ['creator', 'p'] })], UserBlocks: [{ _id: 'block', _openid: 'p', targetOpenid: 'driver', active: true }] })
  assert.equal((await blockedDriver.load('tripManage', 'driver')(action('acceptRequest'))).success, false)
  assert.equal(h.operations.length + blockedDriver.operations.length, 0)
})

test('driver quit and creator kick retain full passenger status and cannot reopen a closed request', async () => {
  for (const name of ['quitDriver', 'kickDriver']) for (const status of ['full', 'close']) {
    const h = harness({ CarpoolRequest: [request({ driverOpenid: 'driver', status, passengerCount: 4 })], userInfo: [{ _id: 'driver-user', _openid: 'driver', tripDriverJoin: ['request-1'] }] })
    assert.equal((await h.load('tripManage', name === 'quitDriver' ? 'driver' : 'creator')(action(name, { reason: 'schedule change' }))).success, true)
    assert.equal(h.row('CarpoolRequest', 'request-1').driverOpenid, '')
    assert.equal(h.row('CarpoolRequest', 'request-1').status, status)
    assert.deepEqual(h.row('userInfo', 'driver-user').tripDriverJoin, [])
  }
})

test('concurrent passenger exits preserve creator booked seats and member references atomically', async () => {
  const h = harness({ CarpoolRequest: [request({ status: 'full', passengerCount: '4', passengerID: ['creator', 'p1', 'p2'], driverOpenid: 'driver' })], userInfo: ['p1', 'p2'].map(id => ({ _id: id, _openid: id, tripPassenger: ['request-1'] })) })
  const results = await Promise.all(['p1', 'p2'].map(actor => h.load('tripManage', actor)(action('quitTrip'))))
  assert.ok(results.every(result => result.success))
  const row = h.row('CarpoolRequest', 'request-1')
  assert.equal(row.passengerCount, 2)
  assert.deepEqual(row.passengerID, ['creator'])
  assert.equal(row.driverOpenid, 'driver')
  assert.equal(row.status, 'open')
  assert.ok(h.rows('userInfo').every(user => user.tripPassenger.length === 0))
})

test('failed member-index cleanup rolls back route removal and seat changes', async () => {
  for (const name of ['quitTrip', 'deleteTrip']) {
    const h = harness({ CarpoolRequest: [request({ passengerCount: 3, passengerID: ['creator', 'p'] })], userInfo: [{ _id: 'p', _openid: 'p', tripPassenger: ['request-1'] }] }, { failUserWrite: true })
    assert.equal((await h.load('tripManage', name === 'quitTrip' ? 'p' : 'creator')(action(name, { reason: 'changed plans' }))).success, false)
    assert.equal(h.row('CarpoolRequest', 'request-1').passengerCount, 3)
    assert.deepEqual(h.row('CarpoolRequest', 'request-1').passengerID, ['creator', 'p'])
    assert.deepEqual(h.row('userInfo', 'p').tripPassenger, ['request-1'])
  }
})

test('request deletion and a racing driver acceptance cannot leave dangling membership indexes', async () => {
  const h = harness({ CarpoolRequest: [request()], userInfo: [{ _id: 'owner', _openid: 'creator', tripPassengerCreate: ['request-1'] }] })
  const [accepted, deleted] = await Promise.all([h.load('tripManage', 'driver')(action('acceptRequest')), h.load('tripManage', 'creator')(action('deleteTrip', { reason: 'cancelled' }))])
  assert.equal(accepted.success, true)
  assert.equal(deleted.success, true)
  assert.equal(h.row('CarpoolRequest', 'request-1'), undefined)
  assert.ok(h.rows('userInfo').every(user => !(user.tripDriverJoin || []).includes('request-1') && !(user.tripPassengerCreate || []).includes('request-1')))
})

test('new requests validate seats and departure time and derive full status without trusting client status', async () => {
  for (const seats of [0, -1, 5, 1.5, null, true, {}, 'bad']) {
    const h = harness()
    assert.equal((await h.loadCreate('creator')({ type: 'request', passengerCount: seats, departures: request().departures })).success, false)
    assert.equal(h.rows('CarpoolRequest').length, 0)
  }
  for (const departure of [[], [{ date: '2026-09-14', time: '12:00' }],
    [{ date: '2027-02-30', time: '12:00' }], [{ date: '2027-03-14', time: '02:30' }],
    [{ date: '2027-04-01', time: '08:00' }, { date: '2027-04-02', time: 'bad' }]]) {
    assert.equal((await harness().loadCreate('creator')({ type: 'request', passengerCount: 1, departures: departure })).success, false)
  }
  const h = harness()
  assert.equal((await h.loadCreate('creator')({ type: 'request', passengerCount: 4, status: 'open', departures: request().departures })).success, true)
  assert.equal(h.rows('CarpoolRequest')[0].status, 'full')
  assert.equal(h.rows('CarpoolRequest')[0].passengerCount, 4)
})

test('request creation, joining and acceptance preserve existing profiles and append their indexes', async () => {
  const h = harness({ CarpoolRequest: [request()], userInfo: ['creator', 'passenger', 'driver'].map(id => ({
    _id: `user-${id}`, _openid: id, name: `${id} profile`, phone: 'private-contact',
    tripPassenger: ['older-request'], tripPassengerCreate: ['older-created'], tripDriverJoin: ['older-accepted']
  })) })
  const created = await h.loadCreate('creator')({ type: 'request', passengerCount: 1, departures: request().departures })
  assert.equal(created.success, true)
  assert.equal((await h.load('joinTrip', 'passenger')({ type: 'request', requestId: 'request-1' })).success, true)
  assert.equal((await h.load('tripManage', 'driver')(action('acceptRequest'))).success, true)
  assert.equal(h.rows('userInfo').length, 3)
  assert.ok(h.rows('userInfo').every(user => user.name === `${user._openid} profile` && user.phone === 'private-contact'))
  assert.deepEqual(h.row('userInfo', 'user-creator').tripPassengerCreate, ['older-created', created.id])
  assert.deepEqual(h.row('userInfo', 'user-passenger').tripPassenger, ['older-request', 'request-1'])
  assert.deepEqual(h.row('userInfo', 'user-driver').tripDriverJoin, ['older-accepted', 'request-1'])
})

test('the independently deployed request state helpers stay identical and use New York wall time', () => {
  const base = path.resolve(__dirname, '../cloudfunctions')
  assert.equal(fs.readFileSync(path.join(base, 'tripManage/requestState.js'), 'utf8'), fs.readFileSync(path.join(base, 'joinTrip/requestState.js'), 'utf8'))
  const state = require('../cloudfunctions/tripManage/requestState')
  assert.equal(state.requestDepartureMs({ departures: [{ date: '2026-09-15', time: '12:00' }] }), Date.parse('2026-09-15T16:00:00Z'))
  assert.equal(state.requestDepartureMs({ departures: [{ date: '2026-12-15', time: '12:00' }] }), Date.parse('2026-12-15T17:00:00Z'))
  assert.equal(state.requestDepartureMs({ departures: [{ date: '2026-11-01', time: '03:00' }] }), Date.parse('2026-11-01T08:00:00Z'))
  assert.equal(state.requestDepartureMs({ departures: [{ date: '2026-03-08', time: '02:30' }] }), 0)
})
