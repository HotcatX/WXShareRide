const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const componentSource = fs.readFileSync(path.join(root, 'components/timeline-preview/timeline-preview.js'), 'utf8')
const helperSource = fs.readFileSync(path.join(root, 'utils/publicPreview.js'), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const flush = () => new Promise(resolve => setImmediate(resolve))

function item(id, kind = 'goods') {
  return {
    id, kind, title: `公开内容 ${id}`, description: '第一段说明\n第二段说明',
    priceText: '$20', regionText: '纽约', timeText: '周六下午',
    availabilityText: '可联系', images: [], tags: ['公开标签']
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(context = {}, runtime) {
  const requests = []
  let definition
  vm.runInNewContext(componentSource, {
    wx: runtime,
    Component(value) { definition = value },
    require() {
      return { callPublicPreview(args) {
        const request = Object.assign(deferred(), { args: plain(args) })
        requests.push(request)
        return request.promise
      } }
    }
  })
  const instance = {
    properties: { context },
    data: plain(definition.data),
    updates: [],
    setData(patch, callback) {
      this.updates.push(plain(patch))
      Object.assign(this.data, patch)
      if (callback) callback()
    }
  }
  Object.entries(definition.methods).forEach(([name, fn]) => { instance[name] = fn.bind(instance) })
  return {
    instance, requests,
    attach() { definition.lifetimes.attached.call(instance) },
    detach() { definition.lifetimes.detached.call(instance) },
    resize() { definition.pageLifetimes.resize.call(instance) },
    context(value) {
      instance.properties.context = value
      definition.observers.context.call(instance, value)
    }
  }
}

function helper(callFunction, timers = {}) {
  const module = { exports: {} }
  vm.runInNewContext(helperSource, {
    module,
    wx: { cloud: { callFunction } },
    setTimeout: timers.setTimeout || setTimeout,
    clearTimeout: timers.clearTimeout || clearTimeout
  })
  return module.exports.callPublicPreview
}

const select = type => ({ currentTarget: { dataset: { type } } })
const open = key => ({ currentTarget: { dataset: { key } } })

test('only the publicPreview action reaches marketApi; query and unrelated identity fields are excluded', async () => {
  const calls = []
  const call = helper(args => {
    calls.push(plain(args))
    return Promise.resolve({ result: { ok: true, items: [], hasMore: false, nextOffset: 0 } })
  })
  await call({ action: 'marketList', type: 'sublet', sellerId: 'seller', cityKey: 'NY', category: 'room', limit: 10, offset: 0, query: { all: true }, ref: 'secret', openid: 'private' })
  assert.deepEqual(calls, [{
    name: 'marketApi',
    data: { action: 'publicPreview', previewAction: 'marketList', type: 'sublet', offset: 0, limit: 10, cityKey: 'NY', category: 'room', sellerId: 'seller' }
  }])
  await assert.rejects(call({ action: 'delete', id: 'record' }), error => error.code === 'LOAD_FAILED')
  assert.equal(calls.length, 1)
})

test('public response projection strips private and unknown fields and rejects cloud/http image URLs', async () => {
  const record = Object.assign(item('one'), {
    phone: '+1 123 456 7890', wechat: 'private', _openid: 'private',
    location: { latitude: 12, longitude: 34 }, owner: { name: 'private' },
    address: 'private precise address', images: ['https://example.test/photo.jpg', 'cloud://env/file', 'http://example.test/file', 'javascript:alert(1)', 'https://example.test/a b'],
    tags: ['公开标签', { phone: 'private' }]
  })
  const call = helper(() => Promise.resolve({ result: { ok: true, item: record, debug: 'trace', openid: 'private' } }))
  const result = plain(await call({ action: 'marketDetail', id: 'one', type: 'goods' }))
  assert.deepEqual(Object.keys(result).sort(), ['item', 'ok'])
  assert.deepEqual(Object.keys(result.item).sort(), ['availabilityText', 'description', 'id', 'images', 'kind', 'priceText', 'regionText', 'tags', 'timeText', 'title'])
  assert.deepEqual(result.item.images, ['https://example.test/photo.jpg'])
  assert.deepEqual(result.item.tags, ['公开标签'])
  assert.equal(result.item.description, record.description)
  assert.equal(JSON.stringify(result).includes('private'), false)
})

test('friendly errors never forward platform traces, while absent detail is unavailable', async () => {
  const failures = [
    () => Promise.reject(new Error('errCode -501023 requestID trace private')),
    () => { throw new Error('sync private trace') },
    () => Promise.resolve({ result: { ok: false, error: 'private stack trace' } })
  ]
  for (const failure of failures) {
    await assert.rejects(helper(failure)({ action: 'marketDetail', id: 'one' }), error => {
      assert.equal(/private|trace|501023/.test(error.message), false)
      assert.equal(error.code, 'LOAD_FAILED')
      return true
    })
  }
  await assert.rejects(helper(() => Promise.resolve({ result: { ok: true, item: null } }))({ action: 'tripDetail', id: 'gone' }), error => error.code === 'UNAVAILABLE' && !error.retryable)
  for (const code of ['not_found', 'invalid_preview_request']) {
    await assert.rejects(helper(() => Promise.resolve({ result: { ok: false, error: code } }))({ action: 'tripDetail', id: 'gone' }), error => error.code === 'UNAVAILABLE' && !error.retryable)
  }
  await assert.rejects(helper(() => Promise.resolve({ result: { ok: false, error: 'preview_unavailable' } }))({ action: 'tripList' }), error => error.code === 'LOAD_FAILED' && error.retryable)
})

test('a stalled cloud call times out with a retryable message and ignores a late response', async () => {
  const pending = deferred()
  let timeout
  let delay
  let cleared = 0
  const call = helper(() => pending.promise, {
    setTimeout(callback, ms) { timeout = callback; delay = ms; return 1 },
    clearTimeout() { cleared += 1 }
  })
  const result = call({ action: 'tripList' })
  const rejection = assert.rejects(result, error => error.code === 'TIMEOUT' && error.retryable)
  assert.equal(delay, 15000)
  timeout()
  await rejection
  pending.resolve({ result: { ok: true, items: [], hasMore: false, nextOffset: 0 } })
  await flush()
  assert.equal(cleared, 1)
})

test('malformed pagination cannot cause repeated load-more requests at the same offset', async () => {
  const call = helper(() => Promise.resolve({ result: { ok: true, items: [item('one')], hasMore: true, nextOffset: 10 } }))
  const result = await call({ action: 'marketList', offset: 10 })
  assert.equal(result.hasMore, false)
  assert.equal(result.nextOffset, 10)
})

test('empty initial context waits; attached plus observer sends only one initial request', async () => {
  const f = fixture()
  f.context({})
  f.attach()
  assert.equal(f.requests.length, 0)
  const context = { kind: 'market', sellerId: 'seller', type: 'goods', ref: 'ignored' }
  f.context(context)
  f.context(Object.assign({}, context, { ref: 'other ignored value' }))
  assert.equal(f.requests.length, 1)
  assert.equal(f.instance.data.title, '公开商品')
  assert.equal(f.requests[0].args.sellerId, 'seller')
  assert.equal(f.requests[0].args.ref, undefined)
  f.requests[0].resolve({ ok: true, items: [], hasMore: false, nextOffset: 0 })
  await flush()
  assert.equal(f.instance.data.loading, false)
  assert.deepEqual(plain(f.instance.data.items), [])
})

test('a context that arrives before attachment and a later repeated observer load only once', () => {
  const context = { kind: 'trip', type: 'request' }
  const f = fixture(context)
  f.context(context)
  f.attach()
  f.context(context)
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].args.type, 'request')
})

test('info pages remain static and resetting to an empty context invalidates pending requests', async () => {
  const f = fixture({ kind: 'info', title: '个人中心' })
  f.attach()
  f.instance.onRetry()
  f.instance.onLoadMore()
  assert.equal(f.requests.length, 0)
  assert.equal(f.instance.data.mode, 'info')
  f.context({ kind: 'market' })
  f.context({})
  f.requests[0].resolve({ ok: true, items: [item('stale')], hasMore: false, nextOffset: 1 })
  await flush()
  assert.equal(f.instance.data.mode, 'waiting')
  assert.equal(f.instance.data.items.length, 0)
})

test('a shared request id opens its detail directly without requesting a list', async () => {
  const f = fixture({ kind: 'trip', type: 'request', id: 'shared' })
  f.attach()
  assert.deepEqual(f.requests[0].args, { action: 'tripDetail', id: 'shared', type: 'request' })
  f.instance.onRetry()
  assert.equal(f.requests.length, 1)
  f.requests[0].resolve({ ok: true, item: item('shared', 'request') })
  await flush()
  assert.equal(f.instance.data.detail.kindLabel, '乘客求车')
  assert.equal(f.instance.data.fromList, false)
  f.instance.onBackToList()
  assert.equal(f.requests.length, 2)
  assert.equal(f.requests[1].args.action, 'tripList')
  assert.equal(f.requests[1].args.type, 'request')
})

test('late filter results cannot overwrite the currently selected category', async () => {
  const f = fixture({ kind: 'market', type: 'goods' })
  f.attach()
  f.instance.onSelectType(select('sublet'))
  f.instance.onSelectType(select('sublet'))
  assert.equal(f.requests.length, 2)
  f.requests[1].resolve({ ok: true, items: [item('new', 'sublet')], hasMore: false, nextOffset: 1 })
  await flush()
  f.requests[0].resolve({ ok: true, items: [item('old')], hasMore: true, nextOffset: 1 })
  await flush()
  assert.equal(f.instance.data.type, 'sublet')
  assert.deepEqual(plain(f.instance.data.items.map(value => value.id)), ['new'])
  assert.equal(f.instance.data.hasMore, false)
})

test('all-trip cards use their own kind; duplicate taps do not duplicate detail requests, and back restores list scroll', async () => {
  const f = fixture({ kind: 'trip', type: 'all' })
  f.attach()
  f.requests[0].resolve({ ok: true, items: [item('request1', 'request'), item('carpool1', 'carpool')], hasMore: true, nextOffset: 2 })
  await flush()
  f.instance.onScroll({ detail: { scrollTop: 428 } })
  f.instance.onOpenDetail(open('request:request1'))
  f.instance.onOpenDetail(open('request:request1'))
  assert.equal(f.requests.length, 2)
  assert.deepEqual(f.requests[1].args, { action: 'tripDetail', id: 'request1', type: 'request' })
  assert.equal(f.instance.data.scrollTop, 0)
  f.instance.onBackToList()
  assert.equal(f.instance.data.mode, 'list')
  assert.equal(f.instance.data.scrollTop, 428)
  assert.equal(f.requests.length, 2)
  f.requests[1].resolve({ ok: true, item: item('request1', 'request') })
  await flush()
  assert.equal(f.instance.data.detail, null)
  assert.equal(f.instance.data.items.length, 2)
})

test('pagination preserves existing cards on failure and retries the same offset without duplicates', async () => {
  const f = fixture({ kind: 'market' })
  f.attach()
  f.requests[0].resolve({ ok: true, items: [item('one')], hasMore: true, nextOffset: 10 })
  await flush()
  f.instance.onLoadMore()
  f.instance.onLoadMore()
  assert.equal(f.requests.length, 2)
  f.requests[1].reject(new Error('private trace'))
  await flush()
  assert.equal(f.instance.data.items.length, 1)
  assert.equal(f.instance.data.error, null)
  assert.equal(f.instance.data.moreError, true)
  f.instance.onLoadMore()
  assert.equal(f.requests[2].args.offset, 10)
  f.requests[2].resolve({ ok: true, items: [item('one'), item('two')], hasMore: false, nextOffset: 12 })
  await flush()
  assert.deepEqual(plain(f.instance.data.items.map(value => value.id)), ['one', 'two'])
  assert.equal(f.instance.data.moreError, false)
  f.instance.onLoadMore()
  assert.equal(f.requests.length, 3)
})

test('old detail response cannot populate a different context and errors never expose raw text', async () => {
  const f = fixture({ kind: 'market', id: 'old' })
  f.attach()
  f.context({ kind: 'trip', id: 'new', type: 'request' })
  f.requests[0].resolve({ ok: true, item: item('old') })
  f.requests[1].reject(new Error('private requestID 123 stack trace'))
  await flush()
  assert.equal(f.instance.data.detail, null)
  assert.equal(JSON.stringify(f.instance.data.error).includes('private'), false)
  f.instance.onRetry()
  assert.deepEqual(f.requests[2].args, { action: 'tripDetail', id: 'new', type: 'request' })
})

test('unavailable detail has no retry loop and can return to public listings', async () => {
  const f = fixture({ kind: 'market', id: 'gone' })
  f.attach()
  f.requests[0].reject(Object.assign(new Error('gone'), { code: 'UNAVAILABLE' }))
  await flush()
  assert.equal(f.instance.data.error.retryable, false)
  f.instance.onRetry()
  assert.equal(f.requests.length, 1)
  f.instance.onBackToList()
  assert.equal(f.requests[1].args.action, 'marketList')
})

test('detached components ignore both successful and failed in-flight requests', async () => {
  for (const success of [true, false]) {
    const f = fixture({ kind: 'market', id: 'one' })
    f.attach()
    f.detach()
    const updateCount = f.instance.updates.length
    if (success) f.requests[0].resolve({ ok: true, item: item('one') })
    else f.requests[0].reject(new Error('failure'))
    await flush()
    assert.equal(f.instance.updates.length, updateCount)
  }
})

test('a component reattached while an old call is pending cannot accept the old response', async () => {
  const f = fixture({ kind: 'market' })
  f.attach()
  f.detach()
  f.attach()
  assert.equal(f.requests.length, 2)
  f.requests[0].resolve({ ok: true, items: [item('old')], hasMore: false, nextOffset: 1 })
  await flush()
  assert.equal(f.instance.data.items.length, 0)
  assert.equal(f.instance.data.loading, true)
  f.requests[1].resolve({ ok: true, items: [item('new')], hasMore: false, nextOffset: 1 })
  await flush()
  assert.equal(f.instance.data.items[0].id, 'new')
})

test('preview stays within its own scroll view and contains no restricted action APIs', () => {
  const wxml = fs.readFileSync(path.join(root, 'components/timeline-preview/timeline-preview.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(root, 'components/timeline-preview/timeline-preview.wxss'), 'utf8')
  assert.match(wxml, /^<scroll-view/)
  assert.match(wxss, /height:\s*100vh/)
  assert.doesNotMatch(componentSource + helperSource, /wx\.(?:login|navigateTo|redirectTo|reLaunch|switchTab|navigateBack|setClipboardData|makePhoneCall|previewImage|openLocation|getLocation)/)
  assert.doesNotMatch(wxml, /open-type=|<navigator|<app-tabbar/)
  assert.doesNotMatch(helperSource, /getTempFileURL/)
})

test('single-page native title bar gets a measured inset even when safeArea.top is zero', () => {
  const f = fixture({ kind: 'info' }, {
    getWindowInfo: () => ({ screenHeight: 844, windowHeight: 844, screenTop: 0, statusBarHeight: 47, safeArea: { top: 0 } }),
    getMenuButtonBoundingClientRect: () => ({ top: 51, height: 32, bottom: 83 })
  })
  f.attach()
  assert.equal(f.instance.data.topInset, 91)
  assert.equal(f.requests.length, 0)
  const wxml = fs.readFileSync(path.join(root, 'components/timeline-preview/timeline-preview.wxml'), 'utf8')
  assert.match(wxml, /padding-top: calc\(\{\{topInset\}\}px \+ 36rpx\)/)
})

test('native window top is deducted and resize recalculates without requesting cloud data', () => {
  let screenTop = 91
  const f = fixture({ kind: 'info' }, {
    getWindowInfo: () => ({ screenTop, statusBarHeight: 47 }),
    getMenuButtonBoundingClientRect: () => ({ top: 51, height: 32 })
  })
  f.attach()
  assert.equal(f.instance.data.topInset, 0)
  screenTop = 0
  f.resize()
  assert.equal(f.instance.data.topInset, 91)
  assert.equal(f.requests.length, 0)
  f.detach()
  const updates = f.instance.updates.length
  screenTop = 91
  f.resize()
  assert.equal(f.instance.updates.length, updates)
})

test('window API fallback and a taller valid capsule preserve the native title area', () => {
  const f = fixture({ kind: 'info' }, {
    getWindowInfo() { throw new Error('older client') },
    getSystemInfoSync: () => ({ statusBarHeight: 24, screenTop: 0 }),
    getMenuButtonBoundingClientRect: () => ({ top: 32, height: 32 })
  })
  f.attach()
  assert.equal(f.instance.data.topInset, 72)
  const noCapsule = fixture({ kind: 'info' }, {
    getWindowInfo: () => ({ statusBarHeight: 47, screenTop: 0 }),
    getMenuButtonBoundingClientRect() { throw new Error('not available') }
  })
  noCapsule.attach()
  assert.equal(noCapsule.instance.data.topInset, 91)
})
