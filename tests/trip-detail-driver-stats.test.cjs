const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const tripManage = require('../utils/tripManage')

const source = fs.readFileSync(path.join(__dirname, '../pages/home/tripDetail/tripDetail.js'), 'utf8')

function harness() {
  let definition
  const calls = []
  vm.runInNewContext(source, {
    Page(value) { definition = value }, console,
    wx: {
      getStorageSync(key) { return key === 'openid' ? 'viewer' : undefined },
      cloud: { callFunction(options) { calls.push(options); throw new Error('Unexpected extra cloud request') } }
    },
    require(name) {
      if (name.endsWith('tripManage')) return tripManage
      if (name.endsWith('tripDetailCache')) return {}
      if (name.endsWith('routeExpiry')) return require('../utils/routeExpiry')
      throw new Error(`Unexpected dependency ${name}`)
    }
  })
  const page = { ...definition, data: structuredClone(definition.data) }
  page.setData = function (patch) { Object.assign(this.data, patch) }
  return { page, calls }
}

const route = (id = 'trip', driver = 'driver') => ({
  _id: id, _openid: driver, passengers: [], availSeatNum: 2,
  departures: [{ address: 'Fort Lee', date: '2030-01-01', time: '08:00' }],
  destinations: [{ address: '哥大' }]
})

test('unjoined detail displays completed driver trips and weighted driver rating from the existing detail response', () => {
  const { page, calls } = harness()
  page.applyTripDetailResult({ ok: true, data: route(), driverInfo: null, driverStats: {
    completedDriverTrips: 12, completedPassengerTrips: 999,
    driverRatingCount: 4, driverRatingAvg: 4.3, driverRatingWeightedAvg: 4.75,
    passengerRatingCount: 50, passengerRatingAvg: 1
  } }, 'trip')
  assert.equal(page.data.driverCompletedText, '12 次')
  assert.equal(page.data.driverRatingText, '4.8')
  assert.equal(page.data.driverInfo, null)
  assert.equal(calls.length, 0)
})

test('missing statistics display 无 while an explicitly recorded zero remains 0 次', () => {
  const { page } = harness()
  for (const stats of [undefined, null, {}, { completedDriverTrips: null }, { completedDriverTrips: '' }, { completedDriverTrips: -1 }]) {
    page.applyDriverStats(stats)
    assert.equal(page.data.driverCompletedText, '无')
    assert.equal(page.data.driverRatingText, '无')
  }
  page.applyDriverStats({ completedDriverTrips: 0, driverRatingAvg: 4.8, driverRatingCount: 0 })
  assert.equal(page.data.driverCompletedText, '0 次')
  assert.equal(page.data.driverRatingText, '无')
  page.applyDriverStats({ completedDriverTrips: '3', driverRatingAvg: 4, driverRatingCount: 2 })
  assert.equal(page.data.driverCompletedText, '3 次')
  assert.equal(page.data.driverRatingText, '4.0')
})

test('existing joined-driver responses remain compatible and rejected/other-route results clear old statistics', () => {
  const { page, calls } = harness()
  page.applyTripDetailResult({ ok: true, data: { ...route(), passengers: [{ _openid: 'viewer' }] },
    driverInfo: { _openid: 'driver', phone: 'fixture', rideStats: {
      completedDriverTrips: 9, driverRatingCount: 1, driverRatingAvg: 5
    } }
  }, 'trip')
  assert.equal(page.data.driverCompletedText, '9 次')
  assert.equal(page.data.driverRatingText, '5.0')
  assert.equal(page.data.driverInfo.phone, 'fixture')
  assert.equal(calls.length, 0)
  page.applyTripData(route('other-trip', 'another-driver'), 'other-trip', { fromPreview: true })
  assert.equal(page.data.driverCompletedText, '无')
  assert.equal(page.data.driverRatingText, '无')
  page.applyDriverStats({ completedDriverTrips: 5, driverRatingCount: 2, driverRatingAvg: 4 })
  page.setLoadError('gone', { notFound: true })
  assert.equal(page.data.driverCompletedText, '无')
  assert.equal(page.data.driverRatingText, '无')
})

test('a refresh that no longer returns driver statistics never retains the previous driver summary', () => {
  const { page } = harness()
  page.applyTripDetailResult({ ok: true, data: route(), driverStats: {
    completedDriverTrips: 10, driverRatingCount: 2, driverRatingAvg: 5
  } }, 'trip')
  page.applyTripDetailResult({ ok: true, data: route(), driverStats: null, driverInfo: null }, 'trip')
  assert.equal(page.data.driverCompletedText, '无')
  assert.equal(page.data.driverRatingText, '无')
})
