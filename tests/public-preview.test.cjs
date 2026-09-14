const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const previewModule = require('../cloudfunctions/marketApi/publicPreview')

const NOW = Date.parse('2026-09-09T16:00:00Z')
const ENV = 'cloud1-preview-test'
const IMAGE = `cloud://${ENV}.bucket-123/market/item.jpg`
const HTTPS_IMAGE = 'https://bucket-123.tcb.qcloud.la/market/item.jpg?sign=server-signature'
const ITEM_KEYS = ['id', 'kind', 'title', 'description', 'priceText', 'regionText', 'timeText', 'availabilityText', 'images', 'tags'].sort()

function matches(row, condition) {
  if (!condition) return true
  if (condition.$and) return condition.$and.every(part => matches(row, part))
  if (condition.$or) return condition.$or.some(part => matches(row, part))
  return Object.entries(condition).every(([key, value]) => {
    const keys = key.split('.')
    const first = row[keys[0]]
    const values = keys.length === 1 ? [first] : (Array.isArray(first) ? first : [first]).map(part => part && part[keys[1]])
    return values.some(actual => {
      if (value && value.$in) return value.$in.includes(actual)
      if (value && Object.hasOwn(value, '$exists')) return (actual !== undefined) === value.$exists
      if (value && Object.hasOwn(value, '$gt')) return actual !== undefined && actual !== null && actual > value.$gt
      if (value && Object.hasOwn(value, '$gte')) return actual !== undefined && actual !== null && actual >= value.$gte
      if (value && Object.hasOwn(value, '$lte')) return actual !== undefined && actual !== null && actual <= value.$lte
      return actual === value
    })
  })
}

// The handler runs its real where/field/order/skip/limit operations against this
// in-memory database; every read and mutation is observable to the assertions.
function fixture(data = {}, options = {}) {
  const calls = { collections: [], reads: [], writes: [], images: [], functions: [] }
  const db = {
    command: {
      in: values => ({ $in: values }), and: parts => ({ $and: parts }), or: parts => ({ $or: parts }),
      gt: value => ({ $gt: value }), gte: value => ({ $gte: value }), lte: value => ({ $lte: value }), exists: value => ({ $exists: value })
    },
    serverDate: () => new Date(NOW),
    collection(name) {
      calls.collections.push(name)
      const mutation = operation => async payload => {
        calls.writes.push({ name, operation, payload })
        if (options.allowWrites) return { stats: { updated: 1, removed: 1 }, _id: 'created-item' }
        throw new Error('Unexpected database mutation')
      }
      const query = {
        condition: null, projection: null, ordering: [], offset: 0, count: 100,
        where(value) { this.condition = value; return this },
        field(value) { this.projection = value; return this },
        orderBy(key, direction) { this.ordering.push([key, direction]); return this },
        skip(value) { this.offset = value; return this },
        limit(value) { this.count = value; return this },
        async get() {
          calls.reads.push({ name, condition: this.condition, projection: this.projection, offset: this.offset, limit: this.count })
          if (options.failRead) throw new Error('private backend connection secret')
          let rows = (data[name] || []).filter(row => matches(row, this.condition)).slice()
          rows.sort((a, b) => {
            for (const [key, direction] of this.ordering) {
              if (a[key] < b[key]) return direction === 'asc' ? -1 : 1
              if (a[key] > b[key]) return direction === 'asc' ? 1 : -1
            }
            return 0
          })
          rows = rows.slice(this.offset, this.offset + this.count)
          return { data: rows.map(row => this.projection
            ? Object.fromEntries(Object.entries(row).filter(([key]) => this.projection[key]))
            : { ...row }) }
        },
        doc(id) {
          return {
            async get() {
              calls.reads.push({ name, id })
              const row = (data[name] || []).find(row => row._id === id)
              return { data: row ? { ...row } : null }
            },
            update: mutation('update'), remove: mutation('remove'), set: mutation('set')
          }
        },
        add: mutation('add'), update: mutation('update'), remove: mutation('remove')
      }
      return query
    }
  }
  const context = { OPENID: options.openid || '', ENV }
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'dynamic', init() {}, database: () => db, getWXContext: () => context,
    async getTempFileURL(args) {
      calls.images.push(args)
      if (options.imageResult) return options.imageResult(args)
      return { fileList: args.fileList.map(fileID => ({ fileID, status: 0, tempFileURL: HTTPS_IMAGE })) }
    },
    async callFunction(args) { calls.functions.push(args); throw new Error('Unexpected function delegation') }
  }
  return { db, cloud, calls, context, preview: previewModule.createPublicPreviewHandler({ db, cloud, now: () => NOW }) }
}

function entry(f) {
  const exports = {}
  const filename = path.resolve(__dirname, '../cloudfunctions/marketApi/index.js')
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    exports, require(name) {
      if (name === 'wx-server-sdk') return f.cloud
      if (name === './publicPreview') return previewModule
      if (name === 'crypto') return require('node:crypto')
      throw new Error(`Unexpected import: ${name}`)
    }, console, Date, Intl, Set, Map, Buffer, process
  }, { filename })
  return exports.main
}

function goods(overrides = {}) {
  return {
    _id: 'goods-1', _openid: 'seller-private-001', listingType: 'goods', status: 'online',
    title: '实木书桌', desc: '结实的实木书桌，桌面有轻微划痕，适合书房。', price: 35,
    category: '家具', condition: '9成新', regionState: 'NY_NJ', cityKey: 'ny_nj',
    pickupStartDate: '2026-09-10', pickupEndDate: '2026-09-20', expireTime: NOW + 86400000,
    createTime: NOW - 1000, ...overrides
  }
}
function trip(overrides = {}) {
  return {
    _id: 'trip-1', status: 'open', cityKey: 'ny_nj', availSeatNum: 2, referencePrice: 25,
    departures: [{ address: '123 Example St, Fort Lee, NJ, Apt 7', date: '2026-09-10', time: '12:00', latitude: 40.12345 }],
    destinations: [{ address: '456 Private Ave, Manhattan, NY', date: '2026-09-10', time: '14:00' }],
    latestDepartureAtMs: NOW + 86400000, createdAt: NOW, ...overrides
  }
}
function assertPublicItem(item) {
  assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS)
  assert.ok(['goods', 'sublet', 'carpool', 'request'].includes(item.kind))
  assert.ok(item.images.every(url => url.startsWith('https://')))
  assert.ok(item.tags.every(tag => typeof tag === 'string'))
}

test('actual marketApi entry rejects every old action anonymously before any database work', async () => {
  const f = fixture()
  const main = entry(f)
  const source = fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/marketApi/index.js'), 'utf8')
  const actions = [...source.matchAll(/if \(action === "([^"]+)"\)/g)].map(match => match[1]).filter(action => action !== 'publicPreview')
  assert.ok(actions.includes('list') && actions.includes('publicConfig') && actions.includes('create') && actions.includes('delete'))
  for (const action of [...new Set(actions), 'unknown', '']) {
    const result = await main({ action, openid: 'forged', OPENID: 'forged', sellerOpenid: 'forged', token: 'forged', isGuest: false, id: 'goods-1', patch: { status: 'sold' } })
    assert.equal(result.ok, false, action)
    assert.equal(result.error, 'not_logged_in', action)
  }
  for (const invalidContextId of [null, {}, true, '   ']) {
    f.context.OPENID = invalidContextId
    assert.equal((await main({ action: 'list', openid: 'forged' })).error, 'not_logged_in')
  }
  assert.deepEqual(f.calls, { collections: [], reads: [], writes: [], images: [], functions: [] })
})

test('actual entry allows anonymous publicPreview only and dispatches previewAction independently', async () => {
  const f = fixture({ market_goods: [goods({ expireTime: Date.now() + 86400000 })] })
  const main = entry(f)
  const result = await main({ action: 'publicPreview', previewAction: 'marketList' })
  assert.equal(result.ok, true)
  assert.equal(result.items.length, 1)
  assertPublicItem(result.items[0])
  const before = f.calls.reads.length
  assert.equal((await main({ action: 'publicPreview', previewAction: 'delete', id: 'goods-1' })).error, 'invalid_preview_request')
  assert.equal(f.calls.reads.length, before)
  assert.equal(f.calls.writes.length, 0)
})

test('logged-in old list/config and ownership/admin checks keep their behavior', async () => {
  const f = fixture({ market_goods: [goods()], cityTree: [{ _id: 'default', cities: ['ny_nj'] }] }, { openid: 'signed-in-user' })
  const main = entry(f)
  const list = await main({ action: 'list', fastList: true })
  assert.equal(list.ok, true)
  assert.equal(list.items[0]._id, 'goods-1')
  assert.equal(list.limit, 20)
  const config = await main({ action: 'publicConfig', collection: 'cityTree' })
  assert.equal(config.ok, true)
  assert.equal(config.docs.cityTree.cities[0], 'ny_nj')
  assert.equal((await main({ action: 'create', payload: {} })).error, 'missing_required_fields')
  for (const action of ['update', 'delete']) {
    assert.equal((await main({ action, id: 'goods-1', openid: 'seller-private-001', patch: { status: 'sold' } })).error, 'forbidden')
  }
  for (const action of ['adminBulkCreate', 'adminListTemplates', 'adminSaveTemplate', 'adminDeleteTemplate']) {
    assert.equal((await main({ action })).error, 'unknown_action', action)
  }
  assert.equal(f.calls.writes.length, 0)
})

test('the trusted original owner can still update with the old field allowlist', async () => {
  const f = fixture({ market_goods: [goods()] }, { openid: 'seller-private-001', allowWrites: true })
  const main = entry(f)
  const result = await main({ action: 'update', id: 'goods-1', patch: { title: '新标题', _openid: 'takeover', viewCount: 999 } })
  assert.equal(result.ok, true)
  assert.equal(result.updated, 1)
  assert.equal(f.calls.writes.length, 1)
  assert.equal(f.calls.writes[0].name, 'market_goods')
  assert.equal(f.calls.writes[0].payload.data.title, '新标题')
  assert.equal(f.calls.writes[0].payload.data._openid, undefined)
  assert.equal(f.calls.writes[0].payload.data.viewCount, undefined)
})

test('public market detail preserves description but redacts known contacts and precise addresses', async () => {
  const doc = goods({
    sellerWechat: 'secretwx_123', sellerPhone: '+1 (201) 555-0199', sellerName: 'Private Seller',
    Apartment: 'SecretTower 8F', location: { address: '884 Private Road', latitude: 40.99991, longitude: -74.99991 },
    sellerNote: 'seller-only-note', buyerOpenid: 'buyer-private', managedByOpenid: 'admin-private',
    deposit: 500, bankAccount: 'private-bank', viewCount: 987,
    desc: '结实的实木书桌，桌面有轻微划痕，适合书房。\nsecretwx_123；+1 (201) 555-0199；user@example.com\nSecretTower 8F；884 Private Road；Private Seller\n微信：another_account\n地址：123 Other Street\n尺寸 120 x 60 cm，9月20日前可取。'
  })
  const f = fixture({ market_goods: [doc] })
  const result = await f.preview({ previewAction: 'marketDetail', id: doc._id, trackView: true, quick: false })
  assert.equal(result.ok, true)
  assertPublicItem(result.item)
  assert.match(result.item.description, /结实的实木书桌/)
  assert.match(result.item.description, /尺寸 120 x 60 cm/)
  const serialized = JSON.stringify(result)
  for (const secret of ['secretwx_123', '201', 'user@example.com', 'SecretTower', '884 Private', 'Private Seller', 'another_account', '123 Other', 'seller-private', 'buyer-private', 'admin-private', 'private-bank', 'seller-only-note', '40.99991', 'latitude', 'viewCount', 'bankAccount', 'deposit']) assert.ok(!serialized.includes(secret), secret)
  assert.equal(f.calls.writes.length, 0)
  assert.equal(f.calls.functions.length, 0)
  assert.deepEqual([...new Set(f.calls.collections)], ['market_goods'])
})

test('market lists and details both hide offline/sold/expired/deleted and unknown types', async () => {
  const rows = [goods(), goods({ _id: 'sublet', listingType: 'sublet', price: 1200 }),
    goods({ _id: 'offline', status: 'offline' }), goods({ _id: 'sold', status: 'sold' }),
    goods({ _id: 'expired', expireTime: NOW }), goods({ _id: 'deleted', deleted: true }),
    goods({ _id: 'missing-expiry', expireTime: 0, pickupEndDate: '' }), goods({ _id: 'unknown', listingType: 'private' })]
  const f = fixture({ market_goods: rows })
  const result = await f.preview({ previewAction: 'marketList', type: 'all', status: 'sold', includeExpired: true, filters: { status: 'offline' } })
  assert.deepEqual(result.items.map(item => item.id).sort(), ['goods-1', 'sublet'])
  for (const id of ['offline', 'sold', 'expired', 'deleted', 'missing-expiry', 'unknown']) {
    assert.deepEqual(await f.preview({ previewAction: 'marketDetail', id }), { ok: false, error: 'not_found' })
  }
  const sublet = await f.preview({ previewAction: 'marketDetail', id: 'sublet', type: 'goods' })
  assert.equal(sublet.item.kind, 'sublet')
  assert.equal(sublet.item.priceText, '$1200/月')
})

test('seller/category/city scope follows original owner semantics including managed listings', async () => {
  const f = fixture({ market_goods: [
    goods({ _id: 'seller-own', _openid: 'seller-A', managedByAdmin: true }),
    goods({ _id: 'managed-elsewhere', _openid: 'admin-B', managedByOpenid: 'seller-A', managedByAdmin: true }),
    goods({ _id: 'other-category', _openid: 'seller-A', category: '电子' }),
    goods({ _id: 'other-city', _openid: 'seller-A', cityKey: 'la', regionState: 'CA' }),
    goods({ _id: 'offline-own', _openid: 'seller-A', status: 'offline' })
  ] })
  const result = await f.preview({ previewAction: 'marketList', sellerId: 'seller-A', category: '家具', cityKey: 'NY_NJ' })
  assert.deepEqual(result.items.map(item => item.id), ['seller-own'])
  assert.equal(f.calls.reads[0].condition.$and[0]._openid, 'seller-A')
  assert.ok(!JSON.stringify(result).includes('seller-A'))
})

test('carpool and request previews expose coarse route, safe capacity and no member/contact/point details', async () => {
  const f = fixture({
    Carpool: [trip({ passengers: [{ openid: 'passenger-secret' }], driverOpenid: 'driver-secret', phone: '2015551234', note: 'private route note' }), trip({ _id: 'full', status: 'full' })],
    CarpoolRequest: [trip({ _id: 'request-1', requestPassengerCount: 3, referencePrice: 0, passengerID: 'requester-secret', remark: 'meet apt 18' })]
  })
  const result = await f.preview({ previewAction: 'tripList', type: 'all', cityKey: 'ny_nj' })
  assert.equal(result.items.length, 3)
  result.items.forEach(assertPublicItem)
  assert.equal(result.items.find(item => item.id === 'full').availabilityText, '已满员')
  assert.equal(result.items[0].regionText, 'Fort Lee → 曼哈顿')
  const detail = await f.preview({ previewAction: 'tripDetail', type: 'request', id: 'request-1' })
  assert.equal(detail.item.kind, 'request')
  assert.equal(detail.item.availabilityText, '需 3 座')
  assert.equal(detail.item.priceText, '$0')
  const serialized = JSON.stringify([result, detail])
  for (const secret of ['123 Example', '456 Private', 'Apt 7', 'passenger-secret', 'driver-secret', '2015551234', 'private route note', 'requester-secret', 'apt 18', '40.12345', 'latitude', 'passengers']) assert.ok(!serialized.includes(secret), secret)
  assert.deepEqual([...new Set(f.calls.collections)].sort(), ['Carpool', 'CarpoolRequest'])
  assert.equal(f.calls.writes.length, 0)
  assert.equal(f.calls.functions.length, 0)
})

test('trip list and detail exclude cancelled, ended, invalid dates and past departures', async () => {
  const rows = [trip(), trip({ _id: 'past', latestDepartureAtMs: NOW - 1 }), trip({ _id: 'cancelled', status: 'cancelled' }),
    trip({ _id: 'ended', endedAt: NOW - 1 }), trip({ _id: 'completed', status: 'completed' }),
    trip({ _id: 'undated', latestDepartureAtMs: 0, departures: [] }),
    trip({ _id: 'date-fallback', latestDepartureAtMs: 0 }), trip({ _id: 'full', status: 'full' })]
  const f = fixture({ Carpool: rows, CarpoolRequest: rows })
  for (const type of ['carpool', 'request']) {
    const result = await f.preview({ previewAction: 'tripList', type })
    assert.deepEqual(result.items.map(item => item.id).sort(), ['date-fallback', 'full', 'trip-1'])
    for (const id of ['past', 'cancelled', 'ended', 'completed', 'undated']) {
      assert.deepEqual(await f.preview({ previewAction: 'tripDetail', type, id }), { ok: false, error: 'not_found' })
    }
  }
})

test('image resolver sees only current-environment public market image IDs and returns safe HTTPS', async () => {
  const valid2 = IMAGE.replace('item.jpg', 'second.webp')
  const valid3 = IMAGE.replace('item.jpg', 'third.jpg')
  const f = fixture({ market_goods: [goods({ imageFileID: IMAGE, imageFileIDs: [valid2, valid3,
    IMAGE.replace(ENV, 'foreign-env'), `cloud://${ENV}.bucket-123/user/private.jpg`,
    `cloud://${ENV}.bucket-123/market/../secret.jpg`, `cloud://${ENV}.bucket-123/market/%2e%2e/secret.jpg`, 'https://example.com/raw.jpg'] })] }, {
    imageResult: args => ({ fileList: args.fileList.map((fileID, i) => ({ fileID, status: 0, tempFileURL: i === 0 ? HTTPS_IMAGE : i === 1 ? 'http://bucket.tcb.qcloud.la/second.webp' : 'https://evil.example.com/third.jpg' })) })
  })
  const detail = await f.preview({ previewAction: 'marketDetail', id: 'goods-1' })
  assert.deepEqual(f.calls.images[0].fileList, [IMAGE, valid2, valid3])
  assert.deepEqual(detail.item.images, [HTTPS_IMAGE])
  assert.ok(!JSON.stringify(detail).includes('cloud://'))
  const list = await f.preview({ previewAction: 'marketList' })
  assert.deepEqual(list.items[0].images, [HTTPS_IMAGE])
  assert.equal(f.calls.images[1].fileList.length, 1)
})

test('image failures remain readable and hidden records never trigger image resolution', async () => {
  const f = fixture({ market_goods: [goods({ imageFileID: IMAGE }), goods({ _id: 'hidden', status: 'offline', imageFileID: IMAGE })] }, {
    imageResult() { throw new Error('private-storage-error') }
  })
  const result = await f.preview({ previewAction: 'marketDetail', id: 'goods-1' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.item.images, [])
  const imageCalls = f.calls.images.length
  assert.equal((await f.preview({ previewAction: 'marketDetail', id: 'hidden' })).error, 'not_found')
  assert.equal(f.calls.images.length, imageCalls)
})

test('list scans, returned pages and total results are bounded with stable offsets', async () => {
  const f = fixture({ market_goods: Array.from({ length: 220 }, (_, i) => goods({ _id: `item-${String(i).padStart(3, '0')}`, createTime: NOW - i })) })
  const first = await f.preview({ previewAction: 'marketList', limit: 999999 })
  assert.equal(first.items.length, 20)
  assert.equal(first.nextOffset, 20)
  assert.equal(first.hasMore, true)
  assert.deepEqual(f.calls.reads.map(read => [read.offset, read.limit]), [[0, 100], [100, 50]])
  const second = await f.preview({ previewAction: 'marketList', offset: first.nextOffset })
  assert.equal(second.items[0].id, 'item-020')
  const last = await f.preview({ previewAction: 'marketList', offset: 90 })
  assert.equal(last.items.length, 10)
  assert.equal(last.hasMore, false)
  assert.equal(last.nextOffset, 100)
  assert.equal((await f.preview({ previewAction: 'marketList', offset: 100 })).error, 'invalid_preview_request')
})

test('database visibility and city filters prevent stale/other-city rows from hiding a valid later result', async () => {
  const stale = Array.from({ length: 160 }, (_, i) => goods({ _id: `stale-${i}`, expireTime: NOW - 1, createTime: NOW + i }))
  const otherCity = Array.from({ length: 160 }, (_, i) => goods({ _id: `other-${i}`, cityKey: 'la', regionState: 'CA', createTime: NOW + i }))
  const f = fixture({ market_goods: [...stale, ...otherCity, goods()] })
  const result = await f.preview({ previewAction: 'marketList', cityKey: 'ny_nj' })
  assert.deepEqual(result.items.map(item => item.id), ['goods-1'])
  const tripRows = [
    ...Array.from({ length: 160 }, (_, i) => trip({ _id: `past-${i}`, latestDepartureAtMs: NOW - 1, createdAt: NOW + i })),
    ...Array.from({ length: 160 }, (_, i) => trip({ _id: `other-${i}`, cityKey: 'la', createdAt: NOW + i })), trip()
  ]
  const trips = fixture({ Carpool: tripRows, CarpoolRequest: tripRows })
  const tripResult = await trips.preview({ previewAction: 'tripList', cityKey: 'ny_nj', type: 'all' })
  assert.equal(tripResult.items.length, 2)
  assert.ok(tripResult.items.every(item => item.id === 'trip-1'))
})

test('invalid requests cannot choose collections, bypass filters or leak backend errors', async () => {
  const f = fixture()
  for (const request of [null, [], { previewAction: 'create' }, { previewAction: 'marketList', sellerId: { $ne: null } },
    { previewAction: 'marketList', offset: -1 }, { previewAction: 'marketList', limit: {} },
    { previewAction: 'marketList', cityKey: '0' }, { previewAction: 'marketList', category: {} },
    { previewAction: 'tripDetail', id: 'trip-1' }, { previewAction: 'marketDetail', id: '../private' }]) {
    assert.equal((await f.preview(request)).error, 'invalid_preview_request')
  }
  assert.equal(f.calls.reads.length, 0)
  const badDb = fixture({}, { failRead: true })
  assert.deepEqual(await badDb.preview({ previewAction: 'marketList', collection: 'userInfo' }), { ok: false, error: 'preview_unavailable' })
  assert.deepEqual([...new Set(badDb.calls.collections)], ['market_goods'])
})

test('pure visibility/date and URL policies handle boundaries without trusting client flags', () => {
  assert.equal(previewModule.tripTime('2026-09-10', '12:00'), Date.parse('2026-09-10T16:00:00Z'))
  assert.equal(previewModule.tripTime('2026-03-08', '02:30'), 0)
  assert.equal(previewModule.tripTime('2026-02-30', '12:00'), 0)
  assert.equal(previewModule.isVisibleMarket(goods({ expireTime: 0 }), NOW), true)
  assert.equal(previewModule.isVisibleMarket(goods({ expireTime: NOW }), NOW), false)
  assert.equal(previewModule.isVisibleTrip(trip({ status: 'full' }), NOW), true)
  assert.equal(previewModule.isVisibleTrip(trip({ isCancelled: true }), NOW), false)
  assert.equal(previewModule.safeFileID(IMAGE, ENV), IMAGE)
  assert.equal(previewModule.safeFileID(IMAGE, 'other'), '')
  assert.equal(previewModule.safeImageURL('https://good.tcb.qcloud.la.evil.test/image.jpg'), '')
  assert.equal(previewModule.safeImageURL('https://u:p@good.tcb.qcloud.la/image.jpg'), '')
  assert.equal(previewModule.safeImageURL('data:image/png;base64,xxx'), '')
  const description = previewModule.cleanPublicText('良好书桌。\nWechat: secretID\n电话 201-555-0199\n邮箱 buyer@example.com\n尺寸 120 x 60 cm；2026-09-20 可取')
  assert.match(description, /良好书桌/)
  assert.match(description, /120 x 60 cm/)
  assert.match(description, /2026-09-20/)
  assert.doesNotMatch(description, /secretID|201-555|buyer@example/)
})

test('English website trip DTO exposes fixed public areas and useful seats/date fields without exact pickup data', async () => {
  const doc = trip({ price: '10 USD/人', referencePrice: undefined, availSeatNum: 0,
    departures: [{ cityKey: 'ny_nj', address: '123 Secret Street, Fort Lee', date: '2026-09-10', time: '12:00' }],
    destinations: [{ cityKey: 'ny_nj', address: '哥大 456 Private Avenue' }],
    driverOpenid: 'private-driver', driverPhone: '123-555-7890'
  })
  const f = fixture({ Carpool: [doc] })
  const result = await f.preview({ previewAction: 'tripList', type: 'carpool', locale: 'en' })
  const item = result.items[0]
  assert.equal(item.fromLabel, 'Fort Lee')
  assert.equal(item.toLabel, 'Columbia University')
  assert.equal(item.dateKey, '2026-09-10')
  assert.equal(item.departureAtMs, Date.parse('2026-09-10T16:00:00Z'))
  assert.equal(item.priceText, '$10/person')
  assert.equal(item.full, true)
  assert.equal(item.seats, 0)
  assert.equal(item.availabilityText, 'Full')
  assert.doesNotMatch(JSON.stringify(result), /123|456|Secret|Private|driverOpenid|private-driver|Phone|latitude|longitude|哥大/)
  assert.deepEqual(f.calls.writes, [])
  assert.deepEqual(f.calls.functions, [])
})

test('English market DTO keeps original listing content while translating fixed labels and redaction markers', async () => {
  const doc = goods({ title: '实木书桌', desc: 'A solid desk. Email buyer@example.com', category: '家具', condition: '9成新' })
  const f = fixture({ market_goods: [doc] })
  const result = await f.preview({ previewAction: 'marketDetail', id: doc._id, locale: 'en' })
  assertPublicItem(result.item)
  assert.equal(result.item.title, '实木书桌')
  assert.equal(result.item.regionText, 'New York / New Jersey')
  assert.equal(result.item.availabilityText, 'Available')
  assert.deepEqual(result.item.tags, ['Furniture', 'Like new'])
  assert.match(result.item.description, /\[redacted\]/)
  assert.doesNotMatch(result.item.description, /buyer@example.com|已隐藏/)
  assert.equal((await f.preview({ previewAction: 'marketList', locale: 'fr' })).error, 'invalid_preview_request')
  const unusual = fixture({ market_goods: [goods({ cityKey: 'constructor', category: '__proto__', condition: 'constructor' })] })
  const safe = await unusual.preview({ previewAction: 'marketDetail', id: 'goods-1', locale: 'en' })
  assert.equal(safe.item.regionText, 'New York / New Jersey')
  assert.deepEqual(safe.item.tags, ['__proto__', 'constructor'])
})

test('only record-referenced current-environment web-admin image paths become public image URLs', async () => {
  const valid = `cloud://${ENV}.bucket-123/web-admin/operator/${'a'.repeat(32)}.jpg`
  const invalid = [valid.replace(ENV, 'foreign-env'), valid.replace('a'.repeat(32), 'private'), valid.replace('/operator/', '/../'), valid.replace('.jpg', '.svg')]
  const f = fixture({ market_goods: [goods({ imageFileIDs: [valid, ...invalid] })] })
  const result = await f.preview({ previewAction: 'marketDetail', id: 'goods-1', locale: 'en' })
  assert.equal(result.ok, true)
  assert.deepEqual(f.calls.images[0].fileList, [valid])
  assert.deepEqual(result.item.images, [HTTPS_IMAGE])
  for (const fileID of invalid) assert.equal(previewModule.safeFileID(fileID, ENV), '')
})

test('current and legacy saved fares remain numeric-only and use nonblank fallback fields', async () => {
  const cases = [
    [{ referencePrice: '10$/人' }, '$10/person'],
    [{ referencePrice: '', price: '8' }, '$8/person'],
    [{ referencePrice: '  ', price: '', displayPrice: '$12/person' }, '$12/person'],
    [{ referencePrice: 0, price: 99 }, '$0/person'],
    [{ referencePrice: '11-13$' }, '$11–$13/person'],
    [{ referencePrice: '$11–$13/person' }, '$11–$13/person'],
    [{ referencePrice: '13-11$' }, 'Price to be confirmed'],
    [{ referencePrice: 'Call 2015550199 for a fare' }, 'Price to be confirmed'],
    [{ referencePrice: '2015550199' }, 'Price to be confirmed']
  ]
  for (const [overrides, expected] of cases) {
    const f = fixture({ Carpool: [trip(overrides)] })
    const result = await f.preview({ previewAction: 'tripList', type: 'carpool', locale: 'en' })
    assert.equal(result.items[0].priceText, expected, JSON.stringify(overrides))
  }
})

test('full passenger request groups still need seats and airport aliases use the same public labels as mini-program filters', async () => {
  for (const [address, label] of [['John F. Kennedy International Airport', 'JFK'], ['拉瓜地亚机场', 'LaGuardia'], ['NewarkLibertyInternationalAirport', 'Newark']]) {
    const f = fixture({ CarpoolRequest: [trip({ status: 'full', passengerCount: 4, requestPassengerCount: undefined, destinations: [{ address }] })] })
    const result = await f.preview({ previewAction: 'tripList', type: 'request', locale: 'en' })
    assert.equal(result.items[0].toLabel, label)
    assert.equal(result.items[0].full, false)
    assert.equal(result.items[0].availabilityText, '4 seats wanted')
  }
})
