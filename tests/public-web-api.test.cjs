const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const api = require('../cloudfunctions/marketApi/publicWeb')
const SECRET = 'test_server_secret_'.repeat(3)
const item = { id: 'trip-1', kind: 'carpool', title: 'Ride offered · Fort Lee → Columbia University', images: [] }
function fixture(options = {}) {
  const calls = []
  const handle = api.createPublicWebHandler({
    getSecret: () => Object.hasOwn(options, 'secret') ? options.secret : SECRET,
    publicPreview: async request => { calls.push(request); if (options.fail) throw new Error('database secret'); return options.result || (request.id ? { ok: true, item } : { ok: true, items: [item], hasMore: false, nextOffset: 1 }) }
  })
  const event = (input = { operation: 'tripList', kind: 'all' }, overrides = {}) => ({ path: '/public-api', httpMethod: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input), ...overrides })
  return { calls, handle, event }
}
function body(result) { return JSON.parse(result.body) }

test('public HTTP adapter fails closed before reading without a strong server credential', async () => {
  for (const secret of [undefined, '', 'short', ' '.repeat(48)]) {
    const f = fixture({ secret })
    assert.equal((await f.handle(f.event())).statusCode, 503)
    assert.deepEqual(f.calls, [])
  }
  const f = fixture()
  for (const authorization of ['', 'Bearer wrong', `Bearer ${'x'.repeat(SECRET.length)}`, `Basic ${SECRET}`, `Bearer ${SECRET}\n`]) {
    const result = await f.handle(f.event(undefined, { headers: { Authorization: authorization, 'Content-Type': 'application/json' } }))
    assert.ok([400, 401].includes(result.statusCode))
  }
  assert.deepEqual(f.calls, [])
})

test('server environment takes precedence over private deployment JSON, including invalid/revoked values', async () => {
  let reads = 0
  const readConfig = () => { reads++; return { PUBLIC_WEB_API_SECRET: SECRET } }
  assert.equal(api.loadServerSecret({ env: {}, readConfig }), SECRET)
  assert.equal(reads, 1)
  for (const value of [SECRET, '', 'short', undefined, ' '.repeat(64)]) {
    const secret = api.loadServerSecret({ env: { PUBLIC_WEB_API_SECRET: value }, readConfig })
    assert.equal(secret, value)
    const f = fixture({ secret })
    assert.equal((await f.handle(f.event())).statusCode, value === SECRET ? 200 : 503)
  }
  assert.equal(reads, 1, 'configured environment never reads the fallback file')
})

test('missing, malformed or unexpected private deployment configuration fails closed without exposing configuration', async () => {
  const configs = [null, [], {}, { secret: SECRET }, { PUBLIC_WEB_API_SECRET: SECRET, unexpected: true },
    { PUBLIC_WEB_API_SECRET: [] }, { PUBLIC_WEB_API_SECRET: '' }, { PUBLIC_WEB_API_SECRET: 'short' }]
  for (const config of configs) {
    const secret = api.loadServerSecret({ env: {}, readConfig: () => config })
    const f = fixture({ secret })
    const result = await f.handle(f.event())
    assert.equal(result.statusCode, 503)
    assert.deepEqual(body(result), { ok: false, error: 'service_unavailable' })
    assert.deepEqual(f.calls, [])
  }
  for (const message of ['Cannot find module private configuration', 'Malformed private JSON with sensitive content']) {
    const secret = api.loadServerSecret({ env: {}, readConfig() { throw new Error(message) } })
    assert.equal(secret, undefined)
    assert.equal((await fixture({ secret }).handle(fixture().event())).statusCode, 503)
  }
  const ignored = fs.readFileSync(path.resolve(__dirname, '../.gitignore'), 'utf8').split(/\r?\n/)
  assert.ok(ignored.includes('/cloudfunctions/marketApi/publicWeb.secret.json'))
})

test('only the exact public path, POST JSON and one unambiguous authorization header are accepted', async () => {
  const f = fixture()
  const bad = [
    [{ path: '/admin-api' }, 404], [{ path: '/public-api/' }, 404], [{ path: '/public-api?x=1' }, 404],
    [{ path: '/public-api', requestContext: { path: '/admin-api' } }, 404],
    [{ httpMethod: 'GET' }, 405], [{ httpMethod: 'OPTIONS' }, 405],
    [{ headers: { Authorization: `Bearer ${SECRET}`, authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' } }, 400],
    [{ headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'text/plain' } }, 415],
    [{ body: 'x'.repeat(2800) }, 413], [{ body: '{bad json' }, 400],
    [{ body: '!!!', isBase64Encoded: true }, 400], [{ isBase64Encoded: 'true' }, 400]
  ]
  for (const [overrides, status] of bad) assert.equal((await f.handle(f.event(undefined, overrides))).statusCode, status, JSON.stringify(overrides))
  assert.deepEqual(f.calls, [])
  const valid = await f.handle(f.event({ operation: 'tripList' }, { path: undefined, requestContext: { path: '/public-api' } }))
  assert.equal(valid.statusCode, 200)
  assert.equal(valid.headers['Access-Control-Allow-Origin'], undefined)
  assert.equal(valid.headers['Cache-Control'], 'no-store')
})

test('write actions, identity probes, query operators, unknown fields and invalid pagination never reach preview reader', async () => {
  const f = fixture()
  const cases = [
    null, [], {}, { operation: 'joinTrip' }, { operation: 'create' }, { operation: 'delete' },
    { operation: 'tripList', action: 'joinTrip' }, { operation: 'marketList', sellerId: 'someone' },
    { operation: 'marketList', collection: 'userInfo' }, { operation: 'marketList', where: { status: 'offline' } },
    { operation: 'tripList', kind: { $ne: 'request' } }, { operation: 'tripList', kind: 'goods' },
    { operation: 'tripList', cityKey: 'unknown' }, { operation: 'tripList', category: '家具' },
    { operation: 'tripList', locale: 'zh' }, { operation: 'tripList', limit: 21 }, { operation: 'tripList', limit: '20' },
    { operation: 'tripList', limit: 0 }, { operation: 'tripList', offset: 81 }, { operation: 'tripList', offset: -1 },
    { operation: 'tripList', offset: 0.5 }, { operation: 'tripList', id: 'trip-1' },
    { operation: 'tripDetail', id: 'trip-1' }, { operation: 'tripDetail', kind: 'all', id: 'trip-1' },
    { operation: 'tripDetail', kind: 'carpool', id: '../secret' }, { operation: 'tripDetail', kind: 'carpool', id: 'trip-1', offset: 0 },
    { operation: 'marketDetail', kind: 'goods', id: 'goods-1', openid: 'forged' }
  ]
  for (const input of cases) assert.equal((await f.handle(f.event(input))).statusCode, 400, JSON.stringify(input))
  assert.deepEqual(f.calls, [])
})

test('all four operations map only to the public reader with server-forced English locale', async () => {
  const f = fixture()
  assert.equal((await f.handle(f.event({ operation: 'tripList', kind: 'request', limit: 10, offset: 20, cityKey: 'ny_nj' }))).statusCode, 200)
  assert.deepEqual(f.calls[0], { previewAction: 'tripList', type: 'request', locale: 'en', limit: 10, offset: 20, cityKey: 'ny_nj' })
  assert.equal((await f.handle(f.event({ operation: 'tripDetail', kind: 'carpool', id: 'trip-1' }))).statusCode, 200)
  assert.equal((await f.handle(f.event({ operation: 'marketList', kind: 'sublet' }))).statusCode, 200)
  const market = fixture({ result: { ok: true, item: { ...item, kind: 'goods' } } })
  const request = { operation: 'marketDetail', kind: 'goods', id: 'trip-1' }
  const encoded = Buffer.from(JSON.stringify(request)).toString('base64')
  assert.equal((await market.handle(market.event(request, { body: encoded, isBase64Encoded: true }))).statusCode, 200)
  assert.equal((await market.handle(market.event({ ...request, kind: 'sublet' }))).statusCode, 404)
})

test('private errors stay generic and pagination never advertises an out-of-range next page', async () => {
  const f = fixture({ fail: true })
  assert.deepEqual(body(await f.handle(f.event())), { ok: false, error: 'service_unavailable' })
  const missing = fixture({ result: { ok: false, error: 'not_found', private: 'secret' } })
  assert.deepEqual(body(await missing.handle(missing.event())), { ok: false, error: 'not_found' })
  const last = fixture({ result: { ok: true, items: [item], hasMore: true, nextOffset: 90 } })
  assert.equal(body(await last.handle(last.event())).hasMore, false)
})

test('actual marketApi entry separates website read path, admin authentication and mini-program identity', async () => {
  const calls = { public: [], admin: [], db: [] }
  const filename = path.resolve(__dirname, '../cloudfunctions/marketApi/index.js')
  const exports = {}
  const cloud = { DYNAMIC_CURRENT_ENV: 'dynamic', init() {}, database() { return { command: {}, collection(name) { calls.db.push(name); throw new Error('Unexpected database access') } } }, getWXContext: () => ({ OPENID: '' }) }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    exports, require(name) {
      if (name === 'wx-server-sdk') return cloud
      if (name === 'crypto') return crypto
      if (name === './publicPreview') return { createPublicPreviewHandler: () => async request => { calls.public.push(request); return { ok: true, items: [], hasMore: false, nextOffset: 0 } } }
      if (name === './publicWeb') return { createPublicWebHandler: deps => api.createPublicWebHandler({ ...deps, getSecret: () => SECRET }) }
      if (name === './webAdmin') return { createWebAdminHandler: () => async event => { calls.admin.push(event); return { statusCode: 403 } } }
      throw new Error(`Unexpected import: ${name}`)
    }, console, Date, Intl, Set, Map, Buffer, process
  }, { filename })
  const f = fixture()
  const attack = f.event({ operation: 'tripList', action: 'create' })
  assert.equal((await exports.main(attack)).statusCode, 400)
  assert.equal(calls.public.length, 0)
  assert.equal((await exports.main(f.event())).statusCode, 200)
  assert.equal(calls.public.length, 1)
  assert.equal((await exports.main(f.event(undefined, { path: '/admin-api' }))).statusCode, 403)
  assert.equal(calls.admin.length, 1)
  assert.equal((await exports.main({ action: 'create', path: '/public-api', token: SECRET })).error, 'not_logged_in')
  assert.deepEqual(calls.db, [])
})
