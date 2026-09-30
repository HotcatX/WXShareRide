const test = require('node:test')
const assert = require('node:assert/strict')
const loadMarket = require('./helpers/market-api.cjs')
const avatar = '11111111-1111-4111-8111-111111111111'
function fixture() {
  const storage = { openid: 'viewer-a', market_seller_profile_cache_v2: { seller: { profile: { wechatID: 'obsolete-private' } } } }
  const calls = [], writes = []
  let pending
  const backend = { isBackendEnabled: () => true,
    async get(url, options) { calls.push({ url, options }); return pending || { userId: 'seller', name: 'Current', avatarFileId: avatar, wechatId: 'current-contact' } },
    async resolveImages(ids) { return ids.map(fileId => ({ fileId, url: `https://cdn.example/${fileId}?read=${calls.length}` })) }
  }
  const wx = { getStorageSync: key => storage[key], setStorageSync: (...args) => writes.push(args),
    cloud: { callFunction() { assert.fail('no legacy seller lookup') }, getTempFileURL() { assert.fail('no cloud URL lookup') } } }
  return { api: loadMarket(wx, backend), backend, calls, writes, storage, pending(value) { pending = value } }
}
test('seller reads ignore obsolete persisted OpenID profiles and refresh signed links', async () => {
  const f = fixture()
  const first = await f.api.getSeller('seller'), next = await f.api.getSeller('seller')
  assert.equal(first.wechatID, 'current-contact')
  assert.notEqual(first.avatarDisplay, next.avatarDisplay)
  assert.equal(f.calls.length, 2)
  assert.equal(f.writes.length, 0, 'private seller data must not return to the old shared cache')
})
test('a late seller profile cannot cross an account change', async () => {
  const f = fixture(); let resolve
  f.pending(new Promise(done => { resolve = done }))
  const request = f.api.getSeller('seller')
  f.storage.openid = 'viewer-b'
  resolve({ userId: 'seller', name: 'Old viewer contact', wechatId: 'private' })
  await assert.rejects(request, { code: 'REQUEST_CANCELLED' })
  assert.equal(f.writes.length, 0)
})
test('large canonical lists use embedded seller projections without per-OpenID queries', async () => {
  const f = fixture()
  f.backend.get = async (url, options) => { f.calls.push({ url, options }); return { items: Array.from({ length: 45 }, (_, i) => ({
    id: `listing-${i}`, listingType: 'goods', images: [], priceCents: 100, seller: { userId: `seller-${i}`, name: `Seller ${i}` }
  })), hasMore: false, nextOffset: 45 } }
  const rows = (await f.api.call({ data: { action: 'list', limit: 50 } })).result.items
  assert.equal(rows.length, 45); assert.equal(rows[44].sellerName, 'Seller 44')
  assert.equal(f.calls.length, 1)
  assert.equal(f.writes.length, 0)
})
test('seller errors are not replaced by stale contacts and a subsequent read can retry', async () => {
  const f = fixture()
  f.pending(Promise.reject(Object.assign(new Error('not visible'), { code: 'SELLER_NOT_FOUND' })))
  await assert.rejects(f.api.getSeller('seller'), { code: 'SELLER_NOT_FOUND' })
  f.pending(null)
  assert.equal((await f.api.getSeller('seller')).name, 'Current')
  assert.equal(f.calls.length, 2)
})
