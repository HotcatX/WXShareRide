const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const plain = value => JSON.parse(JSON.stringify(value))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function utilityHarness() {
  const state = { now: 1800000000000, calls: [], next: null, storage: { openid: 'a', rideListShouldRefreshAt: 1 } }
  class Clock extends Date { static now() { return state.now } }
  const context = {
    module: { exports: {} }, Date: Clock,
    require: () => ({ normalizeRideServiceCityKey: key => ['ny', 'nj', '', undefined].includes(key) ? 'ny_nj' : key }),
    wx: {
      getStorageSync: key => state.storage[key],
      cloud: { callFunction(options) {
        state.calls.push(plain(options))
        return state.next || Promise.resolve({ result: { success: true, data: { fromPlaces: ['Fort Lee', 'Park'], toPlaces: ['哥大'] } } })
      } }
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/ridePlaceOptions.js'), 'utf8'), context)
  return { api: context.module.exports, state }
}
function componentHarness(properties = {}) {
  const { api } = utilityHarness()
  let definition
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/ride-place-picker/index.js'), 'utf8'), {
    Component: value => { definition = value }, require: () => api
  })
  const defaults = Object.fromEntries(Object.entries(definition.properties).map(([key, prop]) => [key, prop.value]))
  const component = {
    ...definition.methods,
    properties: { ...defaults, visible: true, ...properties },
    data: plain(definition.data), events: [],
    setData(patch) { Object.assign(this.data, patch) },
    triggerEvent(name, detail) { this.events.push({ name, detail: detail && plain(detail) }) }
  }
  definition.observers.visible.call(component, true)
  return { component, definition }
}
const tap = value => ({ currentTarget: { dataset: { value } } })
const input = value => ({ detail: { value } })

test('place normalization deduplicates canonical common places without swallowing real custom addresses', () => {
  const { api } = utilityHarness()
  assert.deepEqual(plain(api.uniqueRidePlaces([
    ' Fort Lee ', 'fortlee', 'Fort Lee 核心区', '哥大', 'Columbia University',
    'Fort Lee 公寓', '哥大附近酒店', ' Park  Ave ', 'park ave', '', null, '其他', '自选', 'x'.repeat(201)
  ])), ['Fort Lee', '哥大', 'Fort Lee 公寓', '哥大附近酒店', 'Park Ave'])
  assert.equal(api.normalizeRidePlace('  one\n two  '), 'one two')
})

test('airport labels and exact alias deduplication retain specific self-selected addresses', () => {
  const { api } = utilityHarness()
  assert.deepEqual(plain(api.uniqueRidePlaces([
    'EWR机场', '纽瓦克', 'Newark Liberty International Airport', 'JFK', '肯尼迪机场',
    'LGA Airport', '拉瓜迪亚', 'La Guardia Airport', '法拉盛', 'Flushing',
    'EWR Terminal C', 'Newark Broad Street', 'Flushing Library'
  ])), ['EWR机场', 'JFK', 'LGA Airport', '法拉盛', 'EWR Terminal C', 'Newark Broad Street', 'Flushing Library'])
  assert.deepEqual(['Fort Lee', '哥大', 'EWR机场', 'JFK Airport', 'LGA', 'Flushing'].map(api.shortRidePlaceLabel), ['Fort Lee', '哥大', '纽瓦克', 'JFK', '拉瓜迪亚', '法拉盛'])
  assert.equal(api.shortRidePlaceLabel('EWR Terminal C'), 'EWR Terminal C')
  for (const [place, matching, unrelated] of [
    ['纽瓦克', 'EWR Terminal C', 'fewr plaza'],
    ['JFK', '肯尼迪机场', 'AJFK'],
    ['拉瓜迪亚', 'La Guardia Airport', 'BLGA'],
    ['法拉盛', 'Flushing Library', 'Fort Lee']
  ]) {
    const matches = api.makeRidePlaceMatcher(place)
    assert.equal(matches(matching), true, place)
    assert.equal(matches(unrelated), false, place)
  }
  assert.equal(api.makeRidePlaceMatcher('EWR Terminal C')('EWR Terminal B'), false)
  assert.equal(api.makeRidePlaceMatcher('EWR Terminal C')('EWR Terminal C pickup'), true)
})

test('place options coalesce pending reads, cache successes five minutes, and protect cached arrays', async () => {
  const { api, state } = utilityHarness()
  const wait = deferred()
  state.next = wait.promise
  const first = api.loadRidePlaceOptions({ cityKey: 'ny', viewerKey: 'a' })
  const second = api.loadRidePlaceOptions({ cityKey: 'nj', viewerKey: 'a', force: true })
  assert.equal(state.calls.length, 1)
  assert.deepEqual(state.calls[0], { name: 'getTripList', data: { action: 'places', cityKey: 'ny_nj' } })
  wait.resolve({ result: { success: true, data: { fromPlaces: ['Park', ' park '], toPlaces: ['Museum'] } } })
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(plain(a), { fromPlaces: ['Park'], toPlaces: ['Museum'] })
  a.fromPlaces.push('local edit')
  assert.deepEqual(plain(b.fromPlaces), ['Park'])
  state.next = null
  state.now += 299999
  assert.deepEqual(plain((await api.loadRidePlaceOptions({ cityKey: 'ny_nj', viewerKey: 'a' })).fromPlaces), ['Park'])
  assert.equal(state.calls.length, 1)
  state.now++
  await api.loadRidePlaceOptions({ cityKey: 'ny_nj', viewerKey: 'a' })
  assert.equal(state.calls.length, 2)
  await api.loadRidePlaceOptions({ cityKey: 'ny_nj', viewerKey: 'a', force: true })
  assert.equal(state.calls.length, 3)
})

test('place options isolate city, viewer, mutation revision and guest reads while old responses stay on their key', async () => {
  const { api, state } = utilityHarness()
  const old = deferred()
  state.next = old.promise
  const pending = api.loadRidePlaceOptions({ cityKey: 'ny_nj', viewerKey: 'a', revision: 1 })
  state.next = null
  for (const args of [
    { cityKey: 'ny_nj', viewerKey: 'b', revision: 1 },
    { cityKey: 'ny_nj', viewerKey: 'a', revision: 2 },
    { cityKey: 'boston', viewerKey: 'a', revision: 1 }
  ]) await api.loadRidePlaceOptions(args)
  state.storage.isGuest = true
  await api.loadRidePlaceOptions({ cityKey: 'ny_nj' })
  assert.equal(state.calls.length, 5)
  old.resolve({ result: { success: true, data: { fromPlaces: ['old a'], toPlaces: [] } } })
  await pending
  const b = await api.loadRidePlaceOptions({ cityKey: 'ny_nj', viewerKey: 'b', revision: 1 })
  assert.equal(b.fromPlaces.includes('old a'), false)
  assert.equal(state.calls.length, 5)
})

test('place options do not cache failed or malformed responses', async () => {
  const { api, state } = utilityHarness()
  for (const response of [
    { result: { success: false } },
    { result: { success: true, data: { fromPlaces: [], toPlaces: null } } },
    { result: { success: true, data: { fromPlaces: [{}], toPlaces: [] } } }
  ]) {
    state.next = Promise.resolve(response)
    await assert.rejects(api.loadRidePlaceOptions({ cityKey: 'ny_nj' }))
  }
  state.next = null
  await api.loadRidePlaceOptions({ cityKey: 'ny_nj' })
  assert.equal(state.calls.length, 4)
})

test('picker renders fixed canonical values, filters duplicates and confirms exact selections', () => {
  const { component } = componentHarness({
    value: 'Fort Lee',
    fixedOptions: [{ label: 'Fort Lee', value: 'Fort Lee 核心区' }, '哥大'],
    options: ['Fort Lee', 'Fort Lee 核心区', 'Columbia University', 'Fort Lee 公寓', 'Park', 'park']
  })
  assert.equal(component.data.fixedEntries[0].label, 'Fort Lee')
  assert.equal(component.data.fixedEntries[0].selected, true)
  assert.deepEqual(plain(component.data.suggestions.map(row => row.value)), ['Fort Lee 公寓', 'Park'])
  component.onSelect(tap('Fort Lee 核心区'))
  component.onSelect(tap('Park'))
  component.onSelect(tap('injected missing option'))
  assert.deepEqual(component.events.map(event => event.detail.value), ['Fort Lee 核心区', 'Park'])
})

test('picker shows short airport labels while confirming cloud values and keeps terminal suggestions', () => {
  const { component } = componentHarness({
    value: '纽瓦克',
    fixedOptions: [{ label: '纽瓦克', value: 'EWR 机场' }, { label: '拉瓜迪亚', value: 'LGA Airport' }],
    options: ['Newark Airport', '纽瓦克', 'La Guardia Airport', 'EWR Terminal C', '法拉盛某商场']
  })
  assert.equal(component.data.fixedEntries[0].selected, true)
  assert.deepEqual(plain(component.data.suggestions.map(item => item.value)), ['EWR Terminal C', '法拉盛某商场'])
  component.onSelect(tap('EWR 机场'))
  component.confirmValue('拉瓜迪亚')
  component.confirmValue('EWR Terminal C')
  assert.deepEqual(component.events.map(event => event.detail.value), ['EWR 机场', 'LGA Airport', 'EWR Terminal C'])
})

test('custom place editing stays in the panel, validates text and retains configured price keys', () => {
  const { component } = componentHarness({ fixedOptions: [{ label: 'Fort Lee', value: 'Fort Lee 核心区' }, '哥大'] })
  component.onOpenCustom()
  assert.equal(component.data.customVisible, true)
  component.onCustomInput(input('   '))
  component.onConfirmCustom()
  assert.equal(component.events.length, 0)
  assert.match(component.data.customError, /填写地点/)
  component.onCustomInput(input('  fortlee '))
  component.onConfirmCustom()
  assert.equal(component.events[0].detail.value, 'Fort Lee 核心区')
  component.onCustomInput(input('  Fort Lee\n 公寓 '))
  component.onConfirmCustom()
  assert.equal(component.events[1].detail.value, 'Fort Lee 公寓')
})

test('search permits using a missing location and reopening clears abandoned drafts', () => {
  const { component, definition } = componentHarness({ options: ['Park Ave', 'Museum'] })
  component.onSearch(input('park'))
  assert.deepEqual(plain(component.data.suggestions.map(row => row.value)), ['Park Ave'])
  assert.equal(component.data.canUseSearch, false)
  component.onSearch(input('New plaza'))
  assert.equal(component.data.canUseSearch, true)
  component.onUseSearch()
  assert.equal(component.events[0].detail.value, 'New plaza')
  component.onOpenCustom()
  assert.equal(component.data.customValue, 'New plaza')
  component.onCancel()
  assert.equal(component.events[1].name, 'cancel')
  definition.observers.visible.call(component, true)
  assert.equal(component.data.customVisible, false)
  assert.equal(component.data.keyword, '')
})

test('hidden picker cannot navigate by confirming stale input or request retries', () => {
  const { component } = componentHarness()
  component.properties.visible = false
  component.onSelect(tap('Fort Lee'))
  component.confirmValue('custom')
  component.onRetry()
  component.onCancel()
  assert.equal(component.events.length, 0)
  component.properties.visible = true
  component.properties.loading = true
  component.onRetry()
  assert.equal(component.events.length, 0)
  component.properties.loading = false
  component.onRetry()
  assert.equal(component.events[0].name, 'retry')
})
