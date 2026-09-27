const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const publish = require('../utils/compat/ridePublish')
const templates = require('../utils/compat/rideTemplates')
const plain = value => JSON.parse(JSON.stringify(value))
const now = Date.parse('2026-10-30T16:00:00Z')
const id = '00000000-0000-4000-8000-000000000001'
const receipt = { rideId: id, version: 1, status: 'open', changed: true }
const row = { id, ...templates.toTemplateInput({ templateName: '每周日', weekdayIndex: 6, departureTime: '01:30',
  departureAddress: 'Fort Lee', destinationAddress: '哥大', passengerCount: 8, referencePrice: '包车110USD', comment: '' }) }
row.definition.stops.splice(1, 0, { kind: 'departure', address: 'Inwood', offsetMinutes: 60 })
row.definition.stops.push({ kind: 'destination', address: 'Midtown' })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture() {
  let definition
  const state = { openid: 'owner', requests: [], modals: [], toasts: [], timers: [], navigations: [], pending: null, stale: 0 }
  const wx = { getStorageSync: key => key === 'openid' ? state.openid : false, setStorageSync() {},
    showToast: p => state.toasts.push(p), showModal: p => state.modals.push(p), navigateTo: p => state.navigations.push(p), reLaunch: p => state.navigations.push(p),
    cloud: { database() { throw Error('unexpected CloudBase DB') }, callFunction() { throw Error('unexpected CloudBase function') } } }
  const backend = { isBackendEnabled: () => true,
    async mutate(...args) { state.requests.push(args); const result = state.response ? await state.response : receipt; assert.equal(args[4].validate(result), true); return result },
    async retryPending(_scope, options) { const result = await state.pending; if (result) assert.equal(options.validate(result), true); state.pending = null; return result } }
  const client = publish.createRidePublishClient({ backend, wx, now: () => now,
    loadLocationConfig: async () => ({ requestPrices: [{ fromAddress: 'Fort Lee', toAddress: '哥大', label: '包车110USD' }] }) })
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])) }; static now() { return now } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/home/newTrip/newTrip.js'), 'utf8'), {
    Page: v => { definition = v }, wx, Date: ClockDate, console: { log() {}, error() {} }, clearTimeout() {}, setTimeout: fn => state.timers.push(fn),
    require(name) {
      if (name.endsWith('/compat/profile')) return { isBackendEnabled: () => true, identity: () => state.openid, getUserInfo: async () => ({ success: true, data: { wechatID: 'owner' } }) }
      if (name.endsWith('/compat/ridePublish')) return { ...publish, ...client, toRideInput: draft => publish.toRideInput(draft, now) }
      if (name.endsWith('/compat/rideTemplates')) return { loadRideTemplates: async () => [templates.toLegacyTemplate(row, state.openid)] }
      if (name.endsWith('/tripManage')) return { ...require('../utils/tripManage'), markRideListStale: () => state.stale++ }
      if (name.endsWith('/rideTime')) return require('../utils/rideTime')
      if (name.endsWith('/driverRideDefaults')) return require('../utils/driverRideDefaults')
      if (name.endsWith('/cityTree')) return { DEFAULT_CITY_KEY: 'ny_nj', getStoredCitySnapshot: () => ({ key: 'ny_nj' }),
        isRideServiceCityKey: () => true, getRideServiceCitySnapshot: () => ({ key: 'ny_nj', label: '纽约/新泽西' }) }
      return {}
    },
  })
  const page = { ...definition, data: plain(definition.data) }
  page.setData = function(patch, callback) { Object.assign(this.data, patch); if (callback) callback.call(this) }
  Object.assign(page.data, { mode: 'driver', serverMode: true, departureDate: '2026-11-01', departureTime: '01:30',
    departureAddress: 'Fort Lee', destinationAddress: '哥大', passengerCount: 3, passengerCountInput: '3', referencePrice: '包车110USD',
    userInfo: { wechatID: 'owner' }, carNumber: 'PRIVATE', carBrand: 'Toyota', carModel: 'Camry' })
  return { page, state, api: client }
}

test('server weekly shortcut retains eight seats, quote label and every stop in confirmation and actual submitted payload', async () => {
  const { page, state } = fixture()
  await page.loadTemplates(); page.onTemplateTap({ currentTarget: { dataset: { id } } })
  assert.equal(page.data.passengerCountInput, '8'); assert.equal(page.data.referencePrice, '包车110USD')
  assert.equal(page.data.departureDate, '2026-11-01')
  assert.match(page.data.templateRouteSummary, /Inwood 2026-11-01 02:30/)
  await page.confirmTrip()
  assert.match(state.modals[0].content, /Inwood/); assert.match(state.modals[0].content, /Midtown/)
  state.modals[0].success({ confirm: true }); await new Promise(setImmediate)
  assert.equal(state.requests.length, 1)
  assert.equal(state.requests[0][3].stops.length, 4)
  assert.equal(state.requests[0][3].listedPriceCents, null)
  assert.equal(state.requests[0][3].listedPriceLabel, '包车110USD')
  assert.equal(state.requests[0][3].stops[1].departureAt, '2026-11-01T07:30:00.000Z')
  assert.equal(page.data.publishedRide.id, id)
  page.onPrepareReturnTrip(); assert.equal(page.data.publishedRide.id, id, 'multi-stop return requires explicit times; do not silently drop stops')
})

test('request quote remains a full label, publishes frozen modal values, and suppresses duplicate taps before redirect', async () => {
  const { page, state } = fixture()
  page.setData({ mode: 'passenger', passengerCount: 2 }); await page.updateReferencePriceFromRequestPrice()
  assert.equal(page.data.referencePrice, '包车110USD'); assert.equal(page.data.referencePriceHasNumber, false)
  await page.confirmTrip()
  page.setData({ passengerCount: 4, destinationAddress: 'unconfirmed-edit' })
  const blocked = deferred(); state.response = blocked.promise
  const sending = state.modals[0].success({ confirm: true })
  await page.passenger_submitRequest(); await new Promise(setImmediate); assert.equal(state.requests.length, 1)
  blocked.resolve(receipt); await sending
  assert.equal(state.requests[0][3].partySize, 2)
  assert.equal(state.requests[0][3].stops[1].address, '哥大')
  assert.equal(page.data.publishedRide.passengerCount, 2)
  await page.passenger_submitRequest(); assert.equal(state.requests.length, 1)
})

test('existing publish button recovers an old intent even with an empty form and displays no guessed replacement details', async () => {
  const { page, state } = fixture(); state.pending = receipt
  page.setData({ mode: 'passenger', departureDate: '', departureTime: '', referencePrice: '' })
  await page.confirmTrip()
  assert.equal(state.modals.length, 0); assert.equal(state.requests.length, 0)
  assert.deepEqual(plain(page.data.publishedRide), { id, recovered: true })
  assert.equal(page.data.submitting, false); assert.equal(state.stale, 1)
  page.onPrepareReturnTrip(); assert.equal(page.data.publishedRide.recovered, true)
})

test('late publish/recovery responses after account changes cannot expose prior result or navigate the new account', async () => {
  for (const recovery of [true, false]) {
    const { page, state } = fixture(), blocked = deferred()
    if (recovery) state.pending = blocked.promise
    else state.response = blocked.promise
    const sending = recovery ? page.confirmTrip() : page.driver_submitTrip()
    state.openid = 'another-owner'; blocked.resolve(receipt); await sending
    assert.equal(page.data.publishedRide, null); assert.equal(state.navigations.length, 0)
  }
})

test('server quote transport errors are visible and never read Request_Price from CloudBase', async () => {
  let cloud = 0
  const api = publish.createRidePublishClient({ backend: { isBackendEnabled: () => true }, wx: { cloud: { database() { cloud++ } } },
    loadLocationConfig: async () => { throw Error('offline') } })
  await assert.rejects(api.loadRequestPrice('Fort Lee', '哥大'), /offline/); assert.equal(cloud, 0)
})


test('a changed account can edit again after the previous publish recovery finishes', async () => {
  const { page, state } = fixture(), blocked = deferred()
  page._pageIdentity = 'owner'; state.pending = blocked.promise
  const sending = page.confirmTrip()
  assert.equal(page.data.submitting, true)
  state.openid = 'new-owner'
  page.loadUserInfo = async () => {}; page.loadTemplatesIfNeeded = async () => {}
  page.onShow(); blocked.resolve(receipt); await sending
  assert.equal(page.data.publishedRide, null); assert.equal(page.data.submitting, false)
})
