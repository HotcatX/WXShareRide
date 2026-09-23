const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..')
const PUBLIC_CARPOOL = 'pages/home/tripDetail/tripDetail'
const PUBLIC_REQUEST = 'pages/home/requestDetail/requestDetail'
const PRIVATE_DRIVER = 'pages/profile/myTripDetailDriver/myTripDetailDriver'
const PRIVATE_REQUEST_DRIVER = 'pages/profile/myRequestDetailDriver/myRequestDetailDriver'
const PRIVATE_REQUEST_CREATOR = 'pages/profile/myTripRequestPassenger/myTripRequestPassenger'
const PRIVATE_PASSENGER = 'pages/profile/myTripDetailPassenger/myTripDetailPassenger'
const MARKET_DETAIL = 'pages/market/marketDetail/marketDetail'
const MARKET_SELLER = 'pages/market/marketSeller/marketSeller'
const MARKET_MY = 'pages/market/marketMy/marketMy'
const PRIVATE_SHARE_ROUTES = [PRIVATE_DRIVER, PRIVATE_REQUEST_DRIVER, PRIVATE_REQUEST_CREATOR, PRIVATE_PASSENGER, MARKET_MY]
const CALLBACKS = ['onLoad', 'onShow', 'onReady', 'onPullDownRefresh', 'onReachBottom', 'onHide', 'onUnload', 'onPageScroll', 'onResize', 'onTabItemTap', 'onSaveExitState']

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function makeHarness(scene = 1001, { navigationFails = false } = {}) {
  const navigation = []
  const apiCalls = []
  let launchOptions = { scene }
  const wx = {
    getEnterOptionsSync: () => launchOptions,
    getLaunchOptionsSync: () => launchOptions,
    stopPullDownRefresh: () => apiCalls.push('stopPullDownRefresh'),
    redirectTo(options) {
      navigation.push({ method: 'redirectTo', url: options.url })
      if (navigationFails && options.fail) options.fail({ errMsg: 'redirectTo:fail test' })
      else if (options.success) options.success({})
    },
    cloud: new Proxy({}, { get() { throw new Error('Lifecycle helper must not call cloud APIs') } })
  }
  const sandbox = { module: { exports: {} }, exports: {}, wx, console }
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'utils/timeline.js'), 'utf8'), sandbox, { filename: 'utils/timeline.js' })
  const timeline = sandbox.module.exports
  function updateScene(nextScene) {
    launchOptions = { scene: nextScene }
    timeline.updateLaunchContext(launchOptions)
  }
  updateScene(scene)
  function pageFor(route, initialData = {}) {
    const calls = []
    const config = { data: { existing: 'original', ...initialData } }
    CALLBACKS.forEach(name => {
      config[name] = function (...args) {
        calls.push({ name, receiver: this, args })
        return `result:${name}`
      }
    })
    const returned = timeline.wrapPage(config, {
      getRoute: page => page.route,
      onNormalLoad(page, options) { calls.push({ name: 'onNormalLoad', receiver: page, args: [options] }) }
    })
    assert.equal(returned, config, 'wrapPage must return the original config object')
    const page = { ...config, route, data: plain(config.data), writes: [] }
    page.setData = function (patch, callback) {
      Object.assign(this.data, plain(patch))
      this.writes.push(plain(patch))
      if (callback) callback.call(this)
    }
    return { config, page, calls, names: () => calls.map(call => call.name) }
  }
  return { timeline, updateScene, navigation, apiCalls, pageFor }
}

function targetParts(target) {
  assert.equal(typeof target, 'string')
  const parsed = new URL(target, 'https://miniapp.test')
  return { route: parsed.pathname, query: Object.fromEntries(parsed.searchParams) }
}

const SHARE_FIXTURES = [
  { route: 'pages/home/home', options: { city: 'ny_nj' }, expected: { kind: 'trip', type: 'all', cityKey: 'ny_nj' } },
  { route: 'pages/home/carpoolList/carpoolList', options: { city: 'ny_nj', from: '2', to: '4', time: '1' }, expected: { kind: 'trip', type: 'all', cityKey: 'ny_nj' } },
  { route: PUBLIC_CARPOOL, options: { id: 'carpool_1' }, expected: { kind: 'trip', type: 'carpool', id: 'carpool_1' } },
  { route: PUBLIC_REQUEST, options: { id: 'request_1' }, expected: { kind: 'trip', type: 'request', id: 'request_1' } },
  { route: PRIVATE_DRIVER, options: { id: 'carpool_2' }, expected: { kind: 'trip', type: 'carpool', id: 'carpool_2' } },
  { route: PRIVATE_REQUEST_DRIVER, options: { id: 'request_2' }, expected: { kind: 'trip', type: 'request', id: 'request_2' } },
  { route: PRIVATE_REQUEST_CREATOR, options: { id: 'request_3' }, expected: { kind: 'trip', type: 'request', id: 'request_3' } },
  { route: PRIVATE_PASSENGER, options: { id: 'carpool_3' }, expected: { kind: 'trip', type: 'carpool', id: 'carpool_3' } },
  { route: PRIVATE_PASSENGER, options: { id: 'request_4', sourceType: 'request' }, expected: { kind: 'trip', type: 'request', id: 'request_4' } },
  { route: 'pages/market/market', options: { type: 'sublet', cat: '1B1B', city: 'ny_nj' }, expected: { kind: 'market', type: 'sublet', cityKey: 'ny_nj', category: '1B1B' } },
  { route: MARKET_DETAIL, options: { id: 'goods_1' }, expected: { kind: 'market', type: 'goods', id: 'goods_1' } },
  { route: MARKET_SELLER, options: { openid: 'seller_1', type: 'sublet' }, expected: { kind: 'market', type: 'sublet', sellerId: 'seller_1', title: '公开商品' } },
  { route: MARKET_MY, options: { openid: 'publisher_1', type: 'goods' }, expected: { kind: 'market', type: 'goods', sellerId: 'publisher_1', title: '公开商品' } }
]

test('all twelve existing Moments source pages retain their public query context', () => {
  const { timeline } = makeHarness(1154)
  assert.equal(new Set(SHARE_FIXTURES.map(fixture => fixture.route)).size, 12)
  for (const fixture of SHARE_FIXTURES) {
    assert.deepEqual(plain(timeline.getPreviewContext(fixture.route, fixture.options)), fixture.expected, fixture.route)
    assert.deepEqual(plain(timeline.getPreviewContext(`/${fixture.route}`, fixture.options)), fixture.expected, `leading slash: ${fixture.route}`)
  }
})

test('remaining fourteen registered pages expose an information fallback', () => {
  const { timeline } = makeHarness(1154)
  const routes = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')).pages
  const publicRoutes = new Set(SHARE_FIXTURES.map(fixture => fixture.route))
  const fallbackRoutes = routes.filter(route => !publicRoutes.has(route))
  assert.equal(fallbackRoutes.length, 14)
  for (const route of fallbackRoutes) {
    const context = timeline.getPreviewContext(route, { id: 'private_record', openid: 'viewer_id', mode: 'edit', url: 'https://example.test/private', type: 'sold' })
    assert.equal(context.kind, 'info', route)
    assert.equal(context.id, undefined, route)
    assert.equal(context.sellerId, undefined, route)
    assert.equal(timeline.getFullPageTarget(route, { id: 'private_record' }), '', route)
  }
})

test('route aliases and ID precedence agree with existing onLoad handlers', () => {
  const { timeline } = makeHarness(1154)
  const fixtures = [
    [PUBLIC_CARPOOL, { id: 'correct', tripId: 'other' }, 'correct'],
    [PUBLIC_CARPOOL, { tripId: 'correct' }, 'correct'],
    [PUBLIC_REQUEST, { id: 'correct', requestId: 'other' }, 'correct'],
    [PRIVATE_DRIVER, { tripId: 'correct', id: 'other' }, 'correct'],
    [PRIVATE_REQUEST_DRIVER, { requestId: 'correct', id: 'other' }, 'correct'],
    ...['requestID', 'tripId', 'tripID', '_id'].map(key => [PRIVATE_REQUEST_DRIVER, { [key]: 'correct' }, 'correct']),
    ...['requestId', 'id', 'tripId', 'tripid'].map(key => [PRIVATE_REQUEST_CREATOR, { [key]: 'correct' }, 'correct']),
    [PRIVATE_PASSENGER, { tripId: 'correct', id: 'other', sourceType: 'request' }, 'correct'],
    [PRIVATE_PASSENGER, { tripId: 'correct', requestId: 'other', sourceType: 'request' }, 'correct']
  ]
  for (const [route, options, expected] of fixtures) {
    assert.equal(timeline.getPreviewContext(route, options).id, expected, `${route} ${JSON.stringify(options)}`)
  }
})

test('passenger sourceType defaults to carpool and accepts historical type aliases', () => {
  const { timeline } = makeHarness(1154)
  for (const options of [{}, { sourceType: 'carpool' }, { sourceType: 'invalid' }]) {
    assert.equal(timeline.getPreviewContext(PRIVATE_PASSENGER, { id: 'trip_1', ...options }).type, 'carpool')
  }
  for (const field of ['sourceType', 'type', 'from']) {
    assert.equal(timeline.getPreviewContext(PRIVATE_PASSENGER, { id: 'trip_1', [field]: 'REQUEST' }).type, 'request')
  }
  assert.equal(timeline.getPreviewContext(PRIVATE_PASSENGER, { id: 'trip_1', sourceType: 'carpool', type: 'request' }).type, 'carpool')
  assert.equal(timeline.getPreviewContext(MARKET_SELLER, { openid: 'seller_1', listingType: 'SUBLET' }).type, 'sublet')
  assert.equal(timeline.getPreviewContext(MARKET_SELLER, { openid: 'seller_1', type: 'unexpected' }).type, 'goods')
})

test('missing or malformed shared IDs use fallback without copying private fields', () => {
  const { timeline } = makeHarness(1154)
  for (const route of [PUBLIC_CARPOOL, PUBLIC_REQUEST, PRIVATE_DRIVER, PRIVATE_REQUEST_DRIVER, PRIVATE_REQUEST_CREATOR, PRIVATE_PASSENGER, MARKET_DETAIL, MARKET_SELLER, MARKET_MY]) {
    for (const value of [undefined, '', '../record', { private: true }, 'record&mode=edit']) {
      const context = timeline.getPreviewContext(route, { id: value, openid: value, phone: 'private-phone', wechatID: 'private-contact', passengerID: ['private_member'] })
      assert.equal(context.kind, 'info', `${route}: ${String(value)}`)
      assert.equal(context.phone, undefined)
      assert.equal(context.wechatID, undefined)
      assert.equal(context.passengerID, undefined)
    }
  }
})

test('private sharing targets public detail/seller pages and retains referral aliases', () => {
  const { timeline } = makeHarness()
  const referrals = { ref: 'code-one', referralCode: 'code_two', invite: 'invite 3', inviter: 'invite-four' }
  const fixtures = [
    [PRIVATE_DRIVER, { tripId: 'trip_1' }, `/${PUBLIC_CARPOOL}`, { id: 'trip_1' }],
    [PRIVATE_REQUEST_DRIVER, { requestId: 'req_1' }, `/${PUBLIC_REQUEST}`, { id: 'req_1' }],
    [PRIVATE_REQUEST_CREATOR, { id: 'req_2' }, `/${PUBLIC_REQUEST}`, { id: 'req_2' }],
    [PRIVATE_PASSENGER, { id: 'req_3', sourceType: 'request' }, `/${PUBLIC_REQUEST}`, { id: 'req_3' }],
    [PRIVATE_PASSENGER, { id: 'trip_2' }, `/${PUBLIC_CARPOOL}`, { id: 'trip_2' }],
    [MARKET_MY, { openid: 'publisher_1', type: 'sublet' }, `/${MARKET_SELLER}`, { openid: 'publisher_1', type: 'sublet' }]
  ]
  for (const [route, options, expectedRoute, expectedQuery] of fixtures) {
    const target = targetParts(timeline.getFullPageTarget(route, { ...options, ...referrals, timelineShare: '1', mode: 'edit', phone: 'private' }))
    assert.equal(target.route, expectedRoute)
    assert.deepEqual(target.query, { ...expectedQuery, ...referrals })
  }
  assert.equal(timeline.getFullPageTarget(PUBLIC_CARPOOL, { id: 'trip_1' }), '')
})

test('App context selects preview; page query scene cannot enable or disable it', () => {
  const normal = makeHarness(1001)
  const normalPage = normal.pageFor(PUBLIC_CARPOOL)
  normalPage.page.onLoad({ id: 'trip_1', scene: '1154' })
  assert.equal(normal.timeline.isTimelinePreview(), false)
  assert.deepEqual(normalPage.names(), ['onNormalLoad', 'onLoad'])
  const preview = makeHarness(1154)
  const previewPage = preview.pageFor(PUBLIC_CARPOOL)
  previewPage.page.onLoad({ id: 'trip_1', scene: '1001' })
  assert.equal(preview.timeline.isTimelinePreview(), true)
  assert.deepEqual(previewPage.names(), [])
  preview.updateScene('1001')
  assert.equal(preview.timeline.isTimelinePreview(), false)
})

test('registration gates original UI and preview never calls normal lifecycle hooks', () => {
  const harness = makeHarness(1154)
  const { config, page, names } = harness.pageFor(PRIVATE_DRIVER)
  assert.equal(config.data.isTimelinePreview, true)
  assert.equal(config.data.timelinePageReady, false)
  assert.equal(config.data.existing, 'original')
  page.onLoad({ id: 'trip_1', ref: 'ref_1' })
  for (const name of CALLBACKS.filter(name => name !== 'onLoad')) page[name]({ sentinel: name })
  assert.deepEqual(names(), [])
  assert.equal(page.data.timelinePageReady, true)
  assert.deepEqual(page.data.timelineContext, { kind: 'trip', type: 'carpool', id: 'trip_1' })
  assert.deepEqual(harness.navigation, [])
  assert.deepEqual(harness.apiCalls, ['stopPullDownRefresh'])
})

test('normal mode preserves callback arguments, receivers, results, data and referral input', () => {
  const harness = makeHarness(1001)
  const { config, page, calls, names } = harness.pageFor(PUBLIC_CARPOOL)
  assert.equal(config.data.isTimelinePreview, false)
  assert.equal(config.data.timelinePageReady, false)
  const options = { id: 'trip_1', ref: 'source_ref', custom: 'keep_original' }
  assert.equal(page.onLoad(options), 'result:onLoad')
  for (const name of CALLBACKS.filter(name => name !== 'onLoad')) {
    assert.equal(page[name]('payload', 42), `result:${name}`, name)
  }
  assert.deepEqual(names(), ['onNormalLoad', ...CALLBACKS])
  assert.ok(calls.every(call => call.receiver === page))
  assert.deepEqual(plain(calls[0].args[0]), options)
  assert.deepEqual(plain(calls[1].args[0]), options)
  assert.deepEqual(calls.find(call => call.name === 'onShow').args, ['payload', 42])
  assert.equal(page.data.timelinePageReady, true)
  assert.equal(page.data.isTimelinePreview, false)
  assert.deepEqual(harness.navigation, [])
})

test('preview-to-full restores public initialization once and replays deferred ready', () => {
  const harness = makeHarness(1154)
  const { page, calls, names } = harness.pageFor(MARKET_DETAIL)
  const originalOptions = { id: 'goods_1', ref: 'ref_1', timelineShare: '1' }
  page.onLoad(originalOptions)
  page.onShow()
  page.onReady()
  harness.updateScene(1001)
  page.onShow('restored')
  assert.deepEqual(names(), ['onNormalLoad', 'onLoad', 'onShow', 'onReady'])
  assert.deepEqual(plain(calls[1].args[0]), originalOptions)
  assert.equal(page.data.isTimelinePreview, false)
  assert.equal(page.data.timelineContext, null)
  page.onShow('again')
  assert.deepEqual(names(), ['onNormalLoad', 'onLoad', 'onShow', 'onReady', 'onShow'])
})

test('preview-to-full before ready allows the subsequent normal ready callback', () => {
  const harness = makeHarness(1154)
  const { page, names } = harness.pageFor(PUBLIC_REQUEST)
  page.onLoad({ id: 'request_1' })
  harness.updateScene(1001)
  page.onShow()
  page.onReady()
  assert.deepEqual(names(), ['onNormalLoad', 'onLoad', 'onShow', 'onReady'])
})

test('normal private-page navigation remains private when not entered from a share', () => {
  const harness = makeHarness(1001)
  const { page, names } = harness.pageFor(MARKET_MY)
  page.onLoad({ type: 'goods' })
  page.onShow()
  assert.deepEqual(names(), ['onNormalLoad', 'onLoad', 'onShow'])
  assert.deepEqual(harness.navigation, [])
})

test('flagged full-mode shares redirect before running private callbacks', () => {
  for (const route of PRIVATE_SHARE_ROUTES) {
    const harness = makeHarness(1001)
    const { page, names } = harness.pageFor(route)
    const options = route === MARKET_MY ? { openid: 'publisher_1', type: 'sublet' } : { id: 'trip_1' }
    page.onLoad({ ...options, timelineShare: '1', ref: 'source_ref' })
    page.onShow()
    page.onReady()
    page.onPullDownRefresh()
    assert.deepEqual(names(), [], route)
    assert.equal(harness.navigation.length, 1, route)
    assert.equal(targetParts(harness.navigation[0].url).query.ref, 'source_ref')
    assert.equal(page.data.timelinePageReady, false, 'original UI stays hidden while redirecting')
  }
})

test('old unmarked private Moments shares redirect on same-instance mode transition', () => {
  for (const route of PRIVATE_SHARE_ROUTES) {
    const harness = makeHarness(1154)
    const { page, names } = harness.pageFor(route)
    const options = route === MARKET_MY ? { openid: 'publisher_1' } : { id: 'trip_1' }
    page.onLoad({ ...options, ref: 'old_ref' })
    page.onReady()
    harness.updateScene(1001)
    page.onShow()
    page.onShow()
    assert.deepEqual(names(), [], route)
    assert.equal(harness.navigation.length, 1, route)
    assert.equal(targetParts(harness.navigation[0].url).query.ref, 'old_ref')
  }
})

test('invalid private shares never fall through to the viewer management page', () => {
  for (const scene of [1001, 1154]) {
    for (const route of PRIVATE_SHARE_ROUTES) {
      const harness = makeHarness(scene)
      const { page, names } = harness.pageFor(route)
      page.onLoad({ timelineShare: '1', ref: 'ref_1' })
      if (scene === 1154) harness.updateScene(1001)
      page.onShow()
      page.onReady()
      assert.deepEqual(names(), [], `${scene}: ${route}`)
      assert.equal(page.data.timelineContext?.kind, 'info', `${scene}: ${route}`)
      assert.equal(page.data.isTimelinePreview, true)
      assert.deepEqual(harness.navigation, [])
    }
  }
})

test('failed public redirection stays on an information fallback without private requests', () => {
  const harness = makeHarness(1001, { navigationFails: true })
  const { page, names } = harness.pageFor(MARKET_MY)
  page.onLoad({ openid: 'publisher_1', timelineShare: '1' })
  page.onShow()
  page.onReady()
  page.onReachBottom()
  assert.deepEqual(names(), [])
  assert.equal(page.data.timelineContext.kind, 'info')
  assert.equal(page.data.isTimelinePreview, true)
  assert.equal(page.data.timelinePageReady, true)
  assert.equal(harness.navigation.length, 1)
})

function makeAppHarness(scene = 1001) {
  const cloudCalls = []
  const cloudInit = []
  const storageWrites = []
  const storage = new Map()
  const pageConfigs = []
  const modules = new Map()
  let app
  let launchOptions = { scene }
  const wx = {
    getEnterOptionsSync: () => launchOptions,
    getLaunchOptionsSync: () => launchOptions,
    getStorageSync: key => storage.get(key) || '',
    setStorageSync(key, value) { storage.set(key, value); storageWrites.push({ key, value }) },
    removeStorageSync(key) { storage.delete(key); storageWrites.push({ key, removed: true }) },
    stopPullDownRefresh() {},
    redirectTo() {},
    cloud: {
      init(config) { cloudInit.push(plain(config)) },
      callFunction(config) {
        cloudCalls.push(plain(config))
        return Promise.resolve({ result: { ok: true, referralCode: 'generated_code' } })
      }
    }
  }
  const context = vm.createContext({
    wx, console, setTimeout, clearTimeout,
    Page(config) { pageConfigs.push(config) },
    App(config) { app = config },
    getApp: () => app,
    getCurrentPages: () => []
  })
  function load(file) {
    let resolved = path.resolve(ROOT, file)
    if (!path.extname(resolved)) resolved += '.js'
    assert.ok(resolved.startsWith(`${ROOT}${path.sep}`), 'test imports stay within the project')
    if (modules.has(resolved)) return modules.get(resolved).exports
    const module = { exports: {} }
    modules.set(resolved, module)
    const code = fs.readFileSync(resolved, 'utf8')
    const wrapper = vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename: resolved })
    wrapper(request => {
      assert.ok(request.startsWith('.'), 'test imports must be local')
      return load(path.resolve(path.dirname(resolved), request))
    }, module, module.exports)
    return module.exports
  }
  load('app.js')
  function register(config = {}, route = PUBLIC_CARPOOL) {
    context.Page(config)
    const saved = pageConfigs[pageConfigs.length - 1]
    const page = { ...saved, route, data: plain(saved.data) }
    page.setData = function (patch, callback) {
      Object.assign(this.data, plain(patch))
      if (callback) callback.call(this)
    }
    return page
  }
  return {
    app, register, cloudCalls, cloudInit, storageWrites, storage,
    timeline: load('utils/timeline.js'), referral: load('utils/referral.js'),
    enter(options, event = 'onLaunch') { launchOptions = options; return app[event](options) }
  }
}

test('App and referral hooks perform no referral requests or storage writes in preview', async () => {
  const harness = makeAppHarness(1154)
  harness.storage.set('openid', 'viewer_1')
  harness.storage.set('my_referral_code', 'viewer_ref')
  harness.storage.set('pending_referral', { referralCode: 'old_pending_ref' })
  harness.enter({ scene: 1154, path: PUBLIC_CARPOOL, query: { id: 'trip_1', ref: 'shared_ref' } })
  harness.enter({ scene: 1154, path: PUBLIC_CARPOOL, query: { ref: 'shared_ref' } }, 'onShow')
  const page = harness.register({ onLoad() { throw new Error('Original onLoad must be isolated') } })
  page.onLoad({ id: 'trip_1', ref: 'shared_ref' })
  page.onShow()
  harness.referral.captureReferral({ query: { ref: 'shared_ref' } }, 'directPreviewCall')
  await harness.referral.ensureReferralCode()
  await harness.referral.bindPendingReferral()
  harness.referral.withReferralShare({ title: 'Preview', query: 'id=trip_1' })
  assert.deepEqual(harness.cloudCalls, [])
  assert.deepEqual(harness.storageWrites, [])
  assert.equal(harness.cloudInit.length, 1)
  assert.equal(harness.cloudInit[0].traceUser, false)
})

test('normal share integration keeps original metadata and one timeline marker, without altering friend shares', () => {
  const harness = makeAppHarness()
  harness.storage.set('my_referral_code', 'viewer_ref')
  harness.enter({ scene: 1001 })
  const friendShare = { title: 'Friend title', path: `/${PUBLIC_CARPOOL}?id=trip_1&ref=viewer_ref` }
  const page = harness.register({
    onShareTimeline() { return { title: 'Original title', imageUrl: '/images/share_ride.png', query: 'id=trip_1&ref=viewer_ref&timelineShare=0' } },
    onShareAppMessage() { return friendShare }
  })
  page.onLoad({ id: 'trip_1' })
  const share = page.onShareTimeline()
  const query = new URLSearchParams(share.query)
  assert.equal(share.title, 'Original title')
  assert.equal(share.imageUrl, '/images/share_ride.png')
  assert.equal(query.get('id'), 'trip_1')
  assert.equal(query.get('ref'), 'viewer_ref')
  assert.deepEqual(query.getAll('timelineShare'), ['1'])
  assert.equal(page.onShareAppMessage(), friendShare)
  const defaultPage = harness.register({}, PUBLIC_REQUEST)
  defaultPage.onLoad({ id: 'request_1', ref: 'incoming_ref' })
  const defaultQuery = new URLSearchParams(defaultPage.onShareTimeline().query)
  assert.equal(defaultQuery.get('id'), 'request_1')
  assert.deepEqual(defaultQuery.getAll('ref'), ['viewer_ref'])
  assert.deepEqual(defaultQuery.getAll('timelineShare'), ['1'])
})

test('preview shares do not invoke the original callback with private page state', () => {
  const harness = makeAppHarness(1154)
  harness.enter({ scene: 1154 })
  const page = harness.register({
    data: { phone: 'private-contact' },
    onShareTimeline() { throw new Error('Preview must not call a normal-mode share callback') }
  }, PRIVATE_DRIVER)
  page.onLoad({ id: 'trip_1' })
  const share = page.onShareTimeline()
  assert.equal(new URLSearchParams(share.query).get('id'), 'trip_1')
  assert.equal(JSON.stringify(share).includes('private-contact'), false)
  assert.deepEqual(harness.cloudCalls, [])
})

test('App scene transition restores page referral attribution from original preview options', async () => {
  const harness = makeAppHarness(1154)
  const originalLoads = []
  harness.enter({ scene: 1154, query: { id: 'trip_1', ref: 'original_ref' } })
  const page = harness.register({ onLoad(options) { originalLoads.push(plain(options)) } })
  page.onLoad({ id: 'trip_1', ref: 'original_ref', scene: '1154' })
  page.onReady()
  harness.enter({ scene: 1001 }, 'onShow')
  page.onShow()
  await Promise.resolve()
  assert.equal(harness.timeline.isTimelinePreview(), false)
  assert.deepEqual(originalLoads, [{ id: 'trip_1', ref: 'original_ref', scene: '1154' }])
  const visit = harness.cloudCalls.find(call => call.name === 'referralApi' && call.data.action === 'trackVisit')
  assert.equal(visit?.data.referralCode, 'original_ref')
  assert.equal(visit?.data.path, PUBLIC_CARPOOL)
  assert.equal(visit?.data.query.id, 'trip_1')
})

test('every registered page declares the preview and gates the entire original WXML branch', () => {
  const appConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
  assert.equal(appConfig.usingComponents['timeline-preview'], '/components/timeline-preview/timeline-preview')
  for (const route of appConfig.pages) {
    const wxml = fs.readFileSync(path.join(ROOT, `${route}.wxml`), 'utf8').trim()
    assert.match(wxml, /^<timeline-preview\b[^>]*wx:if="\{\{isTimelinePreview\}\}"[^>]*\/>\s*<block wx:elif="\{\{timelinePageReady\}\}">/, route)
    assert.ok(wxml.endsWith('</block>'), route)
  }
})
