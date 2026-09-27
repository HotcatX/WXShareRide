const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readServerStats, createPublicStatsReader, ENDPOINT } = require('../cloudfunctions/statistics/provider')
const { createStatisticsHandler } = require('../cloudfunctions/statistics/handler')
const { makeRelay, createLegacyTimer } = require('../cloudfunctions/syncPublicStatsReplica/relay')
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

test('an unavailable server or invalid authority never triggers a read from the old database', async () => {
  let oldReads = 0, serverReads = 0
  const dependencies = { readCloudStats: async () => { oldReads++; return { servedTrips: 1 } },
    readServer: async () => { serverReads++; throw Error('server unavailable') } }
  assert.deepEqual(await createPublicStatsReader({ ...dependencies, authority: 'cloudbase' })(), { servedTrips: 1 })
  await assert.rejects(createPublicStatsReader({ ...dependencies, authority: 'server' })())
  await assert.rejects(createPublicStatsReader({ ...dependencies, authority: 'invalid' })())
  assert.equal(oldReads, 1); assert.equal(serverReads, 1)
})

test('after handoff authenticated legacy timers retire without publishing stale cloud snapshots', async () => {
  const key = Buffer.alloc(32, 7), now = Date.now()
  let reads = 0, writes = 0
  for (const mode of ['server', 'invalid']) {
    const run = createStatisticsHandler({ authority: mode, getSyncKey: () => key, now: () => now,
      readPublicStats: async () => { reads++; return {} },
      send: async () => { writes++ }, synchronizePlaces: async () => { writes++ }, getContext: value => value })
    for (const [event, context] of [
      [{ Type: 'Timer', TriggerName: 'publicStatsHourly' }, { SOURCE: 'wx_trigger' }],
      [{ action: 'publicStatsHourlyTimer', Type: 'Timer', TriggerName: 'publicStatsHourly' }, { SOURCE: 'wx_trigger' }],
      [{ Type: 'Timer', TriggerName: 'placeBusinessFiveMinutes' }, { SOURCE: 'wx_trigger' }],
      [makeRelay(key, now), { SOURCE: 'scf' }],
    ]) {
      assert.deepEqual(await run(event, context), mode === 'server'
        ? { ok: true, skipped: 'AUTHORITY_MOVED' } : { ok: false, error: 'AUTHORITY_UNAVAILABLE' })
      assert.equal((await run(event, { SOURCE: 'wx_client', OPENID: 'caller' })).ok, false)
    }
  }
  assert.equal(reads, 0); assert.equal(writes, 0)
})

test('legacy relay accepts exactly the retired acknowledgement without inventing a snapshot timestamp', async () => {
  const dependencies = { getKey: () => Buffer.alloc(32, 7), getContext: value => value }
  const event = { Type: 'Timer', TriggerName: 'publicStatsHourly' }, context = { SOURCE: 'wx_trigger' }
  const stopped = { ok: true, skipped: 'AUTHORITY_MOVED' }
  assert.deepEqual(await createLegacyTimer({ ...dependencies, invoke: async () => ({ result: stopped }) })(event, context), stopped)
  for (const result of [{ ok: false, skipped: 'AUTHORITY_MOVED' }, { ok: true, skipped: 'unknown' },
    { ...stopped, extra: true }]) {
    await assert.rejects(createLegacyTimer({ ...dependencies, invoke: async () => ({ result }) })(event, context),
      /^Error: PUBLIC_STATS_SYNC_FAILED$/)
  }
})
