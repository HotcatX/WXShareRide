const defaults = require('../config/research')
const { sha256, utf8ByteLength } = require('./researchHash')
const { validateEvent, isOpaqueId } = require('./researchSchema')

const STORAGE_KEY = 'ride_research_queue_v1'
const clone = value => JSON.parse(JSON.stringify(value))

function validEndpoint(endpoint) {
  if (typeof endpoint !== 'string') return false
  // Only an approved HTTPS DNS host on the standard port; no IP/domain bypass.
  const match = /^https:\/\/([a-z0-9.-]+)(?::443)?\/v1\/batches$/.exec(endpoint)
  if (!match || match[1].length > 253 || /^\d+(?:\.\d+)+$/.test(match[1])) return false
  const labels = match[1].split('.')
  return labels.length >= 2 && /^[a-z]{2,63}$/.test(labels[labels.length - 1]) &&
    labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
}

function createWxTransport(wxApi) {
  return request => {
    let task
    const promise = new Promise((resolve, reject) => {
      if (!wxApi || typeof wxApi.request !== 'function') { reject(new Error('TRANSPORT_UNAVAILABLE')); return }
      task = wxApi.request({
        url: request.url, method: 'POST', data: request.body,
        header: { 'content-type': 'application/json', Authorization: `Bearer ${request.token}` },
        timeout: request.timeoutMs,
        success: response => resolve({ statusCode: response.statusCode, data: response.data, headers: response.header || {} }),
        fail: () => reject(new Error('NETWORK_ERROR'))
      })
    })
    return { promise, abort: () => { if (task && typeof task.abort === 'function') task.abort() } }
  }
}

function createResearchClient(options = {}) {
  const config = { ...defaults, ...(options.config || {}) }
  const wxApi = options.wx || (typeof wx !== 'undefined' ? wx : null)
  const storage = options.storage || (wxApi && {
    get: key => wxApi.getStorageSync(key), set: (key, value) => wxApi.setStorageSync(key, value),
    remove: key => wxApi.removeStorageSync(key)
  })
  const transport = options.transport || createWxTransport(wxApi)
  const now = options.now || Date.now
  const random = options.random || Math.random
  let sequence = 0
  const makeId = options.makeId || (() => `rr_${now().toString(36)}_${(++sequence).toString(36)}_${Math.floor(random() * 0x100000000).toString(36)}_${Math.floor(random() * 0x100000000).toString(36)}`)
  const bounded = (value, fallback, max) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback
  const limits = {
    batchEvents: bounded(config.maxBatchEvents, 50, 50), batchBytes: bounded(config.maxBatchBytes, 65536, 65536),
    queueEvents: bounded(config.maxQueueEvents, 500, 500), queueBytes: bounded(config.maxQueueBytes, 262144, 262144),
    ttlMs: bounded(config.eventTtlMs, defaults.eventTtlMs, defaults.eventTtlMs),
    minInterval: Math.max(defaults.minUploadIntervalMs, Number(config.minUploadIntervalMs) || 0),
    timeoutMs: bounded(config.requestTimeoutMs, 10000, 30000),
    foregroundUploads: bounded(config.maxUploadsPerForeground, 40, 40)
  }
  let session = null
  let token = ''
  let tokenExpiresAtMs = 0
  let state = null
  let foregroundId = ''
  let attemptsThisForeground = 0
  let generation = 0
  let activeFlight = null
  const placeFlights = new Set()
  let placeRequestsThisForeground = 0
  let storageBlocked = false
  let halted = ''
  let cachedContext
  function eventContext() {
    if (cachedContext) return cachedContext
    const context = {}
    const safeVersion = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)
    try {
      const mini = wxApi.getAccountInfoSync().miniProgram || {}
      if (safeVersion(mini.version || config.buildVersion)) context.clientVersion = mini.version || config.buildVersion
      context.buildMode = ['develop', 'trial', 'release'].includes(mini.envVersion) ? mini.envVersion : 'unknown'
    } catch (_) { if (safeVersion(config.buildVersion)) context.clientVersion = config.buildVersion }
    try {
      const device = typeof wxApi.getDeviceInfo === 'function' ? wxApi.getDeviceInfo() : {}
      context.platform = ['ios', 'android', 'devtools', 'windows', 'mac', 'ohos'].includes(device.platform) ? device.platform : 'unknown'
      const base = typeof wxApi.getAppBaseInfo === 'function' ? wxApi.getAppBaseInfo() : {}
      if (safeVersion(base.SDKVersion)) context.sdkVersion = base.SDKVersion
    } catch (_) {}
    cachedContext = context
    return context
  }

  function eligible() {
    return config.enabled === true && !!session && session.status === 'active' && session.confirmed === true &&
      session.purposeVersion === config.purposeVersion && session.acceptedPurposeVersion === config.purposeVersion
  }

  function freshState() {
    return { schemaVersion: 1, participantKey: session.participantKey, grantId: session.grantId,
      statusVersion: session.statusVersion, purposeVersion: session.purposeVersion,
      events: [], pending: null, failureCount: 0, nextAttemptAt: 0, lastAttemptAt: 0, halted: '',
      dropped: { expired: 0, queueLimit: 0, invalid: 0 } }
  }

  function save(next) {
    try {
      if (!storage || typeof storage.set !== 'function') throw new Error('STORAGE_UNAVAILABLE')
      if (utf8ByteLength(JSON.stringify(next)) > limits.queueBytes) throw new Error('STORAGE_BUDGET')
      storage.set(STORAGE_KEY, clone(next))
      state = next
      storageBlocked = false
      return true
    } catch (_) {
      storageBlocked = true
      return false
    }
  }

  function purge() {
    generation += 1
    token = ''; tokenExpiresAtMs = 0
    state = null
    if (activeFlight && activeFlight.abort) { try { activeFlight.abort() } catch (_) {} }
    placeFlights.forEach(flight => { try { if (flight.abort) flight.abort() } catch (_) {} })
    try {
      if (!storage || typeof storage.remove !== 'function') throw new Error('STORAGE_UNAVAILABLE')
      storage.remove(STORAGE_KEY)
      storageBlocked = false
      return true
    } catch (_) {
      // Fail closed. The caller must not report local cleanup as successful.
      storageBlocked = true
      return false
    }
  }

  function prune(next) {
    const cutoff = now() - limits.ttlMs
    const expired = new Set(next.events.filter(event => event.occurredAt < cutoff).map(event => event.eventId))
    // A previously sent batch is immutable; never edit and reuse its batchId.
    if (next.pending && next.pending.eventIds.some(id => expired.has(id))) {
      next.pending.eventIds.forEach(id => expired.add(id))
      next.pending = null
    }
    if (expired.size) {
      next.events = next.events.filter(event => !expired.has(event.eventId))
      next.dropped.expired += expired.size
    }
    return next
  }

  function sameGrant(saved) {
    return saved && saved.schemaVersion === 1 && saved.participantKey === session.participantKey &&
      saved.grantId === session.grantId && saved.statusVersion === session.statusVersion && saved.purposeVersion === session.purposeVersion
  }

  function readSavedState() {
    try {
      const saved = storage && storage.get(STORAGE_KEY)
      if (!sameGrant(saved)) return freshState()
      if (!Array.isArray(saved.events) || saved.events.length > limits.queueEvents ||
        utf8ByteLength(JSON.stringify(saved)) > limits.queueBytes) return freshState()
      const ids = new Set()
      for (const event of saved.events) {
        // Expired events are pruned below; all other schema checks still apply.
        const validationTime = Math.min(now(), event.occurredAt + limits.ttlMs)
        if (!validateEvent(event, validationTime, limits.ttlMs) || ids.has(event.eventId)) return freshState()
        ids.add(event.eventId)
      }
      for (const key of ['failureCount', 'nextAttemptAt', 'lastAttemptAt']) {
        if (!Number.isSafeInteger(saved[key]) || saved[key] < 0) return freshState()
      }
      if (!saved.dropped || ['expired', 'queueLimit', 'invalid'].some(key => !Number.isSafeInteger(saved.dropped[key]) || saved.dropped[key] < 0)) return freshState()
      if (!['', 'batch_conflict', 'invalid_batch'].includes(saved.halted)) return freshState()
      if (saved.pending) {
        const pending = saved.pending
        if (!isOpaqueId(pending.batchId) || typeof pending.body !== 'string' ||
          utf8ByteLength(pending.body) > limits.batchBytes || sha256(pending.body) !== pending.payloadHash ||
          !Array.isArray(pending.eventIds) || pending.eventIds.length < 1 || pending.eventIds.length > limits.batchEvents) return freshState()
        const payload = JSON.parse(pending.body)
        if (JSON.stringify(Object.keys(payload)) !== JSON.stringify(['schemaVersion', 'batchId', 'events']) || payload.schemaVersion !== 1 ||
          payload.batchId !== pending.batchId || !Array.isArray(payload.events) || payload.events.length !== pending.eventIds.length ||
          payload.events.some((event, i) => event.eventId !== pending.eventIds[i] ||
            JSON.stringify(event) !== JSON.stringify(saved.events[i]))) return freshState()
      }
      return prune(clone(saved))
    } catch (_) { return freshState() }
  }

  function setSession(value) {
    const valid = value && typeof value.accountKey === 'string' && value.accountKey.length > 0 &&
      isOpaqueId(value.participantKey) && isOpaqueId(value.grantId) && Number.isSafeInteger(value.statusVersion) && value.statusVersion >= 1 && value.statusVersion <= 2147483647 &&
      value.status === 'active' && value.confirmed === true && value.purposeVersion === config.purposeVersion &&
      value.acceptedPurposeVersion === config.purposeVersion && config.enabled === true
    if (!valid) { session = null; const cleared = purge(); halted = ''; return { ok: false, reason: 'not_participating', cleared } }
    const changed = session && (session.accountKey !== value.accountKey || session.participantKey !== value.participantKey ||
      session.grantId !== value.grantId || session.statusVersion !== value.statusVersion || session.purposeVersion !== value.purposeVersion)
    if (changed && !purge()) { session = null; return { ok: false, reason: 'storage_unavailable' } }
    // Do not correlate two accounts/grants by reusing an application-session ID.
    // Keep the upload budget for this foreground visit; changing account is not
    // a way to bypass its network limit.
    if (changed && foregroundId) foregroundId = makeId()
    session = { accountKey: value.accountKey, participantKey: value.participantKey, grantId: value.grantId,
      statusVersion: value.statusVersion, purposeVersion: value.purposeVersion, acceptedPurposeVersion: value.acceptedPurposeVersion,
      status: value.status, confirmed: true }
    token = typeof value.token === 'string' ? value.token : ''
    tokenExpiresAtMs = Number.isSafeInteger(value.tokenExpiresAtMs) ? value.tokenExpiresAtMs : 0
    if (token.length > 2048 || /\s/.test(token)) { token = ''; tokenExpiresAtMs = 0 }
    if (!state || !sameGrant(state) || storageBlocked) {
      if (!save(readSavedState())) return { ok: false, reason: 'storage_unavailable' }
      halted = state.halted
    }
    return { ok: true, queuedCount: state.events.length }
  }

  function clearSession() {
    session = null
    foregroundId = ''; attemptsThisForeground = 0; halted = ''
    return { ok: purge() }
  }

  function beginForeground(sessionId) {
    if (foregroundId) return foregroundId // app/page duplicate onShow share one session.
    const nextId = sessionId || makeId()
    if (!isOpaqueId(nextId)) return ''
    foregroundId = nextId
    attemptsThisForeground = 0
    placeRequestsThisForeground = 0
    return foregroundId
  }

  function endForeground() { foregroundId = '' }

  function futureBatchBudget(next) {
    const baseBytes = utf8ByteLength(JSON.stringify({ ...next, pending: null }))
    let largestPendingBytes = 4 // JSON null.
    for (const event of next.events) {
      const body = JSON.stringify({ schemaVersion: 1, batchId: 'x'.repeat(80), events: [event] })
      const pending = { batchId: 'x'.repeat(80), body, payloadHash: 'x'.repeat(64), eventIds: [event.eventId] }
      largestPendingBytes = Math.max(largestPendingBytes, utf8ByteLength(JSON.stringify(pending)))
    }
    // Any later event can become the head after a smaller batch is confirmed.
    // Reserving the largest singleton alongside the entire remaining queue is
    // conservative, but guarantees that every future head can make progress.
    return baseBytes + largestPendingBytes - 4
  }

  function enqueue(eventName, data, meta = {}) {
    if (!eligible()) return { ok: false, reason: 'not_participating' }
    if (storageBlocked || !state) return { ok: false, reason: 'storage_unavailable' }
    if (!foregroundId) return { ok: false, reason: 'not_foreground' }
    let event
    try {
      event = clone({ eventId: meta.eventId || makeId(), eventName, schemaVersion: 1,
        occurredAt: meta.occurredAt === undefined ? now() : meta.occurredAt,
        sessionId: meta.sessionId || foregroundId, data, context: eventContext() })
    } catch (_) { return { ok: false, reason: 'invalid_event' } }
    if (!validateEvent(event, now(), limits.ttlMs)) return { ok: false, reason: 'invalid_event' }
    const next = prune(clone(state))
    const existing = next.events.find(item => item.eventId === event.eventId)
    if (existing) return JSON.stringify(existing) === JSON.stringify(event)
      ? { ok: true, eventId: event.eventId, duplicate: true }
      : { ok: false, reason: 'event_conflict' }
    // Reserve enough room for the immutable wire body, which is also persisted.
    const single = JSON.stringify({ schemaVersion: 1, batchId: 'x'.repeat(80), events: [event] })
    if (utf8ByteLength(single) > limits.batchBytes) return { ok: false, reason: 'event_too_large' }
    next.events.push(event)
    // Keep enough disk budget to persist at least the first immutable batch.
    // Do not accept a queue that cannot ever create its next request.
    const budgets = [next.pending ? utf8ByteLength(JSON.stringify(next)) : futureBatchBudget(next)]
    if (next.pending) {
      const inFlightIds = new Set(next.pending.eventIds)
      // After ACK, a larger event enqueued during this flight becomes the head.
      // Reserve its own wire copy as well, not just today's smaller pending body.
      budgets.push(futureBatchBudget({ ...next, pending: null,
        events: next.events.filter(item => !inFlightIds.has(item.eventId)) }))
    }
    if (next.events.length > limits.queueEvents || budgets.some(bytes => bytes + 256 > limits.queueBytes)) {
      next.events.pop()
      next.dropped.queueLimit += 1
      save(next)
      return { ok: false, reason: 'queue_limit' }
    }
    return save(next) ? { ok: true, eventId: event.eventId, duplicate: false } : { ok: false, reason: 'storage_unavailable' }
  }

  function createPending(next) {
    if (next.pending) return next.pending
    const batchId = makeId()
    if (!isOpaqueId(batchId)) return null
    let events = [], pending = null
    for (const event of next.events.slice(0, limits.batchEvents)) {
      const proposed = [...events, event]
      const body = JSON.stringify({ schemaVersion: 1, batchId, events: proposed })
      if (utf8ByteLength(body) > limits.batchBytes) break
      const candidate = { batchId, body, payloadHash: '0'.repeat(64), eventIds: proposed.map(item => item.eventId) }
      if (utf8ByteLength(JSON.stringify({ ...next, pending: candidate })) + 128 > limits.queueBytes) break
      events = proposed; pending = candidate
    }
    if (pending) pending.payloadHash = sha256(pending.body)
    next.pending = pending
    return pending
  }

  function backoff(next, retryAfterMs) {
    next.failureCount = Math.min(next.failureCount + 1, 30)
    const base = Math.max(1000, Number(config.retryBaseMs) || defaults.retryBaseMs)
    const max = Math.max(base, Number(config.retryMaxMs) || defaults.retryMaxMs)
    const jittered = Math.min(max, base * Math.pow(2, Math.min(next.failureCount - 1, 20)) * (1 + Math.min(1, Math.max(0, random())) * 0.25))
    next.nextAttemptAt = now() + Math.ceil(Math.max(limits.minInterval, jittered, Math.min(24 * 60 * 60 * 1000, retryAfterMs || 0)))
    save(next)
  }

  function flush() {
    if (activeFlight) return activeFlight.promise
    if (!eligible()) return Promise.resolve({ ok: false, reason: 'not_participating' })
    if (!foregroundId) return Promise.resolve({ ok: false, reason: 'not_foreground' })
    if (storageBlocked || !state) return Promise.resolve({ ok: false, reason: 'storage_unavailable' })
    if (halted) return Promise.resolve({ ok: false, reason: halted })
    if (!validEndpoint(config.endpoint)) return Promise.resolve({ ok: false, reason: 'endpoint_unavailable' })
    if (!token || tokenExpiresAtMs <= now()) return Promise.resolve({ ok: false, reason: 'token_required' })
    if (attemptsThisForeground >= limits.foregroundUploads) return Promise.resolve({ ok: false, reason: 'foreground_budget' })
    if ((state.lastAttemptAt && now() - state.lastAttemptAt < limits.minInterval) || now() < state.nextAttemptAt) {
      return Promise.resolve({ ok: false, reason: 'backoff', nextAttemptAt: Math.max(state.nextAttemptAt, state.lastAttemptAt + limits.minInterval) })
    }
    const next = prune(clone(state))
    if (!next.events.length) { save(next); return Promise.resolve({ ok: true, empty: true }) }
    const pending = createPending(next)
    if (!pending) return Promise.resolve({ ok: false, reason: 'batch_storage_limit' })
    next.lastAttemptAt = now()
    if (!save(next)) return Promise.resolve({ ok: false, reason: 'storage_unavailable' })
    attemptsThisForeground += 1
    const requestGeneration = generation
    const flight = { abort: null, promise: null }
    activeFlight = flight
    flight.promise = Promise.resolve().then(() => {
      if (!eligible() || generation !== requestGeneration) return { statusCode: 0, data: null }
      const sent = transport({ url: config.endpoint, body: pending.body, token, timeoutMs: limits.timeoutMs })
      if (sent && sent.promise) { flight.abort = sent.abort; return sent.promise }
      return sent
    }).then(response => {
      if (generation !== requestGeneration || !eligible() || !state) return { ok: false, reason: 'session_changed' }
      const statusCode = Number(response && response.statusCode)
      const result = response && response.data
      if (statusCode === 200 && result && result.ok === true && result.batchId === pending.batchId &&
        result.payloadHash === pending.payloadHash && result.eventCount === pending.eventIds.length) {
        const confirmed = new Set(pending.eventIds)
        const updated = clone(state)
        updated.events = updated.events.filter(event => !confirmed.has(event.eventId))
        updated.pending = null; updated.failureCount = 0; updated.nextAttemptAt = 0
        if (!save(updated)) return { ok: false, reason: 'storage_unavailable' }
        return { ok: true, batchId: pending.batchId, eventCount: pending.eventIds.length, duplicate: result.duplicate === true }
      }
      if (statusCode === 401) { token = ''; tokenExpiresAtMs = 0; return { ok: false, reason: 'token_required' } }
      if (statusCode === 403) { session = null; const cleared = purge(); return { ok: false, reason: 'participation_inactive', cleared } }
      if (statusCode === 409 || statusCode === 422) {
        halted = statusCode === 409 ? 'batch_conflict' : 'invalid_batch'
        save({ ...clone(state), halted })
        return { ok: false, reason: halted }
      }
      const headers = (response && response.headers) || {}
      const retrySeconds = Number(headers['retry-after'] || headers['Retry-After'])
      backoff(clone(state), Number.isFinite(retrySeconds) && retrySeconds > 0 ? retrySeconds * 1000 : 0)
      return { ok: false, reason: statusCode === 200 ? 'invalid_ack' : 'upload_failed' }
    }).catch(() => {
      if (generation !== requestGeneration || !eligible() || !state) return { ok: false, reason: 'session_changed' }
      backoff(clone(state))
      return { ok: false, reason: 'upload_failed' }
    }).finally(() => { if (activeFlight === flight) activeFlight = null })
    return flight.promise
  }

  function getStatus() {
    return { enabled: config.enabled === true, participating: eligible(), foreground: !!foregroundId,
      queuedCount: state ? state.events.length : 0, pendingCount: state && state.pending ? state.pending.eventIds.length : 0,
      nextAttemptAt: state ? state.nextAttemptAt : 0, lastAttemptAt: state ? state.lastAttemptAt : 0,
      attemptsThisForeground, maxUploadsPerForeground: limits.foregroundUploads,
      tokenRequired: eligible() && (!token || tokenExpiresAtMs <= now()),
      inFlight: !!activeFlight, storageBlocked, halted,
      dropped: state ? { ...state.dropped } : { expired: 0, queueLimit: 0, invalid: 0 } }
  }

  async function requestPlaceSuggestions(payload) {
    // This is deliberately a single-purpose method, never a generic authenticated
    // HTTP proxy. Session credentials stay inside this client and out of storage.
    if (!eligible() || !foregroundId || !token || tokenExpiresAtMs <= now() ||
      !validEndpoint(config.endpoint) || placeRequestsThisForeground >= 30 || placeFlights.size >= 2) return null
    if (!payload || payload.schemaVersion !== 1 || typeof payload.cityKey !== 'string' ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(payload.cityKey) ||
      !['departure', 'destination'].includes(payload.field) || !['driver', 'passenger', 'filter'].includes(payload.mode) ||
      Object.keys(payload).some(key => !['schemaVersion', 'cityKey', 'field', 'mode', 'counterpartPlaceId'].includes(key)) ||
      (payload.counterpartPlaceId !== undefined && (typeof payload.counterpartPlaceId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(payload.counterpartPlaceId)))) return null
    const epoch = generation
    const flight = { abort: null }
    placeFlights.add(flight); placeRequestsThisForeground++
    try {
      const sent = transport({ url: config.endpoint.replace(/\/v1\/batches$/, '/v1/place-suggestions'),
        body: JSON.stringify(payload), token, timeoutMs: 2500 })
      if (sent && sent.promise) flight.abort = sent.abort
      const response = await (sent && sent.promise ? sent.promise : sent)
      if (generation !== epoch || !eligible() || !foregroundId) return null
      if (response && (response.statusCode === 401 || response.statusCode === 403 && response.data && response.data.error === 'PLACE_SCOPE_REQUIRED')) {
        token = ''; tokenExpiresAtMs = 0
      }
      return response && response.statusCode === 200 && response.data && response.data.ok === true ? response.data : null
    } catch (_) { return null }
    finally { placeFlights.delete(flight) }
  }

  return { setSession, clearSession, withdraw: clearSession, beginForeground, endForeground, enqueue, flush, getStatus, requestPlaceSuggestions }
}

module.exports = { createResearchClient, createWxTransport, validEndpoint, STORAGE_KEY }
