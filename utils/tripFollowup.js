const rideTime = require('./rideTime')
const { sha256 } = require('./hash')
const analytics = require('./analyticsSession')
const { referencePrice } = require('./rideTelemetry')

const DAY = 86400000
const STORAGE_PREFIX = 'rideFollowupV1_'
const TRIP_ID = /^[A-Za-z0-9_-]{1,80}$/
const text = value => typeof value === 'string' ? value.trim() : ''
const memberId = value => text(typeof value === 'string' ? value : value && (value._openid || value.openid))

function eligibleTrip(trip, account, now, history = false) {
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
  if (!departureAt || !history && now - departureAt > 7 * DAY || now < departureAt) return null
  // A past status only means departure has passed, not that the ride arrived.
  // Keep a short completion buffer; there is no longer a next-morning gate.
  if (now < departureAt + 4 * 3600000) return null
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
  let thankedAt = 0

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
      if (saved.version !== 1 || !Number.isSafeInteger(saved.lastPromptAt) || saved.lastPromptAt < 0 || saved.lastPromptAt > now() ||
        !saved.entries || typeof saved.entries !== 'object' || Array.isArray(saved.entries) || Object.keys(saved.entries).length > 64) return null
      const entries = {}
      for (const [key, entry] of Object.entries(saved.entries)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !entry || !['shown', 'dismissed', 'answered'].includes(entry.status) ||
          !Number.isSafeInteger(entry.at) || entry.at <= 0) return null
        if (entry.at >= now() - 7 * DAY) {
          entries[key] = { status: entry.status, at: entry.at }
          if (entry.status === 'answered' && ['yes', 'no'].includes(entry.outcome)) entries[key].outcome = entry.outcome
          if (entry.status === 'dismissed' && entry.assumedOutcome === 'yes') entries[key].assumedOutcome = 'yes'
        }
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
  function thank(page) {
    if (thankedAt && now() - thankedAt < 10000) return
    thankedAt = now()
    setView(page, { feedbackThanks: true })
    ;(options.setTimeout || setTimeout)(() => setView(page, { feedbackThanks: false }), 1400)
    try { if (typeof wxApi?.vibrateShort === 'function') wxApi.vibrateShort({ type: 'light', fail() {} }) } catch (_) {}
  }
  function historyItem(trip) {
    const account = identity(), currentScope = scope()
    const item = eligibleTrip(trip, account, now(), true)
    if (!item || !currentScope) return null
    return Object.assign(item, { account, scope: currentScope,
      followupId: sha256([participantScope(currentScope), item.tripType, item.tripKey, item.role].join('|')) })
  }
  function pendingOutcomes(item) {
    try { return typeof api.getPendingFollowupOutcomes === 'function' ? api.getPendingFollowupOutcomes().filter(value =>
      value.tripKey === item.tripKey && value.tripType === item.tripType && value.role === item.role) : [] } catch (_) { return [] }
  }
  async function readHistoryOutcomes(trips) {
    const account = identity()
    let requestScope = scope()
    if (!account || !Array.isArray(trips)) return null
    const candidates = trips.map(trip => eligibleTrip(trip, account, now(), true)).filter(Boolean)
    const outcomes = []
    for (let offset = 0; offset < candidates.length; offset += 50) {
      const chunk = candidates.slice(offset, offset + 50)
      let pendingBefore = chunk.flatMap(pendingOutcomes)
      let response
      try { response = await api.requestFollowupOutcomes({ schemaVersion: 1,
        trips: chunk.map(({ tripKey, tripType, role }) => ({ tripKey, tripType, role })) }, () => {
        pendingBefore = chunk.flatMap(pendingOutcomes)
        if (!requestScope) requestScope = scope()
      }) } catch (_) { return null }
      if (identity() !== account || !scope() || requestScope && scope() !== requestScope || !response || response.ok !== true ||
        !Array.isArray(response.outcomes) || response.outcomes.length !== chunk.length) return null
      requestScope = scope()
      const seen = new Set()
      for (const value of response.outcomes) {
        const item = chunk.find(item => item.tripKey === value?.tripKey && item.tripType === value.tripType && item.role === value.role)
        if (!item || seen.has(item.tripKey) || !['self_report', 'dismissed_default', 'unanswered'].includes(value.source) ||
          !Number.isSafeInteger(value.occurredAt) || value.occurredAt < 0 || value.occurredAt > now() + 300000 ||
          (value.source === 'unanswered' ? value.outcome !== null :
            !['yes', 'no'].includes(value.outcome) || value.occurredAt <= 0 || value.source === 'dismissed_default' && value.outcome !== 'yes')) return null
        seen.add(item.tripKey)
        const current = historyItem(item.trip), saved = readState(scope())
        if (!current || !saved) return null
        const local = saved.entries[current.followupId]
        // Accepted queue entries may not have reached the collector yet. Keep
        // those explicit choices, using the same precedence as its projection.
        const explicit = local?.status === 'answered' && ['yes', 'no'].includes(local.outcome)
        const assumed = local?.status === 'dismissed' && local.assumedOutcome === 'yes'
        const queued = pendingBefore.filter(value => value.tripKey === item.tripKey && value.tripType === item.tripType && value.role === item.role)
          .concat(pendingOutcomes(item))
        if (explicit || assumed) queued.push({ outcome: explicit ? local.outcome : 'yes',
          source: explicit ? 'self_report' : 'dismissed_default', occurredAt: local.at })
        const chosen = queued.reduce((latest, candidate) => {
          const priority = source => source === 'self_report' ? 2 : source === 'dismissed_default' ? 1 : 0
          return priority(candidate.source) > priority(latest.source) || priority(candidate.source) === priority(latest.source) &&
            candidate.occurredAt > latest.occurredAt ? candidate : latest
        }, value)
        outcomes.push({ tripKey: item.tripKey, tripType: item.tripType, role: item.role,
          outcome: chosen.outcome, source: chosen.source, occurredAt: chosen.occurredAt })
      }
    }
    return outcomes
  }
  function reportHistory(trip, outcome, page) {
    const item = historyItem(trip)
    if (!foreground || !item || !['yes', 'no'].includes(outcome)) return { ok: false }
    const state = readState(item.scope)
    if (!state) return { ok: false }
    // Rapid yes/no corrections must have an unambiguous latest event even when
    // the device clock has not advanced to the next millisecond.
    const observedAt = Number.isSafeInteger(trip._feedbackOccurredAt) && trip._feedbackOccurredAt > 0 ? trip._feedbackOccurredAt : 0
    const pendingAt = Math.max(0, ...pendingOutcomes(item).map(value => value.occurredAt))
    const meta = eventMeta(Math.max(now(), (state.entries[item.followupId]?.at || 0) + 1, observedAt + 1, pendingAt + 1))
    const result = record('followup_answer', Object.assign(base(item), { outcome,
      outcomeScope: item.role === 'driver' ? 'driver_any_passenger' : 'respondent_booking' }, price(item.trip)), meta)
    if (!result.ok || item.account !== identity() || item.scope !== scope()) return { ok: false }
    completedInMemory.add(item.followupId)
    state.entries[item.followupId] = { status: 'answered', at: meta.occurredAt, outcome }
    // The existing bounded prompt cache is supplementary; the persistent event
    // queue owns delivery. Never add a second journal or block its accepted ACK.
    const recent = Object.entries(state.entries).sort((a, b) => b[1].at - a[1].at).slice(0, 64)
    state.entries = Object.fromEntries(recent)
    saveState(item.scope, state)
    try { Promise.resolve(api.flush()).catch(() => {}) } catch (_) {}
    thank(page)
    return { ok: true, outcome, source: 'self_report', occurredAt: meta.occurredAt }
  }
  function matches(item) { return item && item.scope === scope() && item.account === identity() && !disposed.has(item.page) }
  function closeView(item) {
    if (active === item) active = null
    setView(item && item.page, { followupVisible: false, followupBusy: false, followupError: '' })
  }
  function canConsider() {
    if (active && !matches(active)) closeView(active)
    return foreground && !usedThisForeground && !active && !storageBlocked && !!identity() && !!scope()
  }
  function considerTrips(page, list) {
    if (!canConsider() || disposed.has(page) || !Array.isArray(list)) return false
    const account = identity(), currentScope = scope()
    if (!account || !currentScope) return false
    const state = readState(currentScope)
    if (!state || Object.keys(state.entries).length >= 64) return false
    const candidates = list.map(trip => eligibleTrip(trip, account, now())).filter(Boolean).sort((a, b) => b.departureAt - a.departureAt)
    const candidate = candidates.find(item => {
      item.followupId = sha256([participantScope(currentScope), item.tripType, item.tripKey, item.role].join('|'))
      // Showing once consumes this trip's prompt, including old dismissed
      // entries and an interrupted session. Never infer an answer from shown.
      return !completedInMemory.has(item.followupId) && !state.entries[item.followupId]
    })
    if (!candidate) return false
    const shownAt = now()
    const previousPromptAt = state.lastPromptAt
    state.lastPromptAt = shownAt
    state.entries[candidate.followupId] = { status: 'shown', at: shownAt }
    if (!saveState(currentScope, state)) return false
    const item = Object.assign(candidate, { page, scope: currentScope, account, state, submitted: false, attempt: null })
    const presented = record('followup_presented', base(item), eventMeta(shownAt))
    if (!presented.ok) {
      // No prompt was displayed. Queue pressure must not consume its one chance.
      delete state.entries[candidate.followupId]
      state.lastPromptAt = previousPromptAt
      saveState(currentScope, state)
      return false
    }
    if (!matches(item)) return false
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
      setView(page, { followupBusy: false, followupError: '暂未保存，请重试。' })
      return { ok: false }
    }
    item.submitted = true
    completedInMemory.add(item.followupId)
    item.state.entries[item.followupId] = { status: 'answered', at: item.attempt.meta.occurredAt, outcome }
    saveState(item.scope, item.state) // Only mark done after the persistent event queue accepts it.
    closeView(item)
    thank(page)
    return { ok: true }
  }
  function hide(page, explicitClose = false) {
    const item = active
    if (!item || item.page !== page) return
    if (!item.submitted && matches(item)) {
      const data = Object.assign(base(item), { dismissalReason: explicitClose ? 'close' : 'hidden' })
      // A close is the product's default outcome, not a self-reported answer.
      // Background/navigation never opts the user into that assumption.
      if (explicitClose) Object.assign(data, { assumedOutcome: 'yes',
        outcomeScope: item.role === 'driver' ? 'driver_any_passenger' : 'respondent_booking' }, price(item.trip))
      const result = record('followup_dismissed', data, eventMeta(now()))
      completedInMemory.add(item.followupId)
      item.state.entries[item.followupId] = { status: 'dismissed', at: now(), ...(explicitClose && result.ok ? { assumedOutcome: 'yes' } : {}) }
      saveState(item.scope, item.state)
    }
    closeView(item)
  }
  function dismiss(page) { hide(page, true) }
  function dispose(page) { hide(page); disposed.add(page) }
  function beginForeground() { if (!foreground) { foreground = true; usedThisForeground = false } }
  function endForeground() { if (active) hide(active.page); foreground = false }
  return { canConsider, considerTrips, answer, dismiss, hide, dispose, beginForeground, endForeground, readHistoryOutcomes, reportHistory, thank }
}

let singleton
function current() { if (!singleton) singleton = createFollowupController(); return singleton }
const exported = { createFollowupController, eligibleTrip, referencePrice, STORAGE_PREFIX }
;['canConsider', 'considerTrips', 'answer', 'dismiss', 'hide', 'dispose', 'beginForeground', 'endForeground', 'readHistoryOutcomes', 'reportHistory', 'thank'].forEach(name => {
  exported[name] = function () { return current()[name].apply(null, arguments) }
})
module.exports = exported
