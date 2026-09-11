const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/getTripList/index.js'), 'utf8')
const NOW = Date.parse('2026-09-11T16:00:00Z')
const calendar = { action: 'calendar', type: 'all', month: '2026-09', cityKey: 'ny_nj' }

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

function days(result) {
  assert.equal(result.success, true, result.errorMsg)
  return JSON.parse(JSON.stringify(result.data.days))
}

test('calendar scans the whole month beyond 100 rows and two-day pages, returns only counts, and skips next-date probes', async () => {
  const carpool = Array.from({ length: 215 }, (_, i) => trip(`car-${String(i).padStart(3, '0')}`, i < 160 ? '2026-09-11' : '2026-09-30'))
  const request = Array.from({ length: 120 }, (_, i) => trip(`req-${String(i).padStart(3, '0')}`, '2026-09-15'))
  const h = harness({ carpool: [...carpool, trip('outside', '2026-10-01')].reverse(), request: [...request].reverse() })
  const result = await h.main({ ...calendar, limit: 20, quick: false })
  assert.deepEqual(days(result), [
    { date: '2026-09-11', carpoolCount: 160, requestCount: 0 },
    { date: '2026-09-15', carpoolCount: 0, requestCount: 120 },
    { date: '2026-09-30', carpoolCount: 55, requestCount: 0 }
  ])
  assert.deepEqual(Object.keys(result).sort(), ['data', 'month', 'ok', 'success'])
  assert.equal(result.month, '2026-09')
  assert.deepEqual(Object.keys(result.data), ['days'])
  const routeReads = h.reads.filter(read => read.name !== 'UserBlocks')
  assert.equal(routeReads.length, 5)
  assert.ok(routeReads.every(read => read.limit === 100))
  assert.ok(routeReads.every(read => JSON.stringify(read.order) === JSON.stringify([['firstDepartureDate', 'asc'], ['_id', 'asc']])))
  for (const read of routeReads) {
    assert.equal(read.fields._id, true)
    assert.equal(read.fields.firstDepartureDate, true)
    for (const key of ['price', 'referencePrice', 'departures', 'destinations', 'createdAt', 'phone', 'wechat']) {
      assert.equal(read.fields[key], undefined, `unnecessary field ${key}`)
    }
  }
  assert.equal(h.reads.filter(read => read.name === 'UserBlocks').length, 2)
})

test('calendar rejects invalid months and oversized or malformed filters before database reads', async () => {
  for (const change of [
    { month: undefined }, { month: '' }, { month: '2026-9' }, { month: '2026-00' }, { month: '2026-13' },
    { month: '2026-09-01' }, { month: '2026-09 ' }, { month: { month: '2026-09' } },
    { type: 'driver' }, { type: null }, { cityKey: {} }, { cityKey: 'a'.repeat(81) },
    { fromPlace: 12 }, { toPlace: {} }, { fromPlace: 'a'.repeat(201) },
    { fromPresets: 'Fort Lee' }, { toPresets: Array(101).fill('x') }, { toPresets: ['a'.repeat(201)] }
  ]) {
    const h = harness()
    const result = await h.main({ ...calendar, ...change })
    assert.equal(result.success, false, JSON.stringify(change))
    assert.match(result.errorMsg, /invalid_calendar_/)
    assert.equal(h.reads.length, 0)
  }
})

test('calendar supports leap-month and year boundaries, excludes malformed legacy days, and keeps exact 100-row batches', async () => {
  const h = harness({ actor: '', carpool: [
    ...Array.from({ length: 100 }, (_, i) => trip(`car-${i}`, '2028-02-29')),
    trip('next-month', '2028-03-01'), trip('invalid-date', '2028-02-30'),
    trip('december', '2028-12-31'), trip('new-year', '2029-01-01')
  ] })
  assert.deepEqual(days(await h.main({ ...calendar, month: '2028-02', type: 'carpool' })), [
    { date: '2028-02-29', carpoolCount: 100, requestCount: 0 }
  ])
  assert.deepEqual(days(await h.main({ ...calendar, month: '2028-12', type: 'carpool' })), [
    { date: '2028-12-31', carpoolCount: 1, requestCount: 0 }
  ])
  assert.equal(h.reads.some(read => read.name === 'UserBlocks'), false)
})

test('calendar retains service-city aliases, visible statuses, 30-minute grace, and route type', async () => {
  const h = harness({ carpool: [
    trip('ny', '2026-09-11', { cityKey: 'ny' }),
    trip('nj', '2026-09-11', { cityKey: 'nj', status: 'full', availSeatNum: 0 }),
    trip('other-city', '2026-09-11', { cityKey: 'boston' }),
    trip('expired', '2026-09-11', { latestDepartureAtMs: NOW - 31 * 60 * 1000 }),
    trip('grace', '2026-09-11', { latestDepartureAtMs: NOW - 30 * 60 * 1000 }),
    trip('cancelled', '2026-09-11', { status: 'cancelled' }),
    trip('finished', '2026-09-11', { status: 'past' })
  ], request: [trip('request', '2026-09-11')] })
  assert.deepEqual(days(await h.main({ ...calendar, cityKey: 'nj' })), [
    { date: '2026-09-11', carpoolCount: 3, requestCount: 1 }
  ])
  const start = h.reads.length
  assert.deepEqual(days(await h.main({ ...calendar, type: 'request' })), [
    { date: '2026-09-11', carpoolCount: 0, requestCount: 1 }
  ])
  assert.equal(h.reads.slice(start).some(read => read.name === 'Carpool'), false)
})

test('calendar place matching preserves Fort Lee/Columbia aliases, substring search, and address eligibility', async () => {
  const route = (id, from, to, extra = {}) => trip(id, '2026-09-11', {
    departures: [{ date: '2026-09-11', time: '15:00', address: from }], destinations: [{ address: to }], ...extra
  })
  const h = harness({ carpool: [
    route('alias', 'FORTLEE main road', '哥大北门'),
    route('alias2', 'Fort Lee', 'COLUMBIA University'),
    route('other', 'Newport', 'Columbia'),
    route('incomplete-dep', 'Fort Lee', 'Columbia', { departures: [{ address: 'Fort Lee' }] }),
    route('incomplete-dest', 'Fort Lee', 'Columbia', { destinations: [] })
  ] })
  assert.deepEqual(days(await h.main({ ...calendar, fromPlace: 'fort lee', toPlace: 'columbia' })), [
    { date: '2026-09-11', carpoolCount: 2, requestCount: 0 }
  ])
  assert.deepEqual(days(await h.main({ ...calendar, fromPlace: 'NEWPORT', toPlace: '哥大' })), [
    { date: '2026-09-11', carpoolCount: 1, requestCount: 0 }
  ])
  // No active address filter preserves routes that do not have complete address metadata.
  assert.deepEqual(days(await h.main(calendar)), [{ date: '2026-09-11', carpoolCount: 5, requestCount: 0 }])
  assert.deepEqual(days(await h.main({ ...calendar, fromPlace: '全部', toPlace: '全部' })), [
    { date: '2026-09-11', carpoolCount: 5, requestCount: 0 }
  ])
})

test('calendar Other matches places outside configured presets with alias-aware empty-list fallback', async () => {
  const route = (id, from, to) => trip(id, '2026-09-11', {
    departures: [{ date: '2026-09-11', time: '15:00', address: from }], destinations: [{ address: to }]
  })
  const h = harness({ carpool: [
    route('presets', 'FortLee', '哥大'), route('newport', 'Newport station', 'Penn station'),
    route('other', 'Jersey City', 'Flushing'), route('reverse-presets', 'Columbia', 'Fort Lee')
  ] })
  assert.deepEqual(days(await h.main({ ...calendar, fromPlace: '其他', toPlace: '其他' })), [
    { date: '2026-09-11', carpoolCount: 2, requestCount: 0 }
  ])
  assert.deepEqual(days(await h.main({
    ...calendar, fromPlace: '其他', toPlace: '其他',
    fromPresets: ['Fort Lee', 'Newport', '哥大'], toPresets: ['Columbia', 'Penn', 'FortLee']
  })), [{ date: '2026-09-11', carpoolCount: 1, requestCount: 0 }])
})

test('calendar excludes both blocking directions for owners and participants without exposing their records', async () => {
  const h = harness({ carpool: [
    trip('blocked-owner', '2026-09-11', { _openid: 'blocked-owner' }),
    trip('blocked-passenger', '2026-09-11', { passengers: [{ _openid: 'blocked-passenger', phone: 'private' }] }),
    trip('safe', '2026-09-11', { passengers: [{ _openid: 'viewer' }] })
  ], request: [
    trip('reverse-driver', '2026-09-11', { driverOpenid: 'reverse-driver' }),
    trip('reverse-passenger', '2026-09-11', { passengerID: ['reverse-passenger'] }),
    trip('safe-request', '2026-09-11')
  ], blocks: [
    { _openid: 'viewer', targetOpenid: 'blocked-owner', active: true },
    { _openid: 'viewer', targetOpenid: 'blocked-passenger', active: true },
    { _openid: 'reverse-driver', targetOpenid: 'viewer', active: true },
    { _openid: 'reverse-passenger', targetOpenid: 'viewer', active: true }
  ] })
  const result = await h.main(calendar)
  assert.deepEqual(days(result), [{ date: '2026-09-11', carpoolCount: 1, requestCount: 1 }])
  assert.equal(JSON.stringify(result).includes('private'), false)
  assert.equal(JSON.stringify(result).includes('openid'), false)
  assert.equal(JSON.stringify(result).includes('blocked'), false)
})

test('calendar fails instead of publishing partial counts when a later range batch or block read fails', async () => {
  for (const failQuery of [
    read => read.name === 'Carpool' && JSON.stringify(read.condition).includes('"op":"or"'),
    read => read.name === 'UserBlocks'
  ]) {
    const h = harness({ carpool: Array.from({ length: 101 }, (_, i) => trip(`car-${i}`, '2026-09-11')), failQuery })
    const result = await h.main(calendar)
    assert.equal(result.success, false)
    assert.equal(result.data, undefined)
  }
})

test('calendar additions preserve legacy list and two-day pagination contracts', async () => {
  const h = harness({ carpool: [trip('today', '2026-09-11'), trip('month-end', '2026-09-30')] })
  const legacy = await h.main({ type: 'all', quick: true, cityKey: 'ny_nj' })
  assert.equal(legacy.success, true)
  assert.equal(legacy.data.carpool.length, 2)
  assert.equal(legacy.carpoolList, legacy.data.carpool)
  assert.equal(legacy.data.days, undefined)
  const page = await h.main({ type: 'carpool', startDate: '2026-09-11', endDateExclusive: '2026-09-13', cityKey: 'ny_nj' })
  assert.equal(page.success, true)
  assert.deepEqual(Array.from(page.data, item => item._id), ['today'])
  assert.equal(page.page.nextDate, '2026-09-30')
})

const places = { action: 'places', cityKey: 'ny_nj' }
function suggestedTrip(id, from, to = 'Penn Station', extra = {}) {
  return trip(id, '2026-09-11', {
    departures: [{ date: '2026-09-11', time: '15:00', address: from }],
    destinations: [{ address: to }], ...extra
  })
}
function suggestedPlaces(result) {
  assert.equal(result.success, true, result.errorMsg)
  assert.deepEqual(Object.keys(result).sort(), ['data', 'ok', 'success'])
  assert.deepEqual(Object.keys(result.data).sort(), ['fromPlaces', 'toPlaces'])
  return JSON.parse(JSON.stringify(result.data))
}

test('place suggestions scan both route types beyond 100 rows with minimal projections and no next-date probes', async () => {
  const h = harness({
    carpool: Array.from({ length: 215 }, (_, i) => suggestedTrip(`car-${String(i).padStart(3, '0')}`, 'Newport', 'Hudson Yards')).reverse(),
    request: Array.from({ length: 120 }, (_, i) => suggestedTrip(`req-${String(i).padStart(3, '0')}`, 'Flushing', 'Penn Station')).reverse()
  })
  const result = await h.main({ ...places, type: 'carpool', limit: 20, quick: false })
  assert.deepEqual(suggestedPlaces(result), {
    fromPlaces: ['Newport', 'Flushing'], toPlaces: ['Hudson Yards', 'Penn Station']
  })
  const routeReads = h.reads.filter(read => read.name !== 'UserBlocks')
  assert.equal(routeReads.length, 5)
  assert.ok(routeReads.every(read => read.limit === 100))
  assert.ok(routeReads.every(read => JSON.stringify(read.order) === JSON.stringify([['firstDepartureDate', 'asc'], ['_id', 'asc']])))
  for (const read of routeReads) {
    assert.deepEqual(Object.keys(read.fields).sort(), (read.name === 'Carpool' ?
      ['_id', '_openid', 'departures', 'destinations', 'firstDepartureDate', 'passengers'] :
      ['_id', '_openid', 'departures', 'destinations', 'driverOpenid', 'firstDepartureDate', 'passengerID']).sort())
  }
  assert.equal(h.reads.filter(read => read.name === 'UserBlocks').length, 2)
  assert.equal(JSON.stringify(result).includes('owner-'), false)
})

test('place suggestions contain other creators in the current city and only open/full unexpired routes', async () => {
  const h = harness({ carpool: [
    suggestedTrip('ny', 'NY Place', 'NY Destination', { cityKey: 'ny' }),
    suggestedTrip('nj-full', 'NJ Place', 'NJ Destination', { cityKey: 'nj', status: 'full' }),
    suggestedTrip('own-car', 'Own Car Place', 'Own Car Destination', { _openid: 'viewer' }),
    suggestedTrip('boston', 'Boston Place', 'Boston Destination', { cityKey: 'boston' }),
    suggestedTrip('expired', 'Expired Place', 'Expired Destination', { latestDepartureAtMs: NOW - 31 * 60 * 1000 }),
    suggestedTrip('grace', 'Grace Place', 'Grace Destination', { latestDepartureAtMs: NOW - 30 * 60 * 1000 }),
    suggestedTrip('cancelled', 'Cancelled Place', 'Cancelled Destination', { status: 'cancelled' }),
    suggestedTrip('completed', 'Completed Place', 'Completed Destination', { status: 'past' }),
    suggestedTrip('joined', 'Joined Place', 'Joined Destination', { passengers: [{ _openid: 'viewer' }] })
  ], request: [
    suggestedTrip('own-request', 'Own Request Place', 'Own Request Destination', { _openid: 'viewer' }),
    suggestedTrip('request', 'Request Place', 'Request Destination')
  ] })
  const result = suggestedPlaces(await h.main({ ...places, cityKey: 'nj' }))
  assert.deepEqual(result.fromPlaces, ['Grace Place', 'Joined Place', 'NJ Place', 'NY Place', 'Request Place'])
  assert.deepEqual(result.toPlaces, ['Grace Destination', 'Joined Destination', 'NJ Destination', 'NY Destination', 'Request Destination'])
  const boston = suggestedPlaces(await h.main({ ...places, cityKey: 'boston' }))
  assert.deepEqual(boston.fromPlaces, ['Boston Place'])
})

test('place suggestions apply both block directions to owners, carpool passengers, and request participants before extracting addresses', async () => {
  const h = harness({ carpool: [
    suggestedTrip('owner', 'Blocked Owner Place', 'Hidden Owner Destination', { _openid: 'blocked-owner' }),
    suggestedTrip('passenger', 'Blocked Passenger Place', 'Hidden Passenger Destination', { passengers: [{ _openid: 'blocked-passenger' }] }),
    suggestedTrip('safe', 'Safe Place', 'Safe Destination')
  ], request: [
    suggestedTrip('driver', 'Blocked Driver Place', 'Hidden Driver Destination', { driverOpenid: 'reverse-driver' }),
    suggestedTrip('request-passenger', 'Blocked Request Place', 'Hidden Request Destination', { passengerID: ['reverse-passenger'] })
  ], blocks: [
    { _openid: 'viewer', targetOpenid: 'blocked-owner', active: true },
    { _openid: 'viewer', targetOpenid: 'blocked-passenger', active: true },
    { _openid: 'reverse-driver', targetOpenid: 'viewer', active: true },
    { _openid: 'reverse-passenger', targetOpenid: 'viewer', active: true }
  ] })
  assert.deepEqual(suggestedPlaces(await h.main(places)), { fromPlaces: ['Safe Place'], toPlaces: ['Safe Destination'] })
})

test('place suggestions exclude exact fixed aliases but retain custom Fort Lee/Columbia addresses and normalize duplicate stops', async () => {
  const excluded = ['FortLee', 'FORT LEE', 'Fort Lee 核心区', 'Fort Lee 全区域', '哥大', 'Columbia', '哥大Columbia', '哥大 / Columbia', '哥伦比亚大学', 'Columbia University', '其他', '自选', '全部']
  const h = harness({ carpool: [
    ...excluded.map((name, i) => suggestedTrip(`fixed-${i}`, name, name)),
    suggestedTrip('custom-a', 'Fort Lee 某公寓', 'Columbia 北门'),
    suggestedTrip('custom-b', '  Newport   Station  ', 'Penn   Station', {
      departures: [{ address: '  Newport   Station  ' }, { address: 'newport station' }, { address: {} }, { address: ' ' }, { address: 'x'.repeat(201) }]
    }),
    suggestedTrip('custom-c', 'newport station', 'penn station'),
    suggestedTrip('alpha-a', 'Alpha', 'Alpha'), suggestedTrip('alpha-b', 'Alpha', 'Alpha')
  ] })
  assert.deepEqual(suggestedPlaces(await h.main(places)), {
    fromPlaces: ['Alpha', 'Newport Station', 'Fort Lee 某公寓'],
    toPlaces: ['Alpha', 'Penn Station', 'Columbia 北门']
  })
})

test('place suggestions rank by distinct route frequency then stable text and cap each side at 100', async () => {
  const h = harness({ actor: '', carpool: [
    ...Array.from({ length: 105 }, (_, i) => suggestedTrip(`car-${String(i).padStart(3, '0')}`, `Place ${String(i).padStart(3, '0')}`, `Destination ${String(i).padStart(3, '0')}`)),
    suggestedTrip('popular-car', 'Place 104', 'Destination 104')
  ], request: [suggestedTrip('popular-request', 'Place 104', 'Destination 104')] })
  const result = suggestedPlaces(await h.main(places))
  assert.equal(result.fromPlaces.length, 100)
  assert.equal(result.toPlaces.length, 100)
  assert.deepEqual(result.fromPlaces.slice(0, 3), ['Place 104', 'Place 000', 'Place 001'])
  assert.deepEqual(result.toPlaces.slice(0, 3), ['Destination 104', 'Destination 000', 'Destination 001'])
  assert.equal(result.fromPlaces.at(-1), 'Place 098')
  assert.equal(h.reads.some(read => read.name === 'UserBlocks'), false)
})

test('place suggestions reject malformed cities before reading and never return partial data after range or block failures', async () => {
  for (const cityKey of [undefined, null, {}, [], 12, '', ' ny_nj', 'ny nj', 'ny_nj\n', 'all', 'ny/nj', '../ny', 'a'.repeat(81)]) {
    const h = harness()
    const result = await h.main({ ...places, cityKey })
    assert.equal(result.success, false)
    assert.match(result.errorMsg, /invalid_places_city/)
    assert.equal(h.reads.length, 0)
  }
  for (const failQuery of [
    read => read.name === 'Carpool' && JSON.stringify(read.condition).includes('"op":"or"'),
    read => read.name === 'UserBlocks'
  ]) {
    const h = harness({ carpool: Array.from({ length: 101 }, (_, i) => suggestedTrip(`car-${i}`, 'Newport')), failQuery })
    const result = await h.main(places)
    assert.equal(result.success, false)
    assert.equal(result.data, undefined)
  }
})
