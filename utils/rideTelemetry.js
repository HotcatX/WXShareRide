const research = require('./researchParticipation')
const { resolvePlaceId } = require('./placeCatalog')

const validTripId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)
const tripType = value => value === 'request' ? 'request' : 'carpool'
function referencePrice(trip = {}) {
  const raw = trip.referencePrice != null ? trip.referencePrice : trip.price != null ? trip.price : trip.displayPrice
  const text = String(raw == null ? '' : raw).trim()
  const match = /^(?:\$\s*)?(\d{1,4}(?:\.\d{1,2})?)\s*(?:\$|USD|美元)?\s*(?:\/人)?$/i.exec(text)
  if (!match) return {}
  const cents = Math.round(Number(match[1]) * 100)
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= 1000000
    ? { referencePriceCents: cents, currency: 'USD', priceKind: 'listed_reference' } : {}
}
function coarseArea(value) {
  const text = String(value || '').toLowerCase()
  if (!text || text === '全部') return 'unknown'
  const known = resolvePlaceId(text)
  if (known !== 'unknown') return known
  if (/fort\s*lee|李堡/.test(text)) return 'fort_lee'
  if (/columbia|哥大|哥伦比亚/.test(text)) return 'columbia'
  if (/flushing|法拉盛/.test(text)) return 'flushing'
  if (/(?:^|[^a-z])jfk(?:$|[^a-z])|肯尼迪机场|john\s*f\.?\s*kennedy/.test(text)) return 'jfk'
  if (/(?:^|[^a-z])ewr(?:$|[^a-z])|newark\s+(?:liberty\s+)?(?:international\s+)?airport|纽瓦克(?:自由)?(?:国际)?机场/.test(text)) return 'ewr'
  if (/(?:^|[^a-z])lga(?:$|[^a-z])|la\s*guardia|拉瓜[迪地]亚/.test(text)) return 'lga'
  if (/(?:^|[^a-z])lic(?:$|[^a-z])|long\s+island\s+city|长岛市/.test(text)) return 'lic'
  if (/(?:^|[^a-z])jsq(?:$|[^a-z])|journal\s+square/.test(text)) return 'jsq'
  return 'other'
}
function snapshot(trip = {}, now = Date.now()) {
  const out = { ...referencePrice(trip), snapshotAt: now }
  const stopIds = stops => (Array.isArray(stops) ? stops : []).slice(0, 10).map(stop => {
    const known = resolvePlaceId(stop && stop.address)
    return known !== 'unknown' ? known : stop && stop.address ? 'custom' : 'unknown'
  })
  out.originPlaceIds = stopIds(trip.departures)
  out.destinationPlaceIds = stopIds(trip.destinations)
  if (Number.isSafeInteger(trip.businessVersion) && trip.businessVersion >= 0 && trip.businessVersion <= 2147483647) out.tripVersion = trip.businessVersion
  if (Number.isSafeInteger(trip.__dataGeneratedAt) && trip.__dataGeneratedAt > 0 && trip.__dataGeneratedAt <= now + 300000) {
    out.dataGeneratedAt = trip.__dataGeneratedAt; out.dataTimeSource = 'server'
  } else out.dataTimeSource = 'unknown'
  const dep = (Array.isArray(trip.departures) ? trip.departures : []).find(item => item && item.date) || {}
  const dest = (Array.isArray(trip.destinations) ? trip.destinations : []).find(item => item && item.address) || {}
  const parsedDate = new Date(`${dep.date}T12:00:00Z`)
  if (/^20\d\d-\d\d-\d\d$/.test(dep.date || '') && Number.isFinite(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === dep.date) out.serviceDate = dep.date
  const time = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(dep.time || '')
  if (time && +time[1] < 24 && +time[2] < 60) out.departureMinute = +time[1] * 60 + +time[2]
  const seats = trip.availSeatNum
  if (seats !== '' && seats != null && Number.isInteger(Number(seats)) && +seats >= 0 && +seats <= 20) out.availableSeats = +seats
  out.originArea = coarseArea(dep.address)
  out.destinationArea = coarseArea(dest.address)
  return out
}
function emit(name, data, meta) {
  try { return research.recordEvent(name, data, meta) || { ok: false } } catch (_) { return { ok: false } }
}
function scope() {
  try { return research.getCollectionScope() || '' } catch (_) { return '' }
}
function listVisible(page) {
  const data = page.data || {}
  return !page._listDisposed && page._researchVisible !== false && !data.loading && !data.placePickerVisible &&
    !data.refineFiltersVisible && !data.calendarVisible && !data.cityPickerVisible
}
function stopList(page) {
  const state = page._rideObservation
  if (!state) return
  state.closed = true
  try { if (state.observer) state.observer.disconnect() } catch (_) {}
  state.timers.forEach(timer => clearTimeout(timer))
  state.timers.clear()
  page._rideObservation = null
}
function observeList(page) {
  stopList(page)
  const current = page._rideResultSet
  if (!current || !listVisible(page) || !current.scope || current.scope !== scope()) return
  const api = typeof wx !== 'undefined' ? wx : {}
  const create = page.createIntersectionObserver ? opts => page.createIntersectionObserver(opts)
    : api.createIntersectionObserver ? opts => api.createIntersectionObserver(page, opts) : null
  if (!create) return
  const state = { timers: new Map(), closed: false, observer: null }
  page._rideObservation = state
  try {
    state.observer = create({ thresholds: [0, 0.5, 1], initialRatio: 0, observeAll: true })
    state.observer.relativeTo('.list-scroll').observe('.list-trip-card', entry => {
      if (state.closed) return
      const data = entry.dataset || {}
      const key = `${data.type}:${data.id}`
      const candidate = current.byKey.get(key)
      if (!candidate || current.seen.has(key)) return
      const visible = Number(entry.intersectionRatio) >= 0.5 && listVisible(page)
      if (!visible) {
        if (state.timers.has(key)) clearTimeout(state.timers.get(key))
        state.timers.delete(key)
        return
      }
      if (state.timers.has(key)) return
      state.timers.set(key, setTimeout(() => {
        state.timers.delete(key)
        if (state.closed || page._rideResultSet !== current || !listVisible(page) || scope() !== current.scope) return
        const result = emit('result_card_visible', { selectionSetId: current.id, ...candidate, visibilityBucket: 'half_1s' })
        if (result.ok) current.seen.add(key)
      }, 1000))
    })
  } catch (_) { stopList(page) }
}
function renderList(page, groups, options = {}) {
  stopList(page)
  if (!listVisible(page) || typeof research.makeEventId !== 'function') return ''
  const currentScope = scope()
  if (!currentScope) return ''
  const trips = (groups || []).reduce((all, group) => all.concat(group.items || []), [])
  if (trips.length > 500) return ''
  const at = Date.now()
  const candidates = trips.map((trip, position) => validTripId(trip._id)
    ? { tripKey: trip._id, tripType: tripType(trip._type), position, ...snapshot(trip, at) } : null).filter(Boolean)
  const id = research.makeEventId()
  const summary = { selectionSetId: id, source: options.source === 'network' ? 'network' : 'cache',
    renderedCount: trips.length, hasMore: page.data.hasMoreDays === true,
    candidates: candidates.slice(0, 50), candidatesComplete: candidates.length === trips.length && trips.length <= 50 }
  let result
  if (options.searchId && typeof research.recordResults === 'function') {
    result = research.recordResults({ ...summary, searchId: options.searchId, loadedDateCount: 1 })
  } else result = emit('list_snapshot', summary)
  if (!result || !result.ok) { page._rideResultSet = null; return '' }
  page._rideResultSet = { id, scope: currentScope, seen: new Set(), byKey: new Map(candidates.map(item => [`${item.tripType}:${item.tripKey}`, item])) }
  observeList(page)
  return id
}
function clickTrip(page, id, type, trip) {
  if (!validTripId(id)) return
  const current = page._rideResultSet
  const candidate = current && current.scope === scope() && current.byKey.get(`${type}:${id}`)
  emit('trip_card_clicked', candidate ? { selectionSetId: current.id, ...candidate }
    : { tripKey: id, tripType: tripType(type), ...snapshot(trip || {}) })
}
function pageVisible(page) {
  if (page._rideTelemetryHidden) page._rideDetailSeen = ''
  page._rideTelemetryHidden = false
}
function pageHidden(page) {
  page._rideTelemetryHidden = true; stopList(page)
  if (page._rideDetailSubscription) page._rideDetailSubscription()
  page._rideDetailSubscription = null; page._rideDetailPending = null
}
function viewer() {
  try { return wx.getStorageSync('isGuest') ? '' : String(wx.getStorageSync('openid') || '') } catch (_) { return '' }
}
function detailViewed(page, trip, type, source) {
  if (!trip || !validTripId(trip._id) || page._rideTelemetryHidden || page.data.routeExpired) return
  page._rideDetailPending = { trip, type, source, viewer: viewer() }
  if (!page._rideDetailSubscription && typeof research.subscribe === 'function') {
    page._rideDetailSubscription = () => {}
    page._rideDetailSubscription = research.subscribe(state => {
      const pending = page._rideDetailPending
      if (state.participating && pending && pending.viewer === viewer() && !page._rideTelemetryHidden) {
        detailViewed(page, pending.trip, pending.type, pending.source)
      }
    })
  }
  const currentScope = scope()
  if (!currentScope) return
  const key = `${currentScope}:${type}:${trip._id}`
  if (page._rideDetailSeen === key) return
  if (!source) {
    let previous = ''
    try { const pages = getCurrentPages(); previous = (pages[pages.length - 2] || {}).route || '' } catch (_) {}
    const options = page.__timelineOptions || page.__referralShareOptions || {}
    source = options.fromShare === '1' ? 'share' : /carpoolList/.test(previous) ? 'list' : /profile\//.test(previous) ? 'history' : 'other'
  }
  if (emit('detail_viewed', { tripKey: trip._id, tripType: tripType(type), source, ...snapshot(trip) }).ok) page._rideDetailSeen = key
}
function copyContact(page, content, channel, targetRole, original = {}) {
  const data = page.data || {}
  const type = data.sourceType === 'request' || data.requestId || /Request|requestDetail/.test(page.route || '') ? 'request' : 'carpool'
  const tripKey = data.tripId || data.requestId || (data.trip && data.trip._id) || ''
  const startScope = scope()
  const send = outcome => {
    if (startScope && scope() === startScope && validTripId(tripKey)) emit('contact_action', {
      tripKey, tripType: type, channel, action: 'copy', targetRole, outcome })
  }
  send('attempt')
  return wx.setClipboardData({ ...original, data: content,
    success() { send('success'); if (original.success) return original.success.apply(this, arguments) },
    fail() { send('failure'); if (original.fail) return original.fail.apply(this, arguments) }
  })
}

const safe = fn => function () { try { return fn.apply(this, arguments) } catch (_) { return '' } }
module.exports = { referencePrice, coarseArea, snapshot, renderList: safe(renderList), observeList: safe(observeList),
  stopList, clickTrip: safe(clickTrip), pageVisible, pageHidden, detailViewed: safe(detailViewed), copyContact, validTripId }
