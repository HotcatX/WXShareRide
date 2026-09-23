'use strict'

const { sha256 } = require('./researchHash')

const OPERATIONS = new Set(['getTripList', 'getTripDetail', 'getMyTripHistory', 'getHomeTripList',
  'createTrip', 'joinTrip', 'tripManage', 'syncMyTripStatus', 'getPublicStats'])
const ACTIONS = new Set(['acceptRequest', 'kickDriver', 'kickPassenger', 'deleteTrip',
  'quitDriver', 'quitTrip', 'blockUser', 'getBlockList', 'unblockUser', 'rateUser'])
const ERROR_CODES = new Set(['TIMEOUT', 'PERMISSION_DENIED', 'NOT_FOUND', 'INVALID_ARGUMENT', 'INTERNAL_ERROR'])
const ERROR_NAMES = Object.freeze({ TypeError: 'TYPE_ERROR', ReferenceError: 'REFERENCE_ERROR',
  RangeError: 'RANGE_ERROR', SyntaxError: 'SYNTAX_ERROR', URIError: 'URI_ERROR', EvalError: 'EVAL_ERROR', Error: 'ERROR' })
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const object = value => value !== null && typeof value === 'object'
const tripId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)
const cloudId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value)
const installations = new WeakMap()

function knownCode(value, fallback) {
  if (!object(value)) return fallback
  for (const key of ['code', 'errCode', 'error']) {
    if (typeof value[key] === 'string' && ERROR_CODES.has(value[key])) return value[key]
  }
  return fallback
}

function requestMetadata(options) {
  const name = options.name
  if (!OPERATIONS.has(name)) return null
  const data = object(options.data) ? options.data : null
  let operation = name
  if (name === 'tripManage' && data && ACTIONS.has(data.action)) operation += '.' + data.action
  const meta = { operation }
  // Deliberately read only fixed routing fields, never copy/serialize the payload.
  if (data && (data.type === 'carpool' || data.type === 'request')) {
    const id = [data.tripId, data.requestId, data.id].find(tripId)
    if (id) { meta.tripKey = id; meta.tripType = data.type }
  }
  return meta
}

function resultMetadata(outcome, reply) {
  const result = object(reply) && object(reply.result) ? reply.result : null
  const businessError = outcome === 'success' && result && (result.ok === false || result.success === false)
  const data = { outcome: businessError ? 'business_error' : outcome,
    code: businessError ? knownCode(result, 'BUSINESS_REJECTED')
      : outcome === 'success' ? 'OK' : knownCode(reply, 'NETWORK_FAILURE') }
  if (object(reply)) {
    const id = cloudId(reply.requestID) ? reply.requestID : cloudId(reply.requestId) ? reply.requestId : null
    if (id) data.cloudRequestId = id
  }
  return data
}

function runtimeMetadata(kind, input) {
  let error = input
  if (kind === 'unhandled_rejection' && object(error) && own(error, 'reason')) error = error.reason
  let code = 'UNKNOWN_ERROR'
  let stack = ''
  if (typeof error === 'string') {
    const prefix = /^(TypeError|ReferenceError|RangeError|SyntaxError|URIError|EvalError|Error)(?=[:\s]|$)/.exec(error)
    if (prefix) code = ERROR_NAMES[prefix[1]]
    stack = error.slice(0, 8192)
  } else if (object(error)) {
    if (typeof error.name === 'string' && own(ERROR_NAMES, error.name)) code = ERROR_NAMES[error.name]
    if (typeof error.stack === 'string') stack = error.stack.slice(0, 8192)
  }
  const frames = []
  for (const line of stack.split(/\r?\n/).slice(0, 32)) {
    if (!/^\s*at\s/.test(line) && !/^[A-Za-z_$][\w.$]*@/.test(line)) continue
    // Keep only code basename and bounded line/column; discard paths, queries,
    // function arguments, messages and all other stack content before hashing.
    const match = /(?:^|[/\\( ])([A-Za-z0-9_.-]{1,80}\.(?:js|mjs|cjs)):(\d{1,7}):(\d{1,5})(?=[)\s]|$)/.exec(line)
    if (match) frames.push(match[1] + ':' + match[2] + ':' + match[3])
    if (frames.length === 8) break
  }
  return { errorKind: kind, code, fingerprint: sha256(JSON.stringify([kind, code, frames])) }
}

function createRideDiagnostics(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  let research = null, foreground = false, epoch = 0, successCount = 0, errorCount = 0
  let errorFingerprints = new Set()

  function scope() {
    try {
      const value = research && research.getCollectionScope()
      return typeof value === 'string' && value.length > 0 ? value : ''
    } catch (_) { return '' }
  }
  function record(name, data, startedScope, startedEpoch) {
    try {
      if (!foreground || epoch !== startedEpoch || !startedScope || scope() !== startedScope) return false
      const failed = name === 'client_error' || data.outcome !== 'success'
      if (failed) {
        // Separate error budget remains available after 100 successful calls.
        const fingerprint = name === 'client_error' ? data.fingerprint
          : sha256(JSON.stringify([data.operation, data.outcome, data.code, data.tripType || '', data.tripKey || '']))
        if (errorCount >= 20 || errorFingerprints.has(fingerprint)) return false
        errorCount += 1; errorFingerprints.add(fingerprint)
      } else {
        if (successCount >= 100) return false
        successCount += 1
      }
      research.recordEvent(name, data)
      return true
    } catch (_) { return false }
  }
  function beginForeground() {
    if (foreground) return
    foreground = true; epoch += 1; successCount = 0; errorCount = 0; errorFingerprints = new Set()
  }
  function endForeground() { foreground = false }
  function captureError(kind, error) {
    if (kind !== 'runtime' && kind !== 'unhandled_rejection') return false
    try { return record('client_error', runtimeMetadata(kind, error), scope(), epoch) } catch (_) { return false }
  }

  function install(wxApi, researchApi) {
    try {
      if (!wxApi || !wxApi.cloud || typeof wxApi.cloud.callFunction !== 'function' ||
        !researchApi || typeof researchApi.recordEvent !== 'function' || typeof researchApi.getCollectionScope !== 'function') return false
      const cloud = wxApi.cloud
      const previous = installations.get(cloud)
      if (previous && cloud.callFunction === previous.wrapper) return previous.owner === install
      const original = cloud.callFunction
      research = researchApi
      function wrappedCallFunction() {
        const args = Array.prototype.slice.call(arguments)
        const input = args[0]
        let metadata, startScope = '', startEpoch = epoch, startedAt = 0
        try {
          if (foreground && object(input)) {
            startScope = scope()
            if (startScope) { metadata = requestMetadata(input); startedAt = now() }
          }
        } catch (_) { metadata = null }
        if (!metadata) return original.apply(this, args)
        let settled = false
        const finish = (outcome, reply, syncThrow) => {
          if (settled) return
          settled = true
          try {
            const result = resultMetadata(outcome, reply)
            if (syncThrow) result.code = 'SYNC_THROW'
            const elapsed = now() - startedAt
            const durationMs = Number.isFinite(elapsed) ? Math.max(0, Math.min(300000, Math.round(elapsed))) : 0
            record('service_request', Object.assign({}, metadata, result, { durationMs }), startScope, startEpoch)
          } catch (_) {}
        }
        try {
          // Never add callbacks: doing so can switch wx APIs out of Promise mode.
          const descriptors = Object.getOwnPropertyDescriptors(input)
          let changed = false
          for (const key of ['success', 'fail', 'complete']) {
            const callback = input[key]
            if (typeof callback !== 'function') continue
            changed = true
            descriptors[key] = { configurable: true, enumerable: true, writable: true, value: function () {
              if (key === 'success') finish('success', arguments[0])
              else if (key === 'fail') finish('network_error', arguments[0])
              else {
                try {
                  const response = arguments[0]
                  if (object(response) && own(response, 'result')) finish('success', response)
                  else if (object(response) && typeof response.errMsg === 'string') {
                    if (response.errMsg.indexOf('cloud.callFunction:ok') === 0) finish('success', response)
                    else if (response.errMsg.indexOf('cloud.callFunction:fail') === 0) finish('network_error', response)
                  }
                } catch (_) {}
              }
              return callback.apply(this, arguments)
            } }
          }
          if (changed) args[0] = Object.create(Object.getPrototypeOf(input), descriptors)
        } catch (_) {
          // An unusual options object must still reach the original API unchanged.
          args[0] = input
        }
        let returned
        try { returned = original.apply(this, args) }
        catch (error) { finish('network_error', error, true); throw error }
        try {
          if (returned && typeof returned.then === 'function') {
            returned.then(reply => { finish('success', reply) }, error => { finish('network_error', error) })
          }
        } catch (_) {}
        // Preserve the original promise/task/value, including its rejection.
        return returned
      }
      cloud.callFunction = wrappedCallFunction
      if (cloud.callFunction !== wrappedCallFunction) return false
      installations.set(cloud, { wrapper: wrappedCallFunction, owner: install })
      return true
    } catch (_) { return false }
  }
  return { install, beginForeground, endForeground, captureError,
    getStatus: () => ({ foreground, successes: successCount, errors: errorCount, maxSuccesses: 100, maxErrors: 20 }) }
}

const singleton = createRideDiagnostics()
module.exports = Object.assign({ createRideDiagnostics }, singleton)
