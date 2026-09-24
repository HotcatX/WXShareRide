const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const plain = value => JSON.parse(JSON.stringify(value))
const now = Date.parse('2026-09-22T16:00:00Z') // Tuesday, noon in New York.
class ClockDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])) }
  static now() { return now }
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const route = extra => ({ _id: 'template', departureAddress: 'Fort Lee', destinationAddress: '哥大',
  departureDate: '2026-09-15', departureTime: '18:00', passengerCount: 4, referencePrice: '8$/人', comment: 'Meet at campus', cityKey: 'ny_nj', ...extra })

function fixture(clock = now) {
  class FixtureDate extends ClockDate {
    constructor(...args) { super(...(args.length ? args : [clock])) }
    static now() { return clock }
  }
  let definition
  const state = { openid: 'driver', templateReads: 0, templates: [],
    createCalls: [], modals: [], toasts: [], navigation: [], timers: [], stale: 0 }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/home/newTrip/newTrip.js'), 'utf8'), {
    Page: value => { definition = value }, Date: FixtureDate,
    console: { log() {}, error() {} }, setTimeout: fn => state.timers.push(fn), clearTimeout() {},
    require(name) {
      if (name.endsWith('/driverRideDefaults')) return require('../utils/driverRideDefaults')
      if (name.endsWith('/rideTime')) return require('../utils/rideTime')
      if (name.endsWith('/tripManage')) return { ...require('../utils/tripManage'), markRideListStale: () => state.stale++ }
      if (name.endsWith('/error')) return { showDataError() {} }
      if (name.endsWith('/cityTree')) return { DEFAULT_CITY_KEY: 'ny_nj',
        getStoredCitySnapshot: () => ({ key: 'ny_nj' }), isRideServiceCityKey: () => true,
        getRideServiceCitySnapshot: () => ({ key: 'ny_nj', label: '纽约/新泽西' }) }
      return {}
    },
    wx: {
      getStorageSync: key => key === 'openid' ? state.openid : '', setStorageSync() {},
      showToast: value => state.toasts.push(value), showModal: value => state.modals.push(value),
      navigateTo: value => state.navigation.push(value), reLaunch: value => state.navigation.push(value),
      cloud: {
        database() { return { collection(name) {
          assert.equal(name, 'CarpoolTemplate')
          const query = { where() { return query }, orderBy() { return query },
            get() { state.templateReads++; return state.templateResponse || Promise.resolve({ data: state.templates }) } }
          return query
        } } },
        callFunction(args) {
          assert.equal(args.name, 'createTrip')
          state.createCalls.push(plain(args))
          return state.createResponse || Promise.resolve({ result: { success: true, id: 'trip-created' } })
        }
      }
    }
  })
  const page = { ...definition, data: plain(definition.data) }
  page.setData = function(patch, callback) { Object.assign(this.data, patch); if (callback) callback.call(this) }
  Object.assign(page.data, route(), { departureDate: '2026-09-22', passengerCountInput: '4',
    userInfo: { wechatID: 'driver' }, carNumber: 'TEST123', carBrand: 'Toyota', carModel: 'Camry', showZelle: true })
  return { page, state }
}

test('template replaces a stale draft date with its weekday and advances an elapsed time a whole week', () => {
  const { page, state } = fixture()
  page.setData({ departureDate: '2026-09-24', templates: [route({ _id: 'template', weekdayIndex: 1, departureTime: '08:00' })] })
  page.onTemplateTap({ currentTarget: { dataset: { id: 'template' } } })
  assert.equal(page.data.departureDate, '2026-09-29')
  page.setData({ departureDate: '' })
  page.onTemplateTap({ currentTarget: { dataset: { id: 'template' } } })
  assert.equal(page.data.departureDate, '2026-09-29')
  page.setData({ templates: [route({ _id: 'template', weekdayIndex: 1, departureTime: '15:00' })] })
  page.onTemplateTap({ currentTarget: { dataset: { id: 'template' } } })
  assert.equal(page.data.departureDate, '2026-09-22')
  assert.equal(page.data.departureTime, '15:00')
  assert.equal(page.data.referencePrice, '8')
  assert.equal(page.data.passengerCountInput, '4')
  assert.equal(page.data.comment, 'Meet at campus')
  assert.equal(page.data.showZelle, true)
  assert.equal(state.createCalls.length, 0)
  assert.equal(state.modals.length, 0)
})

test('unknown template weekday or invalid clock asks for dates instead of guessing today or retaining the old draft', () => {
  for (const entry of [route(), route({ weekdayIndex: 1, departureTime: '99:99' })]) {
    const { page, state } = fixture()
    page.setData({ templates: [entry] })
    page.onTemplateTap({ currentTarget: { dataset: { id: 'template' } } })
    assert.equal(page.data.departureDate, '') // A template's old date does not define its weekly schedule.
    assert.equal(page.data.departureAddress, 'Fort Lee')
    assert.match(state.toasts.at(-1).title, /选择日期时间/)
    assert.equal(state.createCalls.length, 0)
  }
})

test('weekly previews and tap agree, with legacy weekday labels supported and templates sorted like a timetable', async () => {
  const { page, state } = fixture()
  state.templates = [
    route({ _id: 'thu', weekdayIndex: 3 }),
    route({ _id: 'tue-evening', weekdayText: '星期二' }),
    route({ _id: 'unknown' }),
    route({ _id: 'tue-class', weekdayIndex: 1, weekdayText: '周四', departureTime: '15:00' })
  ]
  await page.loadTemplates()
  assert.deepEqual(plain(page.data.templates.map(row => row._id)), ['tue-class', 'tue-evening', 'thu', 'unknown'])
  const template = page.data.templates[0]
  assert.equal(template.weeklyLabel, '每周二')
  assert.equal(template.nextDepartureLabel, '9月22日')
  page.onTemplateTap({ currentTarget: { dataset: { id: template._id } } })
  assert.equal(page.data.departureDate, template.nextDepartureDate)

})

test('template reads coalesce and managing templates preserves the draft and refreshes stale reads', async () => {
  const { page, state } = fixture()
  const old = deferred()
  state.templateResponse = old.promise
  const first = page.loadTemplates()
  assert.equal(page.loadTemplates(), first)
  assert.equal(state.templateReads, 1)
  page.onManageTemplates()
  assert.equal(state.navigation[0].url, '/pages/home/CarpoolTemplateList/CarpoolTemplateList')
  assert.equal(page.data.departureTime, '18:00')
  state.templateResponse = Promise.resolve({ data: [route({ _id: 'new' })] })
  await page.loadTemplates()
  old.resolve({ data: [route({ _id: 'old' })] })
  await first
  assert.equal(page.data.templates[0]._id, 'new')
  assert.equal(page.data.templates[0].shortcutTitle, '去学校')
})

test('confirmed snapshot cannot change during the modal/request and successful publication cannot duplicate', async () => {
  const { page, state } = fixture()
  const response = deferred()
  state.createResponse = response.promise
  page.driver_confirmTrip()
  assert.equal(state.modals.length, 1)
  page.setData({ destinationAddress: 'JFK', referencePrice: '99' })
  state.modals[0].success({ confirm: true })
  page.driver_confirmTrip()
  await page.driver_submitTrip()
  assert.equal(state.createCalls.length, 1)
  assert.equal(state.createCalls[0].data.destinations[0].address, '哥大')
  assert.equal(state.createCalls[0].data.referencePrice, '8$/人')
  response.resolve({ result: { success: true, id: 'published' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(page.data.publishedDriverTrip.id, 'published')
  assert.equal(page.data.publishedDriverTrip.destinationAddress, '哥大')
  assert.equal(page.data.publishedDriverTrip.referencePrice, '8')
  assert.equal(state.timers.length, 0)
  assert.equal(state.navigation.length, 0)
  page.driver_confirmTrip()
  await page.driver_submitTrip()
  assert.equal(state.createCalls.length, 1)
})

test('return trip swaps snapshot, clears time, requires a later departure, and publishes only after confirmation', async () => {
  const { page, state } = fixture()
  await page.driver_submitTrip()
  page.onPrepareReturnTrip()
  assert.equal(page.data.departureAddress, '哥大')
  assert.equal(page.data.destinationAddress, 'Fort Lee')
  assert.equal(page.data.departureDate, '2026-09-22')
  assert.equal(page.data.departureTime, '')
  assert.equal(page.data.passengerCountInput, '4')
  assert.equal(page.data.referencePrice, '8')
  assert.equal(page.data.preparingReturn, true)
  assert.equal(state.createCalls.length, 1)
  page.setData({ departureTime: '17:30' })
  page.driver_confirmTrip()
  assert.match(state.toasts.at(-1).title, /返程时间/)
  assert.equal(state.modals.length, 0)
  page.setData({ departureDate: '2026-09-23', departureTime: '08:00' })
  page.driver_confirmTrip()
  assert.equal(state.modals.length, 1)
  assert.equal(state.createCalls.length, 1)
  state.modals[0].success({ confirm: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.createCalls.length, 2)
  assert.equal(state.createCalls[1].data.departures[0].address, '哥大')
  assert.equal(state.createCalls[1].data.departures[0].date, '2026-09-23')
  assert.equal(page.data.preparingReturn, false)
})

test('failed publication can retry while successful publication prevents a duplicate retry', async () => {
  const { page, state } = fixture()
  state.createResponse = Promise.resolve({ result: { success: false } })
  await page.driver_submitTrip()
  assert.equal(state.createCalls.length, 1)
  assert.equal(page.data.publishedDriverTrip, null)
  state.createResponse = Promise.resolve({ result: { success: true, id: 'retry-success' } })
  await page.driver_submitTrip()
  assert.equal(page.data.publishedDriverTrip.id, 'retry-success')
  assert.equal(page.data.submitting, false)
  await page.driver_submitTrip()
  assert.equal(state.createCalls.length, 2)
})

test('choosing another shortcut clears the return constraint without changing profile disclosure', async () => {
  const { page } = fixture()
  await page.driver_submitTrip()
  page.onPrepareReturnTrip()
  page.setData({ templates: [route({ weekdayIndex: 1, departureTime: '13:00' })] })
  page.onTemplateTap({ currentTarget: { dataset: { id: 'template' } } })
  assert.equal(page.data.preparingReturn, false)
  assert.equal(page._returnDepartureTimestamp, null)
  assert.equal(page.data.showZelle, true)
})

test('weekly template skips an invalid New York spring-forward occurrence without changing its clock', () => {
  const { page } = fixture(Date.parse('2027-03-14T04:00:00Z')) // March 13, 23:00 NY.
  page.setData({ templates: [route({ weekdayIndex: 6, departureTime: '02:30' })] })
  page.onTemplateTap({ currentTarget: { dataset: { id: 'template' } } })
  assert.equal(page.data.departureDate, '2027-03-21')
  assert.equal(page.data.departureTime, '02:30')
})

test('a successful publication from a previous account never shows the next account a return-trip action', async () => {
  const { page, state } = fixture()
  const response = deferred()
  state.createResponse = response.promise
  const pending = page.driver_submitTrip()
  state.openid = 'other-driver'
  response.resolve({ result: { success: true, id: 'old-account-trip' } })
  await pending
  assert.equal(page.data.publishedDriverTrip, null)
  assert.equal(state.createCalls.length, 1)
  assert.equal(page.data.preparingReturn, false)
})
