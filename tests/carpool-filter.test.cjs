const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../pages/home/carpoolList/carpoolList.js'), 'utf8')
const city = require('../utils/cityTree')
const pricing = require('../utils/tripManage')
const plain = value => JSON.parse(JSON.stringify(value))
const event = (key, value) => ({ currentTarget: { dataset: { [key]: value } } })

function route(id, from = 'Fort Lee', to = 'Columbia', date = '2030-01-01', extra = {}) {
  return {
    _id: id, status: 'open', availSeatNum: 2, cityKey: 'ny_nj',
    departures: [{ address: from, date, time: '12:00' }],
    destinations: [{ address: to }], ...extra
  }
}

function harness() {
  let definition
  const state = { now: Date.parse('2030-01-01T10:00:00'), calls: [] }
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [state.now])) }
    static now() { return state.now }
  }
  vm.runInNewContext(source, {
    Page: page => { definition = page }, Date: Clock, setTimeout, clearTimeout,
    wx: { cloud: {
      callFunction(args) { state.calls.push(args); throw new Error('Filters must not call the cloud') },
      database() { throw new Error('Filters must not query the database') }
    } },
    getApp: () => ({ withReferralShare: value => value }),
    console,
    require(name) {
      if (name.includes('cityTree')) return city
      if (name.includes('tripManage')) return pricing
      if (name.includes('error')) return { showDataError() {} }
      throw new Error(`Unexpected dependency: ${name}`)
    }
  })
  const page = { ...definition, data: plain(definition.data) }
  page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) callback.call(this) }
  Object.assign(page.data, page.getFilterDateData(), page.buildFilterOptionData(['Fort Lee', 'JFK'], ['哥大/Columbia', 'EWR']))
  const fill = (cars, requests = []) => {
    page.data.originalCarpoolList = cars.map(item => page.decorateTripCommon(item, 'carpool'))
    page.data.originalRequestList = requests.map(item => page.decorateTripCommon(item, 'request'))
    page.applyAllFiltersAndGroup()
  }
  const pick = (field, value) => {
    page.onOpenPlacePicker(event('field', field))
    page.onSelectFilterPlace(event('value', value))
  }
  const ids = () => plain(page.data.dayGroups.flatMap(group => group.items.map(item => item._id)))
  return { page, state, fill, pick, ids }
}

test('combined place, date and route-type filters update results and full counts without network calls', () => {
  const { page, fill, pick, ids, state } = harness()
  fill([
    route('today'), route('tomorrow', 'Fort Lee', 'Columbia', '2030-01-02'),
    route('full-tomorrow', 'Fort Lee', 'Columbia', '2030-01-02', { availSeatNum: 0 }),
    route('airport', 'JFK', 'Columbia', '2030-01-02')
  ], [route('request', 'Fort Lee', 'Columbia', '2030-01-02', { status: 'full', availSeatNum: 0 })])
  const counts = () => plain(page.data.dayGroups.map(group => [group.date, group.carpoolCount, group.requestCount]))
  assert.deepEqual(counts(), [['2030-01-01', 1, 0], ['2030-01-02', 3, 1]])
  pick('from', 'Fort Lee')
  pick('to', '哥大/Columbia')
  page.onQuickDateChange(event('value', 'tomorrow'))
  assert.deepEqual(ids(), ['tomorrow', 'request'])
  assert.equal(page.data.fullTripCount, 1)
  assert.deepEqual(counts(), [['2030-01-02', 2, 1]], 'daily totals include folded full cars after place/date filtering')
  page.onToggleFullTrips()
  assert.deepEqual(ids(), ['tomorrow', 'request', 'full-tomorrow'])
  assert.deepEqual(counts(), [['2030-01-02', 2, 1], ['2030-01-02', 2, 1]], 'both sections show the same daily totals')
  page.onRouteTypeChange(event('type', 'request'))
  assert.deepEqual(ids(), ['request'])
  assert.equal(page.data.showFullTrips, false)
  assert.equal(page.data.fullTripCount, 0, 'requests never enter the full-car section')
  assert.deepEqual(counts(), [['2030-01-02', 0, 1]])
  assert.equal(page.data.moreFilterCount, 2)
  page.onRouteTypeChange(event('type', 'carpool'))
  assert.deepEqual(ids(), ['tomorrow'])
  assert.equal(page.data.fullTripCount, 1)
  assert.deepEqual(counts(), [['2030-01-02', 2, 0]])
  assert.equal(state.calls.length, 0)
})

test('choosing a departure keeps the selected destination by name when option indexes change', () => {
  const { page, fill, pick, ids } = harness()
  fill([route('airport', 'Fort Lee', 'EWR'), route('campus', 'JFK', 'Columbia')])
  pick('to', 'EWR')
  pick('from', 'Fort Lee')
  assert.equal(page.data.selectedToPlace, 'EWR')
  page.applyFilterOptionData(page.buildFilterOptionData(['JFK', 'Fort Lee'], ['New destination', '哥大/Columbia', 'EWR']))
  assert.equal(page.data.toFilterOptions[page.data.toFilterIndex], 'EWR')
  assert.deepEqual(ids(), ['airport'])
})

test('swap retains both names even when absent from the opposite configuration and one-sided swap works', () => {
  const { page, fill, pick, ids } = harness()
  fill([route('outbound', 'Fort Lee', 'EWR'), route('return', 'EWR', 'Fort Lee')])
  pick('from', 'Fort Lee')
  pick('to', 'EWR')
  page.onSwapFilterPlaces()
  assert.equal(page.data.fromFilterLabel, 'EWR')
  assert.equal(page.data.toFilterLabel, 'Fort Lee')
  assert.ok(page.data.fromFilterOptions.includes('EWR'))
  assert.ok(page.data.toFilterOptions.includes('Fort Lee'))
  assert.deepEqual(ids(), ['return'])
  pick('to', '')
  page.onSwapFilterPlaces()
  assert.equal(page.data.fromFilterLabel, '不限出发地')
  assert.equal(page.data.toFilterLabel, 'EWR')
  assert.deepEqual(ids(), ['outbound'])
})

test('place search includes configured and loaded addresses, with case-insensitive campus aliases', () => {
  const { page, fill, pick, ids } = harness()
  fill([route('concert', 'BigBang演唱会', '哥大'), route('campus', 'FORTLEE 核心区', 'Columbia University')])
  page.onOpenPlacePicker(event('field', 'from'))
  page.onPlaceSearchInput({ detail: { value: 'bigbang' } })
  assert.ok(page.data.placePickerOptions.some(option => option.value === 'BigBang演唱会'))
  assert.ok(!page.data.placePickerOptions.some(option => option.value === 'JFK'))
  page.onClosePlacePicker()
  page.onOpenPlacePicker(event('field', 'to'))
  page.onPlaceSearchInput({ detail: { value: 'columbia' } })
  assert.ok(page.data.placePickerOptions.some(option => option.value === '哥大'))
  pick('from', 'Fort Lee')
  pick('to', '哥大/Columbia')
  assert.deepEqual(ids(), ['campus'])
})

test('other still means outside configured places even though custom loaded addresses are selectable', () => {
  const { page, fill, pick, ids } = harness()
  fill([route('configured'), route('custom', 'BigBang演唱会'), route('airport', 'JFK')])
  pick('from', '其他')
  assert.deepEqual(ids(), ['custom'])
  pick('from', 'BigBang演唱会')
  assert.deepEqual(ids(), ['custom'])
  pick('from', '')
  assert.equal(ids().length, 3)
  assert.equal(page.data.hasActiveFilters, false)
})

test('specific date is exact, rejects invalid dates and yields to quick date choices', () => {
  const { page, fill, ids } = harness()
  fill([route('today'), route('tomorrow', 'Fort Lee', 'Columbia', '2030-01-02'), route('later', 'Fort Lee', 'Columbia', '2030-01-05')])
  page.onSpecificDateChange({ detail: { value: '2030-01-05' } })
  assert.deepEqual(ids(), ['later'])
  assert.equal(page.data.dateFilterLabel, '1月5日')
  page.onSpecificDateChange({ detail: { value: '2030-02-30' } })
  assert.equal(page.data.selectedDate, '2030-01-05')
  page.onQuickDateChange(event('value', 'today'))
  assert.equal(page.data.selectedDate, '')
  assert.deepEqual(ids(), ['today'])
  page.onQuickDateChange(event('value', 'all'))
  assert.equal(ids().length, 3)
})

test('returning after midnight updates today and tomorrow without turning a local filter into a network request', () => {
  const { page, state, fill, ids } = harness()
  fill([route('yesterday'), route('today', 'Fort Lee', 'Columbia', '2030-01-02')])
  page.onQuickDateChange(event('value', 'today'))
  page.data.hasLoadedOnce = true
  page.loadBothLists = () => page.applyAllFiltersAndGroup()
  state.now = Date.parse('2030-01-02T00:05:00')
  page.onShow()
  assert.equal(page.data.todayDateStr, '2030-01-02')
  assert.equal(page.data.tomorrowDateStr, '2030-01-03')
  assert.deepEqual(ids(), ['today'])
  assert.equal(state.calls.length, 0)
})

test('new shares round-trip stable names, special characters, date and type across reordered options', () => {
  const { page, fill, pick } = harness()
  const place = 'A&B / 地点 + 入口'
  fill([route('special', place, 'Columbia', '2030-01-05')])
  pick('from', place)
  pick('to', '哥大/Columbia')
  page.onSpecificDateChange({ detail: { value: '2030-01-05' } })
  page.onRouteTypeChange(event('type', 'carpool'))
  const query = page.onShareTimeline().query
  assert.ok(query.includes('fromPlace=A%26B%20%2F'))
  assert.ok(page.onShareAppMessage().path.endsWith(query))
  const incoming = Object.fromEntries(query.split('&').map(pair => pair.split('=')))
  const other = harness().page
  other._initFilterFromShare = other.readShareFilters(incoming)
  other.applyShareFilters(true)
  other.applyFilterOptionData(other.buildFilterOptionData(['New place', 'JFK'], ['EWR']))
  assert.equal(other.data.selectedFromPlace, place)
  assert.equal(other.data.selectedToPlace, '哥大/Columbia')
  assert.equal(other.data.selectedDate, '2030-01-05')
  assert.equal(other.data.routeTypeFilter, 'carpool')
})

test('old index shares and other-date shares survive appended custom places', () => {
  const { page, fill, ids } = harness()
  fill([route('today'), route('other', 'Unlisted venue', 'Columbia', '2030-01-04')])
  page._initFilterFromShare = page.readShareFilters({ from: '3', to: '1', time: '2' })
  page.applyShareFilters(true, () => page.applyAllFiltersAndGroup())
  assert.equal(page.data.selectedFromPlace, '其他', 'legacy index 3 refers to configured other, not appended venue')
  assert.equal(page.data.selectedToPlace, '哥大/Columbia')
  assert.equal(page.data.dateFilterLabel, '其他日期')
  assert.deepEqual(ids(), ['other'])
})

test('reset clears all filters; a late configuration read cannot restore stale share selections', () => {
  const { page, fill, pick, ids } = harness()
  fill([route('one'), route('two', 'JFK', 'EWR')])
  page._initFilterFromShare = page.readShareFilters({ fromPlace: 'Fort%20Lee', type: 'request', time: '1' })
  page.applyShareFilters(false)
  pick('from', 'JFK')
  page.onResetFilter()
  page.applyFilterOptionData(page.buildFilterOptionData(['Fort Lee', 'JFK'], ['EWR', '哥大/Columbia']))
  assert.deepEqual(ids(), ['one', 'two'])
  assert.equal(page.data.fromFilterLabel, '不限出发地')
  assert.equal(page.data.toFilterLabel, '不限目的地')
  assert.equal(page.data.selectedDate, '')
  assert.equal(page.data.routeTypeFilter, 'all')
  assert.equal(page.data.hasActiveFilters, false)
  assert.equal(page.data.placePickerVisible, false)
  assert.equal(page.data.moreFilterCount, 0)
})
