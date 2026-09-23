const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createHash } = require('node:crypto')

const tick = () => new Promise(resolve => setImmediate(resolve))
const plain = value => JSON.parse(JSON.stringify(value))
const hash = data => createHash('sha256').update(JSON.stringify(data)).digest('hex')

const COHORT_KEY = 'linkxPublicStatsRolloutV1'
const LEGACY_KEY = 'linkxPublicStatsTrialV1'
function harness(options = {}) {
  const state = {
    now: 1800000000000, env: options.env || 'develop', http: [], cloud: [], aborts: 0,
    timers: new Map(), nextTimer: 1, storage: options.storage || {}, storageReads: [], storageWrites: [], removals: [],
    random: 0.4321, randomCalls: 0
  }
  const config = { enabled: true, rolloutPercent: { develop: 100, trial: 100, release: 5 } }
  const localMath = Object.create(Math)
  localMath.random = () => { state.randomCalls++; return state.random }
  class Clock extends Date { static now() { return state.now } }
  const wx = {
    getAccountInfoSync() { if (state.envError) throw new Error('unavailable'); return { miniProgram: { envVersion: state.env } } },
    getStorageSync(key) { state.storageReads.push(key); if (state.storageError) throw new Error('unavailable'); return state.storage[key] },
    setStorageSync(key, value) {
      if (state.storageWriteError) throw new Error('unavailable')
      state.storageWrites.push({ key, value: plain(value) })
      if (!state.silentWrite) state.storage[key] = plain(value)
    },
    removeStorageSync(key) { if (state.storageRemoveError) throw new Error('unavailable'); state.removals.push(key); delete state.storage[key] },
    request(options) {
      state.http.push(options)
      if (state.httpThrow) throw new Error('transport unavailable')
      return { abort() { state.aborts++; options.fail({ errMsg: 'request:fail abort' }) } }
    },
    cloud: { callFunction(options) {
      state.cloud.push(options)
      if (state.cloudThrow) throw new Error('cloud unavailable')
      return Promise.resolve({ result: { success: true, data: { servedTrips: 42, coverageText: 'NY / NJ' } } })
    } }
  }
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/publicStatsPilot.js'), 'utf8'), {
    module, wx, Date: Clock, Math: localMath,
    require: name => name === '../config/publicStats' ? config : require(path.join(__dirname, '../utils', name)),
    setTimeout(fn, ms) { const id = state.nextTimer++; state.timers.set(id, { fn, ms }); return id },
    clearTimeout(id) { state.timers.delete(id) }
  })
  function snapshot(overrides = {}) {
    const data = { _id: 'home', servedTrips: 84, coverageText: '纽约 / 新泽西' }
    return { ok: true, schemaVersion: 1, source: 'cloudbase-snapshot', snapshotAt: state.now - 1000,
      expiresAt: state.now + 60000, revision: hash(data), data, ...overrides }
  }
  const succeed = (value = snapshot(), index = state.http.length - 1, statusCode = 200) => state.http[index].success({ statusCode, data: value })
  return { state, wx, config, api: module.exports, snapshot, succeed }
}

test('unknown environments, unavailable APIs, disabled or malformed configuration use the original cloud function', async () => {
  for (const env of [undefined, '', 'development']) {
    const h = harness(); h.state.env = env
    const read = await h.api.loadPublicStats()
    assert.equal(read.diagnostic.source, 'cloudbase')
    assert.equal(h.state.http.length, 0)
    assert.deepEqual(plain(h.state.cloud), [{ name: 'statistics', data: { action: 'publicStats' } }])
  }
  for (const change of [config => { config.enabled = false }, config => { config.enabled = 'true' },
    config => { config.rolloutPercent.release = 101 }, config => { config.rolloutPercent.trial = NaN },
    config => { config.rolloutPercent = null }]) {
    const h = harness(); change(h.config)
    await h.api.loadPublicStats()
    assert.equal(h.state.http.length, 0)
  }
  for (const fault of ['envError', 'missingApi', 'malformedApi']) {
    const h = harness()
    if (fault === 'missingApi') delete h.wx.getAccountInfoSync
    else if (fault === 'malformedApi') h.wx.getAccountInfoSync = () => ({})
    else h.state[fault] = true
    await h.api.loadPublicStats()
    assert.equal(h.state.http.length, 0)
    assert.equal(h.state.cloud.length, 1)
  }
})

test('bundled defaults enable the public read for all three known environments', () => {
  const config = require('../config/publicStats')
  assert.deepEqual(config, { enabled: true, rolloutPercent: { develop: 100, trial: 100, release: 100 } })
})

test('full rollout works without a bucket even when storage is unavailable, invalid or unwritable', async () => {
  for (const env of ['develop', 'trial', 'release']) {
    for (const fault of ['none', 'storageError', 'storageWriteError', 'silentWrite', 'storageRemoveError', 'invalidBucket']) {
      const h = harness({ env, storage: { [LEGACY_KEY]: true } })
      h.config.rolloutPercent[env] = 100
      if (fault === 'invalidBucket') h.state.storage[COHORT_KEY] = { version: 1, bucket: null }
      else h.state[fault] = true
      const request = h.api.loadPublicStats(); h.succeed()
      assert.equal((await request).diagnostic.source, 'lighthouse', env + '/' + fault)
      assert.equal(h.state.cloud.length, 0)
      assert.equal(h.state.storageReads.includes(COHORT_KEY), false)
      assert.equal(h.state.storageWrites.length, 0)
      assert.equal(h.state.randomCalls, 0)
    }
  }
})

test('partial rollout still fails to CloudBase if its stable bucket cannot be read or persisted', async () => {
  for (const fault of ['storageError', 'storageWriteError', 'silentWrite']) {
    const h = harness({ env: 'release' }); h.state[fault] = true
    assert.equal((await h.api.loadPublicStats()).diagnostic.source, 'cloudbase')
    assert.equal(h.state.http.length, 0)
    assert.deepEqual(plain(h.state.cloud), [{ name: 'statistics', data: { action: 'publicStats' } }])
  }
})

test('release 0, 5 and 100 percent use exact stable installation boundaries across restarts', async () => {
  for (const percent of [0, 5, 100]) {
    for (const bucket of [0, 499, 500, 9999]) {
      const storage = { [COHORT_KEY]: { version: 1, bucket } }
      for (let reopen = 0; reopen < 2; reopen++) {
        const h = harness({ env: 'release', storage }); h.config.rolloutPercent.release = percent
        const expected = bucket < percent * 100
        const context = h.api.getPublicStatsReadContext()
        assert.equal(context.pilotEnabled, expected, `${percent}% / ${bucket}`)
        const pending = h.api.loadPublicStats(context)
        if (expected) h.succeed()
        const result = await pending
        assert.equal(result.diagnostic.source, expected ? 'lighthouse' : 'cloudbase')
        assert.equal(h.state.randomCalls, 0)
        assert.equal(h.state.storageWrites.length, 0)
      }
    }
  }
})

test('develop and trial include all valid buckets without reading user identity or requesting remote configuration', async () => {
  for (const env of ['develop', 'trial']) {
    const h = harness({ env, storage: { [COHORT_KEY]: { version: 1, bucket: 9999 }, openid: 'must-not-read' } })
    const pending = h.api.loadPublicStats(); h.succeed()
    assert.equal((await pending).diagnostic.source, 'lighthouse')
    assert.equal(h.state.cloud.length, 0)
    assert.ok(h.state.storageReads.every(key => [COHORT_KEY, LEGACY_KEY].includes(key)))
    assert.equal(h.state.http.length, 1)
  }
})

test('a new anonymous bucket is persisted once, survives reopening, and never appears in HTTP or diagnostics', async () => {
  const h = harness({ env: 'release' }); h.state.random = 0.0499
  const context = h.api.getPublicStatsReadContext()
  assert.equal(context.pilotEnabled, true)
  assert.deepEqual(h.state.storage[COHORT_KEY], { version: 1, bucket: 499 })
  const pending = h.api.loadPublicStats(context); h.succeed()
  const result = await pending
  assert.equal(h.state.randomCalls, 1)
  assert.equal(h.state.storageWrites.length, 1)
  const reopened = harness({ env: 'release', storage: h.state.storage }); reopened.state.random = 0.9999
  assert.equal(reopened.api.getPublicStatsReadContext().pilotEnabled, true)
  assert.equal(reopened.state.randomCalls, 0)
  assert.equal(JSON.stringify(result).includes('bucket'), false)
  assert.equal(JSON.stringify(h.state.http).includes('bucket'), false)
  assert.equal(JSON.stringify(h.api.getPublicStatsPilotDiagnostics()).includes('bucket'), false)
})

test('invalid cohort state fails closed without silently rerandomizing an installation', async () => {
  for (const saved of [false, 7, {}, { version: 2, bucket: 0 }, { version: 1, bucket: -1 },
    { version: 1, bucket: 10000 }, { version: 1, bucket: 1.5 }, { version: 1, bucket: '1' },
    { version: 1, bucket: 0, openid: 'forbidden' }]) {
    const h = harness({ env: 'release', storage: { [COHORT_KEY]: saved } })
    assert.equal((await h.api.loadPublicStats()).diagnostic.source, 'cloudbase')
    assert.equal(h.state.http.length, 0)
    assert.equal(h.state.randomCalls, 0)
    assert.equal(h.state.storageWrites.length, 0)
  }
})

test('the old developer flag has no rollout authority and is cleaned only once per session', async () => {
  const h = harness({ env: 'release', storage: { [COHORT_KEY]: { version: 1, bucket: 500 }, [LEGACY_KEY]: true } })
  await h.api.loadPublicStats()
  h.state.storage[LEGACY_KEY] = true
  await h.api.loadPublicStats()
  assert.equal(h.state.http.length, 0)
  assert.deepEqual(h.state.removals, [LEGACY_KEY])
  assert.equal(h.state.storageReads.filter(key => key === LEGACY_KEY).length, 1)
})

test('valid snapshot merges concurrent reads, uses fixed HTTPS without credentials, and reports safe counters', async () => {
  const h = harness()
  const context = h.api.getPublicStatsReadContext()
  const first = h.api.loadPublicStats(context)
  const second = h.api.loadPublicStats(context)
  assert.equal(first, second)
  assert.equal(h.state.http.length, 1)
  const options = h.state.http[0]
  assert.equal(options.url, 'https://collect.linkx.ink/v1/public-stats')
  assert.equal(options.method, 'GET')
  assert.equal(options.timeout, 2500)
  assert.equal(options.data, undefined)
  assert.deepEqual(plain(options.header), { Accept: 'application/json' })
  h.succeed()
  const result = await first
  assert.equal(result.diagnostic.source, 'lighthouse')
  assert.equal(result.response.result.data.servedTrips, 84)
  assert.equal(h.state.cloud.length, 0)
  assert.equal(h.state.timers.size, 0)
  assert.deepEqual(plain(h.api.getPublicStatsPilotDiagnostics()), { httpRequests: 1, cloudRequests: 0, fallbacks: 0, discarded: 0, circuitSkips: 0 })
  const counts = h.api.getPublicStatsPilotDiagnostics(); counts.httpRequests = 999
  assert.equal(h.api.getPublicStatsPilotDiagnostics().httpRequests, 1)
})

test('null total remains unknown rather than being converted to zero', async () => {
  const h = harness(); const value = h.snapshot()
  value.data.servedTrips = null; value.revision = hash(value.data)
  const pending = h.api.loadPublicStats(); h.succeed(value)
  const result = await pending
  assert.equal(result.response.result.data.servedTrips, null)
  assert.equal(h.state.cloud.length, 0)
})

test('full schema, dates, six-hour lifetime and exact data hash are validated before accepting a snapshot', async () => {
  const invalid = [
    x => ({ ...x, extra: true }), x => ({ ...x, ok: false }), x => ({ ...x, schemaVersion: 2 }),
    x => ({ ...x, source: 'other' }), x => ({ ...x, snapshotAt: 0 }),
    (x, now) => ({ ...x, snapshotAt: now + 60001, expiresAt: now + 120000 }), (x, now) => ({ ...x, expiresAt: now }),
    x => ({ ...x, expiresAt: x.snapshotAt + 6 * 3600000 + 1 }), x => ({ ...x, expiresAt: '1800000060000' }),
    x => ({ ...x, revision: 'a'.repeat(64) }), x => ({ ...x, revision: x.revision.toUpperCase() }),
    x => ({ ...x, data: { ...x.data, _openid: 'forbidden' } }),
    x => ({ ...x, data: { ...x.data, _id: 'other' } }),
    x => ({ ...x, data: { ...x.data, servedTrips: -1 } }),
    x => ({ ...x, data: { ...x.data, servedTrips: 1.2 } }),
    x => ({ ...x, data: { ...x.data, servedTrips: Number.MAX_SAFE_INTEGER + 1 } }),
    x => ({ ...x, data: { ...x.data, servedTrips: '84' } }),
    x => ({ ...x, data: { ...x.data, coverageText: 'x'.repeat(121) } }),
    x => ({ ...x, data: { ...x.data, coverageText: 'NY\nNJ' } }),
    x => ({ ...x, data: { _id: 'home', servedTrips: 84 } }),
    () => null, () => [], () => '<html>failure</html>'
  ]
  for (const change of invalid) {
    const h = harness(); const value = change(h.snapshot(), h.state.now)
    // A valid hash must not make an otherwise invalid data object acceptable.
    if (value && value.data && Object.keys(value.data).some(key => key === '_openid')) value.revision = hash(value.data)
    const pending = h.api.loadPublicStats(); h.succeed(value)
    const result = await pending
    assert.equal(result.diagnostic.source, 'cloudbase')
    assert.equal(result.diagnostic.reason, 'invalid_snapshot')
    assert.equal(h.state.cloud.length, 1)
    assert.equal(h.api.getPublicStatsPilotDiagnostics().fallbacks, 1)
  }
})

test('a device clock up to 60 seconds behind accepts a fresh snapshot but does not extend expiry', async () => {
  const h = harness()
  const pending = h.api.loadPublicStats()
  h.succeed(h.snapshot({ snapshotAt: h.state.now + 60000, expiresAt: h.state.now + 120000 }))
  assert.equal((await pending).diagnostic.source, 'lighthouse')
  assert.equal(h.state.cloud.length, 0)
})

test('network failure, synchronous exceptions and HTTP errors each fall back exactly once without an HTTP retry', async () => {
  for (const cause of ['fail', 'throw', 'http', 'missingRequest']) {
    const h = harness()
    if (cause === 'throw') h.state.httpThrow = true
    if (cause === 'missingRequest') delete h.wx.request
    const pending = h.api.loadPublicStats()
    if (cause === 'fail') { h.state.http[0].fail(); h.state.http[0].fail() }
    if (cause === 'http') h.succeed(h.snapshot(), 0, 503)
    const result = await pending
    assert.equal(result.diagnostic.source, 'cloudbase')
    assert.equal(h.state.cloud.length, 1)
    assert.ok(h.state.http.length <= 1)
    assert.equal(h.state.timers.size, 0)
    assert.equal(h.api.getPublicStatsPilotDiagnostics().fallbacks, 1)
  }
})

test('2500ms deadline aborts, falls back once, and ignores a late success', async () => {
  const h = harness(); const pending = h.api.loadPublicStats()
  const timer = [...h.state.timers.values()][0]
  assert.equal(timer.ms, 2500); timer.fn()
  const result = await pending
  assert.equal(result.diagnostic.reason, 'timeout')
  assert.equal(result.response.result.data.servedTrips, 42)
  assert.equal(h.state.aborts, 1)
  h.succeed()
  await tick()
  assert.equal(h.state.cloud.length, 1)
  assert.equal(result.response.result.data.servedTrips, 42)
})

test('disabling the configuration during HTTP discards and aborts a late server result; a new read uses cloud', async () => {
  const h = harness(); const old = h.api.loadPublicStats()
  h.config.enabled = false
  const next = h.api.loadPublicStats()
  h.succeed()
  assert.equal((await old).diagnostic.source, 'discarded')
  assert.equal((await next).diagnostic.source, 'cloudbase')
  assert.equal(h.state.aborts, 1)
  assert.equal(h.state.cloud.length, 1)
  assert.equal(h.api.getPublicStatsPilotDiagnostics().fallbacks, 0)
})

test('configuration disabled without another read is rechecked when the response arrives', async () => {
  const h = harness(); const pending = h.api.loadPublicStats()
  h.config.enabled = false; h.succeed()
  assert.equal((await pending).diagnostic.source, 'discarded')
  assert.equal(h.state.cloud.length, 0)
})

test('observed off-on transitions reject obsolete context and cannot merge new requests into an older generation', async () => {
  const h = harness(); const oldContext = h.api.getPublicStatsReadContext(); const old = h.api.loadPublicStats(oldContext)
  h.config.enabled = false; h.api.getPublicStatsReadContext()
  h.config.enabled = true; const newer = h.api.loadPublicStats()
  assert.equal(h.state.http.length, 2)
  h.succeed(h.snapshot({ data: { _id: 'home', servedTrips: 999, coverageText: 'old' } }), 0)
  h.succeed(h.snapshot(), 1)
  assert.equal((await old).diagnostic.source, 'discarded')
  assert.equal((await newer).response.result.data.servedTrips, 84)
  assert.equal((await h.api.loadPublicStats(oldContext)).diagnostic.source, 'discarded')
  assert.equal(h.state.http.length, 2)
})

test('cloud failures propagate without a retry loop, and a later fresh read can recover', async () => {
  const h = harness(); h.state.httpThrow = true; h.state.cloudThrow = true
  await assert.rejects(h.api.loadPublicStats(), /cloud unavailable/)
  assert.equal(h.state.cloud.length, 1)
  h.state.cloudThrow = false
  const recovered = await h.api.loadPublicStats()
  assert.equal(recovered.diagnostic.source, 'cloudbase')
  assert.equal(h.state.cloud.length, 2)
})

test('environment and configuration changes invalidate old responses even if both selections include the installation', async () => {
  for (const change of [h => { h.state.env = 'trial' }, h => { h.config.rolloutPercent.release = 6 }]) {
    const h = harness(); const oldContext = h.api.getPublicStatsReadContext()
    const old = h.api.loadPublicStats(oldContext)
    change(h)
    const next = h.api.loadPublicStats()
    assert.equal(h.state.http.length, 2)
    h.succeed(h.snapshot(), 0)
    h.succeed(h.snapshot(), 1)
    assert.equal((await old).diagnostic.source, 'discarded')
    assert.equal((await next).diagnostic.source, 'lighthouse')
    assert.equal(h.state.aborts, 1)
  }
})

test('an environment or storage failure during HTTP invalidates it and moves subsequent reads to cloud', async () => {
  for (const fault of ['envError', 'storageError']) {
    const h = harness({ env: 'release', storage: { [COHORT_KEY]: { version: 1, bucket: 0 } } }); const old = h.api.loadPublicStats()
    h.state[fault] = true
    const next = h.api.loadPublicStats()
    h.succeed()
    assert.equal((await old).diagnostic.source, 'discarded')
    assert.equal((await next).diagnostic.source, 'cloudbase')
    assert.equal(h.state.cloud.length, 1)
    h.state[fault] = false
    const recovered = h.api.loadPublicStats(); h.succeed()
    assert.equal((await recovered).diagnostic.source, 'lighthouse')
  }
})

test('two consecutive HTTP failures cool down for five minutes, then one shared probe can recover', async () => {
  const h = harness()
  for (let index = 0; index < 2; index++) {
    const pending = h.api.loadPublicStats()
    h.state.http[index].fail()
    assert.equal((await pending).diagnostic.source, 'cloudbase')
  }
  assert.equal(h.api.getPublicStatsReadContext().pilotEnabled, true, 'circuit does not change rollout membership')
  assert.equal((await h.api.loadPublicStats()).diagnostic.reason, 'circuit_open')
  h.state.now += 5 * 60000 - 1
  assert.equal((await h.api.loadPublicStats()).diagnostic.reason, 'circuit_open')
  assert.equal(h.state.http.length, 2)
  assert.equal(h.state.cloud.length, 4)
  assert.equal(h.api.getPublicStatsPilotDiagnostics().fallbacks, 2)
  assert.equal(h.api.getPublicStatsPilotDiagnostics().circuitSkips, 2)
  h.state.now++
  const probe = h.api.loadPublicStats()
  assert.equal(h.api.loadPublicStats(), probe)
  assert.equal(h.state.http.length, 3)
  h.succeed()
  assert.equal((await probe).diagnostic.source, 'lighthouse')
  const afterSuccess = h.api.loadPublicStats(); h.state.http.at(-1).fail()
  await afterSuccess
  const next = h.api.loadPublicStats()
  assert.equal(h.state.http.length, 5, 'success resets consecutive failure count')
  h.succeed(); await next
})

test('a failed cooldown probe reopens the circuit without retrying HTTP', async () => {
  const h = harness(); h.state.httpThrow = true
  await h.api.loadPublicStats(); await h.api.loadPublicStats()
  h.state.now += 5 * 60000
  assert.equal((await h.api.loadPublicStats()).diagnostic.reason, 'request_failed')
  assert.equal(h.state.http.length, 3)
  assert.equal((await h.api.loadPublicStats()).diagnostic.reason, 'circuit_open')
  assert.equal(h.state.http.length, 3)
  assert.equal(h.state.cloud.length, 4)
})

test('concurrent callers count one failed HTTP attempt, while a success breaks the failure streak', async () => {
  const h = harness()
  const reads = Array.from({ length: 5 }, () => h.api.loadPublicStats())
  h.state.http[0].fail(); await Promise.all(reads)
  assert.equal(h.state.cloud.length, 1)
  assert.equal(h.api.getPublicStatsPilotDiagnostics().fallbacks, 1)
  const success = h.api.loadPublicStats(); h.succeed(); await success
  const failure = h.api.loadPublicStats(); h.state.http.at(-1).fail(); await failure
  const next = h.api.loadPublicStats()
  assert.equal(h.state.http.length, 4)
  h.succeed(); assert.equal((await next).diagnostic.source, 'lighthouse')
  assert.equal(h.api.getPublicStatsPilotDiagnostics().circuitSkips, 0)
})

test('clock rollback cannot leave the circuit open indefinitely', async () => {
  const h = harness(); h.state.httpThrow = true
  await h.api.loadPublicStats(); await h.api.loadPublicStats()
  h.state.now -= 60000; h.state.httpThrow = false
  const recovered = h.api.loadPublicStats()
  assert.equal(h.state.http.length, 3)
  h.succeed(); assert.equal((await recovered).diagnostic.source, 'lighthouse')
})
