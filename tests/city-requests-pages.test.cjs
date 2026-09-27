const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRideClient } = require('../utils/compat/rides')
const city = require('../utils/cityTree')
const tick = () => new Promise(resolve => setImmediate(resolve))
function harness(kind, server = true) {
  const state = { guest: true, owner: '', calls: [], toasts: [], pending: null, writes: 0 }
  const wx = { getStorageSync: key => key === 'isGuest' ? state.guest : key === 'openid' ? state.owner : undefined,
    showToast: info => state.toasts.push(info.title), cloud: { callFunction(input) {
      if (server) throw Error('No CloudBase request in server mode')
      state.calls.push(input); return Promise.resolve({ result: { success: true } })
    } } }
  const backend = { isBackendEnabled: () => server, submitLocationRequest(input) {
    state.calls.push(input)
    return state.pending || Promise.resolve({ requestId: '00000000-0000-4000-8000-000000000001', cityKey: input.cityKey, status: 'recorded' })
  } }
  const rides = { isBackendEnabled: backend.isBackendEnabled, ...createRideClient({ wx, backend }) }
  let definition
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, kind === 'home' ? '../pages/home/home.js' : '../pages/home/carpoolList/carpoolList.js'), 'utf8'), {
    Page: value => { definition = value }, wx, console, setTimeout, clearTimeout,
    require(name) {
      if (name.endsWith('/compat/rides')) return rides
      if (name.endsWith('/cityTree')) return city
      if (name.endsWith('/rideTime')) return require('../utils/rideTime')
      if (name.endsWith('/rideCalendarPicker')) return { methods: {} }
      if (name.endsWith('/rideTelemetry')) return { stopList() {}, observeList() {} }
      if (name.endsWith('/placePickerTelemetry')) return { closePlacePicker() {} }
      return {}
    }
  })
  const page = { ...definition, data: structuredClone(definition.data) }
  page.setData = function(patch) { state.writes++; Object.assign(this.data, patch) }
  for (const method of ['syncLoginState','scheduleHomeShowRefresh','refreshCommunityConfig','clearHomeShowRefresh','clearCommunityNoticeExpiry']) page[method] = () => {}
  page.setData({ activeCityKey: 'boston', activeCityLabel: 'Boston', activeCityAliases: ['Boston'], rideDemandSubmitting: false, rideDemandRequested: false, isRideServiceAvailable: false })
  return { page, state }
}
for (const kind of ['home', 'carpoolList']) {
  test(`${kind}: guest city request reaches server once and leaves product login unchanged`, async () => {
    const { page, state } = harness(kind)
    await Promise.all([page.onRequestRideCityService(), page.onRequestRideCityService()])
    assert.equal(state.calls.length, 1); assert.deepEqual(state.calls[0], { cityKey: 'boston', sourcePage: kind })
    assert.equal(page.data.rideDemandRequested, true); assert.equal(page.data.rideDemandSubmitting, false)
    assert.equal(state.guest, true); assert.equal(state.owner, '')
  })
  test(`${kind}: old-city recovered intent or city change cannot mark a newly selected city`, async () => {
    for (const recovered of [false, true]) {
      const { page, state } = harness(kind)
      let resolve; state.pending = new Promise(r => { resolve = r })
      const pending = page.onRequestRideCityService(); await tick()
      if (!recovered) page.setData({ activeCityKey: 'atlanta' })
      resolve({ requestId: '00000000-0000-4000-8000-000000000001', cityKey: recovered ? 'atlanta' : 'boston', status: 'recorded', recovered })
      await pending; assert.equal(page.data.rideDemandRequested, false)
      assert.equal(page.data.rideDemandSubmitting, false)
      assert.equal(state.toasts.at(-1), recovered ? '已确认上次请求' : '已收到请求')
    }
  })
  test(`${kind}: late results after account change/unload and failures cannot claim success`, async () => {
    for (const change of ['account', 'unload', 'failure']) {
      const { page, state } = harness(kind)
      let resolve, reject; state.pending = new Promise((yes,no) => { resolve = yes; reject = no })
      const pending = page.onRequestRideCityService(); await tick()
      if (change === 'account') { state.guest = false; state.owner = 'another'; }
      if (change === 'unload') page.onUnload()
      const writes = state.writes
      if (change === 'failure') reject(Error('offline'))
      else resolve({ requestId: '00000000-0000-4000-8000-000000000001', cityKey: 'boston', status: 'recorded' })
      await pending; assert.equal(page.data.rideDemandRequested, false)
      if (change !== 'failure') { assert.equal(state.writes, writes); assert.equal(state.toasts.length, 0) }
      else { assert.equal(page.data.rideDemandSubmitting, false); assert.deepEqual(state.toasts, ['提交失败，请稍后重试']) }
    }
  })
  test(`${kind}: default CloudBase path preserves old complete request`, async () => {
    const { page, state } = harness(kind, false)
    await page.onRequestRideCityService()
    assert.equal(state.calls[0].name, 'rideDemand'); assert.equal(state.calls[0].data.cityLabel, 'Boston')
    assert.deepEqual(Array.from(state.calls[0].data.cityAliases), ['Boston'])
  })
}
