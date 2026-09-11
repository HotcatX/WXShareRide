const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const filename = path.resolve(__dirname, '../utils/marketSellerProfileCache.js')
const source = fs.readFileSync(filename, 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture() {
  const storage = new Map(), calls = [], images = []
  let now = 1800000000000
  class Clock extends Date { static now() { return now } }
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, Date: Clock,
    wx: {
      getStorageSync: key => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, plain(value)),
      cloud: {
        callFunction(request) { const wait = deferred(); calls.push({ request: plain(request), ...wait }); return wait.promise },
        async getTempFileURL(request) {
          images.push(plain(request))
          return { fileList: request.fileList.map(fileID => ({ fileID, tempFileURL: 'https://cdn.example/avatar' })) }
        }
      }
    },
    require: () => ({ buildProfileDisplayLocation: () => '', buildProfileApartmentDisplay: () => '' })
  })
  const resolve = (call, avatar = '') => call.resolve({ result: { ok: true, data: call.request.data.openids.map(openid => ({ _openid: openid, name: openid, avatarUrl: avatar })) } })
  return { api: module.exports, calls, images, storage, resolve, advance: ms => { now += ms } }
}

test('fresh seller data and resolved avatars are reused; expired data refreshes', async () => {
  const f = fixture()
  const first = f.api.fetchAndCacheMarketSellerProfiles(['seller']); await tick()
  f.resolve(f.calls[0], 'cloud://avatar'); await first
  const cached = await f.api.fetchAndCacheMarketSellerProfiles(['seller'])
  assert.equal(cached.seller.avatarDisplay, 'https://cdn.example/avatar')
  assert.equal(f.calls.length, 1); assert.equal(f.images.length, 1)
  f.advance(10 * 60 * 1000 + 1)
  const refresh = f.api.fetchAndCacheMarketSellerProfiles(['seller']); await tick()
  assert.equal(f.calls.length, 2); f.resolve(f.calls[1]); await refresh
})

test('overlapping callers share each seller lookup even with force requested', async () => {
  const f = fixture()
  const first = f.api.fetchAndCacheMarketSellerProfiles(['a', 'b'])
  const second = f.api.fetchAndCacheMarketSellerProfiles(['b', 'c'], { force: true })
  await tick()
  assert.deepEqual(f.calls.map(call => call.request.data.openids), [['a', 'b'], ['c']])
  f.calls.forEach(call => f.resolve(call))
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(Object.keys(a).sort(), ['a', 'b'])
  assert.deepEqual(Object.keys(b).sort(), ['b', 'c'])
})

test('large requests respect the 20-user cloud limit rather than caching truncated users as absent', async () => {
  const f = fixture(), ids = Array.from({ length: 45 }, (_, i) => 'seller-' + i)
  const request = f.api.fetchAndCacheMarketSellerProfiles(ids); await tick()
  assert.deepEqual(f.calls.map(call => call.request.data.openids.length), [20, 20, 5])
  f.calls.forEach(call => f.resolve(call))
  const profiles = await request
  assert.equal(Object.keys(profiles).length, 45)
  assert.equal(profiles['seller-44'].name, 'seller-44')
})

test('empty successful results are cached, but service errors are not cached as empty profiles', async () => {
  const f = fixture()
  const missing = f.api.fetchAndCacheMarketSellerProfiles(['gone']); await tick()
  f.calls[0].resolve({ result: { ok: true, data: [] } }); await missing
  await f.api.fetchAndCacheMarketSellerProfiles(['gone']); assert.equal(f.calls.length, 1)
  const failure = f.api.fetchAndCacheMarketSellerProfiles(['retry']); await tick()
  const rejection = assert.rejects(failure, /denied/)
  f.calls[1].resolve({ result: { ok: false, errorMsg: 'denied' } }); await rejection
  assert.equal(f.api.readMarketSellerProfile('retry'), null)
  const retry = f.api.fetchAndCacheMarketSellerProfiles(['retry']); await tick()
  assert.equal(f.calls.length, 3); f.resolve(f.calls[2]); await retry
})
