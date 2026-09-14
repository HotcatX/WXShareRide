const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const DEVICE_TIMEZONES = ['Asia/Shanghai', 'America/New_York', 'America/Los_Angeles', 'UTC']

// Execute real client modules with a fixed instant and without Intl. Changing the
// child process TZ reproduces a phone whose local date is ahead of New York.
function timezoneFixture(root) {
  const fs = require('node:fs')
  const path = require('node:path')
  const vm = require('node:vm')
  const now = Date.parse('2026-09-14T20:00:00Z')
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
  }
  let pageDefinition
  let componentDefinition
  const context = vm.createContext({
    Date: Clock, Intl: undefined, setTimeout, clearTimeout,
    Page: value => { pageDefinition = value },
    Component: value => { componentDefinition = value },
    console: { log() {}, warn() {}, error() {} },
    getApp: () => ({}),
    wx: {
      getStorageSync: () => undefined,
      cloud: { callFunction() { throw new Error('Timezone calculations must not call the cloud') } }
    }
  })
  const modules = new Map()
  function load(filename) {
    const absolute = path.resolve(root, filename)
    if (absolute === path.join(root, 'utils/error.js')) return { showDataError() {} }
    if (absolute === path.join(root, 'utils/cloudConfig.js')) return { loadPublicConfigDoc: async () => null }
    if (modules.has(absolute)) return modules.get(absolute).exports
    const module = { exports: {} }
    modules.set(absolute, module)
    const expose = absolute === path.join(root, 'pages/home/home.js')
      ? '\nmodule.exports = { getDepartTimestamp, sortByDepartTimeAsc };' : ''
    const execute = vm.runInContext(`(function(require, module, exports) {\n${fs.readFileSync(absolute, 'utf8')}${expose}\n})`, context, { filename: absolute })
    execute(name => {
      if (!name.startsWith('.')) throw new Error(`Unexpected dependency: ${name}`)
      const dependency = path.resolve(path.dirname(absolute), name)
      return load(path.extname(dependency) ? dependency : `${dependency}.js`)
    }, module, module.exports)
    return module.exports
  }
  function page(filename) {
    load(filename)
    const instance = { ...pageDefinition, data: JSON.parse(JSON.stringify(pageDefinition.data)) }
    instance.setData = function (patch, callback) {
      Object.assign(this.data, patch)
      if (callback) callback.call(this)
    }
    return instance
  }
  const rideTime = load('utils/rideTime.js')
  const instants = [
    '2026-09-14T20:00:00Z',
    '2026-09-15T03:59:59Z', '2026-09-15T04:00:00Z',
    '2026-01-15T04:59:59Z', '2026-01-15T05:00:00Z',
    '2027-01-01T04:59:59Z', '2027-01-01T05:00:00Z',
    '2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z',
    '2026-11-01T05:59:59Z', '2026-11-01T06:00:00Z'
  ]
  const parse = (date, time) => {
    const value = rideTime.parseRideDateTime(date, time)
    return Number.isFinite(value) ? new Date(value).toISOString() : null
  }
  const list = page('pages/home/carpoolList/carpoolList.js')
  const trip = {
    _id: 'ny-evening', status: 'open', availSeatNum: 2,
    departures: [{ address: 'Fort Lee', date: '2026-09-14', time: '18:00' }],
    destinations: [{ address: '哥大' }]
  }
  const listResult = {
    dates: list.getFilterDateData(new Clock(now)),
    initialPage: list.getInitialDatePage(),
    timestamp: new Date(list.getTripTimestamp(trip)).toISOString(),
    savedTimestamp: list.getTripTimestamp({ ...trip, departureAtMs: Date.parse('2026-09-14T22:30:00Z') }),
    visible: list.shouldShowTrip(trip)
  }
  list.setData({ selectedDate: '2026-09-15' })
  listResult.selectedPage = list.getInitialDatePage()
  const home = load('pages/home/home.js')
  const homeResult = {
    timestamp: new Date(home.getDepartTimestamp(trip)).toISOString(),
    savedTimestamp: home.getDepartTimestamp({ ...trip, departureAtMs: Date.parse('2026-09-14T22:30:00Z') }),
    order: home.sortByDepartTimeAsc([
      { _id: 'earlier-today', date: '2026-09-14', time: '13:00' }, trip
    ]).map(value => value._id)
  }
  const create = page('pages/home/newTrip/newTrip.js')
  const parsed = create.parseDateTimeSafe('2026-09-14', '18:00')
  const createResult = {
    dates: create.getFilterDateData(new Clock(now)),
    timestamp: parsed && parsed.toISOString(),
    invalidDate: create.parseDateTimeSafe('2026-02-30', '18:00'),
    skippedHour: create.parseDateTimeSafe('2026-03-08', '02:30'),
    nearestWeekdays: [0, 1, 6].map(index => create.getNearestDateByWeekdayIndex_Mon0(index))
  }
  load('components/ride-time-picker/index.js')
  const component = {
    ...componentDefinition.methods,
    data: JSON.parse(JSON.stringify(componentDefinition.data)),
    properties: { visible: true, value: '' },
    setData(patch) { Object.assign(this.data, patch) }
  }
  componentDefinition.observers.visible.call(component, true)
  return {
    instants: instants.map(instant => rideTime.getRideDateTime(Date.parse(instant))),
    defaultTime: rideTime.getRideDateTime(),
    dateObjectTime: rideTime.getRideDateTime(new Clock(now)),
    dates: ['2026-09-15T03:59:59Z', '2027-01-01T04:59:59Z', '2026-03-08T06:00:00Z', '2026-11-01T05:00:00Z']
      .map(instant => rideTime.getRideDateData(Date.parse(instant))),
    parsed: [
      ['2026-09-14', '18:00'], ['2026-01-14', '18:00'],
      ['2026-03-08', '01:59'], ['2026-03-08', '02:00'], ['2026-03-08', '02:59'], ['2026-03-08', '03:00'],
      ['2026-11-01', '01:30'], ['2026-11-01', '02:00'],
      ['2026-02-30', '12:00'], ['2026-09-14', '24:00'], ['2026-09-14', '12:60']
    ].map(([date, time]) => parse(date, time)),
    shifted: [
      ['2026-03-08', 1], ['2026-11-01', 1], ['2026-12-31', 1], ['2027-01-01', -1], ['2028-02-28', 1]
    ].map(([date, days]) => rideTime.shiftRideDate(date, days)),
    valid: ['2028-02-29', '2026-02-29', '2026-04-31', '2026-09-14', '2026-13-01', ''].map(rideTime.isValidRideDate),
    weekdays: ['2026-09-14', '2026-09-20', '2027-01-01'].map(rideTime.getRideWeekday),
    list: listResult,
    home: homeResult,
    create: createResult,
    picker: { selectedTime: component.data.selectedTime, pickerValue: component.data.pickerValue }
  }
}

const results = new Map()
function resultFor(timezone) {
  if (!results.has(timezone)) {
    const script = `process.stdout.write(JSON.stringify((${timezoneFixture.toString()})(${JSON.stringify(ROOT)})))`
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: ROOT, env: { ...process.env, TZ: timezone }, encoding: 'utf8', timeout: 10000
    })
    assert.equal(result.status, 0, `${timezone}: ${result.error || result.stderr}`)
    results.set(timezone, JSON.parse(result.stdout))
  }
  return results.get(timezone)
}

for (const timezone of DEVICE_TIMEZONES) {
  test(`${timezone}: New York wall time survives summer/winter midnight, year boundary and DST`, () => {
    const actual = resultFor(timezone)
    const expected = [
      ['2026-09-14', '16:00', 0], ['2026-09-14', '23:59', 59], ['2026-09-15', '00:00', 0],
      ['2026-01-14', '23:59', 59], ['2026-01-15', '00:00', 0],
      ['2026-12-31', '23:59', 59], ['2027-01-01', '00:00', 0],
      ['2026-03-08', '01:59', 59], ['2026-03-08', '03:00', 0],
      ['2026-11-01', '01:59', 59], ['2026-11-01', '01:00', 0]
    ]
    assert.deepEqual(actual.instants.map(value => [value.date, value.time, value.second]), expected)
    assert.deepEqual(actual.instants[0], {
      date: '2026-09-14', time: '16:00', year: 2026, month: 9, day: 14, hour: 16, minute: 0, second: 0
    })
    assert.deepEqual(actual.defaultTime, actual.instants[0])
    assert.deepEqual(actual.dateObjectTime, actual.instants[0])
    assert.deepEqual(actual.dates, [
      { todayDateStr: '2026-09-14', tomorrowDateStr: '2026-09-15' },
      { todayDateStr: '2026-12-31', tomorrowDateStr: '2027-01-01' },
      { todayDateStr: '2026-03-08', tomorrowDateStr: '2026-03-09' },
      { todayDateStr: '2026-11-01', tomorrowDateStr: '2026-11-02' }
    ])
  })

  test(`${timezone}: New York parsing rejects skipped spring times and selects the first repeated fall time`, () => {
    const actual = resultFor(timezone)
    assert.deepEqual(actual.parsed, [
      '2026-09-14T22:00:00.000Z', '2026-01-14T23:00:00.000Z',
      '2026-03-08T06:59:00.000Z', null, null, '2026-03-08T07:00:00.000Z',
      '2026-11-01T05:30:00.000Z', '2026-11-01T07:00:00.000Z', null, null, null
    ])
    assert.deepEqual(actual.shifted, ['2026-03-09', '2026-11-02', '2027-01-01', '2026-12-31', '2028-02-29'])
    assert.deepEqual(actual.valid, [true, false, false, true, false, false])
    assert.deepEqual(actual.weekdays, [1, 0, 5])
  })

  test(`${timezone}: list, creation, weekday templates and time picker share the New York service clock`, () => {
    const actual = resultFor(timezone)
    const expectedDates = { todayDateStr: '2026-09-14', tomorrowDateStr: '2026-09-15' }
    assert.deepEqual(actual.list.dates, expectedDates, 'Monday must remain the first service day on a Chinese phone after local midnight')
    assert.deepEqual(actual.list.initialPage, {
      startDate: '2026-09-14', endDateExclusive: '2026-09-16', exactDate: false
    }, 'the initial two-day server request must include New York Monday')
    assert.deepEqual(actual.list.selectedPage, {
      startDate: '2026-09-15', endDateExclusive: '2026-09-16', exactDate: true
    }, 'an explicitly selected Tuesday remains Tuesday rather than being clamped to today')
    assert.equal(actual.list.timestamp, '2026-09-14T22:00:00.000Z')
    assert.equal(actual.list.savedTimestamp, Date.parse('2026-09-14T22:30:00Z'), 'saved absolute timestamps retain priority')
    assert.equal(actual.list.visible, true, 'an upcoming 18:00 New York trip is not expired at 16:00 New York')
    assert.equal(actual.home.timestamp, '2026-09-14T22:00:00.000Z')
    assert.equal(actual.home.savedTimestamp, actual.list.savedTimestamp)
    assert.deepEqual(actual.home.order, ['ny-evening', 'earlier-today'], 'home puts upcoming service trips before past trips in every device timezone')
    assert.deepEqual(actual.create.dates, expectedDates)
    assert.equal(actual.create.timestamp, '2026-09-14T22:00:00.000Z')
    assert.equal(actual.create.invalidDate, null)
    assert.equal(actual.create.skippedHour, null)
    assert.deepEqual(actual.create.nearestWeekdays, ['2026-09-14', '2026-09-15', '2026-09-20'])
    assert.deepEqual(actual.picker, { selectedTime: '16:00', pickerValue: [16, 0] })
  })
}
