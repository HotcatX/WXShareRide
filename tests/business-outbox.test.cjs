const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { readPendingBusinessEvents, acknowledgeBusinessEvents } = require('../cloudfunctions/statistics/businessOutbox')
const ledger = require('../cloudfunctions/tripManage/businessLedger')
const catalog = require('../utils/placeCatalog')

function harness(seed = []) {
  const rows = structuredClone(seed)
  const writes = []
  let failId = ''
  const db = { serverDate: () => 'server-time', collection(name) {
    assert.equal(name, 'TripActions')
    return {
      where(filter) { assert.deepEqual(filter, { deliveryState: 'pending' }); return this },
      orderBy(field, direction) { assert.equal(field, 'createdAt'); assert.equal(direction, 'asc'); return this },
      limit(value) { this.count = value; return this },
      async get() { return { data: rows.filter(row => row.deliveryState === 'pending').sort((a, b) => a.createdAt - b.createdAt).slice(0, this.count) } },
      doc(id) { return { async update({ data }) { if (id === failId) throw new Error('lost ACK update'); writes.push(id); Object.assign(rows.find(row => row._id === id), data) } } }
    }
  } }
  return { db, rows, writes, fail(id) { failId = id } }
}
const row = (id, createdAt = 1) => ({ _id: id, deliveryState: 'pending', createdAt, event: { eventId: id, actorOpenid: 'trusted-user' } })
test('outbox reads only pending facts, including a late committed event older than an already delivered event', async () => {
  const h = harness([row('old', 1), row('new', 3)])
  const first = await readPendingBusinessEvents(h.db)
  await acknowledgeBusinessEvents(h.db, first, { ok: true, acceptedEventIds: ['old', 'new'], duplicateEventIds: [] })
  h.rows.push(row('late-commit', 2))
  assert.deepEqual((await readPendingBusinessEvents(h.db)).map(event => event.eventId), ['late-commit'])
})
test('partial/duplicate ACKs update only known immutable event IDs and failures are safe to retry', async () => {
  const h = harness([row('a'), row('b')])
  const events = await readPendingBusinessEvents(h.db)
  h.fail('b')
  await assert.rejects(acknowledgeBusinessEvents(h.db, events, { ok: true, acceptedEventIds: ['a', 'b'], duplicateEventIds: [] }), /lost ACK/)
  assert.deepEqual((await readPendingBusinessEvents(h.db)).map(e => e.eventId), ['b'])
  h.fail('')
  await acknowledgeBusinessEvents(h.db, [events[1]], { ok: true, acceptedEventIds: [], duplicateEventIds: ['b'] })
  assert.equal((await readPendingBusinessEvents(h.db)).length, 0)
  await assert.rejects(acknowledgeBusinessEvents(h.db, [], { ok: true, acceptedEventIds: ['foreign'], duplicateEventIds: [] }), /unexpected/)
})
test('unacknowledged requests retain every pending fact and oversized first events raise a visible error', async () => {
  const h = harness([row('a')])
  const events = await readPendingBusinessEvents(h.db)
  await assert.rejects(acknowledgeBusinessEvents(h.db, events, { ok: false }), /invalid/)
  assert.equal(h.rows[0].deliveryState, 'pending')
  await assert.rejects(readPendingBusinessEvents(h.db, { maxBytes: 70 }), /too_large/)
})
test('business-only batches accommodate the supported 100-member legacy snapshot without stalling newer facts', async () => {
  const members = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(4, '0')}${'a'.repeat(124)}`)
  const endpoint = { address: 'x'.repeat(200), date: '2026-09-23', time: '12:00' }
  const doc = { _openid: 'd'.repeat(128), passengers: members.map(_openid => ({ _openid })),
    departures: Array(12).fill(endpoint), destinations: Array(12).fill(endpoint), passengerCount: 8, availSeatNum: 0 }
  const before = ledger.snapshot('carpool', doc, 1)
  const big = row('big')
  big.event = { ...big.event, before, after: { ...before, tripVersion: 2 }, affectedOpenids: before.participantEdges.map(e => e.openid) }
  const h = harness([big, row('next', 2)])
  const events = await readPendingBusinessEvents(h.db)
  assert.deepEqual(events.map(event => event.eventId), ['big', 'next'])
  const bytes = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, events }))
  assert.ok(bytes > 64 * 1024 && bytes < 112 * 1024)
})
test('business identity helpers use the same fixed aliases as the picker and never conflate Newark city with EWR', () => {
  for (const place of catalog.FIXED_PLACES) {
    for (const value of [place.value, place.label, ...place.aliases]) assert.equal(ledger.placeId(value), place.placeId, value)
  }
  for (const value of ['Newark', '纽瓦克', 'Long Island', 'Jersey City']) assert.equal(ledger.placeId(value), '')
  for (const name of ['createTrip', 'joinTrip', 'syncTripStatus', 'syncMyTripStatus']) {
    assert.equal(fs.readFileSync(path.resolve(__dirname, `../cloudfunctions/${name}/businessLedger.js`), 'utf8'), fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/tripManage/businessLedger.js'), 'utf8'))
    assert.equal(fs.readFileSync(path.resolve(__dirname, `../cloudfunctions/${name}/placeCatalog.js`), 'utf8'), fs.readFileSync(path.resolve(__dirname, '../utils/placeCatalog.js'), 'utf8'))
  }
})
test('synthetic designation comes only from trusted invocation metadata, never client/event fields', () => {
  assert.equal(ledger.isSyntheticContext({ environment: JSON.stringify({ TCB_SOURCE: 'wx_devtools' }) }), true)
  assert.equal(ledger.isSyntheticContext({ environ: 'WX_OPENID=some-id;TCB_SOURCE=wx_devtools' }), true)
  assert.equal(ledger.isSyntheticContext({ environment: JSON.stringify({ TCB_SOURCE: 'wx_client' }), synthetic: true }), false)
  assert.equal(ledger.isSyntheticContext({ synthetic: true, TCB_SOURCE: 'wx_devtools' }), false)
  assert.equal(ledger.isSyntheticContext({ environment: '{bad' }), false)
})
