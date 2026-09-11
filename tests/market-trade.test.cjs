const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const base = path.join(__dirname, '../pages/market/marketTrade/marketTrade')
const source = fs.readFileSync(base + '.js', 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))

function harness(respond = () => ({ ok: true, items: [] })) {
  const calls = [], errors = [], navigation = [], clipboard = [], toasts = []
  let stopped = 0, definition
  const unexpected = () => { throw new Error('Trade history must not access administrator storage or upload APIs') }
  const wx = {
    getWindowInfo: () => ({ statusBarHeight: 24 }),
    getStorageSync: unexpected, setStorageSync: unexpected, removeStorageSync: unexpected,
    chooseMedia: unexpected, compressImage: unexpected, chooseLocation: unexpected,
    cloud: {
      uploadFile: unexpected,
      async callFunction(request) {
        calls.push(plain(request))
        return { result: await respond(request, calls.length) }
      }
    },
    navigateTo: options => navigation.push(plain(options)),
    navigateBack: options => navigation.push(plain(options)),
    stopPullDownRefresh: () => { stopped++ },
    showToast: options => toasts.push(plain(options)),
    setClipboardData(options) { clipboard.push(options.data); options.success() }
  }
  vm.runInNewContext(source, {
    Page(value) { definition = value }, wx,
    console: { error() {} },
    require(name) {
      assert.equal(name, '../../../utils/error', 'Admin-only region and upload dependencies must be absent')
      return { showDataError: (...args) => errors.push(args) }
    }
  })
  const page = { ...definition, data: plain(definition.data) }
  page.setData = patch => Object.assign(page.data, plain(patch))
  return { page, calls, errors, navigation, clipboard, toasts, stopped: () => stopped }
}

test('opening bought or sold history only loads tradeList and never restores administrator access', async () => {
  for (const requestedType of ['bought', 'sold', 'unrecognized']) {
    const { page, calls, errors } = harness()
    page.onLoad({ type: requestedType })
    await tick()
    const type = requestedType === 'bought' ? 'bought' : 'sold'
    assert.deepEqual(calls, [{ name: 'marketApi', data: { action: 'tradeList', type, skip: 0, limit: 50 } }])
    assert.equal(page.data.type, type)
    assert.equal(page.data.pageTitle, type === 'bought' ? '我买到的' : '我卖出的')
    assert.equal(page.data.contactRoleText, type === 'bought' ? '卖家微信' : '买家微信')
    assert.equal(page.data.statusBarHeight, 24)
    assert.equal(page.data.listEmpty, true)
    assert.equal(errors.length, 0)
  }
})

test('trade pagination retains goods and sublet formatting and counterpart contact information', async () => {
  const goods = Array.from({ length: 50 }, (_, index) => ({
    _id: 'goods-' + index, title: ' Desk ', price: 12.5, condition: '九成新',
    thumbFileID: 'cloud://trade/thumb.jpg', buyerOpenid: 'buyer', contactWechat: 'buyer-wechat'
  }))
  const { page, calls } = harness((request, number) => number === 1
    ? { ok: true, items: goods, openid: 'seller', hasMore: true, nextSkip: 50 }
    : { ok: true, data: [{ _id: 'sublet', listingType: 'sublet', price: 1500, roomType: '1B1B', contactWechat: 'tenant' }], hasMore: false })
  await page.init()
  assert.deepEqual(calls.map(call => call.data.skip), [0, 50])
  assert.equal(page.data.myOpenid, 'seller')
  assert.equal(page.data.list.length, 51)
  assert.equal(page.data.listCountText, '51 条记录')
  assert.equal(page.data.listEmpty, false)
  assert.equal(page.data.list[0].title, 'Desk')
  assert.equal(page.data.list[0].priceDisplay, '12.50')
  assert.equal(page.data.list[0].contactWechat, 'buyer-wechat')
  assert.equal(page.data.list[0].otherOpenid, 'buyer')
  assert.equal(page.data.list[0].imageSrc, 'cloud://trade/thumb.jpg')
  assert.equal(page.data.list[50].title, '未命名房源')
  assert.equal(page.data.list[50].priceDisplay, '1500/月')
  assert.equal(page.data.list[50].metaText, '1B1B')
  assert.equal(page.data.list[50].hasImage, false)
})

test('bought records keep seller identity and existing detail, back and copy interactions', async () => {
  const { page, navigation, clipboard, toasts } = harness(() => ({
    ok: true, items: [{ _id: 'bought-1', title: 'Lamp', _openid: 'seller', contactWechat: 'seller-wechat' }]
  }))
  page.data.type = 'bought'
  await page.init()
  assert.equal(page.data.list[0].otherOpenid, 'seller')
  page.onOpenDetail({ currentTarget: { dataset: { id: 'bought-1' } } })
  page.onOpenDetail({ currentTarget: { dataset: {} } })
  page.onBack()
  assert.deepEqual(navigation, [{ url: '/pages/market/marketDetail/marketDetail?id=bought-1' }, { delta: 1 }])
  page.onCopyWechat({ currentTarget: { dataset: { wx: 'seller-wechat' } } })
  page.onCopyWechat({ currentTarget: { dataset: {} } })
  assert.deepEqual(clipboard, ['seller-wechat'])
  assert.deepEqual(toasts.map(item => item.title), ['已复制微信号', '对方未填写微信号'])
})

test('failed pull refresh preserves existing records, reports the failure and stops the refresher', async () => {
  const { page, errors, stopped } = harness(() => { throw new Error('offline') })
  page.data.list = [{ id: 'existing', title: 'Existing' }]
  page.onPullDownRefresh()
  await tick()
  assert.equal(page.data.list[0].id, 'existing')
  assert.equal(errors.length, 1)
  assert.equal(errors[0][0], '交易加载失败')
  assert.equal(stopped(), 1)
})

test('page markup exposes normal trade actions with no hidden admin gesture, form or session remnants', () => {
  const { page } = harness()
  const wxml = fs.readFileSync(base + '.wxml', 'utf8')
  const wxss = fs.readFileSync(base + '.wxss', 'utf8')
  const handlers = [...wxml.matchAll(/(?:bind|catch)(?::)?(?:tap|input|change|confirm|longpress)="([^"]+)"/g)].map(match => match[1])
  assert.deepEqual([...new Set(handlers)].sort(), ['onBack', 'onCopyWechat', 'onOpenDetail'])
  for (const handler of handlers) assert.equal(typeof page[handler], 'function')
  assert.doesNotMatch(source + wxml + wxss, /admin|onHidden|bulk|处理码|批量代发|chooseMedia|uploadFile/i)
  assert.doesNotMatch(Object.keys(page.data).join(' '), /admin|password|draft/i)
  assert.match(wxml, /timeline-preview/)
  assert.match(wxml, /暂无记录/)
  assert.equal(JSON.parse(fs.readFileSync(base + '.json', 'utf8')).enablePullDownRefresh, true)
})
