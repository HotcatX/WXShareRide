const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const tripManage = require('../utils/tripManage')

const pagePaths = {
  public: 'pages/home/requestDetail/requestDetail.js',
  driver: 'pages/profile/myRequestDetailDriver/myRequestDetailDriver.js',
  passenger: 'pages/profile/myTripRequestPassenger/myTripRequestPassenger.js'
}
const request = (extra = {}) => ({
  _id: 'request', serverMode: true, kind: 'request', canonicalStatus: 'open', passengerCount: 4,
  status: 'open', availableSeats: 0, hasDriver: false, viewer: { userId: 'viewer', role: null, isCreator: false }, departures: [{ address: 'Fort Lee', date: '2030-01-01', time: '08:00' }],
  destinations: [{ address: '哥大' }], ...extra
})
const profile = id => ({ userId: id, name: id, role: id.includes('driver') ? 'driver' : 'passenger', seatCount: 1, phone: `phone-${id}`, wechatID: `wechat-${id}` })

function harness(kind, result, actor = 'driver') {
  const calls = [], reads = [], invalidated = [], navigations = [], toasts = []
  let definition
  const state = { result, accepted: { ok: true }, stale: 0, actor, guest: false }
  const wx = {
    getStorageSync: key => key === 'openid' ? state.actor : key === 'isGuest' ? state.guest : undefined,
    getWindowInfo: () => ({ statusBarHeight: 40 }), showShareMenu() {}, stopPullDownRefresh() {},
    showToast: options => toasts.push(options.title),
    redirectTo: options => navigations.push(options.url),
    cloud: { callFunction() { throw new Error('Private contacts must not call CloudBase') } }
  }
  const rides = { isBackendEnabled: () => true, async getTripDetail(type, id) {
    reads.push({ type, id })
    const value = await state.result
    if (value instanceof Error) throw value
    return value
  } }
  const account = { identity: () => state.guest ? '' : state.actor, isBackendEnabled: () => true }
  const telemetry = require('./helpers/load-ride-telemetry.cjs')({}, { wx })
  const contacts = require('./helpers/load-ride-contacts.cjs')({ rides, profile: account, telemetry })
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', pagePaths[kind]), 'utf8'), {
    Page(value) { definition = value }, wx, console: { error() {}, warn() {} }, setTimeout,
    require(name) {
      if (name.endsWith('/compat/rideContacts')) return contacts
      if (name.endsWith('/compat/rides')) return rides
      if (name.endsWith('/compat/profile')) return account
      if (name.endsWith('tripManage')) return {
        ...tripManage,
        async callTripManage(options) { calls.push(options); return state.accepted },
        markRideListStale() { state.stale++ }
      }
      if (name.endsWith('tripDetailCache')) return {
        async fetchTripDetail(type, id, options) { reads.push({ type, id, options }); return state.result },
        readTripDetailCache() { return null },
        removeTripDetailCache(type, id) { invalidated.push([type, id]) }
      }
      if (name.endsWith('routeExpiry')) return require('../utils/routeExpiry')
      if (name.endsWith('rideTelemetry')) return require('./helpers/load-ride-telemetry.cjs')({}, { wx })
      throw new Error(`Unexpected dependency ${name}`)
    }
  })
  const page = { ...definition, data: structuredClone(definition.data) }
  page.setData = function(patch, callback) { Object.assign(this.data, patch); if (callback) callback() }
  return { page, calls, reads, state, invalidated, navigations, toasts }
}

test('a full passenger group without a driver remains available for driver acceptance and links straight to contacts', async () => {
  const h = harness('public')
  h.page.data.tripId = 'request'
  h.page.applyRequestData(request())
  assert.equal(h.page.data.isFull, true)
  assert.equal(h.page.data.isAccepted, false)
  assert.equal(h.page.data.isClosed, false)
  h.page.ensureWechatBeforeAction = async () => true
  await h.page.acceptRequest()
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].action, 'acceptRequest')
  assert.deepEqual(h.invalidated, [['request', 'request']])
  assert.equal(h.state.stale, 1)
  assert.deepEqual(h.navigations, ['/pages/profile/myRequestDetailDriver/myRequestDetailDriver?requestId=request'])
  const template = fs.readFileSync(path.join(__dirname, '..', pagePaths.public.replace('.js', '.wxml')), 'utf8')
  assert.doesNotMatch(template, /wx:elif="\{\{isFull\}\}"/)
  assert.match(template, /isFull \? '乘客已满员'/)
  assert.match(template, /bindtap="openAcceptedDriverDetail"/)
})

test('an assigned or completed request cannot be accepted again regardless of passenger capacity', async () => {
  for (const extra of [{ hasDriver: true }, { status: 'past' }, { status: 'cancelled' }]) {
    const h = harness('public')
    h.page.data.tripId = 'request'
    h.page.applyRequestData(request(extra))
    h.page.ensureWechatBeforeAction = async () => true
    await h.page.acceptRequest()
    assert.equal(h.calls.length, 0)
    assert.equal(h.navigations.length, 0)
  }
})

test('an explicit acceptance failure never navigates to contacts or clears the cached request', async () => {
  for (const response of [
    { ok: false, success: false }, { ok: false, success: true },
    { ok: true, success: false }, { success: 'false' }, null
  ]) {
    const h = harness('public')
    h.state.accepted = response
    h.page.data.tripId = 'request'
    h.page.applyRequestData(request())
    h.page.ensureWechatBeforeAction = async () => true
    await h.page.acceptRequest()
    assert.equal(h.calls.length, 1)
    assert.equal(h.invalidated.length, 0)
    assert.equal(h.state.stale, 0)
    assert.equal(h.navigations.length, 0)
    assert.equal(h.page.data.submittingDriver, false)
    assert.equal(h.toasts.at(-1), '接单失败')
  }
})

const managementDetail = (role, { driver = 'driver', passengers = ['creator', 'p1', 'p2', 'p3'], count = 4, viewerRole = role } = {}) => {
  const viewer = { userId: role === 'driver' ? 'driver' : 'creator', role: viewerRole, isCreator: role === 'passenger' }
  return { ok: true, viewer, ratedTargetUserIds: [],
    data: request({ passengerCount: count, hasDriver: !!driver, driverUserId: driver || null, viewer }),
    driverInfo: driver ? profile(driver) : null, passengerProfiles: passengers.map(profile) }
}

test('driver management enters with a fresh authorized read including the creator without a separate profile lookup', async () => {
  const h = harness('driver', managementDetail('driver'))
  await h.page.onLoad({ requestId: 'request' })
  assert.deepEqual(h.reads, [{ type: 'request', id: 'request' }])
  assert.equal(h.page.data.isMyRequest, true)
  assert.deepEqual(Array.from(h.page.data.passengers, item => item.userId), ['creator', 'p1', 'p2', 'p3'])
  assert.equal(h.page.data.passengers[0].wechatID, 'wechat-creator')
  assert.equal(h.page.data.passengersError, '')
  assert.equal(h.calls.length, 0, 'the authorized detail response replaces the extra user lookup')
})

test('failed authorized contact refresh clears private state and presents an explicit retry', async () => {
  const h = harness('driver', managementDetail('driver'))
  h.page.data.requestId = 'request'
  await h.page.loadRequestDetail('request')
  assert.equal(h.page.data.passengers.length, 4)
  h.state.result = new Error('联系人加载失败')
  await h.page.loadRequestDetail('request')
  assert.equal(h.page.data.passengers.length, 0)
  assert.equal(h.page.data.trip, null)
  assert.match(h.page.data.loadError, /加载失败/)
  assert.equal(h.calls.length, 0)
  h.state.result = managementDetail('driver')
  await h.page.onRetryPassengerInfo()
  assert.equal(h.reads.length, 3)
  assert.equal(h.page.data.loadError, '')
  assert.equal(h.page.data.passengers[0].phone, 'phone-creator')
})

test('an unassigned viewer never uses the driver page to show contacts', async () => {
  const h = harness('driver', managementDetail('driver', { viewerRole: null }))
  await h.page.loadRequestDetail('request')
  assert.equal(h.page.data.isMyRequest, false)
  assert.equal(h.page.data.passengers.length, 0)
  assert.equal(h.calls.length, 0)
  assert.match(h.page.data.loadError, /无权/)
})

test('passenger detail fetches current assignment and driver contacts in the same authorized response', async () => {
  const h = harness('passenger', managementDetail('passenger'), 'creator')
  await h.page.onLoad({ requestId: 'request' })
  assert.deepEqual(h.reads, [{ type: 'request', id: 'request' }])
  assert.equal(h.calls.length, 0)
  assert.equal(h.page.data.driverInfo.wechatID, 'wechat-driver')
  assert.equal(h.page.data.driverInfoError, '')
})

test('a failed driver contact read does not fabricate empty contact fields and can retry', async () => {
  const h = harness('passenger', new Error('联系人加载失败'), 'creator')
  await h.page.loadRequestDetail('request')
  assert.match(h.page.data.loadError, /加载失败/)
  assert.equal(h.page.data.trip, null)
  assert.equal(h.page.data.driverInfo, null)
  h.state.result = managementDetail('passenger')
  await h.page.loadRequestDetail('request')
  assert.equal(h.page.data.driverInfo.phone, 'phone-driver')
  assert.equal(h.page.data.loadError, '')
})

test('driver passenger summary distinguishes booked seats from contact accounts without another query', async () => {
  for (const [count, passengers, expected] of [
    [4, ['creator'], '4 人 · 1 位联系人'], [1, ['creator'], '1 人'],
    [3, ['creator'], '3 人 · 1 位联系人'], [2, ['creator', 'p1'], '2 人']
  ]) {
    const h = harness('driver', managementDetail('driver', { count, passengers }))
    await h.page.loadRequestDetail('request')
    assert.equal(h.page.data.passengerSummaryText, expected)
    assert.equal(h.calls.length, 0)
  }
})

test('passenger displays migrated canonical driver name and WeChat without a historical alias lookup', async () => {
  const result = managementDetail('passenger')
  result.driverInfo = { ...profile('driver'), name: 'Legacy Driver', wechatID: 'legacy-contact' }
  const h = harness('passenger', result, 'creator')
  await h.page.loadRequestDetail('request')
  assert.equal(h.page.data.driverInfo.name, 'Legacy Driver')
  assert.equal(h.page.data.driverInfo.wechatID, 'legacy-contact')
  assert.equal(h.calls.length, 0)
})

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
const passengerDetail = driver => managementDetail('passenger', { driver, passengers: ['creator'], count: 1 })

test('an older passenger detail response cannot restore the driver after a newer removal refresh', async () => {
  const old = deferred()
  const h = harness('passenger', old.promise, 'creator')
  const beforeRemoval = h.page.loadRequestDetail('request')
  h.state.result = passengerDetail('')
  await h.page.loadRequestDetail('request', { force: true })
  assert.equal(h.page.data.driverInfo, null)
  old.resolve(passengerDetail('old-driver'))
  await beforeRemoval
  assert.equal(h.page.data.trip.driverUserId, null)
  assert.equal(h.page.data.driverInfo, null)
  assert.equal(h.page.data.loadError, '')
})

test('an old pending authorized contact read cannot overwrite a newer detail, even when the old lookup fails', async () => {
  for (const fail of [false, true]) {
    const old = deferred()
    const h = harness('passenger', old.promise, 'creator')
    const pending = h.page.loadRequestDetail('request')
    await flush()
    assert.equal(h.reads.length, 1)
    h.state.result = passengerDetail('new-driver')
    await h.page.loadRequestDetail('request', { force: true })
    if (fail) old.reject(new Error('old failure'))
    else old.resolve(passengerDetail('old-driver'))
    await pending
    assert.equal(h.page.data.driverInfo.wechatID, 'wechat-new-driver')
    assert.equal(h.page.data.driverInfoError, '')
    assert.equal(h.page.data.loadError, '')
  }
})

test('switching account or guest mode during a contact read discards private profiles and clears stale data', async () => {
  for (const changeIdentity of [state => { state.actor = 'other' }, state => { state.guest = true }]) {
    const old = deferred()
    const h = harness('passenger', old.promise, 'creator')
    const pending = h.page.loadRequestDetail('request')
    await flush()
    changeIdentity(h.state)
    h.state.result = new Error('登录状态已变化，请刷新路线')
    h.page.onShow()
    old.resolve(passengerDetail('old-driver'))
    await pending
    assert.equal(h.page.data.driverInfo, null)
    assert.equal(h.page.data.trip, null)
    assert.match(h.page.data.loadError, /登录状态已变化/)
  }
})

test('leaving either management page cancels pending detail rendering and pull-refresh cleanup', async () => {
  for (const kind of ['driver', 'passenger']) {
    const old = deferred()
    const h = harness(kind, old.promise, kind === 'passenger' ? 'creator' : 'driver')
    h.page.data.requestId = 'request'
    const pending = h.page.onDetailRefresherRefresh()
    h.page.onUnload()
    const before = structuredClone(h.page.data)
    old.resolve(kind === 'passenger' ? passengerDetail('driver') : managementDetail('driver'))
    await pending
    assert.deepEqual(JSON.parse(JSON.stringify(h.page.data)), before)
    assert.equal(h.calls.length, 0)
  }
})
