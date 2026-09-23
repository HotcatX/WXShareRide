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
  const state = { now: Date.parse('2030-01-01T10:00:00'), calls: [], store: {}, dbReads: [],
    config: { Departure: { _id: 'from', fortLee: 'Fort Lee', jfk: 'JFK' }, Arrival: { _id: 'to', columbia: '哥大/Columbia', ewr: 'EWR' } },
    configFailure: false, holdConfig: null
  }
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [state.now])) }
    static now() { return state.now }
  }
  const context = {
    Page: page => { definition = page }, Date: Clock, setTimeout, clearTimeout,
    wx: {
      getStorageSync: key => state.store[key],
      setStorageSync: (key, value) => { state.store[key] = value },
      cloud: {
      callFunction(args) { state.calls.push(args); throw new Error('Filters must not call the cloud') },
      database() { return { collection(name) { return { async get() {
        state.dbReads.push(name)
        if (state.holdConfig) await state.holdConfig
        if (state.configFailure) throw new Error('configuration temporarily unavailable')
        return { data: [plain(state.config[name])] }
      } } } } }
    } },
    getApp: () => ({ withReferralShare: value => value }),
    console: { error() {}, warn() {} },
    require(name) {
      if (name.includes('placeRecommendations') || name.includes('placePickerTelemetry')) {
        if (!context._placeModules) context._placeModules = require('./helpers/load-place-modules.cjs')(context, context.require('researchParticipation'))
        return context._placeModules(name)
      }
      if (name.includes('rideTelemetry')) return require('./helpers/load-ride-telemetry.cjs')(context.require('researchParticipation'), { wx: context.wx, Date: typeof Clock === 'undefined' ? Date : Clock })
      if (name.includes('researchParticipation')) return { recordSearch: () => '', recordResults: () => ({ ok: false }) }
      if (name.includes('rideTime')) return require('../utils/rideTime')
      if (name.includes('cityTree')) return city
      if (name.includes('ridePlaceOptions')) return require('../utils/ridePlaceOptions')
      if (name.includes('rideAddressConfig')) {
        const module = { exports: {} }
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/rideAddressConfig.js'), 'utf8'), {
          ...context, module, require: name => require('../utils/' + (name.includes('placeCatalog') ? 'placeCatalog' : 'ridePlaceOptions'))
        })
        return module.exports
      }
      if (name.includes('tripManage')) return pricing
      if (name.includes('rideCalendarPicker')) {
        const module = { exports: {} }
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/rideCalendarPicker.js'), 'utf8'), {
          ...context, module, require: () => require('../utils/rideCalendar')
        })
        return module.exports
      }
      if (name.includes('error')) return { showDataError() {} }
      throw new Error(`Unexpected dependency: ${name}`)
    }
  }
  vm.runInNewContext(source, context)
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
  page.onToggleHideFullTrips()
  assert.deepEqual(ids(), ['tomorrow', 'request', 'full-tomorrow'])
  assert.deepEqual(counts(), [['2030-01-02', 2, 1], ['2030-01-02', 2, 1]], 'both sections show the same daily totals')
  page.onRouteTypeChange(event('type', 'request'))
  assert.deepEqual(ids(), ['request'])
  assert.equal(page.data.hideFullTrips, false, 'changing route type keeps the display preference')
  assert.equal(page.data.fullTripCount, 0, 'requests never enter the full-car section')
  assert.deepEqual(counts(), [['2030-01-02', 0, 1]])
  assert.equal(page.data.moreFilterCount, 2)
  page.onRouteTypeChange(event('type', 'carpool'))
  assert.deepEqual(ids(), ['tomorrow', 'full-tomorrow'])
  assert.equal(page.data.fullTripCount, 1)
  assert.deepEqual(counts(), [['2030-01-02', 2, 0], ['2030-01-02', 2, 0]])
  assert.equal(state.calls.length, 0)
})

test('choosing a departure keeps the selected destination by name when option indexes change', () => {
  const { page, fill, pick, ids } = harness()
  fill([route('airport', 'Fort Lee', 'EWR'), route('campus', 'JFK', 'Columbia')])
  pick('to', 'EWR')
  pick('from', 'Fort Lee')
  assert.equal(page.data.selectedToPlace, 'EWR 纽瓦克机场')
  page.applyFilterOptionData(page.buildFilterOptionData(['JFK', 'Fort Lee'], ['New destination', '哥大/Columbia', 'EWR']))
  assert.equal(page.data.toFilterOptions[page.data.toFilterIndex], 'EWR 纽瓦克机场')
  assert.deepEqual(ids(), ['airport'])
})

test('swap retains both names even when absent from the opposite configuration and one-sided swap works', () => {
  const { page, fill, pick, ids } = harness()
  fill([route('outbound', 'Fort Lee', 'EWR'), route('return', 'EWR', 'Fort Lee')])
  pick('from', 'Fort Lee')
  pick('to', 'EWR')
  page.onSwapFilterPlaces()
  assert.equal(page.data.fromFilterLabel, 'EWR 纽瓦克机场')
  assert.equal(page.data.toFilterLabel, 'Fort Lee')
  assert.ok(page.data.fromFilterOptions.includes('EWR 纽瓦克机场'))
  assert.ok(page.data.toFilterOptions.includes('Fort Lee'))
  assert.deepEqual(ids(), ['return'])
  pick('to', '')
  page.onSwapFilterPlaces()
  assert.equal(page.data.fromFilterLabel, '不限出发地')
  assert.equal(page.data.toFilterLabel, 'EWR 纽瓦克机场')
  assert.deepEqual(ids(), ['outbound'])
})

test('place search includes approved options and campus aliases without republishing private loaded addresses', () => {
  const { page, fill, pick, ids } = harness()
  fill([route('concert', 'BigBang演唱会', '哥大'), route('campus', 'FORTLEE 核心区', 'Columbia University')])
  page.onOpenPlacePicker(event('field', 'from'))
  page.onPlaceSearchInput({ detail: { value: 'bigbang' } })
  assert.ok(!page.data.placePickerOptions.some(option => option.value === 'BigBang演唱会'))
  assert.ok(!page.data.placePickerOptions.some(option => option.value === 'JFK'))
  page.onClosePlacePicker()
  page.onOpenPlacePicker(event('field', 'to'))
  page.onPlaceSearchInput({ detail: { value: 'columbia' } })
  assert.ok(page.data.placePickerOptions.some(option => option.value === '哥大'))
  pick('from', 'Fort Lee')
  pick('to', '哥大/Columbia')
  assert.deepEqual(ids(), ['campus'])
})

test('other still means outside configured places and unapproved custom options cannot be injected', () => {
  const { page, fill, pick, ids } = harness()
  fill([route('configured'), route('custom', 'BigBang演唱会'), route('airport', 'JFK')])
  pick('from', '其他')
  assert.deepEqual(ids(), ['custom'])
  pick('from', 'BigBang演唱会')
  assert.equal(page.data.selectedFromPlace, '其他')
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
  page.changeFilters({ selectedFromPlace: place })
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
  assert.equal(other.data.selectedToPlace, '哥大')
  assert.equal(other.data.selectedDate, '2030-01-05')
  assert.equal(other.data.routeTypeFilter, 'carpool')
})

test('unversioned ambiguous old indexes clear their side instead of using reordered places', () => {
  const { page, fill, ids } = harness()
  fill([route('today'), route('other', 'Unlisted venue', 'Columbia', '2030-01-04')])
  page._initFilterFromShare = page.readShareFilters({ from: '3', to: '2', time: '2' })
  page.applyShareFilters(true, () => page.applyAllFiltersAndGroup())
  assert.equal(page.data.selectedFromPlace, '', 'index 3 changed across old catalogs and cannot be guessed')
  assert.equal(page.data.selectedToPlace, '哥大')
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

test('full-car visibility is independent from filter badges and survives resetting every filter', () => {
  const { page, fill, pick, ids, state } = harness()
  fill([route('available'), route('full', 'Fort Lee', 'Columbia', '2030-01-01', { availSeatNum: 0 })])
  assert.equal(page.data.hideFullTrips, true)
  assert.equal(page.data.hasActiveFilters, false)
  assert.equal(page.data.moreFilterCount, 0)
  page.onToggleHideFullTrips()
  assert.deepEqual(ids(), ['available', 'full'])
  assert.equal(page.data.hasActiveFilters, false)
  assert.equal(page.data.moreFilterCount, 0)
  pick('from', 'Fort Lee')
  page.onRouteTypeChange(event('type', 'carpool'))
  page.onQuickDateChange(event('value', 'today'))
  assert.equal(page.data.moreFilterCount, 2)
  page.onResetFilter()
  assert.equal(page.data.hideFullTrips, false)
  assert.deepEqual(ids(), ['available', 'full'])
  assert.equal(page.data.hasActiveFilters, false)
  assert.equal(page.data.moreFilterCount, 0)
  assert.equal(state.store.carpoolListHideFullTripsV1, false)
  assert.equal(state.calls.length, 0)
})

test('cloud fixed places lead in the eight-place order while loaded private addresses stay out of suggestions', async () => {
  const { page, state, fill } = harness()
  state.config.Departure = { _id: 'from', flushing: 'Flushing', jfk: 'JFK机场', lga: 'LaGuardia', fortLee: 'Fort Lee', ewr: 'EWR机场', columbia: 'Columbia' }
  state.config.Arrival = plain(state.config.Departure)
  fill([
    route('legacy-ewr', 'Newark', 'LaGuardia'),
    route('legacy-jfk', '肯尼迪机场', 'Flushing'),
    route('specific', 'EWR Terminal C', '法拉盛 Main St 123号'),
    route('concert', 'BigBang演唱会', 'Fort Lee 某公寓')
  ])
  await page.onOpenPlacePicker(event('field', 'from'))
  assert.deepEqual(plain(page.data.fromFilterOptions), ['全部', 'Fort Lee', '哥大', '法拉盛', 'JFK', 'EWR 纽瓦克机场', 'LGA 拉瓜迪亚', 'LIC', 'JSQ', '其他'])
  assert.deepEqual(plain(page.data.toFilterOptions), ['全部', 'Fort Lee', '哥大', '法拉盛', 'JFK', 'EWR 纽瓦克机场', 'LGA 拉瓜迪亚', 'LIC', 'JSQ', '其他'])
  assert.equal(state.calls.length, 0, 'reusing currently loaded route places needs no new cloud function call')
})

test('selecting short airport/place names finds legacy aliases and terminal addresses; searching aliases finds short options', async () => {
  const { page, state, fill, ids } = harness()
  state.config.Departure = { _id: 'from', fortLee: 'Fort Lee', columbia: '哥大', ewr: 'EWR 纽瓦克机场', jfk: 'JFK', lga: 'LGA 拉瓜迪亚', flushing: '法拉盛' }
  state.config.Arrival = plain(state.config.Departure)
  fill([
    route('ewr-cn', 'EWR机场'), route('ewr-en', 'Newark'), route('ewr-terminal', 'EWR Terminal C'),
    route('lga-cn', 'LGA机场'), route('lga-en', 'LaGuardia'),
    route('jfk-cn', '肯尼迪机场'), route('jfk-en', 'JFK机场'),
    route('flushing', 'Flushing'), route('custom', '自选聚会地点')
  ])
  await page.onOpenPlacePicker(event('field', 'from'))
  for (const [label, matching] of [
    ['EWR 纽瓦克机场', ['ewr-cn', 'ewr-terminal']],
    ['LGA 拉瓜迪亚', ['lga-cn', 'lga-en']],
    ['JFK', ['jfk-cn', 'jfk-en']], ['法拉盛', ['flushing']]
  ]) {
    page.changeFilters({ selectedFromPlace: label })
    assert.deepEqual(ids(), matching)
    assert.equal(page.data.fromFilterLabel, label)
  }
  page.changeFilters({ selectedFromPlace: 'EWR Terminal C' })
  assert.deepEqual(ids(), ['ewr-terminal'], 'specific custom selections do not widen into the whole airport')
  await page.onOpenPlacePicker(event('field', 'from'))
  for (const [keyword, label] of [['ewr', 'EWR 纽瓦克机场'], ['Newark Airport', 'EWR 纽瓦克机场'], ['lga机场', 'LGA 拉瓜迪亚'], ['LaGuardia', 'LGA 拉瓜迪亚'], ['肯尼迪', 'JFK'], ['Flushing', '法拉盛']]) {
    page.onPlaceSearchInput({ detail: { value: keyword } })
    assert.ok(page.data.placePickerOptions.some(option => option.label === label), keyword)
  }
  assert.equal(state.calls.length, 0)
})

test('fixed-place config is refreshed at five minutes on opening either picker, without old 24-hour storage blocking updates', async () => {
  const { page, state, fill } = harness()
  state.store.carpoolListFilterOptionsV1 = { savedAt: state.now, fromPlaceList: ['旧出发地'], toPlaceList: ['旧目的地'] }
  assert.equal(page.getCachedFilterOptions(), null)
  fill([route('custom', '自选演唱会')])
  await page.onOpenPlacePicker(event('field', 'from'))
  assert.deepEqual(state.dbReads, ['Departure', 'Arrival'])
  page.changeFilters({ selectedFromPlace: '自选演唱会', placePickerVisible: false })
  page.onToggleHideFullTrips()
  state.config.Departure = { _id: 'from', fortLee: 'Fort Lee', ewr: 'EWR 纽瓦克机场', lga: 'LGA 拉瓜迪亚' }
  state.config.Arrival = { _id: 'to', columbia: '哥大', flushing: '法拉盛' }
  state.now += 299999
  await page.onOpenPlacePicker(event('field', 'to'))
  assert.equal(state.dbReads.length, 2)
  assert.ok(page.data.toPlaceList.includes('法拉盛'))
  state.now += 1
  await page.onOpenPlacePicker(event('field', 'from'))
  assert.equal(state.dbReads.length, 4)
  assert.deepEqual(plain(page.data.fromPlaceList), ['Fort Lee', '哥大', '法拉盛', 'JFK', 'EWR 纽瓦克机场', 'LGA 拉瓜迪亚', 'LIC', 'JSQ'])
  assert.deepEqual(plain(page.data.toPlaceList), ['Fort Lee', '哥大', '法拉盛', 'JFK', 'EWR 纽瓦克机场', 'LGA 拉瓜迪亚', 'LIC', 'JSQ'])
  assert.equal(page.data.selectedFromPlace, '自选演唱会')
  assert.equal(page.data.hideFullTrips, false)
  assert.ok(page.data.fromFilterOptions.includes('自选演唱会'))
  await page.onOpenPlacePicker(event('field', 'to'))
  assert.equal(state.dbReads.length, 4)
})

test('concurrent fixed-place opens coalesce; a failed or late update preserves the current page and its selection', async () => {
  const { page, state, fill } = harness()
  fill([route('one')])
  let release
  state.holdConfig = new Promise(resolve => { release = resolve })
  const first = page.onOpenPlacePicker(event('field', 'from'))
  const same = page.onOpenPlacePicker(event('field', 'to'))
  assert.equal(state.dbReads.length, 2)
  release()
  await Promise.all([first, same])
  state.holdConfig = null
  page.changeFilters({ selectedToPlace: 'EWR 纽瓦克机场' })
  state.now += 300000
  state.configFailure = true
  const before = plain(page.data)
  await page.onOpenPlacePicker(event('field', 'to'))
  assert.deepEqual(plain(page.data.fromPlaceList), before.fromPlaceList)
  assert.deepEqual(plain(page.data.toPlaceList), before.toPlaceList)
  assert.equal(page.data.selectedToPlace, 'EWR 纽瓦克机场')

  state.configFailure = false
  state.holdConfig = new Promise(resolve => { release = resolve })
  const late = page.onOpenPlacePicker(event('field', 'from'))
  page.onUnload()
  const beforeUnload = plain(page.data)
  release()
  await late
  assert.deepEqual(plain(page.data), beforeUnload)
})
