// Optional publisher suggestions: bounded reads, page-local cache, no writes.
const backend = require('./backendClient')
const rides = require('./compat/rides')
const { toHistoryRide } = require('./compat/rideHistory')
const { resolvePlaceId } = require('./placeCatalog')
const { getRideDateTime, parseRideDateTime, shiftRideDate } = require('./rideTime')
const telemetry = require('./rideTelemetry')

const place = value => resolvePlaceId(value) === 'unknown'
  ? String(value || '').trim().replace(/\s+/g, ' ').toLowerCase() : resolvePlaceId(value)
const routeKey = (from, to) => JSON.stringify([place(from), place(to)])

function requestPlan(form, history, now = Date.now()) {
  const from = form.departureAddress, to = form.destinationAddress
  const routes = new Map()
  for (const trip of history) {
    if (trip.cityKey !== form.cityKey || trip.departures.length !== 1 || trip.destinations.length !== 1) continue
    const a = trip.departures[0].address, b = trip.destinations[0].address
    const key = routeKey(a, b), previous = routes.get(key)
    routes.set(key, { from: a, to: b, weight: (previous?.weight || 0) + 1 })
  }
  const selected = from && to ? [{ from, to, weight: 1 }] : [...routes.values()]
    .filter(route => (!from || place(from) === place(route.from)) && (!to || place(to) === place(route.to)))
    .sort((a, b) => b.weight - a.weight).slice(0, 3)
  const startDate = form.departureDate || getRideDateTime(now).date
  return { cityKey: form.cityKey, routes: selected, startDate,
    endDateExclusive: shiftRideDate(startDate, form.departureDate ? 1 : 2),
    time: form.departureTime || '', basis: from && to ? 'form' : 'history' }
}

function selectRequests(rows, plan, now = Date.now()) {
  const weights = new Map(plan.routes.map(route => [routeKey(route.from, route.to), route.weight]))
  return [...new Map(rows.map(row => [row._id, row])).values()].filter(trip => {
    const from = trip.departures[0], to = trip.destinations[0]
    const difference = trip.departureAtMs - parseRideDateTime(from?.date, plan.time)
    return trip.kind === 'request' && trip.status === 'open' && !trip.hasDriver &&
      trip.cityKey === plan.cityKey && trip.departures.length === 1 && trip.destinations.length === 1 &&
      weights.has(routeKey(from.address, to.address)) && trip.departureAtMs > now &&
      from.date >= plan.startDate && from.date < plan.endDateExclusive &&
      (!plan.time || difference >= -30 * 60000 && difference <= 15 * 60000)
  }).sort((a, b) => {
    const delta = trip => plan.time ? Math.abs(trip.departureAtMs - parseRideDateTime(trip.departures[0].date, plan.time)) : trip.departureAtMs - now
    const weight = trip => weights.get(routeKey(trip.departures[0].address, trip.destinations[0].address))
    return (plan.basis === 'history' ? weight(b) - weight(a) : 0) || delta(a) - delta(b) || a.departureAtMs - b.departureAtMs || a._id.localeCompare(b._id)
  }).slice(0, 3).map(trip => ({ ...trip, _type: 'request',
    fromText: trip.departures[0].address, toText: trip.destinations[0].address,
    timeText: trip.departures[0].time, dateText: `${Number(trip.departures[0].date.slice(5, 7))}月${Number(trip.departures[0].date.slice(8, 10))}日` }))
}

function createRequestRecommendations(page, city, options = {}) {
  const api = options.backend || backend, lists = options.rides || rides, platform = options.wx || wx, events = options.telemetry || telemetry
  const now = options.now || Date.now
  const account = () => platform.getStorageSync('isGuest') ? '' : platform.getStorageSync('openid') || ''
  const cache = new Map()
  let history, historyOwner, timer, revision = 0
  const form = () => ({ mode: page.data.mode, departureAddress: page.data.departureAddress,
    destinationAddress: page.data.destinationAddress, departureDate: page.data.departureDate,
    departureTime: page.data.departureTime, cityKey: city(), owner: account(),
    disabled: !!page.data.publishedRide || (page._selectedTemplate?.definition.stops.length || 0) > 2 })
  async function driverHistory(owner) {
    if (!owner) return []
    if (historyOwner !== owner) { historyOwner = owner; history = null; cache.clear() }
    if (!history) history = api.get('/api/v1/me/rides?scope=history&role=driver&page=1&limit=50')
      .then(result => result.rides.filter(row => row.role === 'driver' && row.isCreator && row.kind === 'offer').map(row => toHistoryRide(row, owner)))
      .catch(() => [])
    return history
  }
  async function requests(plan, owner) {
    if (!plan.routes.length) return { rows: [], source: 'cache' }
    const key = JSON.stringify([owner, plan.cityKey, plan.startDate, plan.endDateExclusive])
    const saved = cache.get(key)
    if (saved && now() - saved.at < 60000) return { rows: await saved.value, source: 'cache' }
    const value = lists.callTripList({ type: 'request', cityKey: plan.cityKey,
      startDate: plan.startDate, endDateExclusive: plan.endDateExclusive })
      .then(response => response.result.data.request).catch(error => { cache.delete(key); throw error })
    cache.set(key, { at: now(), value })
    if (cache.size > 8) cache.delete(cache.keys().next().value)
    return { rows: await value, source: 'network' }
  }
  async function load() {
    const current = ++revision, snapshot = form()
    const valid = () => current === revision && !page._calendarDisposed && !page._rideTelemetryHidden && JSON.stringify(snapshot) === JSON.stringify(form())
    if (snapshot.mode !== 'driver' || snapshot.disabled) return
    try {
      const previous = snapshot.departureAddress && snapshot.destinationAddress ? [] : await driverHistory(snapshot.owner)
      if (!valid()) return
      const plan = requestPlan(snapshot, previous, now())
      const result = await requests(plan, snapshot.owner)
      const trips = selectRequests(result.rows, plan, now())
      if (!valid()) return
      const context = { surface: 'driver_publish', basis: plan.basis,
        ...(snapshot.departureAddress ? { originPlaceIds: [resolvePlaceId(snapshot.departureAddress)] } : {}),
        ...(snapshot.destinationAddress ? { destinationPlaceIds: [resolvePlaceId(snapshot.destinationAddress)] } : {}),
        ...(snapshot.departureDate ? { serviceDate: snapshot.departureDate } : {}),
        ...(snapshot.departureTime ? { departureMinute: Number(snapshot.departureTime.slice(0, 2)) * 60 + Number(snapshot.departureTime.slice(3)) } : {}) }
      page.setData({ requestSuggestions: trips }, () => {
        if (valid()) events.renderList(page, [{ items: trips }], { source: result.source, queryKey: JSON.stringify(plan), context })
      })
    } catch (_) { /* Suggestions never interrupt publishing. */ }
  }
  return {
    refresh() {
      revision++; clearTimeout(timer); events.stopList(page)
      page.setData({ requestSuggestions: [] })
      timer = setTimeout(load, 250)
    },
    pause() { revision++; clearTimeout(timer); events.pageHidden(page) },
    observe() { events.observeList(page) },
    show() { events.pageVisible(page); this.refresh() },
    async load() { clearTimeout(timer); await load() }
  }
}

module.exports = { requestPlan, selectRequests, createRequestRecommendations }
