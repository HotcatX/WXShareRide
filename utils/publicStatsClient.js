// One public read; partial rollouts reuse a local anonymous installation bucket.
// This pure hash helper does not load or enable the analytics collection client.
const { sha256 } = require('./hash')
const { readPublicStats } = require('./compat/cloudReads')
const rollout = require('../config/publicStats')
const { readInstallationBucket } = require('./rolloutCohort')

const LEGACY_FLAG_KEY = 'linkxPublicStatsTrialV1'
const ENDPOINT = 'https://collect.linkx.ink/v1/public-stats'
const TIMEOUT_MS = 2500
const MAX_SNAPSHOT_AGE_MS = 6 * 60 * 60 * 1000
const CLOCK_SKEW_MS = 60000
const CIRCUIT_FAILURE_LIMIT = 2
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000
let lastSelection = null
let generation = 0
let pendingRead = null
let pendingCloud = null
let pendingHttp = null
let legacyCleanupDone = false
let legacyCleanupFailed = false
let consecutiveHttpFailures = 0
let circuitOpenedAt = 0
let circuitUntil = 0
const counts = { httpRequests: 0, cloudRequests: 0, fallbacks: 0, discarded: 0, circuitSkips: 0 }

function cleanLegacyFlagOnce() {
  if (legacyCleanupDone) return
  legacyCleanupDone = true
  try {
    const old = wx.getStorageSync(LEGACY_FLAG_KEY)
    if (old !== undefined && old !== null && old !== '') wx.removeStorageSync(LEGACY_FLAG_KEY)
  } catch (_) { legacyCleanupFailed = true }
}

function readBucket() {
  return readInstallationBucket(wx, Math.random)
}

function selectTransport() {
  cleanLegacyFlagOnce()
  let signature = 'unavailable'
  try {
    const percentages = rollout && rollout.rolloutPercent
    const shares = percentages && ['develop', 'trial', 'release'].map(env => percentages[env])
    const validConfig = rollout && typeof rollout.enabled === 'boolean' && shares &&
      shares.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100)
    if (!validConfig) return { enabled: false, reason: 'config_unavailable', signature: 'config_unavailable' }
    const account = wx.getAccountInfoSync()
    const reportedEnv = account && account.miniProgram && account.miniProgram.envVersion
    const env = ['develop', 'trial', 'release'].includes(reportedEnv) ? reportedEnv : 'unknown'
    signature = JSON.stringify([rollout.enabled, shares, env])
    if (!rollout.enabled) return { enabled: false, reason: 'rollout_disabled', signature }
    if (env === 'unknown') return { enabled: false, reason: 'environment_unavailable', signature }
    const percent = percentages[env]
    if (percent === 0) return { enabled: false, reason: 'outside_rollout', signature }
    // A fully deployed public read needs neither identity nor local assignment.
    // Storage failures must not send healthy full-rollout reads back to CloudBase.
    if (percent === 100) return { enabled: true, reason: 'full_rollout', signature }
    if (legacyCleanupFailed) return { enabled: false, reason: 'storage_unavailable', signature: signature + ':storage-error' }
    const bucket = readBucket()
    // Bucket stays on this installation. Neither requests nor diagnostics expose it.
    return { enabled: bucket < percent * 100, reason: 'outside_rollout', signature: signature + ':' + bucket }
  } catch (_) { return { enabled: false, reason: 'environment_or_storage_unavailable', signature: signature + ':unavailable' } }
}

function getPublicStatsReadContext() {
  const selected = selectTransport()
  if (selected.signature !== lastSelection) {
    lastSelection = selected.signature
    generation += 1
    if (pendingHttp) pendingHttp.cancel()
  }
  return { serverEnabled: selected.enabled, key: `public-stats:${selected.enabled ? 'server' : 'cloud'}:${generation}`, reason: selected.reason }
}

function isPublicStatsReadCurrent(context) {
  const current = getPublicStatsReadContext()
  return !!context && context.key === current.key && context.serverEnabled === current.serverEnabled
}

function exactKeys(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

function validSnapshot(value) {
  if (!exactKeys(value, ['ok', 'schemaVersion', 'source', 'snapshotAt', 'expiresAt', 'revision', 'data']) ||
    value.ok !== true || value.schemaVersion !== 1 || value.source !== 'cloudbase-snapshot') return false
  const { snapshotAt, expiresAt, data } = value
  const now = Date.now()
  if (!Number.isSafeInteger(snapshotAt) || snapshotAt <= 0 || !Number.isSafeInteger(expiresAt) ||
    expiresAt <= snapshotAt || expiresAt - snapshotAt > MAX_SNAPSHOT_AGE_MS || snapshotAt > now + CLOCK_SKEW_MS || now >= expiresAt) return false
  if (!exactKeys(data, ['_id', 'servedTrips', 'coverageText']) || data._id !== 'home' ||
    !(data.servedTrips === null || (Number.isSafeInteger(data.servedTrips) && data.servedTrips >= 0)) ||
    typeof data.coverageText !== 'string' || data.coverageText.length > 120 || /[\u0000-\u001f\u007f]/.test(data.coverageText) ||
    typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)) return false
  return sha256(JSON.stringify(data)) === value.revision
}

function failure(reason) { const error = new Error(reason); error.reason = reason; return error }

function requestSnapshot(context) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    let task = null
    const entry = { cancel: () => finish(failure('mode_changed'), null, true) }
    const finish = (error, value, abort = false) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (pendingHttp === entry) pendingHttp = null
      if (abort && task && typeof task.abort === 'function') {
        try { task.abort() } catch (_) {}
      }
      if (error) reject(error)
      else resolve(value)
    }
    pendingHttp = entry
    timer = setTimeout(() => finish(failure('timeout'), null, true), TIMEOUT_MS)
    try {
      if (!isPublicStatsReadCurrent(context)) return finish(failure('mode_changed'))
      counts.httpRequests += 1
      task = wx.request({
        url: ENDPOINT, method: 'GET', timeout: TIMEOUT_MS, dataType: 'json',
        header: { Accept: 'application/json' },
        success(response) {
          if (settled) return
          if (!isPublicStatsReadCurrent(context)) return finish(failure('mode_changed'))
          if (!response || response.statusCode !== 200) return finish(failure('http_error'))
          try {
            if (!validSnapshot(response.data)) return finish(failure('invalid_snapshot'))
            finish(null, response.data)
          } catch (_) { finish(failure('invalid_snapshot')) }
        },
        fail() { finish(failure('request_failed')) }
      })
    } catch (_) { finish(failure('request_failed')) }
  })
}

function readCloud() {
  if (pendingCloud) return pendingCloud
  const request = new Promise((resolve, reject) => {
    try {
      counts.cloudRequests += 1
      resolve(readPublicStats(wx))
    } catch (error) { reject(error) }
  })
  pendingCloud = request
  const clear = () => { if (pendingCloud === request) pendingCloud = null }
  request.then(clear, clear)
  return request
}

function discarded() {
  counts.discarded += 1
  return { response: null, diagnostic: { source: 'discarded', reason: 'mode_changed' } }
}

function circuitIsOpen() {
  if (!circuitUntil) return false
  const now = Date.now()
  // Clock rollback must not leave a device indefinitely stuck in cooldown.
  if (now < circuitOpenedAt || now >= circuitUntil) { circuitUntil = 0; return false }
  return true
}

function recordHttpFailure() {
  consecutiveHttpFailures += 1
  if (consecutiveHttpFailures >= CIRCUIT_FAILURE_LIMIT) {
    circuitOpenedAt = Date.now()
    circuitUntil = circuitOpenedAt + CIRCUIT_COOLDOWN_MS
  }
}

function loadPublicStats(context = getPublicStatsReadContext()) {
  if (!isPublicStatsReadCurrent(context)) return Promise.resolve(discarded())
  if (pendingRead && pendingRead.key === context.key) return pendingRead.promise
  const entry = { key: context.key, promise: null }
  entry.promise = (async () => {
    let reason = context.reason || 'outside_rollout'
    const coolingDown = context.serverEnabled && circuitIsOpen()
    if (coolingDown) { reason = 'circuit_open'; counts.circuitSkips += 1 }
    if (context.serverEnabled && !coolingDown) {
      try {
        const snapshot = await requestSnapshot(context)
        if (!isPublicStatsReadCurrent(context)) return discarded()
        consecutiveHttpFailures = 0
        circuitUntil = 0
        return {
          response: { result: { success: true, data: snapshot.data } },
          diagnostic: { source: 'lighthouse', snapshotAt: snapshot.snapshotAt, expiresAt: snapshot.expiresAt, revision: snapshot.revision }
        }
      } catch (error) {
        if (!isPublicStatsReadCurrent(context)) return discarded()
        reason = error.reason || 'request_failed'
        recordHttpFailure()
        counts.fallbacks += 1
      }
    }
    const response = await readCloud()
    if (!isPublicStatsReadCurrent(context)) return discarded()
    return { response, diagnostic: { source: 'cloudbase', reason } }
  })()
  pendingRead = entry
  const clear = () => { if (pendingRead === entry) pendingRead = null }
  entry.promise.then(clear, clear)
  return entry.promise
}

function getPublicStatsDiagnostics() { return Object.assign({}, counts) }

module.exports = {
  getPublicStatsReadContext, isPublicStatsReadCurrent, loadPublicStats, getPublicStatsDiagnostics
}
