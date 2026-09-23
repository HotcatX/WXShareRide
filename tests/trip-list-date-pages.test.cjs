const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/getTripList/index.js'), 'utf8')
const NOW = Date.parse('2026-09-11T16:00:00Z')
const page = { type: 'all', startDate: '2026-09-11', endDateExclusive: '2026-09-13', cityKey: 'ny_nj', quick: true }

function trip(id, date, extra = {}) {
  return {
    _id: id, _openid: `owner-${id}`, status: 'open', cityKey: 'ny_nj',
    firstDepartureDate: date, firstDepartureTime: '15:00',
    departureAtMs: Date.parse(`${date}T19:00:00Z`), latestDepartureAtMs: Date.parse(`${date}T19:00:00Z`),
    departures: [{ date, time: '15:00', address: 'Fort Lee' }], destinations: [{ address: '哥大' }],
    ...extra
  }
}

function harness({ carpool = [], request = [], blocks = [], actor = 'viewer', failQuery } = {}) {
  const reads = []
  const command = Object.fromEntries(['in', 'gte', 'gt', 'lt', 'and', 'or'].map(op => [op, value => ({ op, value })]))
  function matches(row, condition) {
    if (condition.op === 'and') return condition.value.every(item => matches(row, item))
    if (condition.op === 'or') return condition.value.some(item => matches(row, item))
    return Object.entries(condition).every(([key, expected]) => {
      const value = row[key]
      if (!expected || typeof expected !== 'object' || !expected.op) return value === expected
      if (expected.op === 'in') return expected.value.includes(value)
      if (expected.op === 'gte') return value >= expected.value
      if (expected.op === 'gt') return value > expected.value
      if (expected.op === 'lt') return value < expected.value
      throw new Error(`unsupported operator ${expected.op}`)
    })
  }
  const db = {
    command,
    collection(name) {
      let condition = {}, fields, limit = 100
      const order = []
      const query = {
        where(value) { condition = value; return query },
        orderBy(key, direction) { order.push([key, direction]); return query },
        limit(value) { limit = value; return query },
        field(value) { fields = value; return query },
        async get() {
          const read = { name, condition, fields, limit, order: [...order] }
          reads.push(read)
          if (failQuery && failQuery(read)) throw new Error('database unavailable')
          const rows = name === 'Carpool' ? carpool : name === 'CarpoolRequest' ? request : name === 'UserBlocks' ? blocks : []
          const selected = rows.filter(row => matches(row, condition)).sort((a, b) => {
            for (const [key, direction] of order) {
              if (a[key] === b[key]) continue
              const compared = a[key] < b[key] ? -1 : 1
              return direction === 'desc' ? -compared : compared
            }
            return 0
          }).slice(0, limit)
          return { data: selected.map(row => fields ? Object.fromEntries(Object.entries(row).filter(([key]) => fields[key])) : { ...row }) }
        }
      }
      return query
    }
  }
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])) }
    static now() { return NOW }
  }
  const cloud = { init() {}, database: () => db, getWXContext: () => ({ OPENID: actor }) }
  const context = { exports: {}, Date: Clock, require(name) { assert.equal(name, 'wx-server-sdk'); return cloud }, console: { error() {}, warn() {} } }
  vm.runInNewContext(source, context)
  return { main: context.exports.main, reads }
}

test('date pages read complete busy dates for both types beyond the old 80 and database 100 limits', async () => {
  const carpool = Array.from({ length: 215 }, (_, i) => trip(`car-${String(i).padStart(3, '0')}`, i < 160 ? '2026-09-11' : '2026-09-12'))
  const request = Array.from({ length: 120 }, (_, i) => trip(`req-${String(i).padStart(3, '0')}`, '2026-09-11'))
  const h = harness({ carpool: [...carpool].reverse(), request: [...request].reverse() })
  const result = await h.main({ ...page, limit: 20 })
  assert.equal(result.success, true)
  assert.equal(result.data.carpool.length, 215)
  assert.equal(result.data.request.length, 120)
  assert.equal(new Set(result.data.carpool.map(row => row._id)).size, 215)
  assert.equal(result.page.nextDate, '')
  assert.equal(result.page.hasMore, false)
  const routeReads = h.reads.filter(read => read.name !== 'UserBlocks')
  assert.equal(routeReads.length, 7) // 3 + 2 range batches, plus two next-date probes.
  assert.ok(routeReads.every(read => JSON.stringify(read.order) === JSON.stringify([['firstDepartureDate', 'asc'], ['_id', 'asc']])))
  assert.equal(h.reads.filter(read => read.name === 'UserBlocks').length, 2)
})

test('nextDate chooses the first future date across both types and skips empty calendar days', async () => {
  const h = harness({ carpool: [trip('now', '2026-09-11'), trip('later-car', '2026-09-17')], request: [trip('later-request', '2026-09-15')] })
  const first = await h.main(page)
  assert.deepEqual(JSON.parse(JSON.stringify(first.page)), { startDate: '2026-09-11', endDateExclusive: '2026-09-13', nextDate: '2026-09-15', hasMore: true })
  assert.deepEqual(Array.from(first.data.carpool, row => row._id), ['now'])
  assert.equal(first.data.request.length, 0)
  const second = await h.main({ ...page, startDate: first.page.nextDate, endDateExclusive: '2026-09-17' })
  assert.deepEqual(Array.from(second.data.request, row => row._id), ['later-request'])
  assert.equal(second.page.nextDate, '2026-09-17')
})

test('range is start-inclusive/end-exclusive, keeps full vehicles, and applies expiry to rows and next-date probes', async () => {
  const h = harness({ carpool: [
    trip('before', '2026-09-10', { latestDepartureAtMs: NOW + 1000 }),
    trip('start', '2026-09-11', { status: 'full' }),
    trip('end', '2026-09-12'),
    trip('expired', '2026-09-11', { latestDepartureAtMs: NOW - 31 * 60 * 1000 }),
    trip('grace', '2026-09-11', { latestDepartureAtMs: NOW - 30 * 60 * 1000 }),
    trip('cancelled', '2026-09-11', { status: 'cancelled' }),
    trip('future-cancelled', '2026-09-12', { status: 'past' })
  ] })
  const result = await h.main({ ...page, endDateExclusive: '2026-09-12' })
  assert.equal(result.success, true)
  assert.deepEqual(Array.from(result.data.carpool, row => row._id).sort(), ['grace', 'start'])
  assert.equal(result.page.nextDate, '2026-09-12')
  const expiredNext = harness({ carpool: [trip('expired-future', '2026-09-20', { latestDepartureAtMs: NOW - 31 * 60 * 1000 })] })
  assert.equal((await expiredNext.main(page)).page.hasMore, false)
})

test('date ranges reject missing, malformed, impossible, reversed, and wider than two-day inputs without querying', async () => {
  for (const invalid of [
    { startDate: '2026-09-11' }, { endDateExclusive: '2026-09-13' },
    { startDate: '2026-09-11', endDateExclusive: '2026-09-11' },
    { startDate: '2026-09-11', endDateExclusive: '2026-09-10' },
    { startDate: '2026-09-11', endDateExclusive: '2026-09-14' },
    { startDate: '2026-02-30', endDateExclusive: '2026-03-02' },
    { startDate: '2026-9-11', endDateExclusive: '2026-09-13' },
    { startDate: '2026-09-11T00:00:00Z', endDateExclusive: '2026-09-13' },
    { startDate: null, endDateExclusive: '2026-09-13' },
    { startDate: '', endDateExclusive: '' }
  ]) {
    const h = harness()
    const result = await h.main({ type: 'all', ...invalid })
    assert.equal(result.success, false, JSON.stringify(invalid))
    assert.match(result.errorMsg, /invalid_date_range/)
    assert.equal(h.reads.length, 0)
  }
  const leap = await harness().main({ ...page, startDate: '2028-02-28', endDateExclusive: '2028-03-01' })
  assert.equal(leap.success, true)
  const monthBoundary = await harness().main({ ...page, startDate: '2026-12-31', endDateExclusive: '2027-01-02' })
  assert.equal(monthBoundary.success, true)
})

test('date pages retain service-city aliases, both blocking directions for participants, and private field stripping', async () => {
  const h = harness({ carpool: [
    trip('ny', '2026-09-11', { cityKey: 'ny', passengers: [{ _openid: 'safe' }], passengerID: ['safe'], driverOpenid: 'private' }),
    trip('nj', '2026-09-11', { cityKey: 'nj' }),
    trip('other-city', '2026-09-11', { cityKey: 'boston' }),
    trip('blocked-car', '2026-09-11', { passengers: [{ _openid: 'blocked-passenger' }] }),
    trip('future-other-city', '2026-09-18', { cityKey: 'boston' })
  ], request: [
    trip('blocked-request', '2026-09-11', { driverOpenid: 'reverse-blocker' }),
    trip('safe-request', '2026-09-11', { passengerID: ['safe'], driverOpenid: 'safe-driver' })
  ], blocks: [
    { _openid: 'viewer', targetOpenid: 'blocked-passenger', active: true },
    { _openid: 'reverse-blocker', targetOpenid: 'viewer', active: true }
  ] })
  const result = await h.main({ ...page, cityKey: 'ny' })
  assert.equal(result.success, true)
  assert.deepEqual(Array.from(result.data.carpool, row => row._id).sort(), ['nj', 'ny'])
  assert.deepEqual(Array.from(result.data.request, row => row._id), ['safe-request'])
  assert.equal(result.page.hasMore, false)
  for (const row of [...result.data.carpool, ...result.data.request]) {
    for (const key of ['_openid', 'driverOpenid', 'passengerID', 'passengers']) assert.equal(Object.hasOwn(row, key), false)
  }
})

test('failed date-page, next-date or block queries return failure instead of partial rows or false end of list', async () => {
  for (const failQuery of [
    read => read.name === 'Carpool' && read.limit === 100,
    read => read.name === 'CarpoolRequest' && read.limit === 1,
    read => read.name === 'UserBlocks'
  ]) {
    const h = harness({ carpool: [trip('test', '2026-09-11')], failQuery })
    const result = await h.main(page)
    assert.equal(result.success, false)
    assert.equal(result.page, undefined)
    assert.equal(result.data, undefined)
  }
})

test('publishers retain their own routes after blocking a participant, without exposing identities or exempting other routes', async () => {
  const fixtures = {
    carpool: [
      trip('own-original', '2026-09-11', { _openid: 'viewer', availSeatNum: 2, passengers: [{ _openid: 'blocked-passenger' }] }),
      trip('own-republished', '2026-09-11', { _openid: 'viewer', availSeatNum: 2 }),
      trip('other-blocked', '2026-09-11', { passengers: [{ _openid: 'blocked-passenger' }] }),
      trip('joined-blocked', '2026-09-11', { passengers: [{ _openid: 'viewer' }, { _openid: 'blocked-passenger' }] })
    ],
    request: [
      trip('own-request', '2026-09-11', { _openid: 'viewer', driverOpenid: 'reverse-blocker', passengerID: ['blocked-passenger'] }),
      trip('other-request', '2026-09-11', { driverOpenid: 'reverse-blocker' })
    ],
    blocks: [
      { _openid: 'viewer', targetOpenid: 'blocked-passenger', active: true },
      { _openid: 'reverse-blocker', targetOpenid: 'viewer', active: true }
    ]
  }
  for (const event of [page, { type: 'all', quick: true, fastOnly: true, cityKey: 'ny_nj' }]) {
    const result = await harness(fixtures).main(event)
    assert.equal(result.success, true)
    assert.deepEqual(Array.from(result.data.carpool, row => row._id).sort(), ['own-original', 'own-republished'])
    assert.deepEqual(Array.from(result.data.request, row => row._id), ['own-request'])
    for (const row of [...result.data.carpool, ...result.data.request]) {
      for (const key of ['_openid', 'driverOpenid', 'passengerID', 'passengers']) assert.equal(Object.hasOwn(row, key), false)
    }
    const blockedViewer = await harness({ ...fixtures, actor: 'blocked-passenger' }).main(event)
    assert.ok(!blockedViewer.data.carpool.some(row => row._id.startsWith('own-')))
    assert.ok(!blockedViewer.data.request.some(row => row._id === 'own-request'))
  }
})

test('ownership never bypasses expired, cancelled, past or service-city eligibility', async () => {
  const rows = [
    trip('own-active', '2026-09-11', { _openid: 'viewer' }),
    trip('own-expired', '2026-09-11', { _openid: 'viewer', latestDepartureAtMs: NOW - 31 * 60 * 1000 }),
    trip('own-cancelled', '2026-09-11', { _openid: 'viewer', status: 'cancelled' }),
    trip('own-past', '2026-09-11', { _openid: 'viewer', status: 'past' }),
    trip('own-other-city', '2026-09-11', { _openid: 'viewer', cityKey: 'boston' })
  ]
  for (const event of [page, { type: 'all', quick: true, fastOnly: true, cityKey: 'ny_nj' }]) {
    const result = await harness({ carpool: rows, request: rows }).main(event)
    assert.equal(result.success, true)
    assert.deepEqual(Array.from(result.data.carpool, row => row._id), ['own-active'])
    assert.deepEqual(Array.from(result.data.request, row => row._id), ['own-active'])
  }
})

test('legacy callers retain limited all-date results and the existing response shape', async () => {
  const h = harness({ carpool: Array.from({ length: 110 }, (_, i) => trip(`car-${i}`, '2026-09-20')), request: [trip('request', '2026-09-30')] })
  const result = await h.main({ type: 'all', limit: 80, quick: true, fastOnly: true, cityKey: 'ny_nj' })
  assert.equal(result.success, true)
  assert.equal(result.data.carpool.length, 80)
  assert.equal(result.data.request.length, 1)
  assert.equal(result.page, undefined)
  assert.equal(result.carpoolList, result.data.carpool)
  assert.equal(result.requestList, result.data.request)
  const oneType = await h.main({ type: 'request', quick: true, fastOnly: true })
  assert.equal(oneType.type, 'request')
  assert.equal(oneType.data[0]._id, 'request')
  assert.equal(oneType.page, undefined)
})

test('single-type date callers retain their array contract and anonymous callers need no block reads', async () => {
  const h = harness({ actor: '', carpool: [trip('driver', '2026-09-11'), trip('later', '2026-09-21')], request: [trip('request', '2026-09-15')] })
  const result = await h.main({ ...page, type: 'carpool', quick: false })
  assert.equal(result.success, true)
  assert.equal(result.type, 'carpool')
  assert.deepEqual(Array.from(result.data, row => row._id), ['driver'])
  assert.equal(result.page.nextDate, '2026-09-21')
  assert.equal(result.data[0]._openid, undefined)
  assert.equal(h.reads.some(read => read.name === 'UserBlocks'), false)
})
