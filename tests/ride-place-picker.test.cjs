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
function utilityHarness() { return { api: require('../utils/ridePlaceOptions') } }
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
    triggerEvent(name, detail) { if (name === 'presentation' || name === 'customcancel') return; this.events.push({ name, detail: detail && plain(detail) }) }
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
  ])), ['EWR机场', '纽瓦克', 'JFK', 'LGA Airport', '法拉盛', 'EWR Terminal C', 'Newark Broad Street', 'Flushing Library'])
  assert.deepEqual(['Fort Lee', '哥大', 'EWR机场', 'JFK Airport', 'LGA', 'Flushing'].map(api.shortRidePlaceLabel), ['Fort Lee', '哥大', 'EWR 纽瓦克机场', 'JFK', 'LGA 拉瓜迪亚', '法拉盛'])
  assert.equal(api.shortRidePlaceLabel('EWR Terminal C'), 'EWR Terminal C')
  for (const [place, matching, unrelated] of [
    ['EWR 机场', 'EWR Terminal C', 'Newark Broad Street'],
    ['JFK', '肯尼迪机场', 'AJFK'],
    ['拉瓜迪亚', 'La Guardia Airport', 'BLGA'],
    ['法拉盛', 'Flushing Library', 'Fort Lee'],
    ['Inwood', 'Inwood Park', 'Inwoodman'],
    ['中城', 'Midtown Manhattan', 'Midtown Jersey City'],
    ['下城', 'Lower Manhattan', 'Downtown Brooklyn'],
    ['Queens', '皇后区', 'Queensboro']
  ]) {
    const matches = api.makeRidePlaceMatcher(place)
    assert.equal(matches(matching), true, place)
    assert.equal(matches(unrelated), false, place)
  }
  assert.equal(api.makeRidePlaceMatcher('EWR Terminal C')('EWR Terminal B'), false)
  assert.equal(api.makeRidePlaceMatcher('EWR Terminal C')('EWR Terminal C pickup'), true)
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
    value: 'EWR',
    fixedOptions: [{ label: '纽瓦克', value: 'EWR 机场' }, { label: '拉瓜迪亚', value: 'LGA Airport' }],
    options: ['Newark Airport', '纽瓦克', 'La Guardia Airport', 'EWR Terminal C', '法拉盛某商场']
  })
  assert.equal(component.data.fixedEntries[0].selected, true)
  assert.deepEqual(plain(component.data.suggestions.map(item => item.value)), ['纽瓦克', 'EWR Terminal C', '法拉盛某商场'])
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
