const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { getDriverRouteDefaultPrice, getDriverRoutePriceKey } = require('../utils/driverRideDefaults')

test('Fort Lee core line defaults to $8 in both directions with normalized labels', () => {
  for (const fortLee of ['Fort Lee', 'Fortlee', ' Fort Lee 核心区 ', 'FORT LEE核心区']) {
    for (const [from, to] of [[fortLee, '哥大'], ['哥大', fortLee]]) {
      assert.equal(getDriverRouteDefaultPrice(from, to), '8')
      assert.equal(getDriverRoutePriceKey(from, to), 'fortLeeCore')
    }
  }
})

test('core-line system default ignores old personal prices while whole-area pricing stays unchanged', () => {
  assert.equal(getDriverRouteDefaultPrice('Fort Lee 全区域', '哥大'), '13')
  assert.equal(getDriverRouteDefaultPrice('哥大', 'FortLee全区域'), '13')
  const customPrice = { fortLeeCore: '9.50 USD', fortLeeNonCore: '15$/人' }
  assert.equal(getDriverRouteDefaultPrice('哥大', 'Fort Lee', customPrice), '8')
  assert.equal(getDriverRouteDefaultPrice('Fort Lee 全区域', '哥大', customPrice), '15')
  for (const oldPrice of [0, '', '10', '10 USD', '10$/人', '25.5']) {
    assert.equal(getDriverRouteDefaultPrice('Fort Lee', '哥大', { fortLeeCore: oldPrice }), '8')
    assert.equal(getDriverRouteDefaultPrice('哥大', 'Fort Lee 核心区', { fortLeeCore: oldPrice }), '8')
  }
  assert.equal(getDriverRouteDefaultPrice('Fort Lee', '哥大', null), '8')
})

test('airports, custom addresses and incomplete pairs do not inherit the core-line price', () => {
  const pairs = [
    ['Fort Lee', 'JFK'], ['纽瓦克', '哥大'], ['拉瓜迪亚', '哥大'],
    ['Fort Lee 送家门口', '哥大'], ['Fort Lee', '哥大医院'],
    ['Fort Lee', 'Fort Lee'], ['', '哥大'], ['哥大', '']
  ]
  for (const [from, to] of pairs) {
    assert.equal(getDriverRouteDefaultPrice(from, to, { fortLeeCore: '20' }), '')
    assert.equal(getDriverRoutePriceKey(from, to), '')
  }
})

function templateHarness() {
  let definition
  const saved = []
  const profileUpdates = []
  const sourcePath = path.join(__dirname, '../pages/home/driverCarpoolTemplate/driverCarpoolTemplate.js')
  const state = { template: {}, modalResult: { confirm: false } }
  const wx = {
    getStorageSync: () => 'driver-1', showToast() {}, navigateBack() {},
    showModal: async () => state.modalResult,
    cloud: { database: () => ({
      serverDate: () => 'server-date',
      collection: () => ({
        doc: () => ({
          get: async () => ({ data: state.template }),
          update: async ({ data }) => { saved.push(data); return { stats: { updated: 1 } } }
        }),
        add: async ({ data }) => { saved.push(data); return { _id: 'saved-template' } }
      })
    }) }
  }
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), {
    Page: page => { definition = page }, wx, console,
    setTimeout() {},
    require(name) {
      if (name.endsWith('/error')) return { showDataError() {} }
      if (name.endsWith('/userProfileUpdate')) return { callUpdateUser: async payload => { profileUpdates.push(payload) } }
      return require(path.resolve(path.dirname(sourcePath), name))
    }
  }, { filename: sourcePath })
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) }
  page.setData = function (patch, callback) { Object.assign(this.data, patch); callback?.call(this) }
  return { page, state, saved, profileUpdates }
}

test('changing a template to an unpriced route clears its previous price', async () => {
  const { page, state } = templateHarness()
  assert.equal(page.data.referencePrice, '')
  Object.assign(page.data, { departureAddress: 'Fort Lee', destinationAddress: '哥大' })
  page.updateReferencePrice()
  assert.equal(page.data.referencePrice, '8')
  page.data.destinationAddress = 'JFK'
  page.updateReferencePrice()
  assert.equal(page.data.referencePrice, '')
  page.data.referencePrice = '25'
  page.data.departureAddresses = ['其他']
  state.modalResult = { confirm: true, content: ' Fort Lee 门口 ' }
  await page.onAddressSelect({ currentTarget: { dataset: { type: 'departure' } }, detail: { value: 0 } })
  assert.equal(page.data.departureAddress, 'Fort Lee 门口')
  assert.equal(page.data.referencePrice, '')
})

test('saved template price remains explicit and saving it does not overwrite personal defaults', async () => {
  const { page, state, saved, profileUpdates } = templateHarness()
  state.template = {
    _openid: 'driver-1', departureAddress: 'Fort Lee', destinationAddress: '哥大',
    referencePrice: '17$/人', passengerCount: 3, weekdayIndex: 0, weekdayText: '周一'
  }
  await page.loadTemplateDetail('tpl-1')
  assert.equal(page.data.referencePrice, '17$/人')
  page.data.userInfo = { customPrice: { fortLeeCore: '9' } }
  await page.submitTemplate('Monday route')
  assert.equal(saved[0].referencePrice, '17$/人')
  assert.equal(profileUpdates.length, 1)
  assert.equal(Object.hasOwn(profileUpdates[0], 'customPrice'), false)
  assert.equal(page.data.userInfo.customPrice.fortLeeCore, '9')
})
