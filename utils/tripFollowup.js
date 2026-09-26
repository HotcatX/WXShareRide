const rideTime = require('./rideTime')
const { sha256 } = require('./hash')
const analytics = require('./analyticsSession')
const { referencePrice } = require('./rideTelemetry')

const DAY = 86400000
const STORAGE_PREFIX = 'rideFollowupV1_'
const TRIP_ID = /^[A-Za-z0-9_-]{1,80}$/
const text = value => typeof value === 'string' ? value.trim() : ''
const memberId = value => text(typeof value === 'string' ? value : value && (value._openid || value.openid))

function eligibleTrip(trip, account, now) {
  if (!trip || !account || trip.missing || !TRIP_ID.test(text(trip._id))) return null
  const type = text(trip.historySource || trip._sourceType)
  const historyRole = text(trip.historyRole || trip.role).toLowerCase()
  if (!['carpool', 'request'].includes(type) || !['past', 'close'].includes(text(trip.status).toLowerCase())) return null
  if (['cancelled', 'canceled', 'deleted', 'isCancelled', 'isCanceled', 'isDeleted'].some(key =>
    trip[key] === true || trip[key] === 1 || trip[key] === 'true') ||
    ['cancelledAt', 'canceledAt', 'deletedAt'].some(key => !!trip[key])) return null
  const creator = text(trip._openid || trip.openid)
  const driver = type === 'carpool' ? creator : text(trip.driverOpenid)
  const rawPassengers = type === 'carpool' && Array.isArray(trip.passengers) ? trip.passengers : trip.passengerID
  const passengers = (Array.isArray(rawPassengers) ? rawPassengers : []).map(memberId)
  let role = ''
  if ((type === 'carpool' && ['driver_create', 'driver'].includes(historyRole) ||
    type === 'request' && historyRole === 'driver_join') && driver === account) role = 'driver'
  if (driver !== account && (historyRole === 'passenger' && passengers.includes(account) ||
    type === 'request' && ['passenger', 'passenger_create'].includes(historyRole) && creator === account)) role = 'passenger'
  if (!role) return null
  const departures = Array.isArray(trip.departures) ? trip.departures : []
  if (departures.length > 100) return null
  const times = [trip.latestDepartureAtMs, trip.departureAtMs].map(value => {
    if (typeof value !== 'number' && typeof value !== 'string') return 0
    const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : 0
  })
  departures.concat([{ date: trip.firstDepartureDate, time: trip.firstDepartureTime }]).forEach(point => {
    const parsed = rideTime.parseRideDateTime(point && point.date, point && point.time)
    if (Number.isFinite(parsed)) times.push(parsed)
  })
  const departureAt = Math.max(0, ...times)
  if (!departureAt || now - departureAt > 7 * DAY || now < departureAt) return null
  const local = rideTime.getRideDateTime(departureAt)
  const nextMorning = rideTime.parseRideDateTime(rideTime.shiftRideDate(local.date, 1), '09:00')
  if (!Number.isFinite(nextMorning) || now < Math.max(departureAt + 4 * 3600000, nextMorning)) return null
  return { tripKey: text(trip._id), tripType: type, role, departureAt, trip }
}

function createFollowupController(options = {}) {
  const wxApi = options.wx || (typeof wx !== 'undefined' ? wx : null)
  const api = options.analytics || analytics
  const now = options.now || Date.now
  const price = options.referencePrice || referencePrice
  const disposed = new WeakSet()
  let foreground = true, usedThisForeground = false, active = null, storageBlocked = false
  const completedInMemory = new Set()

  function identity() {
    try { return wxApi.getStorageSync('isGuest') ? '' : text(wxApi.getStorageSync('openid')) } catch (_) { return '' }
  }
  function scope() {
    try {
      const value = api.getCollectionScope()
      return typeof value === 'string' && /^(real|test):[A-Za-z0-9_-]{16,80}(?::\d{1,10})?$/.test(value) ? value : ''
    } catch (_) { return '' }
  }
  // Authorization versions invalidate an open prompt, but do not forget an
  // answer already given by this participant in the same real/test mode.
  function participantScope(value) { return value.split(':').slice(0, 2).join(':') }
  function storageKey(value) { return STORAGE_PREFIX + sha256(participantScope(value)) }
  function readState(value) {
    try {
      const saved = wxApi.getStorageSync(storageKey(value))
      if (!saved) return { version: 1, lastPromptAt: 0, entries: {} }
      if (saved.version !== 1 || !Number.isSafeInteger(saved.lastPromptAt) || saved.lastPromptAt < 0 ||
        !saved.entries || typeof saved.entries !== 'object' || Array.isArray(saved.entries) || Object.keys(saved.entries).length > 64) return null
      const entries = {}
      for (const [key, entry] of Object.entries(saved.entries)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !entry || !['shown', 'dismissed', 'answered'].includes(entry.status) ||
          !Number.isSafeInteger(entry.at) || entry.at <= 0) return null
        if (entry.at >= now() - 7 * DAY) entries[key] = { status: entry.status, at: entry.at }
      }
      return { version: 1, lastPromptAt: saved.lastPromptAt, entries }
    } catch (_) { return null }
  }
  function saveState(value, state) {
    try { wxApi.setStorageSync(storageKey(value), state); return true } catch (_) { storageBlocked = true; return false }
  }
  function setView(page, data) { if (page && !disposed.has(page) && typeof page.setData === 'function') page.setData(data) }
  function base(item) { return { followupId: item.followupId, tripKey: item.tripKey, tripType: item.tripType, role: item.role } }
  function record(name, data, meta) {
    if (!meta) return { ok: false }
    try { return api.recordEvent(name, data, meta) || { ok: false } } catch (_) { return { ok: false } }
  }
  function eventMeta(at) {
    try { return { eventId: api.makeEventId(), occurredAt: at } } catch (_) { return null }
  }
  function matches(item) { return item && item.scope === scope() && item.account === identity() && !disposed.has(item.page) }
  function closeView(item) {
    if (active === item) active = null
    setView(item && item.page, { followupVisible: false, followupBusy: false, followupError: '' })
  }
  function considerTrips(page, list) {
    if (active && !matches(active)) closeView(active)
    if (!foreground || usedThisForeground || active || storageBlocked || disposed.has(page) || !Array.isArray(list)) return false
    const account = identity(), currentScope = scope()
    if (!account || !currentScope) return false
    const state = readState(currentScope)
    if (!state || state.lastPromptAt && now() - state.lastPromptAt < DAY) return false
    const candidates = list.map(trip => eligibleTrip(trip, account, now())).filter(Boolean).sort((a, b) => b.departureAt - a.departureAt)
    const candidate = candidates.find(item => {
      item.followupId = sha256([participantScope(currentScope), item.tripType, item.tripKey, item.role].join('|'))
      return !completedInMemory.has(item.followupId) && !(state.entries[item.followupId] && state.entries[item.followupId].status === 'answered')
    })
    if (!candidate) return false
    const shownAt = now()
    state.lastPromptAt = shownAt
    state.entries[candidate.followupId] = { status: 'shown', at: shownAt }
    if (!saveState(currentScope, state)) return false
    const item = Object.assign(candidate, { page, scope: currentScope, account, state, submitted: false, attempt: null })
    const presented = record('followup_presented', base(item), eventMeta(shownAt))
    if (!presented.ok || !matches(item)) return false
    active = item; usedThisForeground = true
    const trip = item.trip, departure = Array.isArray(trip.departures) ? trip.departures[0] || {} : {}
    const destination = Array.isArray(trip.destinations) ? trip.destinations[0] || {} : {}
    const local = rideTime.getRideDateTime(item.departureAt)
    setView(page, { followupVisible: true, followupBusy: false, followupError: '',
      followupTime: local.date + ' ' + local.time,
      followupRoute: [text(trip._fromAddress || departure.address).slice(0, 50), text(trip._toAddress || destination.address).slice(0, 50)].filter(Boolean).join(' → '),
      followupQuestion: item.role === 'driver' ? '您接到乘客了吗？' : '您坐上车了吗？' })
    return true
  }
  function answer(page, outcome) {
    const item = active
    if (!item || item.page !== page || item.submitted || !['yes', 'no'].includes(outcome)) return { ok: false }
    if (!foreground || !matches(item)) { closeView(item); return { ok: false } }
    if (!item.attempt || item.attempt.outcome !== outcome) item.attempt = {
      outcome, meta: eventMeta(now())
    }
    const data = Object.assign(base(item), { outcome,
      outcomeScope: item.role === 'driver' ? 'driver_any_passenger' : 'respondent_booking' }, price(item.trip))
    setView(page, { followupBusy: true, followupError: '' })
    const result = record('followup_answer', data, item.attempt.meta)
    if (!result.ok) {
      setView(page, { followupBusy: false, followupError: '暂未保存，可重试或稍后回答。' })
      return { ok: false }
    }
    item.submitted = true
    completedInMemory.add(item.followupId)
    item.state.entries[item.followupId] = { status: 'answered', at: now() }
    saveState(item.scope, item.state) // Only mark done after the persistent event queue accepts it.
    closeView(item)
    return { ok: true }
  }
  function hide(page) {
    const item = active
    if (!item || item.page !== page) return
    if (!item.submitted && matches(item)) {
      record('followup_dismissed', base(item), eventMeta(now()))
      item.state.entries[item.followupId] = { status: 'dismissed', at: now() }
      saveState(item.scope, item.state)
    }
    closeView(item)
  }
  function dispose(page) { hide(page); disposed.add(page) }
  function beginForeground() { if (!foreground) { foreground = true; usedThisForeground = false } }
  function endForeground() { if (active) hide(active.page); foreground = false }
  return { considerTrips, answer, hide, dispose, beginForeground, endForeground }
}

let singleton
function current() { if (!singleton) singleton = createFollowupController(); return singleton }
const exported = { createFollowupController, eligibleTrip, referencePrice, STORAGE_PREFIX }
;['considerTrips', 'answer', 'hide', 'dispose', 'beginForeground', 'endForeground'].forEach(name => {
  exported[name] = function () { return current()[name].apply(null, arguments) }
})
module.exports = exported
