const defaults = require('../config/research')
const { createResearchClient } = require('./researchClient')
const { readInstallationBucket } = require('./rolloutCohort')
const { isOpaqueId } = require('./researchSchema')

const PENDING_KEY = 'rideResearchPendingWithdrawV1'
const ROUTES = Object.freeze({
  'pages/home/home': 'home',
  'pages/home/carpoolList/carpoolList': 'carpool_list',
  'pages/home/tripDetail/tripDetail': 'trip_detail',
  'pages/home/requestDetail/requestDetail': 'request_detail',
  'pages/profile/tripHistory/tripHistory': 'trip_history'
})
const validVersion = value => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647

function createResearchParticipation(options = {}) {
  const wxApi = options.wx || (typeof wx !== 'undefined' ? wx : null)
  const config = Object.assign({}, defaults, options.config || {})
  const now = options.now || Date.now
  const setTimer = options.setTimeout || setTimeout
  const clearTimer = options.clearTimeout || clearTimeout
  const random = options.random || Math.random
  const client = options.client || createResearchClient({ wx: wxApi, config, now, random, transport: options.transport })
  let sequence = 0
  const makeId = options.makeId || (() => `rp_${now().toString(36)}_${(++sequence).toString(36)}_${Math.floor(random() * 0x100000000).toString(36)}_${Math.floor(random() * 0x100000000).toString(36)}`)
  let account = '', collectionMode = '', environment = '', generation = 0, foreground = false, foregroundEpoch = 0
  let inCohort = false, known = false, verified = false, attempted = false
  let status = 'unknown', statusVersion = 0, participantKey = '', tokenExpiresAt = 0
  let statusFlight = null, actionFlight = null, uploadFlight = null, timer = null
  let pending = [], storageError = false, error = '', withdrawalBlocked = false
  let currentPage = '', pageVisit = 0, recordedVisit = -1, firstBatch = true, queuedSince = 0
  let lastTokenRefresh = 0, automaticWithdrawTried = false, automaticActivationTried = false
  const listeners = new Set()
  const searchIds = new Set()

  function stopTimer() { if (timer !== null) clearTimer(timer); timer = null }
  function readPending() {
    try {
      const saved = wxApi.getStorageSync(PENDING_KEY)
      if (!saved) { pending = []; return }
      if (!Array.isArray(saved) || saved.length > 8 || saved.some(item => !item ||
        !isOpaqueId(item.participantKey) || !isOpaqueId(item.requestId) || !validVersion(item.expectedStatusVersion) ||
        item.purposeVersion !== config.purposeVersion || item.noticeVersion !== config.noticeVersion ||
        typeof item.conflict !== 'boolean' || Object.keys(item).length !== 6)) throw new Error('invalid_pending')
      pending = saved
    } catch (_) { storageError = true; error = 'storage_unavailable' }
  }
  function savePending(next) {
    try {
      if (next.length) wxApi.setStorageSync(PENDING_KEY, next)
      else wxApi.removeStorageSync(PENDING_KEY)
      pending = next; storageError = false
      return true
    } catch (_) { storageError = true; error = 'storage_unavailable'; return false }
  }
  readPending()
  function ownPending() { return participantKey && pending.find(item => item.participantKey === participantKey) }
  function getState() {
    const queue = client.getStatus()
    return { loggedIn: !!account, inCohort, status, statusVersion, known,
      participating: verified && queue.participating && !ownPending() && !storageError && !withdrawalBlocked,
      canWithdraw: !!account && known && (status === 'active' || !!ownPending()),
      pendingWithdrawal: !!ownPending(), withdrawalConflict: !!(ownPending() && ownPending().conflict),
      busy: !!actionFlight, loading: !!statusFlight, error,
      queuedCount: queue.queuedCount, collectionReady: verified && queue.participating,
      localCleanupComplete: !queue.storageBlocked }
  }
  function emit() { const state = getState(); listeners.forEach(listener => { try { listener(state) } catch (_) {} }) }
  function stopCollection() { stopTimer(); verified = false; tokenExpiresAt = 0; queuedSince = 0; client.clearSession() }
  function selectCohort() {
    try {
      if (config.enabled !== true) return false
      if (!['develop', 'trial', 'release'].includes(environment)) return false
      const share = config.rolloutPercent && config.rolloutPercent[environment]
      if (typeof share !== 'number' || !Number.isFinite(share) || share <= 0 || share > 100) return false
      if (share === 100) return true
      const bucket = readInstallationBucket(wxApi, random)
      return Number.isInteger(bucket) && bucket >= 0 && bucket < 10000 && bucket < share * 100
    } catch (_) { return false }
  }
  function syncIdentity() {
    let next = ''
    try { next = wxApi.getStorageSync('isGuest') ? '' : String(wxApi.getStorageSync('openid') || '') } catch (_) {}
    environment = ''
    try { const info = wxApi.getAccountInfoSync(); environment = info && info.miniProgram && info.miniProgram.envVersion } catch (_) {}
    const nextMode = environment === 'release' ? 'real' : ['develop', 'trial'].includes(environment) ? 'test' : ''
    if (next !== account || nextMode !== collectionMode) {
      if (account || !next || (collectionMode && nextMode !== collectionMode)) stopCollection()
      generation += 1; account = next; collectionMode = nextMode; known = false; verified = false; attempted = false
      status = 'unknown'; statusVersion = 0; participantKey = ''; tokenExpiresAt = 0
      statusFlight = null; actionFlight = null; automaticWithdrawTried = false; recordedVisit = -1; withdrawalBlocked = false
      automaticActivationTried = false
      searchIds.clear()
      error = storageError ? 'storage_unavailable' : ''
      if (foreground) client.beginForeground()
    }
    const previouslyInCohort = inCohort
    inCohort = selectCohort()
    if (previouslyInCohort && !inCohort) stopCollection()
    if (!account || !inCohort || storageError) { verified = false; stopTimer() }
    return !!account
  }
  function validReply(reply) {
    return reply && reply.ok === true && ['none', 'active', 'revoked'].includes(reply.status) &&
      (collectionMode === 'test' ? reply.synthetic === true : collectionMode === 'real' && (reply.synthetic === undefined || reply.synthetic === false)) &&
      validVersion(reply.statusVersion) && reply.purposeVersion === config.purposeVersion && reply.noticeVersion === config.noticeVersion &&
      (reply.status === 'none' ? reply.statusVersion === 0 : isOpaqueId(reply.participantKey) && reply.statusVersion > 0)
  }
  function applyReply(reply) {
    if (!validReply(reply)) throw new Error('invalid_response')
    known = true; status = reply.status; statusVersion = reply.statusVersion; participantKey = reply.participantKey || ''
    error = storageError ? 'storage_unavailable' : ''
    verified = false
    if (status === 'active' && inCohort && !ownPending() && !storageError && !withdrawalBlocked && reply.session &&
      reply.session.participantKey === participantKey && reply.session.statusVersion === statusVersion) {
      const set = client.setSession(Object.assign({}, reply.session, { accountKey: collectionMode + ':' + account }))
      verified = set.ok === true
      tokenExpiresAt = verified && Number.isSafeInteger(reply.session.tokenExpiresAtMs) ? reply.session.tokenExpiresAtMs : 0
      if (foreground) client.beginForeground()
    } else stopCollection()
  }
  async function call(action, requestId, expectedStatusVersion) {
    const data = {
      action, requestId, expectedStatusVersion, purposeVersion: config.purposeVersion, noticeVersion: config.noticeVersion
    }
    if (collectionMode === 'test') data.collectionMode = 'test'
    const response = await wxApi.cloud.callFunction({ name: 'statistics', data })
    const reply = response && response.result
    if (!reply || reply.ok !== true) {
      const failure = new Error('participation_request_failed')
      failure.conflict = !!(reply && reply.statusCode === 409)
      throw failure
    }
    return reply
  }
  function refreshStatus(options = {}) {
    if (!syncIdentity()) { emit(); return Promise.resolve(getState()) }
    if (statusFlight) return statusFlight
    if (!options.force && attempted) return Promise.resolve(getState())
    attempted = true
    const epoch = generation
    const flight = Promise.resolve().then(() => call('status', makeId(), 0)).then(reply => {
      syncIdentity()
      if (epoch !== generation) return
      applyReply(reply)
    }).catch(() => {
      if (epoch === generation) { verified = false; error = 'status_unavailable'; stopTimer() }
    }).finally(() => {
      if (statusFlight !== flight) return
      statusFlight = null; emit()
      const waiting = ownPending()
      if (foreground && waiting && !waiting.conflict && !automaticWithdrawTried) {
        automaticWithdrawTried = true
        retryWithdrawal(waiting)
      } else if (foreground && inCohort && known && status === 'none' && !storageError && !withdrawalBlocked && !automaticActivationTried) {
        automaticActivationTried = true
        activate()
      } else if (foreground && verified) {
        recordCurrentPage()
        scheduleUpload()
      }
    }).then(() => getState())
    statusFlight = flight; emit()
    return flight
  }
  function scheduleUpload(immediate = false) {
    stopTimer()
    const state = client.getStatus()
    if (!foreground || !verified || !inCohort || ownPending() || storageError || !state.queuedCount ||
      state.halted || state.storageBlocked || state.attemptsThisForeground >= state.maxUploadsPerForeground) return
    const time = now()
    if (!queuedSince) queuedSince = time
    const due = Math.max(state.nextAttemptAt, state.lastAttemptAt ? state.lastAttemptAt + config.minUploadIntervalMs : 0,
      tokenExpiresAt <= time && lastTokenRefresh ? lastTokenRefresh + 30000 : 0,
      (immediate || firstBatch) ? time : Math.min(time + 2000, queuedSince + 15000))
    timer = setTimer(() => { timer = null; flush() }, Math.max(0, due - time))
  }
  function flush() {
    if (uploadFlight) return uploadFlight
    syncIdentity()
    if (!foreground || !account || !inCohort || !verified || ownPending() || storageError) return Promise.resolve({ ok: false })
    const epoch = generation
    const flight = (async () => {
      if (tokenExpiresAt <= now()) {
        if (now() - lastTokenRefresh < 30000) return { ok: false, reason: 'token_refresh_wait' }
        lastTokenRefresh = now()
        await refreshStatus({ force: true })
        if (epoch !== generation || !verified) return { ok: false, reason: 'status_unavailable' }
      }
      const result = await client.flush()
      if (epoch !== generation) return result
      firstBatch = false
      if (result.ok) queuedSince = client.getStatus().queuedCount ? now() : 0
      if (result.reason === 'token_required') { tokenExpiresAt = 0; lastTokenRefresh = now() }
      if (result.reason === 'participation_inactive') { verified = false; known = false; error = 'participation_inactive' }
      return result
    })().finally(() => {
      if (uploadFlight !== flight) return
      uploadFlight = null; emit()
      if (foreground && verified) scheduleUpload()
    })
    uploadFlight = flight
    return flight
  }
  function record(eventName, data, meta) {
    syncIdentity()
    if (!foreground || !verified || !inCohort || ownPending() || storageError) return { ok: false }
    const result = client.enqueue(eventName, data, meta)
    if (result.ok) scheduleUpload()
    return result
  }
  function recordCurrentPage() {
    if (!currentPage || recordedVisit === pageVisit) return
    if (record('page_view', { page: currentPage }).ok) recordedVisit = pageVisit
  }
  function pageShown(route) {
    currentPage = ROUTES[String(route || '').replace(/^\//, '')] || ''
    pageVisit += 1
    syncIdentity()
    if (!currentPage || !foreground || !inCohort || !account) return
    if (verified) recordCurrentPage()
    else refreshStatus().then(recordCurrentPage)
  }
  function beginForeground() {
    syncIdentity()
    if (foreground) return (inCohort || pending.length) ? refreshStatus() : Promise.resolve(getState())
    foreground = true; foregroundEpoch += 1; attempted = false; automaticWithdrawTried = false
    verified = false; firstBatch = true; client.beginForeground(); syncIdentity()
    if (account && (inCohort || pending.length)) return refreshStatus()
    emit(); return Promise.resolve(getState())
  }
  function endForeground() {
    const epoch = foregroundEpoch
    const finishing = flush()
    foreground = false; stopTimer(); currentPage = ''; pageVisit += 1
    Promise.resolve(finishing).finally(() => { if (!foreground && foregroundEpoch === epoch) client.endForeground() })
  }
  function activate() {
    syncIdentity()
    if (actionFlight) return actionFlight
    // Automatic activation is permitted only for never-activated accounts.
    // A revoked account is never silently re-enabled, including across restarts.
    if (!account || !inCohort || !known || status !== 'none' || storageError || ownPending() || withdrawalBlocked) return Promise.resolve({ ok: false, error: 'not_eligible' })
    const epoch = generation, expected = statusVersion, requestId = makeId()
    const flight = call('activate', requestId, expected).then(reply => {
      syncIdentity()
      if (epoch !== generation) return { ok: false, error: 'account_changed' }
      applyReply(reply); firstBatch = true; recordCurrentPage(); scheduleUpload(true)
      return { ok: status === 'active', collecting: verified }
    }).catch(async failure => {
      if (epoch === generation) { error = failure.conflict ? 'status_conflict' : 'activation_unconfirmed'; await refreshStatus({ force: true }); error = failure.conflict ? 'status_conflict' : 'activation_unconfirmed' }
      return { ok: false, error: failure.conflict ? 'status_conflict' : 'activation_unconfirmed' }
    }).finally(() => { if (actionFlight === flight) { actionFlight = null; emit() } })
    actionFlight = flight; emit(); return flight
  }
  function retryWithdrawal(item) {
    if (actionFlight) return actionFlight
    if (!item || item.participantKey !== participantKey || item.conflict) return Promise.resolve({ ok: false })
    stopCollection()
    const epoch = generation
    const flight = call('withdraw', item.requestId, item.expectedStatusVersion).then(reply => {
      syncIdentity()
      if (epoch !== generation) return { ok: false, error: 'account_changed' }
      if (!validReply(reply) || reply.participantKey !== item.participantKey || reply.status !== 'revoked') throw new Error('invalid_response')
      if (!savePending(pending.filter(entry => entry.requestId !== item.requestId))) return { ok: false, error: 'storage_unavailable' }
      withdrawalBlocked = false
      applyReply(reply)
      return { ok: true }
    }).catch(async failure => {
      if (epoch === generation) {
        if (failure.conflict) {
          savePending(pending.map(entry => entry.requestId === item.requestId ? Object.assign({}, entry, { conflict: true }) : entry))
          await refreshStatus({ force: true })
        }
        error = failure.conflict ? 'status_conflict' : 'withdrawal_pending'
      }
      return { ok: false, error: failure.conflict ? 'status_conflict' : 'withdrawal_pending' }
    }).finally(() => { if (actionFlight === flight) { actionFlight = null; emit() } })
    actionFlight = flight; emit(); return flight
  }
  function withdraw() {
    syncIdentity()
    if (actionFlight) return actionFlight
    if (!getState().canWithdraw) return Promise.resolve({ ok: false, error: 'status_required' })
    withdrawalBlocked = true
    stopCollection()
    let item = ownPending()
    if (!item || item.conflict) {
      item = { participantKey, requestId: makeId(), expectedStatusVersion: statusVersion,
        purposeVersion: config.purposeVersion, noticeVersion: config.noticeVersion, conflict: false }
      const others = pending.filter(entry => entry.participantKey !== participantKey)
      if (others.length >= 8 || !savePending(others.concat([item]))) { emit(); return Promise.resolve({ ok: false, error: 'storage_unavailable' }) }
    }
    automaticWithdrawTried = true
    return retryWithdrawal(item)
  }
  function identityChanged() { syncIdentity(); emit(); if (foreground && account && (inCohort || pending.length)) return refreshStatus() }
  function subscribe(listener) { listeners.add(listener); listener(getState()); return () => listeners.delete(listener) }
  function recordSearch(data) {
    if (currentPage !== 'carpool_list') return ''
    const searchId = makeId()
    if (!record('search_submitted', Object.assign({}, data, { searchId })).ok) return ''
    // Searches only need correlation until the next explicit search.
    searchIds.clear(); searchIds.add(searchId)
    return searchId
  }
  function recordResults(data) {
    if (currentPage !== 'carpool_list' || !searchIds.has(data.searchId)) return { ok: false }
    const selectionSetId = data.selectionSetId || makeId()
    const result = record('result_set_rendered', Object.assign({ candidatesComplete: false }, data, { selectionSetId }))
    return Object.assign({}, result, { selectionSetId })
  }
  function getCollectionScope() {
    syncIdentity()
    return verified && participantKey && getState().participating ? `${collectionMode}:${participantKey}:${statusVersion}` : ''
  }
  async function requestPlaceSuggestions(payload) {
    syncIdentity()
    if (!foreground || !account || !inCohort || ownPending() || storageError || withdrawalBlocked) return null
    const epoch = generation
    if (!verified) {
      await refreshStatus()
      if (actionFlight) await actionFlight
    } else if (tokenExpiresAt <= now()) {
      if (now() - lastTokenRefresh < 30000) return null
      lastTokenRefresh = now()
      await refreshStatus({ force: true })
    }
    syncIdentity()
    if (epoch !== generation || !verified || !foreground || ownPending() || typeof client.requestPlaceSuggestions !== 'function') return null
    const response = await client.requestPlaceSuggestions(payload)
    syncIdentity()
    if (epoch === generation && tokenExpiresAt !== 0 && client.getStatus().tokenRequired) {
      tokenExpiresAt = 0; lastTokenRefresh = now()
    }
    return epoch === generation && verified && foreground ? response : null
  }
  return { beginForeground, endForeground, identityChanged, pageShown, refreshStatus, withdraw,
    getState, subscribe, recordSearch, recordResults, flush, recordEvent: record, makeEventId: makeId, getCollectionScope, requestPlaceSuggestions }
}

let singleton
function current() { if (!singleton) singleton = createResearchParticipation(); return singleton }
const exported = { createResearchParticipation, PENDING_KEY, ROUTES }
;['beginForeground', 'endForeground', 'identityChanged', 'pageShown', 'refreshStatus', 'withdraw',
  'getState', 'subscribe', 'recordSearch', 'recordResults', 'flush', 'recordEvent', 'makeEventId', 'getCollectionScope', 'requestPlaceSuggestions'].forEach(name => {
  exported[name] = function () { return current()[name].apply(null, arguments) }
})
module.exports = exported
