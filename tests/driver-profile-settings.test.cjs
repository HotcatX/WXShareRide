const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const plain = value => JSON.parse(JSON.stringify(value))

function profile(user) {
  let definition
  const state = { writes: [], toasts: [], navigation: [], errors: [] }
  const context = {
    Page: value => { definition = value },
    wx: {
      getStorageSync: () => undefined,
      showToast: value => state.toasts.push(value), navigateBack: () => state.navigation.push('back'),
      cloud: { callFunction: async () => ({ result: { data: user ? [user] : [] } }) }
    },
    console: { error() {} }, setTimeout: callback => { callback(); return 1 },
    require(name) {
      if (name.endsWith('/compat/profile')) return require('./helpers/profile-api.cjs')(context.wx)
      if (name.endsWith('/profileDisplay')) return { resolveProfileAvatar: async (user, fallback) => user.avatarUrl || fallback }
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
})
