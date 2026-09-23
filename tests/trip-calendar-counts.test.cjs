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

test('calendar fixed airport and Flushing choices match historical aliases while a specific custom address stays specific', async () => {
  const groups = [
    ['EWR', ['EWR', 'Newark Liberty International Airport', 'EWR Terminal C', '纽瓦克机场 T1']],
    ['JFK', ['JFK', '肯尼迪', 'John F Kennedy International Airport', '肯尼迪机场', 'JFK Terminal 4']],
    ['拉瓜迪亚', ['LGA', '拉瓜迪亚', 'LaGuardia', 'La Guardia Airport', 'LGA Terminal B']],
    ['法拉盛', ['Flushing', '法拉盛', 'Flushing Library', '法拉盛地铁站']]
  ]
  const rows = groups.flatMap(([name, aliases]) => aliases.map((address, i) => trip(`${name}-${i}`, '2026-09-11', {
    departures: [{ date: '2026-09-11', time: '15:00', address }], destinations: [{ address }]
  })))
  rows.push(trip('not-airport-code', '2026-09-11', {
    departures: [{ date: '2026-09-11', time: '15:00', address: 'fewr AJFK BLGA station' }],
    destinations: [{ address: 'fewr AJFK BLGA station' }]
  }))
  const h = harness({ carpool: rows })
  for (const [name, aliases] of groups) {
    for (const selected of [name, aliases[0]]) {
      const before = h.reads.length
      assert.deepEqual(days(await h.main({ ...calendar, fromPlace: selected, toPlace: selected })), [
        { date: '2026-09-11', carpoolCount: aliases.length, requestCount: 0 }
      ], `${selected} must match only its alias family`)
      assert.equal(h.reads.slice(before).filter(read => read.name !== 'UserBlocks').length, 2,
        'alias matching must reuse the two existing route scans')
    }
  }
  assert.deepEqual(days(await h.main({ ...calendar, fromPlace: 'EWR Terminal C' })), [
    { date: '2026-09-11', carpoolCount: 1, requestCount: 0 }
  ])
})

test('calendar Other excludes the new configured fixed groups using their historical aliases', async () => {
  const presetNames = ['Fort Lee', '哥大', 'EWR', 'JFK', '拉瓜迪亚', '法拉盛']
  const h = harness({ carpool: ['EWR', 'LGA', '肯尼迪机场', 'Flushing', 'EWR Terminal C', 'Newport station'].map((address, i) =>
    trip(`other-${i}`, '2026-09-11', {
      departures: [{ date: '2026-09-11', time: '15:00', address }], destinations: [{ address: '哥大' }]
    }))
  })
  assert.deepEqual(days(await h.main({ ...calendar, fromPlace: '其他', fromPresets: presetNames })), [
    { date: '2026-09-11', carpoolCount: 1, requestCount: 0 }
  ])
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

test('legacy place suggestions never redistribute unverified user addresses or scan business history', async () => {
  for (const actor of ['viewer', '']) {
    const h = harness({ actor, carpool: [
      suggestedTrip('private', 'Fort Lee Apartment 3A', '555 Private Street'),
      suggestedTrip('public-looking', 'Some park entrance', 'Unverified station'),
      suggestedTrip('known', 'EWR Terminal C', 'Flushing Library')
    ] })
    assert.deepEqual(suggestedPlaces(await h.main(places)), { fromPlaces: [], toPlaces: [] })
    assert.equal(h.reads.length, 0)
  }
})

test('legacy place compatibility validates city before returning fixed-only fallback', async () => {
  for (const cityKey of [undefined, null, {}, [], 12, '', ' ny_nj', 'ny nj', 'ny_nj\n', 'all', 'ny/nj', '../ny', 'a'.repeat(81)]) {
    const h = harness()
    const result = await h.main({ ...places, cityKey })
    assert.equal(result.success, false)
    assert.match(result.errorMsg, /invalid_places_city/)
    assert.equal(h.reads.length, 0)
  }
})

test('EWR does not include Newark city and new JSQ/LIC filters retain region boundaries', async () => {
  const addresses = ['Newark', '纽瓦克', 'Newark Broad Street', 'Newark Liberty International Airport', 'EWR Terminal C',
    'Jersey City', 'Journal Square', 'JSQ PATH', 'Long Island', 'Long Island City', 'LIC']
  const h = harness({ carpool: addresses.map((address, i) => suggestedTrip('boundary-' + i, address)) })
  for (const [fromPlace, count] of [['EWR', 2], ['JSQ', 2], ['LIC', 2]]) {
    assert.deepEqual(days(await h.main({ ...calendar, fromPlace })), [{ date: '2026-09-11', carpoolCount: count, requestCount: 0 }])
  }
})
