const { isTimelinePreview } = require('./timeline')
const transport = require('./compat/referrals')
const analytics = require('./analyticsSession')
const REFERRAL_CODE_KEY = 'my_referral_code'
const PENDING_REFERRAL_KEY = 'pending_referral'
const VISIT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_PENDING_VISITS = 32
let identity = '', generation = 0, ensureFlight = null, bindFlight = null
let subscribed = false, flushing = false, visitError = ''
const entryRoutes = {
  'pages/home/home': 'home', 'pages/home/carpoolList/carpoolList': 'carpool_list',
  'pages/home/tripDetail/tripDetail': 'trip_detail', 'pages/home/requestDetail/requestDetail': 'request_detail',
  'pages/profile/tripHistory/tripHistory': 'trip_history', 'pages/market/market': 'market',
  'pages/profile/profile': 'profile'
}
function account() { return wx.getStorageSync('isGuest') ? '' : String(wx.getStorageSync('openid') || '') }
function syncIdentity() {
  const next = JSON.stringify([transport.isBackendEnabled(), account()])
  if (next !== identity) { identity = next; generation++; ensureFlight = null; bindFlight = null }
  return generation
}
function current(epoch) { return !isTimelinePreview() && syncIdentity() === epoch }
function normalizeText(value) { return String(value || '').trim() }
function sanitizeReferralCode(value) {
  const text = normalizeText(value)
  if (transport.isBackendEnabled()) return /^ref_[a-f0-9]{12}$/.test(text) ? text : ''
  return text.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)
}
function getMyReferralCodeSync() {
  if (isTimelinePreview()) return ''
  syncIdentity()
  const openid = account()
  if (!openid) return ''
  const direct = wx.getStorageSync(REFERRAL_CODE_KEY)
  if (direct && typeof direct === 'object' && direct.openid === openid) return sanitizeReferralCode(direct.code)
  // An old unscoped string is not evidence of its owner. Only the cached
  // profile's explicit identity can migrate it without cross-account sharing.
  const user = wx.getStorageSync('userInfo') || {}
  if (user._openid !== openid) return ''
  return sanitizeReferralCode(user.referralCode)
}
function setMyReferralCode(code) {
  if (isTimelinePreview()) return ''
  syncIdentity()
  const openid = account(), safeCode = sanitizeReferralCode(code)
  if (!openid || !safeCode) return ''
  wx.setStorageSync(REFERRAL_CODE_KEY, { openid, code: safeCode })
  const user = wx.getStorageSync('userInfo') || {}
  if (user._openid === openid) wx.setStorageSync('userInfo', { ...user, referralCode: safeCode })
  return safeCode
}
function readPending() {
  const value = wx.getStorageSync(PENDING_REFERRAL_KEY)
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
function writePending(value) { wx.setStorageSync(PENDING_REFERRAL_KEY, value) }
function pruneVisits(pending, now) {
  const visits = Array.isArray(pending.visits) ? pending.visits : []
  pending.expiredVisits = Number(pending.expiredVisits) || 0
  pending.visits = visits.filter(visit => {
    if (visit.occurredAt < now - VISIT_TTL_MS) { if (!visit.queued) pending.expiredVisits++; return false }
    return true
  })
  return pending
}
function freezeVisitMetadata(visit, metadata) {
  if (!visit.sessionId && metadata) { visit.sessionId = metadata.sessionId; visit.context = metadata.context }
}
function sourceName(source) { return ['appLaunch', 'appShow', 'pageLoad'].includes(source) ? source : 'other' }
function installSubscription() {
  if (subscribed || !transport.isBackendEnabled()) return
  subscribed = true // subscribe immediately invokes the callback; guard re-entry first.
  analytics.subscribe(state => { if (state.collectionReady) flushReferralVisits() })
}
function flushReferralVisits() {
  if (flushing || isTimelinePreview() || !transport.isBackendEnabled()) return { ok: false }
  flushing = true
  try {
    const owner = account(), pending = pruneVisits(readPending(), Date.now())
    const expired = pending.expiredVisits, dropped = Number(pending.droppedVisits) || 0
    const metadata = analytics.getEventMetadata()
    // appLaunch precedes beginForeground. Its capture is assigned once to the
    // first observed real foreground, even while still a guest, then frozen.
    for (const visit of pending.visits) if (!visit.owner || visit.owner === owner) freezeVisitMetadata(visit, metadata)
    writePending(pending)
    if (!owner) return { ok: false, reason: 'not_logged_in' }
    for (const visit of pending.visits) {
      if (visit.queued || (visit.owner && visit.owner !== owner)) continue
      // Guest captures are attributed only when this account actually becomes
      // eligible. Visitors who never log in are not a complete guest census.
      if (!visit.sessionId) return { ok: false, reason: 'not_foreground' }
      visit.owner = owner
      writePending(pending)
      const result = analytics.recordEvent('referral_visit', { code: visit.code, source: visit.source, entry: visit.entry },
        { eventId: visit.eventId, sessionId: visit.sessionId, context: visit.context, occurredAt: visit.occurredAt })
      if (!result || !result.ok) { visitError = result && result.reason || 'collection_unavailable'; return { ok: false, error: visitError } }
      visit.queued = true
      writePending(pending)
    }
    for (const [key, reason, count] of [['droppedVisits', 'queue_limit', dropped], ['expiredVisits', 'expired', expired]]) {
      if (!count) continue
      const result = analytics.recordEvent('collection_diagnostic', { reason, droppedCount: Math.min(500, count) })
      if (!result || !result.ok) { visitError = result && result.reason || 'collection_unavailable'; return { ok: false, error: visitError } }
      pending[key] = Math.max(0, count - 500); writePending(pending)
    }
    visitError = ''
    return { ok: true }
  } catch (_) { visitError = 'storage_unavailable'; return { ok: false, error: visitError } }
  finally { flushing = false }
}
function captureReferral(options = {}, source = '') {
  if (isTimelinePreview()) return ''
  syncIdentity()
  const query = options.query && typeof options.query === 'object' ? options.query : options
  const code = sanitizeReferralCode(query.ref || query.referralCode || query.invite || query.inviter)
  if (!code || code === getMyReferralCodeSync()) return ''
  const now = Date.now(), old = readPending()
  if (!transport.isBackendEnabled()) {
    const payload = { referralCode: code, source: normalizeText(source), scene: options.scene || '',
      path: normalizeText(options.path), query, capturedAtMs: now, owner: account() }
    writePending(payload)
    transport.call('trackVisit', payload).catch(() => {})
    return code
  }
  pruneVisits(old, now)
  const entry = entryRoutes[normalizeText(options.path).replace(/^\//, '')] || 'other'
  const visits = Array.isArray(old.visits) ? old.visits : []
  const duplicate = visits.find(visit => visit.code === code && visit.entry === entry &&
    visit.owner === account() && now - visit.occurredAt >= 0 && now - visit.occurredAt < 10000)
  const next = { referralCode: code, capturedAtMs: duplicate ? duplicate.occurredAt : now, owner: account(),
    bound: old.referralCode === code && old.owner === account() && old.bound === true,
    visits, droppedVisits: Number(old.droppedVisits) || 0, expiredVisits: Number(old.expiredVisits) || 0 }
  if (!duplicate) {
    // Retain accepted IDs briefly to deduplicate appLaunch/appShow/pageLoad.
    next.visits = visits.filter(visit => !visit.queued || now - visit.occurredAt < 10000)
    if (next.visits.length < MAX_PENDING_VISITS) next.visits.push({ eventId: analytics.makeEventId(),
      code, source: sourceName(source), entry, occurredAt: now, owner: account(), queued: false })
    else next.droppedVisits++
  }
  writePending(next)
  installSubscription()
  flushReferralVisits()
  return code
}
function ensureReferralCode() {
  if (isTimelinePreview()) return Promise.resolve('')
  const epoch = syncIdentity(), cached = getMyReferralCodeSync()
  if (!account()) return Promise.resolve('')
  if (transport.isBackendEnabled()) { installSubscription(); flushReferralVisits() }
  if (cached) return Promise.resolve(cached)
  if (ensureFlight) return ensureFlight
  const flight = transport.call('getMyReferralCode').then(result =>
    current(epoch) && result && result.ok ? setMyReferralCode(result.referralCode) : '')
    .catch(() => '').finally(() => { if (ensureFlight === flight) ensureFlight = null })
  ensureFlight = flight
  return flight
}
function bindPendingReferral() {
  if (isTimelinePreview()) return Promise.resolve(null)
  const epoch = syncIdentity(), owner = account(), pending = readPending()
  if (!owner) return Promise.resolve(null)
  if (transport.isBackendEnabled()) { installSubscription(); flushReferralVisits() }
  const code = sanitizeReferralCode(pending.referralCode)
  if (!code || pending.bound || (pending.owner && pending.owner !== owner)) return Promise.resolve(null)
  if (bindFlight) return bindFlight
  // Persist ownership before the request, so a late/retried guest bind cannot
  // attach the original invitation to a different account on this device.
  const claimed = { ...readPending(), owner }
  writePending(claimed)
  const intent = JSON.stringify([code, claimed.capturedAtMs, owner])
  const flight = transport.call('bindReferral', { ...claimed, referralCode: code }).then(result => {
    if (!current(epoch)) return { ok: false, error: 'ACCOUNT_CHANGED' }
    const latest = readPending()
    if (result && result.ok && intent === JSON.stringify([latest.referralCode, latest.capturedAtMs, latest.owner])) {
      if (transport.isBackendEnabled()) writePending({ ...latest, bound: true })
      else wx.removeStorageSync(PENDING_REFERRAL_KEY)
    }
    return result
  }).catch(error => ({ ok: false, error: error && /^[A-Z_]+$/.test(error.code) ? error.code : 'REFERRAL_UNAVAILABLE' }))
    .finally(() => { if (bindFlight === flight) bindFlight = null })
  bindFlight = flight
  return flight
}
function getReferralStatus() {
  const pending = readPending()
  return { pendingVisits: (Array.isArray(pending.visits) ? pending.visits : []).filter(visit => !visit.queued).length,
    droppedVisits: pending.droppedVisits || 0, expiredVisits: pending.expiredVisits || 0, error: visitError }
}

function appendParamToPath(target, key, value) {
  const safeValue = encodeURIComponent(value)
  if (!target) return `${key}=${safeValue}`

  const [base, hash = ""] = String(target).split("#")
  const joiner = base.indexOf("?") >= 0 ? "&" : "?"
  const next = `${base}${joiner}${key}=${safeValue}`
  return hash ? `${next}#${hash}` : next
}

function appendParamToQuery(query, key, value) {
  const safeValue = encodeURIComponent(value)
  const text = String(query || "").replace(/^[?&]+/, "")
  return text ? `${text}&${key}=${safeValue}` : `${key}=${safeValue}`
}

function withReferralShare(config = {}) {
  if (isTimelinePreview()) return config
  const code = getMyReferralCodeSync()
  if (!code) return config

  const next = { ...config }
  if (next.path) {
    next.path = appendParamToPath(next.path, "ref", code)
  } else {
    next.query = appendParamToQuery(next.query || "", "ref", code)
  }
  return next
}

module.exports = { captureReferral, ensureReferralCode, bindPendingReferral, getMyReferralCodeSync,
  setMyReferralCode, withReferralShare, flushReferralVisits, getReferralStatus }
