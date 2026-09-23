const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const plain = value => JSON.parse(JSON.stringify(value))

function backend(user) {
  const state = { writes: [], reads: [] }
  const collection = {
    where(condition) { state.reads.push(plain(condition)); return this },
    limit() { return this },
    async get() { return { data: user ? [user] : [] } },
    async add({ data }) { state.writes.push({ kind: 'create', data: plain(data) }); return { _id: 'new-profile' } },
    doc(id) { return { async update({ data }) { state.writes.push({ kind: 'update', id, data: plain(data) }) } } }
  }
  const cloud = {
    init() {}, getWXContext: () => ({ OPENID: 'driver' }),
    database: () => ({ collection(name) { assert.equal(name, 'userInfo'); return collection } })
  }
  const context = { exports: {}, require(name) { assert.equal(name, 'wx-server-sdk'); return cloud }, console: { error() {} } }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'cloudfunctions/updateUser/index.js'), 'utf8'), context)
  return { state, main: context.exports.main }
}

function profile(user) {
  let definition
  const state = { writes: [], toasts: [], navigation: [], errors: [] }
  const context = {
    Page: value => { definition = value },
    wx: {
      showToast: value => state.toasts.push(value), navigateBack: () => state.navigation.push('back'),
      cloud: { callFunction: async () => ({ result: { data: user ? [user] : [] } }) }
    },
    console: { error() {} }, setTimeout: callback => { callback(); return 1 },
    require(name) {
      if (name.endsWith('/userProfileUpdate')) return { callUpdateUser: async data => { state.writes.push(plain(data)); return { result: { ok: true } } } }
      if (name.endsWith('/error')) return { showDataError: (...args) => state.errors.push(args) }
      if (name.endsWith('/Region')) return {
        DEFAULT_REGION_TREE: {}, normalizeRegionTree: value => value, getCityOptions: () => [],
        getCitySnapshot: () => null, findState: () => null
      }
      throw new Error(`Unexpected dependency ${name}`)
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/profile/editInfo/editInfo.js'), 'utf8'), context)
  const page = { ...definition, data: plain(definition.data) }
  page.setData = function(patch, callback) { Object.assign(this.data, patch); if (callback) callback.call(this) }
  page._getCurrentRegionMeta = () => ({ stateKey: '', groupLabel: '', areaLabel: '', buildingName: '' })
  return { page, state }
}

test('new profiles save driver defaults and address without the legacy undefined-variable error', async () => {
  const { main, state } = backend()
  const result = await main({ regionPhone: 'US', Apartment: 'Test building', defaultShowZelle: true })
  assert.equal(result.ok, true)
  assert.equal(state.writes.length, 1)
  const saved = state.writes[0].data
  assert.equal(saved.regionPhone, 'US')
  assert.equal(saved.Apartment, 'Test building')
  assert.equal(saved.defaultShowZelle, true)
  const defaults = backend()
  await defaults.main({ name: 'Driver' })
  assert.equal(defaults.state.writes[0].data.defaultShowZelle, false)
})

test('profile updates preserve omitted Zelle preference and target only the current user', async () => {
  const existing = { _id: 'profile', defaultShowZelle: true, customPrice: { fortLeeCore: '9', fortLeeNonCore: '16' } }
  const { main, state } = backend(existing)
  await main({ name: 'Renamed' })
  assert.equal('defaultShowZelle' in state.writes[0].data, false)
  assert.equal('customPrice' in state.writes[0].data, false)
  await main({ defaultShowZelle: false })
  const update = state.writes[1].data
  assert.equal(update.defaultShowZelle, false)
  assert.equal('customPrice' in update, false)
  assert.ok(state.reads.every(query => query._openid === 'driver'))
  assert.ok(state.writes.every(write => write.id === 'profile'))
})

test('Zelle preference rejects malformed values without database writes', async () => {
  for (const value of ['true', 1, 0, null, [], {}]) {
    const { main, state } = backend({ _id: 'profile' })
    assert.equal((await main({ defaultShowZelle: value })).ok, false)
    assert.equal(state.writes.length, 0)
  }
})

test('profile defaults Zelle sharing to opt-out without exposing old fare preferences', async () => {
  const { page } = profile({ wechatID: 'test', customPrice: { fortLeeCore: '10$/人', fortLeeNonCore: 0 } })
  await page.loadUserInfo()
  assert.equal(page.data.customPriceCore, undefined)
  assert.equal(page.data.customPriceNonCore, undefined)
  assert.equal(page.data.defaultShowZelle, false)
  assert.equal(page.data.unsaved, false)
})

test('saving from newTrip persists driver preferences and returns to the preserved draft', async () => {
  const { page, state } = profile({ wechatID: 'test', defaultShowZelle: true })
  await page.loadUserInfo()
  page.data.from = 'newTrip'
  page.onDefaultShowZelleChange({ detail: { value: false } })
  await page.onSaveProfile()
  assert.equal(state.writes.length, 1)
  assert.equal(state.writes[0].defaultShowZelle, false)
  assert.equal('customPrice' in state.writes[0], false)
  assert.deepEqual(state.navigation, ['back'])
})

test('saving profile edits never replaces prices stored by earlier clients', async () => {
  const { page, state } = profile({ wechatID: 'test', customPrice: { fortLeeCore: '10$/人', fortLeeNonCore: '13$/人' } })
  await page.loadUserInfo()
  page.data.carBrand = 'Test brand'
  page.markDirty()
  assert.equal(await page.saveToCloud({ silent: true }), true)
  assert.equal(state.writes.length, 1)
  assert.equal('customPrice' in state.writes[0], false)
  const { main, state: backendState } = backend({ _id: 'profile' })
  await main(state.writes[0])
  assert.equal('customPrice' in backendState.writes[0].data, false)
})
