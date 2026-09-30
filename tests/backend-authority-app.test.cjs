const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ROOT = path.join(__dirname, '..')
const tick = () => new Promise(resolve => setImmediate(resolve))
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const reply = authority => ({ result: { ok: true, data: { appId: 'wx8a8a389199aa2a0e', authority } } })

function harness({ storage = { isGuest: true }, restart = true } = {}) {
  const state = { now: Date.now(), cloud: [], restarts: [], notices: [], loading: [], stoppedPulls: 0, next: () => Promise.resolve(reply('cloudbase')) }
  const configs = [], modules = new Map(); let app
  const wx = {
    getStorageSync: key => storage[key], setStorageSync: (key, value) => { storage[key] = plain(value) },
    removeStorageSync: key => { delete storage[key] }, getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
    getEnterOptionsSync: () => ({ scene: 1001 }), getLaunchOptionsSync: () => ({ scene: 1001 }),
    showLoading: value => state.loading.push(value), hideLoading: () => state.loading.push('hidden'),
    stopPullDownRefresh: () => { state.stoppedPulls++ },
    showToast: value => state.notices.push(value),
    cloud: { init() {}, callFunction(input) {
      state.cloud.push(plain(input))
      if (input.name === 'backend' && input.data.action === 'authority') return state.next()
      if (input.name === 'referralApi' && input.data.action === 'trackVisit') return Promise.resolve({ result: { ok: true } })
      if (state.business) return state.business(input)
      throw Error(`Unexpected real App request ${input.name}:${input.data?.action}`)
    } }
  }
  if (restart) wx.restartMiniProgram = input => state.restarts.push(input)
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [state.now])) } static now() { return state.now } }
  const context = vm.createContext({ wx, Date: Clock, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} }, Page(config) { configs.push(config) }, App(config) { app = config },
    getCurrentPages: () => [], getApp: () => app })
  function load(file) {
    const filename = path.resolve(ROOT, file.endsWith('.js') ? file : file + '.js')
    if (modules.has(filename)) return modules.get(filename).exports
    const module = { exports: {} }; modules.set(filename, module)
    const execute = vm.runInContext(`(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`, context, { filename })
    execute(name => load(path.resolve(path.dirname(filename), name)), module, module.exports)
    return module.exports
  }
  load('app.js')
  function page(config = {}) {
    context.Page(config)
    const definition = configs.at(-1)
    return { ...definition, route: 'pages/home/home', data: plain(definition.data),
      setData(patch, callback) { Object.assign(this.data, patch); if (callback) callback() } }
  }
  function launch(query = {}) {
    const options = { scene: 1001, path: 'pages/home/home', query }
    app.onLaunch(options); app.onShow(options)
  }
  return { state, storage, app, load, page, launch, wx }
}

test('real App and module registration make no business calls until the handshake, then replay lifecycle only', async () => {
  const h = harness(), response = deferred(), events = []
  h.state.next = () => response.promise
  // The actual market decorator is invoked before any App lifecycle starts.
  const decorated = h.load('utils/compat/market.js').page({ data: {}, onLoad() { events.push('load') },
    onShow() { events.push('show') }, onReady() { events.push('ready') }, submit() { events.push('submit') } })
  const page = h.page(decorated)
  h.launch(); page.onLoad({}); page.onShow(); page.onReady(); page.submit()
  await tick()
  assert.deepEqual(h.state.cloud, [{ name: 'backend', data: { action: 'authority' } }])
  assert.deepEqual(events, [])
  response.resolve(reply('cloudbase')); await tick()
  assert.deepEqual(events, ['load', 'show', 'ready'])
  assert.equal(h.load('utils/backendClient.js').isBackendEnabled(), false)
  page.submit(); assert.equal(events.at(-1), 'submit')
  page.onHide(); h.app.onHide(); h.app.onShow({ scene: 1001 }); page.onShow()
  await tick()
  assert.equal(h.state.cloud.filter(call => call.data.action === 'authority').length, 2)
  assert.equal(events.filter(value => value === 'load').length, 1)
  page.onUnload(); h.app.onHide()
})

test('App lifecycle leaves cloud calls unwrapped and installs no diagnostic error handlers', async () => {
  const h = harness(), originalCall = h.wx.cloud.callFunction
  const response = deferred(), failure = Error('business request failed')
  const request = { name: 'getTripDetail', data: { type: 'carpool', id: 'synthetic-trip' } }
  h.state.business = input => {
    assert.equal(input, request)
    return response.promise
  }
  h.launch(); await tick()
  assert.equal(h.wx.cloud.callFunction, originalCall)
  assert.equal(h.app.onError, undefined)
  assert.equal(h.app.onUnhandledRejection, undefined)
  const pending = h.wx.cloud.callFunction(request)
  assert.equal(pending, response.promise)
  h.app.onHide(); h.app.onShow({ scene: 1001 }); await tick()
  assert.equal(h.wx.cloud.callFunction, originalCall)
  response.reject(failure)
  await assert.rejects(pending, error => error === failure)
  assert.deepEqual(h.state.cloud.filter(input => input.name !== 'backend'), [request])
  h.app.onHide()
})

test('real App fails closed, recovers on the next foreground and keeps the original referral capture clock', async () => {
  const h = harness(), fail = deferred(), events = []
  h.state.next = () => fail.promise
  const page = h.page({ onLoad() { events.push('load') }, submit() { events.push('write') },
    onPullDownRefresh() { events.push('business-refresh') } })
  const capturedAt = h.state.now
  h.launch({ ref: 'captured_invite' }); page.onLoad({}); page.onShow()
  fail.reject(Error('offline')); await tick(); page.submit()
  assert.deepEqual(events, []); assert.equal(h.state.cloud.length, 1)
  page.onPullDownRefresh()
  assert.equal(h.state.stoppedPulls, 1); assert.deepEqual(events, [])
  assert.equal(h.storage.pending_referral, undefined)
  h.app.onHide(); page.onHide(); h.state.now += 8000
  h.state.next = () => Promise.resolve(reply('cloudbase'))
  h.app.onShow({ scene: 1001 }); page.onShow(); await tick()
  assert.deepEqual(events, ['load'])
  const visit = h.state.cloud.find(call => call.name === 'referralApi')
  assert.equal(visit.data.capturedAtMs, capturedAt)
  page.onUnload(); h.app.onHide()
})

test('server publish keeps one original HTTP write across foreground and duplicate taps', async () => {
  const h = harness(), ack = deferred(), events = [], requests = []
  h.state.next = () => Promise.resolve(reply('server'))
  const owner = 'synthetic-publish-owner', id = '00000000-0000-4000-8000-000000000001'
  const backendModule = h.load('utils/backendClient.js')
  const local = { openid: owner, isGuest: false, [backendModule.SESSION_KEY]: {
    token: 't'.repeat(43), expiresAt: new Date(h.state.now + 3600000).toISOString(),
    user: { id, openid: owner, referralCode: 'ref_0123456789ab' }
  } }
  const wx = { getStorageSync: key => local[key], setStorageSync: (key, value) => { local[key] = plain(value) },
    removeStorageSync: key => { delete local[key] }, cloud: { callFunction() { throw Error('publish cannot use the old cloud writer') } },
    request(options) { requests.push(options); ack.promise.then(data => options.success({ statusCode: 201, data })); return { abort() {} } } }
  const publish = h.load('utils/compat/ridePublish.js').createRidePublishClient({ wx,
    backend: backendModule.createBackendClient({ wx, authority: h.load('utils/backendAuthority.js') }) })
  const future = h.load('utils/rideTime.js').getRideDateTime(h.state.now + 2 * 86400000)
  const draft = { openid: owner, kind: 'offer', cityKey: 'ny_nj', departureAddress: 'Fort Lee', destinationAddress: '哥大',
    departureDate: future.date, departureTime: future.time, passengerCount: 3, referencePrice: '8.50', comment: '' }
  const page = h.page({ data: { busy: false }, onLoad() {}, async submit() {
    if (this.data.busy) return
    this.setData({ busy: true })
    const result = await publish.publishRide(draft)
    events.push('completed'); this.setData({ busy: false, publishedId: result.id })
  } })
  h.launch(); page.onLoad({}); page.onShow(); await tick()
  const submitted = page.submit({ type: 'tap', currentTarget: {} }); await tick()
  assert.equal(page.data.busy, true); assert.equal(requests.length, 1)
  const pending = plain(local[backendModule.PENDING_KEY])
  h.app.onHide(); page.onHide(); h.app.onShow({ scene: 1001 }); page.onShow(); await tick()
  for (const type of ['tap', 'change', 'submit']) page.submit({ type, detail: {}, currentTarget: {} })
  assert.deepEqual(plain(local[backendModule.PENDING_KEY]), pending)
  ack.resolve({ ok: true, data: { rideId: id, version: 1, status: 'open', changed: true } }); await submitted
  assert.equal(page.data.publishedId, id); assert.equal(page.data.busy, false)
  assert.equal(requests.length, 1); assert.equal(requests[0].url, 'https://collect.linkx.ink/api/v1/rides')
  assert.equal(requests[0].data.listedPriceCents, 850)
  assert.equal(requests[0].header['Idempotency-Key'], pending[0].key)
  assert.deepEqual(events, ['completed']); assert.equal(local[backendModule.PENDING_KEY], undefined)
  page.onUnload(); h.app.onHide()
})

test('server handoff stops the old App, restarts once, and a new runtime keeps pending without any CloudBase handshake', async () => {
  const storage = { isGuest: true, 'linkx.backend.pending.v1': [{ method: 'CLOUD', key: 'original', request: { body: { id: 'old-template' } } }] }
  const originalPending = plain(storage['linkx.backend.pending.v1'])
  const h = harness({ storage }), events = []
  const page = h.page({ onLoad() {}, submit() { events.push('write') } })
  h.launch(); page.onLoad({}); page.onShow(); await tick()
  h.app.onHide(); page.onHide(); h.state.next = () => Promise.resolve(reply('server'))
  h.app.onShow({ scene: 1001 }); page.onShow(); await tick(); page.submit()
  assert.equal(h.state.restarts.length, 1); assert.equal(h.state.restarts[0].path, 'pages/home/home')
  assert.deepEqual(events, []); assert.equal(storage['linkx.backend.authority.v1'], 'server')
  assert.throws(() => h.load('utils/backendClient.js').isBackendEnabled(), error => error.code === 'BACKEND_RESTART_REQUIRED')
  assert.deepEqual(storage['linkx.backend.pending.v1'], originalPending)
  const next = harness({ storage })
  next.launch(); await tick()
  assert.equal(next.load('utils/backendClient.js').isBackendEnabled(), true)
  assert.deepEqual(next.state.cloud, [])
  assert.deepEqual(storage['linkx.backend.pending.v1'], originalPending)
  next.app.onHide()
})

test('unsupported or failed native restart never hot-switches the old page or resumes writes', async () => {
  for (const restart of [false, true]) {
    const h = harness({ restart }), events = []
    const page = h.page({ onLoad() {}, submit() { events.push('write') } })
    h.launch(); page.onLoad({}); page.onShow(); await tick()
    h.app.onHide(); page.onHide(); h.state.next = () => Promise.resolve(reply('server'))
    h.app.onShow({ scene: 1001 }); page.onShow(); await tick()
    if (restart) h.state.restarts[0].fail({})
    page.submit(); page.setData({ late: true })
    assert.deepEqual(events, []); assert.equal(page.data.late, undefined)
    assert.equal(h.load('utils/backendAuthority.js').state().phase, 'restart_required')
  }
})

test('confirmed handoff with failed persistence stops foreground before retry can restart', async () => {
  const h = harness(), events = []
  const page = h.page({ onLoad() {}, submit() { events.push('write') } })
  h.launch(); page.onLoad({}); page.onShow(); await tick()
  assert.equal(h.app._authorityForeground, true)
  const write = h.wx.setStorageSync
  h.wx.setStorageSync = (key, value) => {
    if (key === 'linkx.backend.authority.v1') throw Error('disk full')
    write(key, value)
  }
  h.state.next = () => Promise.resolve(reply('server'))
  const authority = h.load('utils/backendAuthority.js')
  await assert.rejects(authority.refresh(), error => error.code === 'LOCAL_STORAGE_UNAVAILABLE')
  assert.equal(authority.state().phase, 'handoff_blocked')
  assert.equal(h.app._authorityForeground, false); assert.equal(h.app._authorityVisible, false)
  assert.equal(h.state.restarts.length, 0); assert.equal(h.state.loading.at(-1), 'hidden')
  page.submit(); page.setData({ late: true })
  assert.deepEqual(events, []); assert.equal(page.data.late, undefined)
  h.wx.setStorageSync = write
  await assert.rejects(authority.ready(), error => error.code === 'BACKEND_RESTART_REQUIRED')
  assert.equal(h.state.restarts.length, 1)
  page.onUnload(); h.app.onHide()
})
