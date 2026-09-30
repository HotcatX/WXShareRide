const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createBackendClient } = require('../utils/backendClient')

const tick = () => new Promise(resolve => setImmediate(resolve))
function harness() {
  const storage = { openid: 'synthetic-member', isGuest: false }
  const state = { requests: [], timers: new Map(), sequence: 0, aborts: 0, cloud: 0 }
  const wx = {
    getStorageSync: key => storage[key],
    setStorageSync: (key, value) => { storage[key] = value },
    removeStorageSync: key => { delete storage[key] },
    request(options) {
      if (state.throwRequest) throw new Error('native failure')
      state.requests.push(options)
      return { abort() { state.aborts++ } }
    },
    cloud: { callFunction() { state.cloud++; throw new Error('statistics must not call CloudBase') } }
  }
  const backend = createBackendClient({ wx, config: { mode: 'server', origin: 'https://collect.linkx.ink' },
    setTimeout(fn, ms) { const id = ++state.sequence; state.timers.set(id, { fn, ms }); return id },
    clearTimeout(id) { state.timers.delete(id) } })
  let definition
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/home/home.js'), 'utf8'), {
    Page: value => { definition = value }, wx, Date, console,
    require(name) {
      if (name.endsWith('/backendClient')) return backend
      if (name.endsWith('/cityTree')) return { getCitySnapshot: () => ({ key: 'ny_nj' }), getCountryTabs: () => [], getCountryGroups: () => [] }
      if (name.endsWith('/tripFollowup')) return { hide() {} }
      return {}
    }
  })
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch) } }
  page.syncLoginState()
  const succeed = (data = { servedCount: 84, coverageText: 'NY / NJ' }, index = state.requests.length - 1) =>
    state.requests[index].success({ statusCode: 200, data: { ok: true, data, requestId: 'synthetic' } })
  return { page, storage, state, succeed }
}

test('home uses one anonymous canonical GET with the shared timeout, no credentials or cloud calls', async () => {
  const h = harness()
  const reads = Array.from({ length: 5 }, () => h.page.loadPublicStats())
  await tick()
  assert.equal(h.state.requests.length, 1)
  const request = h.state.requests[0]
  assert.equal(request.url, 'https://collect.linkx.ink/api/v1/statistics/public')
  assert.equal(request.method, 'GET'); assert.equal(request.timeout, 15000)
  assert.equal(request.data, undefined); assert.equal(request.header.Authorization, undefined)
  h.succeed(); await Promise.all(reads)
  assert.equal(h.page.data.publicStats.servedTrips, 84)
  assert.equal(h.storage.homePublicStatsCacheV1.data.servedTrips, 84)
  assert.equal(h.state.cloud, 0); assert.equal(h.state.timers.size, 0)
})

test('malformed totals and coverage never become a valid cached zero and a later read can recover', async () => {
  for (const data of [null, [], {}, { servedCount: null, coverageText: 'NY' },
    ...[-1, 1.2, Number.MAX_SAFE_INTEGER + 1, '84'].map(servedCount => ({ servedCount, coverageText: 'NY' })),
    ...[undefined, {}, 'x'.repeat(121), 'NY\nNJ'].map(coverageText => ({ servedCount: 84, coverageText }))]) {
    const h = harness(); const read = h.page.loadPublicStats(); await tick()
    h.succeed(data); await read
    assert.equal(h.storage.homePublicStatsCacheV1, undefined)
    assert.equal(h.page.data.publicStats.hasServedTrips, false)
    const retry = h.page.loadPublicStats(); await tick(); h.succeed(); await retry
    assert.equal(h.page.data.publicStats.servedTrips, 84)
    assert.equal(h.state.cloud, 0)
  }
})

test('zero and safe integer totals retain their meaning; unknown coverage and extra fields never leak into cache', async () => {
  for (const servedCount of [0, Number.MAX_SAFE_INTEGER]) {
    for (const coverageText of [null, '', 'NY / NJ']) {
      const h = harness(); const read = h.page.loadPublicStats(); await tick()
      h.succeed({ servedCount, coverageText, openid: 'must-not-copy', profile: { private: true } }); await read
      assert.equal(h.page.data.publicStats.servedTrips, servedCount)
      assert.equal(h.page.data.publicStats.hasServedTrips, true)
      assert.equal(h.page.data.publicStats.coverageText, coverageText || 'N/A')
      assert.deepEqual(Object.keys(h.storage.homePublicStatsCacheV1.data).sort(), ['coverageText', 'servedTrips'])
      assert.equal(JSON.stringify(h.page.data.publicStats).includes('must-not-copy'), false)
    }
  }
})

test('HTTP and native failures stay unavailable without cloud fallback and retry on the next read', async () => {
  for (const cause of ['network', 'http', 'envelope', 'throw']) {
    const h = harness(); h.state.throwRequest = cause === 'throw'
    const read = h.page.loadPublicStats(); await tick()
    if (cause === 'network') h.state.requests[0].fail()
    if (cause === 'http') h.state.requests[0].success({ statusCode: 503, data: { ok: false, error: { code: 'STATISTICS_NOT_INITIALIZED' } } })
    if (cause === 'envelope') h.state.requests[0].success({ statusCode: 200, data: { success: true, data: { servedCount: 84 } } })
    await read
    assert.equal(h.storage.homePublicStatsCacheV1, undefined); assert.equal(h.state.cloud, 0)
    h.state.throwRequest = false
    const retry = h.page.loadPublicStats(); await tick(); h.succeed(); await retry
    assert.equal(h.page.data.publicStats.servedTrips, 84)
  }
})

test('the shared timeout aborts once, ignores a late response and allows an immediate fresh attempt', async () => {
  const h = harness(); const read = h.page.loadPublicStats(); await tick()
  const timer = [...h.state.timers.values()][0]; assert.equal(timer.ms, 15000); timer.fn()
  await read
  assert.equal(h.state.aborts, 1); assert.equal(h.state.cloud, 0)
  h.succeed({ servedCount: 999, coverageText: 'obsolete' }, 0); await tick()
  assert.equal(h.storage.homePublicStatsCacheV1, undefined)
  const retry = h.page.loadPublicStats(); await tick(); h.succeed(); await retry
  assert.equal(h.page.data.publicStats.servedTrips, 84)
})

test('the canonical client rejects an old identity even before the page observes the switch', async () => {
  const h = harness(); const read = h.page.loadPublicStats(); await tick()
  h.storage.openid = 'synthetic-other'
  h.succeed(); await read
  assert.equal(h.storage.homePublicStatsCacheV1, undefined)
  assert.equal(h.page.data.publicStats.hasServedTrips, false)
  h.page.syncLoginState()
  const retry = h.page.loadPublicStats(); await tick(); h.succeed(); await retry
  assert.equal(h.page.data.publicStats.servedTrips, 84)
})
