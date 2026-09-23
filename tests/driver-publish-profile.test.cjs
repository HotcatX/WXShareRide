const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const root = path.join(__dirname, '..')
const plain = value => JSON.parse(JSON.stringify(value))
const profile = extra => ({ wechatID: 'test-driver', carNumber: 'TEST123', carBrand: 'Toyota', carModel: 'Camry', ...extra })

function fixture() {
  let definition
  const state = { user: profile(), calls: [], modals: [], navigation: [], toast: [], response: null }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/home/newTrip/newTrip.js'), 'utf8'), {
    Page: value => { definition = value }, console: { log() {}, error() {} },
    setTimeout() {}, clearTimeout() {},
    require(name) {
      if (name.endsWith('/placePickerTelemetry')) return { closePlacePicker() {} }
      if (name.endsWith('/driverRideDefaults')) return require('../utils/driverRideDefaults')
      if (name.endsWith('/tripManage')) return { ...require('../utils/tripManage'), markRideListStale() {} }
      if (name.endsWith('/rideTime')) return require('../utils/rideTime')
      if (name.endsWith('/error')) return { showDataError() {} }
      if (name.endsWith('/cityTree')) return {
        DEFAULT_CITY_KEY: 'ny_nj', getStoredCitySnapshot: () => ({ key: 'ny_nj' }),
        isRideServiceCityKey: () => true, getRideServiceCitySnapshot: () => ({ key: 'ny_nj', label: '纽约/新泽西' })
      }
      return {}
    },
    wx: {
      getStorageSync: () => 'driver', setStorageSync() {},
      showToast: value => state.toast.push(value),
      showModal: value => state.modals.push(value),
      navigateTo: value => state.navigation.push(value),
      cloud: { callFunction(args) {
        state.calls.push(plain(args))
        if (args.name === 'getUserInfo') return state.response || Promise.resolve({ result: { data: state.user ? [state.user] : [] } })
        if (args.name === 'createTrip') return Promise.resolve({ result: { success: true, id: 'test-only' } })
        throw new Error(`Unexpected call ${args.name}`)
      } }
    }
  })
  const page = { ...definition, data: plain(definition.data) }
  page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) callback.call(this) }
  page.data.departureAddress = 'Fort Lee'
  page.data.destinationAddress = '哥大'
  return { page, state }
}

test('profile reads are coalesced; empty account preferences keep disclosure disabled', async () => {
  const { page, state } = fixture()
  await Promise.all([page.loadUserInfo(), page.loadUserInfo()])
  assert.equal(state.calls.length, 1)
  assert.equal(page.data.driverProfileReady, true)
  assert.equal(page.data.showZelle, false)
  assert.equal(page.data.referencePrice, '8')
  assert.equal(page.data.loadingUserInfo, false)
})

test('returning from profile refreshes vehicle and preference, retaining the trip draft and manual price', async () => {
  const { page, state } = fixture()
  await page.loadUserInfo()
  page.setData({ departureDate: '2030-01-20', departureTime: '18:45', comment: 'Keep draft' })
  page.onReferencePriceInput({ detail: { value: '9' } })
  page.onEditDriverProfile()
  assert.equal(state.navigation[0].url, '/pages/profile/editInfo/editInfo?from=newTrip')
  state.user = profile({ carNumber: 'NEW123', defaultShowZelle: true, customPrice: { fortLeeCore: '12$/人' } })
  await page.loadUserInfo()
  assert.equal(page.data.carNumber, 'NEW123')
  assert.equal(page.data.showZelle, true)
  assert.equal(page.data.referencePrice, '9')
  assert.equal(page.data.departureDate, '2030-01-20')
  assert.equal(page.data.departureTime, '18:45')
  assert.equal(page.data.comment, 'Keep draft')
})

test('profile edits cannot override the system core fare; cleared vehicle data cannot fall back to stale details', async () => {
  const { page, state } = fixture()
  await page.loadUserInfo()
  state.user = profile({ carNumber: '', defaultShowZelle: true, customPrice: { fortLeeCore: '9$/人' } })
  await page.loadUserInfo()
  assert.equal(page.data.referencePrice, '8')
  assert.equal(page.data.driverProfileReady, false)
  assert.equal(page.data.carNumber, '')
  page.driver_confirmTrip()
  assert.equal(state.modals[0].title, '完善司机资料')
  state.modals[0].success({ confirm: true })
  assert.equal(state.navigation[0].url, '/pages/profile/editInfo/editInfo?from=newTrip')
  assert.ok(!state.calls.some(call => call.name === 'createTrip'))
})

test('switching from a known route to an airport clears a previous automatic or edited fare', async () => {
  const { page } = fixture()
  await page.loadUserInfo()
  page.onReferencePriceInput({ detail: { value: '15' } })
  page.setData({ destinationAddress: 'JFK' })
  await page.afterAddressChanged()
  assert.equal(page.data.referencePrice, '')
  assert.equal(page.data.referencePriceHasNumber, false)
  page.setData({ departureAddress: '哥大', destinationAddress: 'Fort Lee 核心区' })
  await page.afterAddressChanged()
  assert.equal(page.data.referencePrice, '8')
})

test('saved templates retain price and comment but cannot override the profile Zelle choice', async () => {
  for (const enabled of [true, false]) {
    const { page, state } = fixture()
    state.user = profile({ defaultShowZelle: enabled })
    await page.loadUserInfo()
    page.setData({ templatesExpanded: true, templates: [{ _id: 'template', departureAddress: 'Fort Lee', destinationAddress: '哥大', referencePrice: '11$/人', zelle: enabled ? 'no' : 'yes', comment: 'Template note', weekdayIndex: 1, passengerCount: 3 }] })
    page.onTemplateTap({ currentTarget: { dataset: { id: 'template' } } })
    assert.equal(page.data.referencePrice, '11')
    assert.equal(page.data.showZelle, enabled)
    assert.equal(page.data.commentExpanded, true)
    assert.equal(page.data.templatesExpanded, false)
    await page.loadUserInfo()
    assert.equal(page.data.referencePrice, '11')
  }
})

test('publishing snapshots the explicit Zelle choice and fare without rewriting profile defaults or vehicles', async () => {
  for (const enabled of [true, false]) {
    const { page, state } = fixture()
    state.user = profile({ defaultShowZelle: enabled })
    await page.loadUserInfo()
    page.onReferencePriceInput({ detail: { value: '8.50' } })
    await page.driver_submitTrip()
    const payload = state.calls.find(call => call.name === 'createTrip').data
    assert.equal(payload.zelle, enabled ? 'yes' : 'no')
    assert.equal(payload.referencePrice, '8.50$/人')
    assert.equal('customPrice' in payload, false)
    assert.equal('carNumber' in payload, false)
    assert.equal('carBrand' in payload, false)
    assert.equal('carModel' in payload, false)
  }
})

test('leaving while a profile is loading cannot update an unloaded page', async () => {
  const { page, state } = fixture()
  let resolve
  state.response = new Promise(done => { resolve = done })
  const pending = page.loadUserInfo()
  page.onUnload()
  resolve({ result: { data: [profile({ defaultShowZelle: true })] } })
  await pending
  assert.equal(page.data.userInfo, null)
  assert.equal(page.data.showZelle, false)
})

test('a profile request from before editing cannot overwrite saved settings or cancel the fresh read', async () => {
  const { page, state } = fixture()
  let resolveOld, resolveNew
  state.response = new Promise(done => { resolveOld = done })
  const oldRead = page.loadUserInfo()
  page.onEditDriverProfile()
  state.response = new Promise(done => { resolveNew = done })
  const newRead = page.loadUserInfo()
  resolveOld({ result: { data: [profile({ carNumber: 'OLD', defaultShowZelle: false })] } })
  await oldRead
  assert.equal(page.data.userInfo, null)
  assert.equal(page.data.loadingUserInfo, true)
  assert.equal(page.loadUserInfo(), newRead)
  resolveNew({ result: { data: [profile({ carNumber: 'NEW', defaultShowZelle: true })] } })
  await newRead
  assert.equal(state.calls.length, 2)
  assert.equal(page.data.carNumber, 'NEW')
  assert.equal(page.data.showZelle, true)
  assert.equal(page.data.loadingUserInfo, false)
})
