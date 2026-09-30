const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const tripManage = require('../utils/tripManage')
const plain = value => JSON.parse(JSON.stringify(value))
const id = '00000000-0000-4000-8000-000000000001'
const driverId = '00000000-0000-4000-8000-000000000002'
const passengerId = '00000000-0000-4000-8000-000000000003'
const otherId = '00000000-0000-4000-8000-000000000004'
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const kinds = {
  myTripDetailDriver: ['carpool', 'driver', true], myTripDetailPassenger: ['carpool', 'passenger', false],
  myRequestDetailDriver: ['request', 'driver', false], myTripRequestPassenger: ['request', 'passenger', true],
}
function response(kind, role, creator) {
  const member = (userId, memberRole, seatCount) => ({ userId, role: memberRole, seatCount, name: userId, phone: 'phone', wechatID: 'wechat',
    carNumber: 'PLATE', zelleName: 'NAME', zelleAccount: 'ZELLE', pickupAddress: 'pickup', dropoffAddress: 'dropoff',
    avatarFileId: null, avatarUrl: '', rideStats: { completedDriverTrips: 3, completedPassengerTrips: 2 } })
  const driver = member(driverId, 'driver', 0), passengers = [member(passengerId, 'passenger', 2), member(otherId, 'passenger', 1)]
  const viewer = { userId: role === 'driver' ? driverId : passengerId, role, isCreator: creator, seatCount: role === 'driver' ? 0 : 2 }
  return { ok: true, viewer, ratedTargetUserIds: [otherId], driverInfo: driver, passengerProfiles: passengers,
    data: { _id: id, serverMode: true, kind: kind === 'request' ? 'request' : 'offer', canonicalStatus: 'closed', status: 'past',
      passengerCount: 3, largeLuggageCount: 2, referencePrice: '包车110USD', viewer,
      departures: [{ address: 'Fort Lee', date: '2026-10-01', time: '15:00' }], destinations: [{ address: '哥大' }] } }
}
function fixture(name) {
  const [kind, role, creator] = kinds[name] || ['request', 'passenger', true]
  const state = { identity: 'account-A', result: response(kind, role, creator), writes: [], modals: [], toasts: [], timers: [], reads: 0, now: 1800000000000 }
  const profile = { identity: () => state.identity, isBackendEnabled: () => true }
  const rides = { isBackendEnabled: () => true, async getTripDetail() { state.reads++; return await state.result } }
  const telemetry = { pageVisible() {}, pageHidden() {}, detailViewed() {} }
  class ClockDate extends Date { static now() { return state.now } }
  const context = { module: { exports: {} }, Date: ClockDate, setTimeout: (fn, ms) => { state.timers.push({ fn, ms, active: true }); return state.timers.length }, clearTimeout(index) { if (state.timers[index - 1]) state.timers[index - 1].active = false }, require(name) {
    if (name === './rides') return rides
    if (name === './profile') return profile
    if (name === '../tripManage') return tripManage
    if (name === '../rideTelemetry') return telemetry
    throw Error(name)
  } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/compat/rideContacts.js'), 'utf8'), context)
  const contacts = context.module.exports
  let definition
  const wx = { getStorageSync: key => key === 'openid' ? state.identity : false, getWindowInfo: () => ({ statusBarHeight: 40 }),
    showShareMenu() {}, showLoading() {}, hideLoading() {}, stopPullDownRefresh() {},
    showToast: data => state.toasts.push(data), showModal: data => state.modals.push(data),
    cloud: { callFunction() { throw Error('No CloudBase in server management') }, database() { throw Error('No legacy DB') } } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../pages/profile/${name}/${name}.js`), 'utf8'), {
    Page: value => { definition = value }, wx, clearTimeout() {}, console: { error() {} }, setTimeout: fn => state.timers.push(fn),
    require(name) {
      if (name.endsWith('/compat/rideContacts')) return contacts
      if (name.endsWith('/compat/profile')) return profile
      if (name.endsWith('/rideTelemetry')) return telemetry
      if (name.endsWith('/error')) return { showDataError() {} }
      if (name.endsWith('/tripDetailCache')) return { fetchTripDetail() { throw Error('server reads use authorized facade') }, removeTripDetailCache() {} }
      if (name.endsWith('/tripManage')) return { ...tripManage, askReason: async () => 'reason',
        async callTripManage(body) { state.writes.push(plain(body)); return body.action === 'getBlockList' ? { ok: true, list: [{ targetUserId: otherId, name: 'other', wechatId: 'canonical-wechat', createdAt: '2026-09-01T12:00:00Z' }] } : { ok: true } },
        async rateTripUser(body) { state.writes.push(plain(body)); return false }, markRideListStale() {} }
      throw Error(name)
    },
  })
  const page = { ...definition, data: plain(definition.data) }
  page.setData = function(patch, callback) { Object.assign(this.data, patch); if (callback) callback() }
  const load = () => name.includes('Request') || name === 'myRequestDetailDriver' ? page.loadRequestDetail(id) : page.loadTripDetail(id, ...(name === 'myTripDetailPassenger' ? [kind] : []))
  return { page, state, load, contacts }
}

test('all four server management pages show authorized UUID contacts, party seats, complete quote labels and ratings without CloudBase', async () => {
  for (const [name, [kind, role]] of Object.entries(kinds)) {
    const h = fixture(name); await h.load()
    assert.equal(h.page.data.trip._id, id, name); assert.equal(h.page.data.trip.referencePriceText, '包车110USD')
    assert.equal(h.page.data.isTripCompleted, true); assert.equal(h.page.data.isRequestCompleted, true)
    assert.equal(h.page.data.driverInfo.userId, driverId); assert.equal('_openid' in h.page.data.driverInfo, false)
    if (role === 'driver') {
      assert.equal(h.page.data.passengers.length, 2)
      assert.equal(h.page.data.passengerSummaryText, '3 人 · 2 位联系人')
      assert.equal(h.page.data.passengers[1].hasRated, true)
    } else if (kind === 'request') {
      assert.deepEqual(plain(h.page.data.otherPassengers.map(p => p.userId)), [otherId])
      assert.equal(h.page.data.largeLuggageCount, 2)
    }
    assert.equal(JSON.stringify(h.page.data).includes('_openid'), false)
  }
})

test('management rejects wrong role/creator, clears prior contacts on failed refresh, and discards unloaded/account-changed results', async () => {
  for (const name of Object.keys(kinds)) {
    const h = fixture(name); await h.load()
    h.state.result = { ...h.state.result, viewer: { ...h.state.result.viewer, role: null } }
    await h.load(); assert.equal(h.page.data.trip, null); assert.equal(h.page.data.driverInfo, null)
    assert.match(h.page.data.loadError, /无权/)
    const delayed = deferred(); h.state.result = delayed.promise
    const pending = h.load(); h.page.onUnload(); delayed.resolve(response(...kinds[name])); await pending
    assert.equal(h.page.data.trip, null)
  }
  const h = fixture('myTripRequestPassenger'); await h.load()
  const delayed = deferred(); h.state.result = delayed.promise
  const pending = h.load(); h.state.identity = 'account-B'; h.page.onShow()
  assert.equal(h.page.data.trip, null)
  delayed.resolve(response('request', 'passenger', false)); await pending; await new Promise(setImmediate)
  assert.equal(h.page.data.trip, null)
})

test('kick, block, rating and driver removal send explicit targetUserId with no invented OpenID', async () => {
  const event = { currentTarget: { dataset: { userId: otherId, name: 'Passenger' } } }
  for (const name of ['myTripDetailDriver', 'myRequestDetailDriver']) {
    const h = fixture(name); await h.load(); h.page.setData({ tripId: id, requestId: id })
    await h.page.onBlockUser(event); await h.state.modals.pop().success({ confirm: true })
    assert.equal(h.state.writes[0].targetUserId, otherId); assert.equal('targetOpenid' in h.state.writes[0], false)
    h.page.setData({ ratedTargetMap: {} }); await h.page.onRatePassenger(event)
    assert.equal(h.state.writes.at(-1).targetUserId, otherId)
  }
  const h = fixture('myTripRequestPassenger'); await h.load(); h.page.setData({ requestId: id, kickMode: true })
  await h.page.onKickDriver(); assert.equal(h.state.writes[0].targetUserId, driverId)
  h.page.setData({ kickMode: true }); await h.page.onKickPassenger(event)
  assert.equal(h.state.writes[1].targetUserId, otherId)
})

test('account switching while a management confirmation is open prevents mutation', async () => {
  const h = fixture('myTripDetailDriver'); await h.load()
  await h.page.onBlockUser({ currentTarget: { dataset: { userId: otherId } } })
  h.state.identity = 'account-B'; await h.state.modals[0].success({ confirm: true })
  assert.equal(h.state.writes.length, 0)
})

test('server block list uses target UUIDs and cannot unblock after account change', async () => {
  const h = fixture('blockList'); await h.page.loadBlockList()
  assert.equal(h.page.data.list[0].wechatID, 'canonical-wechat'); assert.equal(h.page.data.list[0].targetUserId, otherId); assert.equal('targetOpenid' in h.page.data.list[0], false)
  const event = { currentTarget: { dataset: { userId: otherId } } }
  h.page.onUnblockUser(event); await h.state.modals[0].success({ confirm: true })
  assert.deepEqual(h.state.writes[1], { action: 'unblockUser', targetUserId: otherId }); assert.equal(h.page.data.list.length, 0)
  await h.page.loadBlockList(); h.page.onUnblockUser(event); h.state.identity = 'account-B'
  await h.state.modals[1].success({ confirm: true }); assert.equal(h.state.writes.length, 3)
})


test('private management refreshes signed avatars while visible and after background expiry, cancels timers on hide/unload', async () => {
  for (const name of Object.keys(kinds)) {
    const h = fixture(name); await h.load()
    assert.equal(h.state.timers.at(-1).ms, 240000)
    h.state.now += 120000; h.page.onHide()
    assert.equal(h.state.timers.some(t => t.active), false)
    h.page.onShow(); assert.equal(h.state.timers.at(-1).ms, 120000)
    h.state.now += 120000; h.state.timers.at(-1).active = false; h.state.timers.at(-1).fn(); await new Promise(setImmediate)
    assert.equal(h.state.reads, 2)
    h.page.onHide(); h.state.now += 300000; h.page.onShow(); await new Promise(setImmediate)
    assert.equal(h.state.reads, 3)
    h.page.onUnload(); assert.equal(h.state.timers.some(t => t.active), false)
  }
})

test('missing historical luggage is not a confirmed zero; new requests with an explicit zero remain zero', async () => {
  const h = fixture('myRequestDetailDriver')
  delete h.state.result.data.largeLuggageCount
  await h.load(); assert.equal(h.page.data.largeLuggageCount, null)
  h.state.result.data.largeLuggageCount = 0
  await h.load(); assert.equal(h.page.data.largeLuggageCount, 0)
})
