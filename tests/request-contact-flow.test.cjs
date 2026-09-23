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
  _id: 'request', _openid: 'creator', passengerID: ['p1', 'p2', 'p3'], passengerCount: 4,
  status: 'full', driverOpenid: '', departures: [{ address: 'Fort Lee', date: '2030-01-01', time: '08:00' }],
  destinations: [{ address: '哥大' }], ...extra
})
const profile = id => ({ _openid: id, name: id, phone: `phone-${id}`, wechatID: `wechat-${id}` })

function harness(kind, result, actor = 'driver') {
  const calls = [], reads = [], invalidated = [], navigations = [], toasts = []
  let definition
  const state = { result, userResult: { ok: true, data: [] }, accepted: { ok: true }, stale: 0, actor, guest: false }
  const wx = {
    getStorageSync: key => key === 'openid' ? state.actor : key === 'isGuest' ? state.guest : undefined,
    getWindowInfo: () => ({ statusBarHeight: 40 }), showShareMenu() {}, stopPullDownRefresh() {},
    showToast: options => toasts.push(options.title),
    redirectTo: options => navigations.push(options.url),
    cloud: { async callFunction(options) {
      calls.push(options)
      const result = await state.userResult
      if (result instanceof Error) throw result
      return { result }
    } }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', pagePaths[kind]), 'utf8'), {
    Page(value) { definition = value }, wx, console: { error() {}, warn() {} }, setTimeout,
    require(name) {
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
  page.setData = function(patch) { Object.assign(this.data, patch) }
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
  for (const extra of [{ driverOpenid: 'other-driver' }, { status: 'past' }, { status: 'cancelled' }]) {
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

test('driver management enters with a fresh read and reuses authorized profiles including an omitted creator', async () => {
  const h = harness('driver', {
    ok: true, openid: 'driver', data: request({ driverOpenid: 'driver' }),
    passengerProfiles: ['creator', 'p1', 'p2', 'p3'].map(profile), passengerProfilesError: false
  })
  await h.page.onLoad({ requestId: 'request' })
  assert.equal(h.reads[0].options.force, true)
  assert.equal(h.reads[0].options.allowStale, false)
  assert.equal(h.page.data.isMyRequest, true)
  assert.deepEqual(Array.from(h.page.data.passengers, item => item._openid), ['creator', 'p1', 'p2', 'p3'])
  assert.equal(h.page.data.passengers[0].wechatID, 'wechat-creator')
  assert.equal(h.page.data.passengersError, '')
  assert.equal(h.calls.length, 0, 'the detail response must replace the extra user lookup')
})

test('failed authorized passenger lookup preserves known membership and presents an explicit retry', async () => {
  const h = harness('driver', {
    ok: true, openid: 'driver', data: request({ driverOpenid: 'driver' }),
    passengerProfiles: [], passengerProfilesError: true
  })
  h.page.data.requestId = 'request'
  await h.page.loadRequestDetail('request')
  assert.equal(h.page.data.passengers.length, 4)
  assert.match(h.page.data.passengersError, /加载失败/)
  assert.equal(h.page.data.loadError, '')
  assert.equal(h.calls.length, 0)
  h.state.result = { ...h.state.result, passengerProfiles: ['creator', 'p1', 'p2', 'p3'].map(profile), passengerProfilesError: false }
  await h.page.onRetryPassengerInfo()
  assert.equal(h.reads.at(-1).options.force, true)
  assert.equal(h.page.data.passengersError, '')
  assert.equal(h.page.data.passengers[0].phone, 'phone-creator')
})

test('an unassigned viewer never uses the driver page to request contacts', async () => {
  const h = harness('driver', { ok: true, openid: 'stranger', data: request({ driverOpenid: 'driver' }), passengerProfiles: [] })
  await h.page.loadRequestDetail('request')
  assert.equal(h.page.data.isMyRequest, false)
  assert.equal(h.page.data.passengers.length, 0)
  assert.equal(h.calls.length, 0)
})

test('passenger detail fetches current assignment and missing driverInfo triggers the compatible lookup instead of an empty fake profile', async () => {
  const h = harness('passenger', {
    ok: true, openid: 'creator', data: request({ driverOpenid: 'driver', passengerID: ['creator'] })
  }, 'creator')
  h.state.userResult = { ok: true, data: [profile('driver')] }
  await h.page.onLoad({ requestId: 'request' })
  assert.equal(h.reads[0].options.force, true)
  assert.equal(h.reads[0].options.allowStale, false)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].name, 'getUserInfoByOpenids')
  assert.equal(h.page.data.driverInfo.wechatID, 'wechat-driver')
  assert.equal(h.page.data.driverInfoError, '')
})

test('a failed driver contact lookup does not erase a passenger route or imply unfilled contact fields', async () => {
  const h = harness('passenger', {
    ok: true, openid: 'creator', data: request({ driverOpenid: 'driver', passengerID: ['creator'] }), driverInfo: null
  }, 'creator')
  h.state.userResult = new Error('offline')
  await h.page.loadRequestDetail('request')
  assert.equal(h.page.data.loadError, '')
  assert.equal(h.page.data.trip._id, 'request')
  assert.equal(h.page.data.driverInfo, null)
  assert.match(h.page.data.driverInfoError, /加载失败/)
})

test('driver passenger summary distinguishes booked seats from contact accounts without another query', async () => {
  for (const [extra, expected] of [
    [{ passengerCount: 4, passengerID: ['creator'] }, '4 人 · 1 位联系人'],
    [{ passengerCount: 1, passengerID: ['creator'] }, '1 人'],
    [{ passengerCount: undefined, requestPassengerCount: 3, passengerID: ['creator'] }, '3 人 · 1 位联系人'],
    [{ passengerCount: undefined, passengerID: ['creator', 'p1'] }, '2 人']
  ]) {
    const h = harness('driver', {
      ok: true, openid: 'driver', data: request({ ...extra, driverOpenid: 'driver' }),
      passengerProfiles: ['creator', 'p1'].map(profile), passengerProfilesError: false
    })
    await h.page.loadRequestDetail('request')
    assert.equal(h.page.data.passengerSummaryText, expected)
    assert.equal(h.calls.length, 0)
  }
})

test('passenger driver profiles normalize historical nickname and WeChat aliases from either detail or fallback', async () => {
  for (const [field, source] of [['wechatId', 'detail'], ['wechat', 'fallback']]) {
    const legacy = { _openid: 'driver', nickName: 'Legacy Driver', [field]: 'legacy-contact' }
    const h = harness('passenger', {
      ok: true, openid: 'creator', data: request({ driverOpenid: 'driver', passengerID: ['creator'] }),
      ...(source === 'detail' ? { driverInfo: legacy } : {})
    }, 'creator')
    h.state.userResult = { ok: true, data: [legacy] }
    await h.page.loadRequestDetail('request')
    assert.equal(h.page.data.driverInfo.name, 'Legacy Driver')
    assert.equal(h.page.data.driverInfo.wechatID, 'legacy-contact')
    assert.equal(h.calls.length, source === 'detail' ? 0 : 1)
  }
})

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
const passengerDetail = driver => ({
  ok: true, openid: 'creator', data: request({ driverOpenid: driver, passengerID: ['creator'] }),
  driverInfo: driver ? profile(driver) : null
})

test('an older passenger detail response cannot restore the driver after a newer removal refresh', async () => {
  const old = deferred()
  const h = harness('passenger', old.promise, 'creator')
  const beforeRemoval = h.page.loadRequestDetail('request')
  h.state.result = passengerDetail('')
  await h.page.loadRequestDetail('request', { force: true })
  assert.equal(h.page.data.driverInfo, null)
  old.resolve(passengerDetail('old-driver'))
  await beforeRemoval
  assert.equal(h.page.data.trip.driverOpenid, '')
  assert.equal(h.page.data.driverInfo, null)
  assert.equal(h.page.data.loadError, '')
})

test('an old pending contact lookup cannot overwrite a newer detail, even when the old lookup fails', async () => {
  for (const fail of [false, true]) {
    const old = deferred()
    const h = harness('passenger', { ...passengerDetail('old-driver'), driverInfo: null }, 'creator')
    h.state.userResult = old.promise
    const pending = h.page.loadRequestDetail('request')
    await flush()
    assert.equal(h.calls.length, 1)
    h.state.result = passengerDetail('new-driver')
    await h.page.loadRequestDetail('request', { force: true })
    if (fail) old.reject(new Error('old failure'))
    else old.resolve({ ok: true, data: [profile('old-driver')] })
    await pending
    assert.equal(h.page.data.driverInfo.wechatID, 'wechat-new-driver')
    assert.equal(h.page.data.driverInfoError, '')
    assert.equal(h.page.data.loadError, '')
  }
})

test('switching account or guest mode during a contact lookup discards private profiles and clears stale data', async () => {
  for (const changeIdentity of [state => { state.actor = 'other' }, state => { state.guest = true }]) {
    const old = deferred()
    const h = harness('passenger', { ...passengerDetail('old-driver'), driverInfo: null }, 'creator')
    h.state.userResult = old.promise
    const pending = h.page.loadRequestDetail('request')
    await flush()
    changeIdentity(h.state)
    old.resolve({ ok: true, data: [profile('old-driver')] })
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
    old.resolve(kind === 'passenger' ? passengerDetail('driver') : {
      ok: true, openid: 'driver', data: request({ driverOpenid: 'driver' }),
      passengerProfiles: ['creator', 'p1', 'p2', 'p3'].map(profile), passengerProfilesError: false
    })
    await pending
    assert.deepEqual(h.page.data, before)
    assert.equal(h.calls.length, 0)
  }
})
