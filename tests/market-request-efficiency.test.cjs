const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const filename = path.resolve(__dirname, '../pages/market/market.js')
const source = fs.readFileSync(filename, 'utf8')
const localRequire = createRequire(filename)
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const item = id => ({ _id: id, title: id, listingType: 'goods', status: 'online', category: '家具', managedByAdmin: true, sellerName: 'Seller' })
const result = items => ({ result: { ok: true, items, hasMore: false, nextSkip: items.length } })

function fixture() {
  const calls = [], errors = [], fileCalls = [], timers = []
  const storage = new Map()
  let now = 1800000000000, definition, stopped = 0
  class Clock extends Date { static now() { return now } }
  const wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    stopPullDownRefresh: () => { stopped++ },
    cloud: {
      callFunction(request) { const wait = deferred(); calls.push({ request: plain(request), ...wait }); return wait.promise },
      getTempFileURL(request) { const wait = deferred(); fileCalls.push({ request: plain(request), ...wait }); return wait.promise }
    }
  }
  vm.runInNewContext(source, {
    Page: value => { definition = value }, wx, Date: Clock,
    console: { error() {}, warn() {} },
    setTimeout(fn) { timers.push(fn) },
    require(name) {
      if (name === '../../utils/error') return { showDataError: (...args) => errors.push(args) }
      if (name === '../../utils/marketSellerProfileCache') return {
        readMarketSellerProfiles: () => ({}), fetchAndCacheMarketSellerProfiles: async () => ({})
      }
      return localRequire(name)
    }
  })
  const page = { ...definition, data: plain(definition.data) }
  page.setData = function (patch, callback) { Object.assign(this.data, plain(patch)); if (callback) callback.call(this) }
  page._marketBootstrapped = true
  page._marketViewerKey = 'guest'
  page._thumbUrlCache = {}
  page._sellerProfileCache = {}
  return { page, calls, fileCalls, errors, storage, timers, advance: ms => { now += ms }, stopped: () => stopped }
}

test('forced concurrent refreshes share a request; an empty success is reused on ordinary return for 30 seconds', async () => {
  const f = fixture(), { page, calls } = f
  const first = page._fetchFirstPage({ force: true })
  const duplicate = page._fetchFirstPage({ force: true })
  assert.equal(first, duplicate)
  await tick(); assert.equal(calls.length, 1)
  calls[0].resolve(result([])); await first
  assert.equal(page.data.showEmpty, true)
  await page.onShow(); f.advance(29999); await page.onShow()
  assert.equal(calls.length, 1)
  f.advance(1); const refresh = page.onShow(); await tick()
  assert.equal(calls.length, 2)
  calls[1].resolve(result([item('fresh')])); await refresh
  assert.equal(page.data.allGoods[0].id, 'fresh')
  assert.equal(page.data.isLoadingGoods, false)
})

test('manual refresh bypasses the 30-second result cache and retains loading cleanup', async () => {
  const f = fixture(), { page, calls } = f
  const first = page._fetchFirstPage(); await tick(); calls[0].resolve(result([])); await first
  page._loadMarketAds = async () => {}
  page.onPullDownRefresh(); await tick()
  assert.equal(calls.length, 2)
  calls[1].resolve(result([item('published')])); await tick()
  assert.equal(page.data.allGoods[0].id, 'published')
  assert.equal(page.data.isLoadingGoods, false)
  assert.equal(f.stopped(), 1)
})

test('older filter responses cannot overwrite the current filter or clear its loading flag', async () => {
  const f = fixture(), { page, calls } = f
  const old = page._fetchFirstPage({ force: true }); await tick()
  page.data.keyword = 'new'; page._resetGoodsStateForFetch()
  const next = page._fetchFirstPage({ force: true }); await tick()
  calls[0].resolve(result([item('old')])); await old
  assert.equal(page.data.allGoods.length, 0)
  assert.equal(page.data.isLoadingGoods, true)
  calls[1].resolve(result([item('new')])); await next
  assert.equal(page.data.allGoods[0].id, 'new')
  assert.equal(page.data.isLoadingGoods, false)
})

test('switching A to B to A joins the pending A transport but applies only the latest selection', async () => {
  const f = fixture(), { page, calls } = f
  const a = page._fetchFirstPage({ force: true }); await tick()
  page.data.keyword = 'B'; const b = page._fetchFirstPage({ force: true }); await tick()
  page.data.keyword = ''; const again = page._fetchFirstPage({ force: true }); await tick()
  assert.equal(calls.length, 2)
  calls[0].resolve(result([item('A')])); await Promise.all([a, again])
  assert.equal(page.data.allGoods[0].id, 'A')
  calls[1].resolve(result([item('B')])); await b
  assert.equal(page.data.allGoods[0].id, 'A')
  assert.equal(page.data.isLoadingGoods, false)
})

test('a product mutation or viewer change requires a fresh request and cannot reuse an older in-flight response', async () => {
  for (const [key, value] of [['market_goods_changed_at', 1800000000001], ['openid', 'new-viewer']]) {
    const f = fixture(), { page, calls } = f
    const first = page._fetchFirstPage({ force: true }); await tick()
    f.storage.set(key, value)
    const second = page._fetchFirstPage({ force: true }); await tick()
    assert.equal(calls.length, 2)
    calls[0].resolve(result([item('before')])); await first
    assert.equal(page.data.allGoods.length, 0)
    calls[1].resolve(result([item('after')])); await second
    assert.equal(page.data.allGoods[0].id, 'after')
  }
})

test('onShow detects login change even within the ordinary cache interval', async () => {
  const f = fixture(), { page, calls } = f
  const first = page._fetchFirstPage(); await tick(); calls[0].resolve(result([])); await first
  f.storage.set('openid', 'logged-in')
  const showing = page.onShow(); await tick()
  assert.equal(calls[1].request.name, 'getUserInfo')
  calls[1].resolve({ result: { data: [{}] } }); await tick()
  assert.equal(calls[2].request.data.action, 'list')
  calls[2].resolve(result([])); await showing
})

test('failed refresh does not poison the cache, retry is allowed immediately', async () => {
  const f = fixture(), { page, calls } = f
  const first = page._fetchFirstPage(); await tick(); calls[0].reject(new Error('network')); await first
  assert.equal(page.data.isLoadingGoods, false)
  const retry = page._fetchFirstPage(); await tick(); assert.equal(calls.length, 2)
  calls[1].resolve(result([])); await retry
  assert.equal(f.errors.length, 1)
})

test('rendering listings does not schedule unseen detail or sibling-category requests', async () => {
  const f = fixture(), { page, calls } = f
  const request = page._fetchFirstPage({ force: true }); await tick()
  calls[0].resolve(result([item('one'), item('two'), item('three')])); await request; await tick()
  assert.equal(calls.length, 1)
  assert.equal(f.timers.length, 0)
  assert.equal(page.data.allGoods.length, 3)
})

test('empty list snapshots restore correctly instead of causing a false cache miss', async () => {
  const f = fixture(), { page, calls } = f
  const request = page._fetchFirstPage(); await tick(); calls[0].resolve(result([])); await request
  page.data.allGoods = [item('old')]
  const state = page._restoreGoodsFromCache()
  assert.equal(state.restored, true)
  assert.equal(page.data.allGoods.length, 0)
  assert.equal(page.data.cloudHasMore, false)
})

test('overlapping thumbnail resolutions share file requests and can retry after failure', async () => {
  const f = fixture(), { page, fileCalls } = f
  const rows = [{ thumbFileID: 'cloud://a' }]
  const a = page._fillThumbUrlsFor(rows), b = page._fillThumbUrlsFor(rows)
  await tick(); assert.equal(fileCalls.length, 1)
  fileCalls[0].reject(new Error('image service unavailable')); await Promise.all([a, b])
  const retry = page._fillThumbUrlsFor(rows); await tick(); assert.equal(fileCalls.length, 2)
  fileCalls[1].resolve({ fileList: [{ fileID: 'cloud://a', tempFileURL: 'https://cdn.example/a' }] }); await retry
  await page._fillThumbUrlsFor(rows); assert.equal(fileCalls.length, 2)
})

test('an older next-page response cannot append after a first-page refresh or clear its loading state', async () => {
  const f = fixture(), { page, calls } = f
  page.data.cloudHasMore = true
  page.data.cloudSkip = 8
  const next = page._fetchNextPage(); await tick()
  assert.equal(calls[0].request.data.skip, 8)
  const refresh = page._fetchFirstPage({ force: true }); await tick()
  calls[0].resolve(result([item('old-page')])); await next
  assert.equal(page.data.allGoods.length, 0)
  assert.equal(page.data.isLoadingGoods, true)
  calls[1].resolve(result([item('new-first')])); await refresh
  assert.equal(page.data.allGoods[0].id, 'new-first')
  assert.equal(page.data.isLoadingGoods, false)
})

test('location lookups share in-flight work and short cache, while edited profile data invalidates it', async () => {
  const f = fixture(), { page, calls } = f
  f.storage.set('openid', 'viewer')
  const first = page._loadMyLocationFromProfile(), duplicate = page._loadMyLocationFromProfile()
  await tick(); assert.equal(calls.length, 1)
  calls[0].resolve({ result: { data: [{ location: { lat: 40, lng: -73 } }] } }); await Promise.all([first, duplicate])
  await page._loadMyLocationFromProfile(); assert.equal(calls.length, 1)
  f.storage.set('userInfo', { location: { lat: 41, lng: -73 } })
  const edited = page._loadMyLocationFromProfile(); await tick(); assert.equal(calls.length, 2)
  calls[1].resolve({ result: { data: [{ location: { lat: 41, lng: -73 } }] } }); await edited
  assert.equal(page.data.myLocation.lat, 41)
  f.advance(30000)
  const expired = page._loadMyLocationFromProfile(); await tick(); assert.equal(calls.length, 3)
  calls[2].resolve({ result: { data: [{ location: { lat: 41, lng: -73 } }] } }); await expired
})

test('failure during a forced refresh clears prior success freshness so ordinary return retries immediately', async () => {
  const f = fixture(), { page, calls } = f
  const initial = page._fetchFirstPage(); await tick(); calls[0].resolve(result([])); await initial
  const forced = page._fetchFirstPage({ force: true }); await tick()
  calls[1].reject(new Error('network')); await forced
  const retry = page.onShow(); await tick(); assert.equal(calls.length, 3)
  calls[2].resolve(result([])); await retry
})

test('a late profile response from before a location edit cannot overwrite the edited location or its cache', async () => {
  const f = fixture(), { page, calls } = f
  f.storage.set('openid', 'viewer')
  f.storage.set('userInfo', { location: { lat: 40, lng: -73 } })
  const old = page._loadMyLocationFromProfile(); await tick()
  f.storage.set('userInfo', { location: { lat: 41, lng: -73 } })
  const edited = page._loadMyLocationFromProfile(); await tick()
  calls[1].resolve({ result: { data: [{ location: { lat: 41, lng: -73 } }] } }); await edited
  calls[0].resolve({ result: { data: [{ location: { lat: 40, lng: -73 } }] } }); await old
  assert.equal(page.data.myLocation.lat, 41)
  await page._loadMyLocationFromProfile()
  assert.equal(page.data.myLocation.lat, 41)
  assert.equal(calls.length, 2)
})
