const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createResearchClient, createWxTransport, validEndpoint, STORAGE_KEY } = require('../utils/researchClient')
const { sha256, utf8ByteLength } = require('../utils/researchHash')
const { validateEvent } = require('../utils/researchSchema')
const defaults = require('../config/research')

const copy = value => JSON.parse(JSON.stringify(value))
const T = 1800700000000
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function grant(overrides = {}) {
  return { accountKey: 'local-account-a', participantKey: 'participant_00000001', grantId: 'consent_grant_000001',
    status: 'active', statusVersion: 1, confirmed: true, purposeVersion: defaults.purposeVersion,
    acceptedPurposeVersion: defaults.purposeVersion, token: 'short-lived-test-token', tokenExpiresAtMs: T + 30 * 86400000, ...overrides }
}
function ack(request) {
  const body = JSON.parse(request.body)
  return { statusCode: 200, data: { ok: true, batchId: body.batchId, payloadHash: sha256(request.body),
    eventCount: body.events.length, receivedAt: T, duplicate: false } }
}
function harness(overrides = {}) {
  const map = overrides.map || new Map()
  const clock = overrides.clock || { now: T }
  const calls = []
  let sequence = 0
  const storage = overrides.storage || {
    get: key => map.has(key) ? copy(map.get(key)) : undefined,
    set: (key, value) => map.set(key, copy(value)), remove: key => map.delete(key)
  }
  const client = createResearchClient({
    storage, now: () => clock.now, random: () => 0,
    makeId: () => `synthetic_${clock.now}_${++sequence}`,
    config: { enabled: true, endpoint: 'https://collect.example.com/v1/batches', maxUploadsPerForeground: 1, ...(overrides.config || {}) },
    transport: request => { calls.push(request); return overrides.transport ? overrides.transport(request) : Promise.resolve(ack(request)) }
  })
  const start = (session = grant()) => { assert.equal(client.setSession(session).ok, true); client.beginForeground() }
  const nextVisit = (ms = 300000) => { client.endForeground(); clock.now += ms; client.beginForeground() }
  return { client, map, clock, calls, start, nextVisit }
}

test('UTF-8 and SHA-256 match Node for boundary lengths, CJK, emoji and unpaired surrogates', () => {
  for (const value of ['', 'abc', '拼车🚗', '\ud800', '\udfff', ...[55, 56, 63, 64, 65, 1000, 65536].map(n => 'a'.repeat(n))]) {
    assert.equal(utf8ByteLength(value), Buffer.byteLength(value))
    assert.equal(sha256(value), crypto.createHash('sha256').update(value).digest('hex'))
  }
})

test('checked-in rollout includes all installations; enabling alone never establishes server authorization', async () => {
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.endpoint, 'https://collect.linkx.ink/v1/batches')
  assert.deepEqual(defaults.rolloutPercent, { develop: 100, trial: 100, release: 100 })
  const h = harness({ config: { enabled: false } })
  h.client.beginForeground()
  assert.equal(h.client.setSession(grant()).ok, false)
  assert.equal(h.client.enqueue('page_view', { page: 'home' }).reason, 'not_participating')
  assert.equal((await h.client.flush()).reason, 'not_participating')
  assert.equal(h.calls.length, 0)
  assert.equal(h.map.has(STORAGE_KEY), false)
  const enabled = harness()
  enabled.client.beginForeground()
  assert.equal(enabled.client.enqueue('page_view', { page: 'home' }).ok, false)
})

test('session requires explicit confirmed active consent and exact accepted purpose version', () => {
  for (const changed of [{ confirmed: false }, { status: 'withdrawn' }, { acceptedPurposeVersion: '' },
    { purposeVersion: 'old' }, { grantId: '' }, { statusVersion: 0 }]) {
    const h = harness()
    assert.equal(h.client.setSession(grant(changed)).ok, false)
    h.client.beginForeground()
    assert.equal(h.client.enqueue('page_view', { page: 'home' }).ok, false)
  }
})

test('HTTPS DNS endpoint only; no HTTP, naked IP, credentials, custom ports, query or fragment', async () => {
  assert.equal(validEndpoint('https://collect.linkx.ink/v1/batches'), true)
  assert.equal(validEndpoint('https://collect.example.com:443/v1/batches'), true)
  for (const endpoint of ['', 'http://collect.example.com/v1/batches', 'https://127.0.0.1/v1/batches',
    'https://[::1]/v1/batches', 'https://localhost/v1/batches', 'https://u:p@a.example/v1/batches',
    'https://a.example:8443/v1/batches', 'https://a.example/v1/batches?a=1', 'https://a.example/v1/batches#x']) {
    assert.equal(validEndpoint(endpoint), false, endpoint)
    const h = harness({ config: { endpoint } }); h.start()
    h.client.enqueue('page_view', { page: 'home' })
    assert.equal((await h.client.flush()).reason, 'endpoint_unavailable')
    assert.equal(h.calls.length, 0)
  }
})

test('no token or expired token never uploads; token and account key never reach persisted state or body', async () => {
  const h = harness(); h.start(grant({ token: '' }))
  assert.equal(h.client.enqueue('page_view', { page: 'home' }).ok, true)
  assert.equal((await h.client.flush()).reason, 'token_required')
  h.client.setSession(grant({ tokenExpiresAtMs: T - 1 }))
  assert.equal((await h.client.flush()).reason, 'token_required')
  h.client.setSession(grant())
  assert.equal((await h.client.flush()).ok, true)
  const saved = JSON.stringify(h.map.get(STORAGE_KEY))
  assert.equal(saved.includes('short-lived-test-token'), false)
  assert.equal(saved.includes('local-account-a'), false)
  assert.equal(h.calls[0].body.includes('participant_'), false)
  assert.equal(h.calls[0].body.includes('consent_grant'), false)
})

test('30 browser events create no automatic requests, concurrent flushes share one batch, visit has one request budget', async () => {
  const pending = deferred()
  const h = harness({ transport: () => pending.promise }); h.start()
  const firstForeground = h.client.beginForeground()
  assert.equal(h.client.beginForeground(), firstForeground)
  for (let i = 0; i < 30; i += 1) assert.equal(h.client.enqueue('page_view', { page: 'home' }).ok, true)
  assert.equal(h.calls.length, 0)
  const a = h.client.flush(), b = h.client.flush()
  assert.equal(a, b)
  await tick(); assert.equal(h.calls.length, 1)
  pending.resolve(ack(h.calls[0]))
  assert.equal((await a).eventCount, 30)
  h.client.enqueue('page_view', { page: 'profile' })
  assert.equal((await h.client.flush()).reason, 'foreground_budget')
  h.nextVisit(1000)
  assert.equal((await h.client.flush()).reason, 'backoff')
  assert.equal(h.calls.length, 1)
})

test('ACK loss, restart and retry preserve exact batch bytes and batchId; token refresh does not re-key body', async () => {
  const h = harness({ transport: () => Promise.reject(new Error('ACK_LOST')) }); h.start()
  h.client.enqueue('page_view', { page: 'home' })
  assert.equal((await h.client.flush()).reason, 'upload_failed')
  const firstBody = h.calls[0].body
  h.clock.now += 300000
  const restarted = harness({ map: h.map, clock: h.clock }); restarted.start(grant({ token: 'new-token' }))
  const result = await restarted.client.flush()
  assert.equal(result.ok, true)
  assert.equal(restarted.calls[0].body, firstBody)
  assert.equal(restarted.calls[0].token, 'new-token')
  assert.equal(restarted.client.getStatus().queuedCount, 0)
})

test('partial or wrong ACK keeps whole immutable batch; late enqueues are not deleted by valid ACK', async () => {
  const pending = deferred()
  const h = harness({ transport: () => pending.promise }); h.start()
  h.client.enqueue('page_view', { page: 'home' })
  const upload = h.client.flush(); await tick()
  h.client.enqueue('page_view', { page: 'profile' })
  pending.resolve(ack(h.calls[0])); await upload
  assert.equal(h.client.getStatus().queuedCount, 1)
  const invalid = harness({ transport: request => Promise.resolve({ ...ack(request), data: { ...ack(request).data, eventCount: 0 } }) })
  invalid.start(); invalid.client.enqueue('page_view', { page: 'home' })
  assert.equal((await invalid.client.flush()).reason, 'invalid_ack')
  assert.equal(invalid.client.getStatus().queuedCount, 1)
  assert.equal(invalid.client.getStatus().pendingCount, 1)
})

test('account and grant changes clear old queue; stale ACK cannot resurrect withdrawn data', async () => {
  const pending = deferred(); let aborts = 0
  const h = harness({ transport: () => ({ promise: pending.promise, abort: () => { aborts += 1 } }) }); h.start()
  h.client.enqueue('page_view', { page: 'home' })
  const upload = h.client.flush(); await tick()
  assert.equal(h.client.withdraw().ok, true)
  assert.equal(aborts, 1)
  assert.equal(h.map.has(STORAGE_KEY), false)
  pending.resolve(ack(h.calls[0]))
  assert.equal((await upload).reason, 'session_changed')
  assert.equal(h.map.has(STORAGE_KEY), false)
  h.start(); h.client.enqueue('page_view', { page: 'home' })
  h.client.setSession(grant({ accountKey: 'account-b', participantKey: 'participant_00000002', grantId: 'consent_grant_000002' }))
  assert.equal(h.client.getStatus().queuedCount, 0)
  h.client.enqueue('page_view', { page: 'profile' })
  h.client.setSession(grant({ accountKey: 'account-b', participantKey: 'participant_00000002', grantId: 'consent_grant_000003', statusVersion: 2 }))
  assert.equal(h.client.getStatus().queuedCount, 0)
})

test('staged request is cancelled before transport starts if consent is cleared synchronously', async () => {
  const h = harness(); h.start(); h.client.enqueue('page_view', { page: 'home' })
  const upload = h.client.flush()
  h.client.clearSession()
  assert.equal((await upload).reason, 'session_changed')
  assert.equal(h.calls.length, 0)
})

test('500-event cap and TTL are explicit, including entire expired pending batch', async () => {
  const h = harness({ transport: () => Promise.reject(new Error('OFFLINE')) }); h.start()
  for (let i = 0; i < 500; i += 1) assert.equal(h.client.enqueue('page_view', { page: 'home' }).ok, true)
  assert.equal(h.client.enqueue('page_view', { page: 'home' }).reason, 'queue_limit')
  await h.client.flush()
  h.nextVisit(7 * 86400000 + 1)
  assert.equal((await h.client.flush()).empty, true)
  assert.equal(h.client.getStatus().queuedCount, 0)
  assert.equal(h.client.getStatus().dropped.expired, 500)
  assert.equal(h.client.getStatus().dropped.queueLimit, 1)
})

test('small storage budget retains room for an immutable batch and can drain without a capacity deadlock', async () => {
  const h = harness({ config: { maxQueueBytes: 2500 } }); h.start()
  let accepted = 0
  while (accepted < 100 && h.client.enqueue('page_view', { page: 'home' }).ok) accepted += 1
  assert.ok(accepted > 1 && accepted < 100)
  let attempts = 0
  while (h.client.getStatus().queuedCount) {
    const result = await h.client.flush()
    assert.equal(result.ok, true)
    assert.ok(Buffer.byteLength(JSON.stringify(h.map.get(STORAGE_KEY))) <= 2500)
    h.nextVisit(); attempts += 1
    assert.ok(attempts <= accepted)
  }
})

test('wire batches honor both 50-event and 64KiB bounds without mutating a sent batch', async () => {
  const h = harness(); h.start()
  for (let i = 0; i < 70; i += 1) h.client.enqueue('page_view', { page: 'home' })
  assert.equal((await h.client.flush()).eventCount, 50)
  h.nextVisit(); assert.equal((await h.client.flush()).eventCount, 20)
  const many = harness(); many.start()
  const candidates = Array.from({ length: 50 }, (_, i) => ({ tripKey: `synthetic_trip_${String(i).padStart(4, '0')}`, tripType: 'carpool',
    position: i, availableSeats: 2, tripVersion: 1, referencePriceCents: 1000, currency: 'USD', priceKind: 'driverReference' }))
  for (let i = 0; i < 10; i += 1) many.client.enqueue('result_set_rendered', { searchId: 'synthetic_search_001', selectionSetId: 'synthetic_choice_001',
    source: 'network', renderedCount: 50, loadedDateCount: 2, hasMore: true, candidatesComplete: true, candidates })
  const sent = await many.client.flush()
  assert.equal(sent.ok, true)
  assert.ok(sent.eventCount < 10)
  assert.ok(Buffer.byteLength(many.calls[0].body) <= 65536)
})

test('a small in-flight batch cannot admit a late large event that deadlocks the next batch', async () => {
  const pending = deferred()
  const h = harness({ config: { maxQueueBytes: 3000 }, transport: () => pending.promise }); h.start()
  h.client.enqueue('page_view', { page: 'home' })
  const upload = h.client.flush(); await tick()
  const candidates = Array.from({ length: 10 }, (_, i) => ({ tripKey: `synthetic_trip_${String(i).padStart(4, '0')}`,
    tripType: 'carpool', position: i, availableSeats: 2 }))
  const result = h.client.enqueue('result_set_rendered', { searchId: 'synthetic_search_001', selectionSetId: 'synthetic_choice_001',
    source: 'network', renderedCount: 10, loadedDateCount: 2, hasMore: false, candidatesComplete: true, candidates })
  assert.equal(result.reason, 'queue_limit')
  const beforeFlight = harness({ config: { maxQueueBytes: 3000 } }); beforeFlight.start()
  beforeFlight.client.enqueue('page_view', { page: 'home' })
  assert.equal(beforeFlight.client.enqueue('result_set_rendered', { searchId: 'synthetic_search_001', selectionSetId: 'synthetic_choice_001',
    source: 'network', renderedCount: 10, loadedDateCount: 2, hasMore: false, candidatesComplete: true, candidates }).reason, 'queue_limit')
  assert.equal(h.client.enqueue('page_view', { page: 'profile' }).ok, true)
  pending.resolve(ack(h.calls[0])); await upload
  h.nextVisit()
  // A restarted transport uses the persisted queue just as the next session does.
  const next = harness({ config: { maxQueueBytes: 3000 }, map: h.map, clock: h.clock }); next.start()
  assert.equal((await next.client.flush()).ok, true)
  assert.equal(next.client.getStatus().queuedCount, 0)
})

test('event whitelist rejects personal fields, forged business facts and false complete choice sets', () => {
  const h = harness(); h.start()
  for (const [name, data] of [['page_view', { page: 'home', openid: 'private' }], ['joined_successfully', {}],
    ['page_view', { page: 'home', note: 'free text' }], ['search_submitted', { searchId: 'synthetic_search_001', tripType: 'all', serviceDate: '2026-02-30' }],
    ['result_set_rendered', { searchId: 'synthetic_search_001', selectionSetId: 'synthetic_choice_001', source: 'cache', renderedCount: 2,
      loadedDateCount: 1, hasMore: false, candidatesComplete: true, candidates: [] }]]) {
    assert.equal(h.client.enqueue(name, data).reason, 'invalid_event')
  }
  assert.equal(h.client.getStatus().queuedCount, 0)
  const future = { eventId: 'synthetic_event_001', eventName: 'page_view', schemaVersion: 1, occurredAt: T + 300001, data: { page: 'home' } }
  assert.equal(validateEvent(future, T), false)
  assert.equal(h.client.enqueue('page_view', { page: 'home' }, { eventId: 'synthetic_event_001' }).ok, true)
  assert.equal(h.client.enqueue('page_view', { page: 'home' }, { eventId: 'synthetic_event_001' }).duplicate, true)
  assert.equal(h.client.enqueue('page_view', { page: 'profile' }, { eventId: 'synthetic_event_001' }).reason, 'event_conflict')
})

test('401 waits for refreshed token; 403 clears participation; permanent malformed batch halts across restart', async () => {
  const h = harness({ transport: () => Promise.resolve({ statusCode: 401, data: { code: 'TOKEN_EXPIRED' } }) }); h.start()
  h.client.enqueue('page_view', { page: 'home' }); await h.client.flush(); h.nextVisit()
  assert.equal((await h.client.flush()).reason, 'token_required')
  assert.equal(h.client.getStatus().queuedCount, 1)
  const denied = harness({ transport: () => Promise.resolve({ statusCode: 403, data: { code: 'PARTICIPATION_INACTIVE' } }) }); denied.start()
  denied.client.enqueue('page_view', { page: 'home' })
  assert.equal((await denied.client.flush()).reason, 'participation_inactive')
  assert.equal(denied.map.has(STORAGE_KEY), false)
  const invalid = harness({ transport: () => Promise.resolve({ statusCode: 422, data: { code: 'INVALID_BATCH' } }) }); invalid.start()
  invalid.client.enqueue('page_view', { page: 'home' }); await invalid.client.flush()
  const restarted = harness({ map: invalid.map, clock: invalid.clock }); restarted.start()
  assert.equal((await restarted.client.flush()).reason, 'invalid_batch')
  assert.equal(restarted.calls.length, 0)
})

test('Retry-After and exponential backoff survive restart; no hidden retry timers', async () => {
  const h = harness({ transport: () => Promise.resolve({ statusCode: 429, headers: { 'Retry-After': '3600' } }) }); h.start()
  h.client.enqueue('page_view', { page: 'home' }); await h.client.flush()
  assert.equal(h.client.getStatus().nextAttemptAt, T + 3600000)
  h.nextVisit(300000)
  const restarted = harness({ map: h.map, clock: h.clock }); restarted.start()
  assert.equal((await restarted.client.flush()).reason, 'backoff')
  assert.equal(restarted.calls.length, 0)
})

test('storage failures fail closed, never send unpersisted batch, and report incomplete local cleanup', async () => {
  const storage = { get: () => undefined, set: () => { throw new Error('DISK_FULL') }, remove: () => { throw new Error('UNAVAILABLE') } }
  const h = harness({ storage })
  assert.equal(h.client.setSession(grant()).reason, 'storage_unavailable')
  h.client.beginForeground()
  assert.equal(h.client.enqueue('page_view', { page: 'home' }).reason, 'storage_unavailable')
  assert.equal((await h.client.flush()).reason, 'storage_unavailable')
  assert.equal(h.client.withdraw().ok, false)
  assert.equal(h.calls.length, 0)
})

test('wx transport sends exact string body and token only in Authorization, with abort support', async () => {
  let received, aborted = 0
  const transport = createWxTransport({ request: args => { received = args; return { abort: () => { aborted += 1 } } } })
  const request = { url: 'https://collect.example.com/v1/batches', body: '{"events":[]}', token: 'secret-token', timeoutMs: 10000 }
  const result = transport(request)
  assert.equal(received.data, request.body)
  assert.equal(received.header.Authorization, 'Bearer secret-token')
  assert.equal(received.url.includes('secret-token'), false)
  result.abort(); assert.equal(aborted, 1)
  received.success({ statusCode: 200, data: { ok: true } })
  assert.equal((await result.promise).statusCode, 200)
})

test('SDK fixtures for every event type pass the actual collector validator', async () => {
  const { validateBatch } = await import('../services/research-collector/src/validation.mjs')
  const h = harness({ transport: request => {
    validateBatch(JSON.parse(request.body), T)
    return Promise.resolve(ack(request))
  } }); h.start()
  const trip = { tripKey: 'synthetic_trip_0001', tripType: 'carpool' }
  const fixtures = [
    ['page_view', { page: 'carpool_list' }],
    ['search_submitted', { searchId: 'synthetic_search_001', tripType: 'all', serviceDate: '2026-09-23', originArea: 'fort_lee', partySize: 1 }],
    ['result_set_rendered', { searchId: 'synthetic_search_001', selectionSetId: 'synthetic_choice_001', source: 'cache',
      renderedCount: 1, loadedDateCount: 2, hasMore: false, candidatesComplete: true, candidates: [{ ...trip, position: 0, availableSeats: 2 }] }],
    ['result_card_visible', { ...trip, selectionSetId: 'synthetic_choice_001', position: 0, visibilityBucket: 'half_1s' }],
    ['trip_detail_opened', { ...trip, source: 'list' }],
    ['contact_entry_clicked', { ...trip, method: 'wechat' }],
    ['no_suitable_option', { searchId: 'synthetic_search_001', reason: 'time' }],
    ['collection_diagnostic', { reason: 'queue_limit', droppedCount: 1 }]
  ]
  for (const [name, data] of fixtures) assert.equal(h.client.enqueue(name, data).ok, true, name)
  assert.equal((await h.client.flush()).eventCount, fixtures.length)
})

test('configured foreground budget permits 40 spaced batches then stops until another foreground', async () => {
  const h = harness({ config: { maxUploadsPerForeground: 40 } }); h.start()
  for (let index = 0; index < 40; index += 1) {
    assert.equal(h.client.enqueue('page_view', { page: 'home' }).ok, true)
    assert.equal((await h.client.flush()).ok, true)
    h.clock.now += 15000
  }
  h.client.enqueue('page_view', { page: 'home' })
  assert.equal((await h.client.flush()).reason, 'foreground_budget')
  assert.equal(h.calls.length, 40)
  h.nextVisit(15000)
  assert.equal((await h.client.flush()).ok, true)
})

test('place request uses same-host fixed API with in-memory bearer and no identity or arbitrary URL', async () => {
  const h = harness({ transport: async request => ({ statusCode: 200, data: { ok: true, places: [] } }) }); h.start()
  const payload = { schemaVersion: 1, cityKey: 'ny_nj', field: 'departure', mode: 'driver', counterpartPlaceId: 'columbia' }
  assert.deepEqual(await h.client.requestPlaceSuggestions(payload), { ok: true, places: [] })
  assert.equal(h.calls[0].url, 'https://collect.example.com/v1/place-suggestions')
  assert.equal(h.calls[0].token, 'short-lived-test-token')
  assert.deepEqual(JSON.parse(h.calls[0].body), payload)
  assert.equal(JSON.stringify(h.map).includes('short-lived-test-token'), false)
  for (const changed of [{ openid: 'other-account' }, { url: 'https://evil.example' }, { cityKey: '../x' }, { field: 'unknown' }]) {
    assert.equal(await h.client.requestPlaceSuggestions({ ...payload, ...changed }), null)
  }
  assert.equal(h.calls.length, 1)
})

test('personalized response is discarded after logout or account change, and no authorization never sends', async () => {
  const response = deferred(); let aborted = 0
  const h = harness({ transport: () => ({ promise: response.promise, abort() { aborted++ } }) })
  const payload = { schemaVersion: 1, cityKey: 'ny_nj', field: 'destination', mode: 'passenger' }
  assert.equal(await h.client.requestPlaceSuggestions(payload), null)
  assert.equal(h.calls.length, 0)
  h.start()
  const pending = h.client.requestPlaceSuggestions(payload)
  h.client.setSession(grant({ accountKey: 'b', participantKey: 'participant_00000002', grantId: 'consent_grant_000002' }))
  response.resolve({ statusCode: 200, data: { ok: true, places: [{ label: 'old account' }] } })
  assert.equal(await pending, null)
  assert.equal(aborted, 1)
  h.client.clearSession()
  assert.equal(await h.client.requestPlaceSuggestions(payload), null)
})
