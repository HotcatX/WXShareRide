const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const NOW = Date.parse('2026-09-24T14:00:00Z')
class ClockDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])) }
  static now() { return NOW }
}
const departure = { address: 'Fort Lee', date: '2026-09-25', time: '15:00' }
const destination = { address: '哥大' }
function fixture() {
  const state = { transactions: 0, reads: 0, writes: [], committed: false }
  const transaction = {
    collection(name) { return { async add({ data }) { state.writes.push({ name, data }); return { _id: 'new-trip' } } } },
    async commit() { state.committed = true }, async rollback() {}
  }
  const db = {
    command: {}, serverDate: () => new ClockDate(),
    async startTransaction() { state.transactions += 1; return transaction },
    collection() { state.reads += 1; return { where() { return { limit() { return { async get() { return { data: [] } } } } } } } }
  }
  const cloud = { init() {}, database: () => db, getWXContext: () => ({ OPENID: 'signed-in-user' }) }
  const exports = {}
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/createTrip/index.js'), 'utf8'), {
    exports, Date: ClockDate, Intl, console: { error() {} },
    require(name) {
      if (name === 'wx-server-sdk') return cloud
      if (name === './businessLedger') return require('../cloudfunctions/createTrip/businessLedger')
      throw new Error(name)
    }
  })
  return { state, create: exports.main }
}

for (const type of ['carpool', 'request']) {
  test(`${type} rejects missing or malformed route endpoints before any database access`, async () => {
    const valid = { type, departures: [departure], destinations: [destination] }
    const invalid = [
      { type },
      ...['departures', 'destinations'].flatMap(key => [
        undefined, null, {}, 'Fort Lee', [], [null], ['Fort Lee'], [{}],
        [{ address: '' }], [{ address: ' \n\t ' }], [{ address: 123 }],
        [key === 'departures' ? departure : destination, {}]
      ].map(value => ({ ...valid, [key]: value })))
    ]
    for (const payload of invalid) {
      const { create, state } = fixture()
      const result = await create(payload)
      assert.equal(result.success, false, JSON.stringify(payload))
      assert.equal(result.ok, false)
      assert.equal(state.transactions, 0)
      assert.equal(state.reads, 0)
      assert.equal(state.writes.length, 0)
    }
  })

  test(`${type} rejects invalid departure date/time, rollover and DST gaps before a transaction`, async () => {
    const patches = [
      { date: undefined }, { date: '' }, { date: 20260925 }, { date: '2026-9-25' },
      { date: '2027-02-30' }, { date: '2026-09-23' }, { date: '2027-03-14', time: '02:30' },
      { time: undefined }, { time: '' }, { time: 1500 }, { time: '25:00' }, { time: '12:60' },
      { time: '15:00garbage' }, { time: '15:00:00' }, { time: '3:0' }
    ]
    for (const patch of patches) {
      const { create, state } = fixture()
      const result = await create({ type, departures: [{ ...departure, ...patch }], destinations: [destination] })
      assert.equal(result.success, false, JSON.stringify(patch))
      assert.match(result.errorMsg, /出发时间/)
      assert.equal(state.transactions, 0)
      assert.equal(state.reads, 0)
      assert.equal(state.writes.length, 0)
    }
    const { create, state } = fixture()
    assert.equal((await create({ type, departures: [departure, { ...departure, time: 'bad' }], destinations: [destination] })).success, false)
    assert.equal(state.transactions, 0)
  })

  test(`${type} accepts the current frontend payload with an address-only destination`, async () => {
    const { create, state } = fixture()
    const result = await create({ type, departures: [departure], destinations: [destination], passengerCount: 2, referencePrice: '$13.00' })
    assert.equal(result.success, true)
    assert.equal(state.transactions, 1)
    assert.equal(state.committed, true)
    const trip = state.writes.find(row => row.name === (type === 'carpool' ? 'Carpool' : 'CarpoolRequest')).data
    assert.equal(trip.departureAtMs, Date.parse('2026-09-25T19:00:00Z'))
    assert.equal(trip.destinations[0].address, '哥大')
    assert.equal(state.writes.filter(row => row.name === 'TripActions').length, 1)
  })
}

test('an empty authenticated invocation cannot create the default carpool', async () => {
  const { create, state } = fixture()
  assert.equal((await create({})).success, false)
  assert.equal((await create()).success, false)
  assert.equal(state.transactions, 0)
  assert.equal(state.writes.length, 0)
})
