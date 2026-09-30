const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { createAddressListRelay } = require('../cloudfunctions/getAddressList')

const ids = {
  Departure: 'b4498fc86903a813018505643bc4ca31',
  Arrival: 'cd349d8f6903a85901817428411cfbff',
  Departure_Request: '4798591469645faa0bab74191c815837',
  Arrival_Request: 'b4498fc869645e7c0bb50b4d0b12607e'
}
const locations = { ok: true, data: { rideAddresses: {
  offer: { fromPlaces: ['Fort Lee', '哥大'], toPlaces: ['JFK', 'LGA'] },
  request: { fromPlaces: ['JSQ', 'LIC'], toPlaces: ['NYU', 'Inwood'] }
} }, requestId: 'upstream-only' }

function transport({ status = 200, headers = {}, body = JSON.stringify(locations), chunks,
  error, throwError = false, paused = false, aborted = false, closed = false, complete = true } = {}) {
  const state = { calls: [], reqDestroyed: false, resDestroyed: false }
  const request = (url, options, callback) => {
    state.calls.push({ url, options })
    if (throwError) throw Error('private DNS details')
    const req = new EventEmitter()
    req.destroy = () => { state.reqDestroyed = true }
    req.end = () => queueMicrotask(() => {
      if (error) { req.emit('error', Error(error)); return }
      const res = new EventEmitter()
      res.statusCode = status
      res.complete = complete
      res.headers = { 'content-type': 'application/json; charset=utf-8', ...headers }
      res.destroy = () => { state.resDestroyed = true }
      state.response = res
      callback(res)
      if (state.resDestroyed || paused) return
      for (const chunk of chunks || [Buffer.from(body)]) res.emit('data', chunk)
      if (aborted) res.emit('aborted')
      else if (closed) res.emit('close')
      else { res.emit('end'); res.emit('close') }
    })
    return req
  }
  return { state, request }
}

test('legacy four address types retain their original configuration IDs and exact selected order over one fixed GET', async () => {
  const upstream = transport()
  const main = createAddressListRelay(upstream)
  const expected = { Departure: ['Fort Lee', '哥大'], Arrival: ['JFK', 'LGA'],
    Departure_Request: ['JSQ', 'LIC'], Arrival_Request: ['NYU', 'Inwood'] }
  for (const [type, addressList] of Object.entries(expected)) {
    assert.deepEqual(await main({ type }), { success: true, id: ids[type], addressList })
  }
  assert.equal(upstream.state.calls.length, 4)
  for (const call of upstream.state.calls) {
    assert.equal(call.url, 'https://collect.linkx.ink/api/v1/locations')
    assert.deepEqual(call.options, { method: 'GET', headers: { accept: 'application/json', 'accept-encoding': 'identity' } })
  }
})

test('current canonical catalog fits the bounded legacy relay without freezing an old address snapshot', async () => {
  const catalog = require('../services/backend/src/locations/catalog.generated.json')
  const upstream = transport({ body: JSON.stringify({ ok: true, data: catalog }) })
  const main = createAddressListRelay(upstream)
  for (const [type, kind, field] of [['Departure', 'offer', 'fromPlaces'], ['Arrival', 'offer', 'toPlaces'],
    ['Departure_Request', 'request', 'fromPlaces'], ['Arrival_Request', 'request', 'toPlaces']]) {
    const result = await main({ type })
    assert.equal(result.success, true)
    assert.deepEqual(result.addressList, catalog.rideAddresses[kind][field])
  }
})

test('reserved platform metadata is ignored without reading, changing or forwarding it', async () => {
  const upstream = transport()
  const main = createAddressListRelay(upstream)
  const event = { type: 'Departure' }
  for (const field of ['userInfo', 'tcbContext']) {
    Object.defineProperty(event, field, { enumerable: true, get() { throw Error('Metadata must not be read') } })
  }
  assert.deepEqual(await main(event), { success: true, id: ids.Departure, addressList: ['Fort Lee', '哥大'] })
  assert.deepEqual(Object.keys(event), ['type', 'userInfo', 'tcbContext'])
  for (const metadata of [null, {}, 'untrusted', { type: 'Arrival', openid: 'spoofed', url: 'https://untrusted.invalid' }]) {
    assert.equal((await main({ type: 'Departure', userInfo: metadata, tcbContext: metadata })).id, ids.Departure)
  }
  for (const call of upstream.state.calls) {
    assert.equal(call.url, 'https://collect.linkx.ink/api/v1/locations')
    assert.deepEqual(call.options, { method: 'GET', headers: { accept: 'application/json', 'accept-encoding': 'identity' } })
  }
  const calls = upstream.state.calls.length
  for (const key of ['url', 'headers', 'collection', 'action', 'openid', '_openid', 'context', 'limit']) {
    assert.deepEqual(await main({ type: 'Departure', userInfo: {}, tcbContext: {}, [key]: 'injected' }),
      { success: false, message: '参数格式不正确' })
  }
  assert.equal(upstream.state.calls.length, calls)
})

test('missing or unsupported types preserve failures; collection, URL, identity and extra inputs never reach transport', async () => {
  const upstream = transport()
  const main = createAddressListRelay(upstream)
  for (const event of [undefined, null, [], 'Departure', {}, { type: '' }, { type: 0 }]) {
    assert.deepEqual(await main(event), { success: false, message: '缺少参数 type' })
  }
  for (const type of ['userInfo', 'constructor', '__proto__', '../Departure', '%44eparture', ['Departure'], 1]) {
    assert.deepEqual(await main({ type }), { success: false, message: '不支持的地址类型' })
  }
  for (const key of ['url', 'collection', 'limit', '_openid', 'headers', 'action']) {
    assert.deepEqual(await main({ type: 'Departure', [key]: 'unused' }), { success: false, message: '参数格式不正确' })
  }
  assert.equal(upstream.state.calls.length, 0)
})

test('network, redirect, encoding, MIME, truncated body and malformed JSON failures remain visible and never retry elsewhere', async () => {
  for (const input of [{ throwError: true }, { error: 'private connection details' }, { status: 302 }, { status: 500 },
    { headers: { 'content-encoding': 'gzip' } }, { headers: { 'content-type': 'text/html' } },
    { headers: { 'content-type': ['application/json'] } }, { headers: { 'content-type': 'application/json; charset=latin1' } },
    { body: 'not JSON' }, { chunks: [Buffer.from([0xc3, 0x28])] }, { aborted: true }, { closed: true }]) {
    const upstream = transport(input)
    assert.deepEqual(await createAddressListRelay(upstream)({ type: 'Departure' }),
      { success: false, message: '加载失败', error: 'ADDRESS_LIST_UNAVAILABLE' })
    assert.equal(upstream.state.calls.length, 1)
  }
})

test('advertised and streaming payload limits reject unbounded replies before parsing', async () => {
  for (const input of [{ headers: { 'content-length': '65537' } }, { headers: { 'content-length': 'invalid' } },
    { headers: { 'content-length': ['100'] } }, { chunks: [Buffer.alloc(65536, 32), Buffer.from('x')] }]) {
    const upstream = transport(input)
    const result = await createAddressListRelay(upstream)({ type: 'Departure' })
    assert.equal(result.success, false)
    assert.equal(upstream.state.resDestroyed, true)
    assert.equal(upstream.state.reqDestroyed, true)
    assert.equal(upstream.state.calls.length, 1)
  }
})

test('content length measures complete UTF-8 bytes across chunks and rejects valid JSON with inconsistent framing', async () => {
  const body = JSON.stringify(locations), bytes = Buffer.from(body)
  assert.ok(bytes.length > body.length, 'fixture contains multibyte addresses')
  const split = bytes.indexOf(Buffer.from('哥')) + 1
  const chunks = [bytes.subarray(0, split), bytes.subarray(split)]
  const exact = transport({ headers: { 'content-length': String(bytes.length) }, chunks })
  assert.deepEqual(await createAddressListRelay(exact)({ type: 'Departure' }),
    { success: true, id: ids.Departure, addressList: ['Fort Lee', '哥大'] })
  const chunked = transport({ headers: { 'transfer-encoding': 'chunked' }, chunks })
  assert.equal((await createAddressListRelay(chunked)({ type: 'Departure' })).success, true)

  for (const input of [
    { headers: { 'content-length': String(bytes.length + 1) }, chunks },
    { headers: { 'content-length': String(bytes.length - 1) }, chunks },
    { headers: { 'content-length': String(body.length) }, chunks },
    { headers: { 'content-length': String(bytes.length) }, chunks: [bytes.subarray(0, -1)] },
    { headers: { 'transfer-encoding': 'chunked' }, chunks, complete: false },
    { headers: { 'transfer-encoding': 'chunked' }, chunks: [bytes.subarray(0, split)], aborted: true },
    { headers: { 'transfer-encoding': 'chunked' }, chunks: [bytes.subarray(0, split)], closed: true }
  ]) {
    const upstream = transport(input)
    assert.deepEqual(await createAddressListRelay(upstream)({ type: 'Departure' }),
      { success: false, message: '加载失败', error: 'ADDRESS_LIST_UNAVAILABLE' })
    assert.equal(upstream.state.reqDestroyed, true)
    assert.equal(upstream.state.resDestroyed, true)
    assert.equal(upstream.state.calls.length, 1)
  }
})

test('invalid upstream envelopes and lists cannot be reported as successful empty or coercible addresses', async () => {
  const bad = [null, {}, { ok: false, data: locations.data }, { ok: true, data: {} }]
  for (const fromPlaces of [[], ['same', 'same'], [null], [1], [''], [' spaced '], ['a\u0000b'], ['x'.repeat(201)],
    Array.from({ length: 101 }, (_, index) => String(index)), { 0: 'Fort Lee' }]) {
    bad.push({ ok: true, data: { rideAddresses: { offer: { fromPlaces } } } })
  }
  for (const body of bad) {
    const upstream = transport({ body: JSON.stringify(body) })
    assert.deepEqual(await createAddressListRelay(upstream)({ type: 'Departure' }),
      { success: false, message: '加载失败', error: 'ADDRESS_LIST_UNAVAILABLE' })
  }
})

test('ten-second total deadline terminates a slow streaming response and ignores a late successful body', async () => {
  const upstream = transport({ paused: true })
  let deadline, cleared = 0
  const main = createAddressListRelay({ ...upstream,
    setTimer(callback, milliseconds) { assert.equal(milliseconds, 10000); deadline = callback; return 'timer' },
    clearTimer(timer) { assert.equal(timer, 'timer'); cleared++ }
  })
  const pending = main({ type: 'Departure' })
  await Promise.resolve()
  upstream.state.response.emit('data', Buffer.from('{'))
  deadline()
  assert.deepEqual(await pending, { success: false, message: '加载失败', error: 'ADDRESS_LIST_TIMEOUT' })
  assert.equal(cleared, 1)
  assert.equal(upstream.state.reqDestroyed, true)
  assert.equal(upstream.state.resDestroyed, true)
  upstream.state.response.emit('data', Buffer.from(JSON.stringify(locations)))
  upstream.state.response.emit('end')
  assert.equal(cleared, 1)
  assert.equal(upstream.state.calls.length, 1)
})

test('deployed entry loads only Node built-ins and has no SDK, secret or external package dependency', async () => {
  const directory = path.join(__dirname, '../cloudfunctions/getAddressList')
  const upstream = transport()
  const loaded = []
  const exports = {}
  vm.runInNewContext(fs.readFileSync(path.join(directory, 'index.js'), 'utf8'), {
    exports, Buffer, setTimeout, clearTimeout,
    require(name) {
      loaded.push(name)
      if (name === 'node:https') return { request: upstream.request }
      if (name === 'node:util') return require('node:util')
      throw Error('Unexpected dependency: ' + name)
    }
  })
  assert.equal((await exports.main({ type: 'Departure' })).success, true)
  assert.deepEqual(loaded, ['node:https', 'node:util'])
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'))
  assert.deepEqual(pkg.dependencies, {})
  assert.deepEqual(Object.keys(lock.packages), [''])
})
