const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const base = path.join(__dirname, '../pages/market/marketTrade/marketTrade')
const source = fs.readFileSync(base + '.js', 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))

function harness(respond = () => ({ items: [], hasMore: false, nextOffset: 0 })) {
  const calls = [], errors = [], navigation = [], clipboard = [], toasts = []
  let stopped = 0, definition
  const unexpected = () => { throw new Error('Trade history must not access administrator storage or upload APIs') }
  const wx = {
    getWindowInfo: () => ({ statusBarHeight: 24 }),
    getStorageSync: key => key === 'openid' ? 'synthetic-seller' : '', setStorageSync: unexpected, removeStorageSync: unexpected,
    chooseMedia: unexpected, compressImage: unexpected, chooseLocation: unexpected,
    cloud: { uploadFile: unexpected, callFunction: unexpected },
    navigateTo: options => navigation.push(plain(options)),
    navigateBack: options => navigation.push(plain(options)),
    stopPullDownRefresh: () => { stopped++ },
    showToast: options => toasts.push(plain(options)),
    setClipboardData(options) { clipboard.push(options.data); options.success() }
  }
  const backend = { isBackendEnabled: () => true,
    async get(url, options) { const request = { url, options }; calls.push(plain(request)); return respond(request, calls.length) },
    resolveImages: async ids => ids.map(fileId => ({ fileId, url: `https://images.example/${fileId}` }))
  }
  vm.runInNewContext(source, {
    Page(value) { definition = value }, wx,
    console: { error() {} },
    require(name) {
      if (name.endsWith("/compat/market")) return require("./helpers/market-api.cjs")(wx, backend)
      assert.equal(name, '../../../utils/error', 'Admin-only region and upload dependencies must be absent')
      return { showDataError: (...args) => errors.push(args) }
    }
  })
  const page = { ...definition, data: plain(definition.data) }
  page.setData = patch => Object.assign(page.data, plain(patch))
  return { page, calls, errors, navigation, clipboard, toasts, stopped: () => stopped }
}

test('sold history uses only the current account route; unsupported bought history performs no I/O', async () => {
  for (const requestedType of ['bought', 'sold', 'unrecognized']) {
    const { page, calls, errors } = harness()
    page.onLoad({ type: requestedType }); await tick()
    const bought = requestedType === 'bought'
    assert.equal(calls.length, bought ? 0 : 1)
    if (!bought) {
      assert.equal(new URL(calls[0].url, 'https://example.test').pathname, '/api/v1/me/market/listings')
      assert.equal(new URL(calls[0].url, 'https://example.test').searchParams.get('status'), 'sold')
    }
    assert.equal(errors.length, bought ? 1 : 0)
    assert.equal(page.data.statusBarHeight, 24)
    assert.equal(page.data.listEmpty, true)
  }
})

test('sold pagination retains goods and sublet formatting without inventing buyer identity or contact', async () => {
  const image = '11111111-1111-4111-8111-111111111111'
  const goods = Array.from({ length: 50 }, (_, index) => ({ id: 'goods-' + index, title: ' Desk ', priceCents: 1250,
    listingType: 'goods', status: 'sold', condition: '九成新', images: [{ fileId: image }] }))
  const { page, calls } = harness((request, number) => number === 1
    ? { items: goods, hasMore: true, nextOffset: 50 }
    : { items: [{ id: 'sublet', listingType: 'sublet', title: '', priceCents: 150000, category: '1B1B', images: [] }], hasMore: false })
  await page.init()
  assert.deepEqual(calls.map(call => new URL(call.url, 'https://example.test').searchParams.get('offset')), ['0', '50'])
  assert.equal(page.data.list.length, 51)
  assert.equal(page.data.list[0].title, 'Desk')
  assert.equal(page.data.list[0].priceDisplay, '12.50')
  assert.equal(page.data.list[0].contactWechat, '')
  assert.equal(page.data.list[0].otherOpenid, '')
  assert.equal(page.data.list[0].imageSrc, `https://images.example/${image}`)
  assert.equal(page.data.list[50].title, '未命名房源')
  assert.equal(page.data.list[50].priceDisplay, '1500/月')
  assert.equal(page.data.list[50].metaText, '1B1B')
})

test('existing detail, back and copy interactions remain independent of retired buy-history transport', () => {
  const { page, navigation, clipboard, toasts } = harness()
  page.onOpenDetail({ currentTarget: { dataset: { id: 'listing' } } })
  page.onOpenDetail({ currentTarget: { dataset: {} } })
  page.onBack()
  assert.deepEqual(navigation, [{ url: '/pages/market/marketDetail/marketDetail?id=listing' }, { delta: 1 }])
  page.onCopyWechat({ currentTarget: { dataset: { wx: 'contact-from-current-view' } } })
  page.onCopyWechat({ currentTarget: { dataset: {} } })
  assert.deepEqual(clipboard, ['contact-from-current-view'])
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
