const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function harness(active = 'home') {
  const state = { remembered: [], navigation: [], events: [], storage: {} }
  let definition
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/app-tabbar/app-tabbar.js'), 'utf8'), {
    Component(value) { definition = value },
    require(name) {
      assert.equal(name, '../../utils/tabMemory')
      return { rememberTab: tab => state.remembered.push(tab) }
    },
    wx: {
      getStorageSync: key => state.storage[key],
      setStorageSync: (key, value) => { state.storage[key] = value },
      switchTab: options => state.navigation.push({ method: 'switchTab', ...options }),
      reLaunch: options => state.navigation.push({ method: 'reLaunch', ...options })
    }
  })
  const component = {
    ...definition.methods,
    data: { ...definition.data, active, displayActive: active },
    setData(patch) { Object.assign(this.data, patch) },
    triggerEvent(name, detail) { state.events.push({ name, detail }) }
  }
  return { component, state }
}

const tabEvent = (key, url = `/pages/${key}/${key}`) => ({ currentTarget: { dataset: { key, url } } })

test('home and profile selections are remembered only after successful navigation', () => {
  for (const [active, target] of [['home', 'profile'], ['profile', 'home']]) {
    const { component, state } = harness(active)
    component.onTapTab(tabEvent(target))
    assert.equal(state.navigation[0].method, 'switchTab')
    assert.deepEqual(state.remembered, [])
    state.navigation[0].success()
    assert.deepEqual(state.remembered, [target])
  }
})

test('failed bottom-tab navigation preserves the prior remembered selection', () => {
  const { component, state } = harness('home')
  component.onTapTab(tabEvent('profile'))
  state.navigation[0].fail()
  assert.deepEqual(state.remembered, [])
  assert.equal(component.data.displayActive, 'home')
})

test('tapping the currently active home or profile refreshes its memory without navigation', () => {
  for (const active of ['home', 'profile']) {
    const { component, state } = harness(active)
    component.onTapTab(tabEvent(active))
    assert.deepEqual(state.remembered, [active])
    assert.equal(state.navigation.length, 0)
  }
})

test('missing, unknown and mismatched tab routes never become remembered destinations', () => {
  const { component, state } = harness('home')
  component.onTapTab(tabEvent('profile', ''))
  component.onTapTab(tabEvent('settings', '/pages/settings/settings'))
  component.onTapTab(tabEvent('profile', '/pages/home/home'))
  component.onTapTab(tabEvent('home', '/pages/settings/settings'))
  for (const navigation of state.navigation) navigation.success()
  assert.deepEqual(state.remembered, [])
})

test('switching between goods and sublets on the market page immediately remembers the exact column', () => {
  const { component, state } = harness('market')
  component._activateMarketType('sublet')
  assert.deepEqual(state.remembered, ['sublet'])
  assert.equal(state.storage.market_active_listing_type_v1, 'sublet')
  component.onToggleMarketType()
  assert.deepEqual(state.remembered, ['sublet', 'goods'])
  assert.equal(state.storage.market_active_listing_type_v1, 'goods')
  assert.equal(state.navigation.length, 0)
  assert.deepEqual(state.events.map(event => [event.name, event.detail.type]), [
    ['marketchange', 'sublet'], ['marketchange', 'goods']
  ])
})

test('cross-page market navigation remembers goods or sublets after success and never after failure', () => {
  for (const type of ['goods', 'sublet']) {
    const { component, state } = harness('profile')
    component._activateMarketType(type)
    assert.equal(state.navigation[0].url, '/pages/market/market')
    assert.equal(state.storage.market_active_listing_type_v1, type)
    assert.deepEqual(state.remembered, [])
    state.navigation[0].fail()
    assert.deepEqual(state.remembered, [])
    assert.equal(component.data.displayActive, 'profile')
    component._activateMarketType(type)
    state.navigation[1].success()
    assert.deepEqual(state.remembered, [type])
  }
})
