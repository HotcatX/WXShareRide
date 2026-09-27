const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const id = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'
const flush = () => new Promise(r => setImmediate(r))
function harness(kind) {
  const state = { owner: 'self-openid', guest: false, writes: [], notices: [], timers: new Map(), next: 0, reads: [],
    profile: { result: { data: [{ _openid: 'self-openid', wechatID: 'me', pickupSpot: ['Lobby'] }] } }, fail: false }
  const wx = { getStorageSync: key => key === 'openid' ? state.owner : key === 'isGuest' ? state.guest : undefined,
    setStorageSync() {}, removeStorageSync() {}, showToast: o => state.notices.push(o.title),
    stopPullDownRefresh() {}, navigateTo() {}, showModal() {}, cloud: { callFunction() { throw Error('No CloudBase') }, database() { throw Error('No CloudBase') } } }
  const rides = { isBackendEnabled: () => true, async joinTrip(body) { state.writes.push(body); return { result: { ok: true, success: true } } } }
  let definition
  const file = path.resolve(__dirname, `../pages/home/${kind}/${kind}.js`)
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { Page: value => { definition = value }, wx, console: { error() {}, warn() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: fn => { state.timers.set(++state.next, fn); return state.next }, clearInterval: n => state.timers.delete(n),
    getCurrentPages: () => [{}], require(name) {
      if (name.endsWith('/compat/rides')) return rides
      if (name.endsWith('/compat/profile')) return { getUserInfo: async () => state.profile, legacyDocument: r => r.result.data[0] }
      if (name.endsWith('/rideTelemetry')) return { detailViewed() {} }
      if (name.endsWith('/tripDetailCache')) return { readTripDetailCache: () => null, removeTripDetailCache() {}, async fetchTripDetail(...args) {
        state.reads.push(args); if (state.fail) throw Error('permission refreshed unavailable'); return state.detail
      } }
      if (name.endsWith('/tripManage')) return { ...require('../utils/tripManage'), markRideListStale() {},
        callTripManage: async body => { state.writes.push(body); return { ok: true } } }
      return require(path.resolve(path.dirname(file), name))
    } })
  const page = { ...definition, data: structuredClone(definition.data), _detailAccount: 'user:self-openid' }
  page.setData = function(patch, cb) { Object.assign(this.data, patch); cb?.() }
  page.data.tripId = 'route'
  return { page, state }
}
function trip(patch = {}) {
  return { _id: 'route', serverMode: true, status: 'open', departures: [{ address: 'Fort Lee', date: '2030-01-01', time: '15:00' }],
    destinations: [{ address: 'Columbia' }], referencePrice: '11-13$', hasDriver: true, availableSeats: 2, passengerCount: 2,
    passengers: [], passengerID: [], viewer: { userId: id, isCreator: false, role: 'passenger', seatCount: 1 },
    driverUserId: other, creatorUserId: other, ...patch }
}
test('offer detail trusts membership UUID and authorized driver contact without another profile lookup', () => {
  const { page } = harness('tripDetail')
  page.applyTripDetailResult({ ok: true, data: trip(), driverInfo: { userId: other, name: 'Driver', wechatID: 'private', carBrand: 'A', carModel: 'B' } }, 'route')
  assert.equal(page.data.hasJoined, true); assert.equal(page.data.isOwner, false)
  assert.equal(page.data.driverInfo.wechatID, 'private'); assert.equal(page.data.driverOpenid, '')
  assert.equal(page.data.driverUserId, other); assert.equal(page.data.referencePriceText, '11-13$')
  page.applyTripDetailResult({ ok: true, data: trip({ viewer: { userId: id, isCreator: true, role: 'driver', seatCount: 0 } }) }, 'route')
  assert.equal(page.data.isOwner, true); assert.equal(page.data.hasJoined, false)
})
test('request detail derives driver assignment and canonical remaining seats without inventing member OpenIDs', () => {
  const { page } = harness('requestDetail')
  page.applyRequestData(trip({ seatCapacity: 6, availableSeats: 4, hasDriver: true, viewer: { userId: id, role: 'driver', isCreator: false } }))
  assert.equal(page.data.seatLeft, 4); assert.equal(page.data.isAccepted, true); assert.equal(page.data.acceptedByMe, true)
  assert.equal(page.data.joinedByMe, false); assert.equal(page.data.ownerOpenid, ''); assert.equal(page.data.ownerUserId, other)
})
test('joining waits for own profile and aborts if account changes or the page unloads', async () => {
  for (const action of ['switch', 'unload']) {
    const { page, state } = harness('tripDetail')
    page.applyTripData(trip({ viewer: { role: null, isCreator: false } }), 'route')
    page.setData({ pickupAddress: 'Lobby', dropoffAddress: 'Gate' })
    let resolve; state.profile = new Promise(r => { resolve = r })
    const pending = page.joinCarpool(); await flush()
    if (action === 'switch') state.owner = 'different'; else page.onUnload()
    resolve({ result: { data: [{ wechatID: 'valid' }] } }); await pending
    assert.equal(state.writes.length, 0)
  }
})
test('permission refresh failure clears former contacts instead of showing an expired authorized snapshot', async () => {
  const { page, state } = harness('tripDetail')
  page.applyTripDetailResult({ ok: true, data: trip(), driverInfo: { userId: other, wechatID: 'private' } }, 'route')
  state.fail = true; await page.loadTripDetail('route', { force: true, silent: true })
  assert.equal(page.data.driverInfo, null); assert.equal(page.data.trip, null)
})
test('visible server detail uses one refresh timer and hide/unload stop it; account change clears contact data immediately', async () => {
  const { page, state } = harness('tripDetail')
  state.detail = { ok: true, data: trip(), driverInfo: { userId: other, wechatID: 'private' } }
  page.applyTripDetailResult(state.detail, 'route')
  await page.onShow(); await page.onShow(); assert.equal(state.timers.size, 1)
  page.onHide(); assert.equal(state.timers.size, 0)
  state.owner = 'different'; state.fail = true
  await page.onShow(); assert.equal(page.data.driverInfo, null)
  page.onUnload(); assert.equal(state.timers.size, 0)
})
