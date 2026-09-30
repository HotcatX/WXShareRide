const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readServerStats, ENDPOINT } = require('../cloudfunctions/statistics/provider')
const { createStatisticsHandler } = require('../cloudfunctions/statistics/handler')
const authority = require('../cloudfunctions/backend/authority')

function transport(body, status = 200, headers = {}) {
  return (url, options, callback) => {
    assert.equal(url, ENDPOINT); assert.equal(options.method, 'GET')
    const req = new EventEmitter()
    req.destroy = () => {}
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter()
      Object.assign(res, { statusCode: status, headers, destroy() {} })
      callback(res)
      res.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)))
      res.emit('end')
    })
    return req
  }
}

test('statistics and backend bundles use one generated authority value', () => {
  assert.equal(authority, require('../config/backend').mode)
  assert.equal(require('../cloudfunctions/statistics/authority'), authority)
})

test('server public-statistics reader projects only canonical public values and rejects bad transport', async () => {
  assert.deepEqual(await readServerStats(transport({ ok: true, data: { servedCount: 42, coverageText: null, ignored: 'private' } })),
    { _id: 'home', servedTrips: 42, coverageText: 'N/A' })
  const good = { ok: true, data: { servedCount: 42, coverageText: 'NY / NJ' } }
  for (const request of [transport(good, 302, { location: 'https://elsewhere.invalid' }),
    transport(good, 503), transport(good, 200, { 'content-encoding': 'gzip' }),
    transport(good, 200, { 'content-length': '8193' }), transport(good, 200, { 'content-length': '1' }),
    transport(Buffer.alloc(8193)), transport(Buffer.from([0xff])), transport({ ok: false, data: good.data }),
    ...[null, '42', -1, 1.2, Number.MAX_SAFE_INTEGER + 1].map(servedCount => transport({ ok: true, data: { servedCount, coverageText: null } })),
    transport({ ok: true, data: { servedCount: 42, coverageText: 'bad\nvalue' } })]) {
    await assert.rejects(readServerStats(request), /^Error: PUBLIC_STATS_UNAVAILABLE$/)
  }
})

test('only explicit server authority permits public reads or account dispatch', async () => {
  let reads = 0, accounts = 0
  for (const authority of [undefined, null, '', 'cloudbase', 'invalid']) {
    const run = createStatisticsHandler({ authority,
      readPublicStats: async () => { reads++; return {} },
      account: async () => { accounts++; return {} } })
    assert.deepEqual(await run({ action: 'publicStats' }), { success: false,
      errorMsg: 'PUBLIC_STATS_UNAVAILABLE', data: { _id: 'home', servedTrips: null, coverageText: 'N/A' } })
    for (const action of ['status', 'activate', 'withdraw', 'placeBusinessTimer', 'legacyPublicStatsTimer']) {
      assert.deepEqual(await run({ action }), { ok: false, error: 'AUTHORITY_UNAVAILABLE', statusCode: 503 })
    }
  }
  assert.equal(reads, 0); assert.equal(accounts, 0)
})
