const defaultRides = require('./compat/rides')
const { resolvePlaceId } = require('./placeCatalog')
const { getRideDateTime, parseRideDateTime, shiftRideDate } = require('./rideTime')

const fail = code => Object.assign(new Error('暂时无法加载'), { code })
const text = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : ''
const open = trip => trip && trip.status === 'open' &&
  (trip.canonicalStatus === undefined || trip.canonicalStatus === 'open')
const EARLIER_WINDOW = 30 * 60 * 1000
const LATER_WINDOW = 15 * 60 * 1000

function place(stop) {
  const address = text(stop && stop.address)
  if (!address) return null
  const known = resolvePlaceId(address)
  // A broad placeId must not equate different building or pickup addresses.
  if (known === 'unknown') return { key: `address:${address}` }
  const explicit = resolvePlaceId(stop.placeId)
  if (explicit !== 'unknown' && explicit !== known) return null
  return { key: `place:${known}` }
}

function departure(stop, absolute) {
  if (!stop || typeof stop.time !== 'string') return NaN
  let time = stop.time
  if (/^\d{2}:\d{2}$/.test(time) && stop.second !== undefined) {
    if (!Number.isInteger(stop.second) || stop.second < 0 || stop.second > 59) return NaN
    time += `:${String(stop.second).padStart(2, '0')}`
  }
  const parsed = parseRideDateTime(stop.date, time)
  if (!Number.isFinite(parsed)) return NaN
  const stamp = absolute === undefined ? parsed : absolute
  if (!Number.isSafeInteger(stamp)) return NaN
  const wall = getRideDateTime(stamp)
  const expected = getRideDateTime(parsed)
  if (wall.date !== expected.date || wall.time !== expected.time || wall.second !== expected.second) return NaN
  // Local clock text cannot identify the two occurrences of an autumn hour.
  if (absolute === undefined) {
    const repeated = getRideDateTime(parsed + 3600000)
    if (repeated.date === expected.date && repeated.time === expected.time && repeated.second === expected.second) return NaN
  }
  return stamp
}

function route(trip) {
  if (!trip || typeof trip._id !== 'string' || !trip._id || typeof trip.cityKey !== 'string' || !trip.cityKey ||
    trip.kind !== 'offer' || !Array.isArray(trip.departures) || !trip.departures.length ||
    !Array.isArray(trip.destinations) || !trip.destinations.length) return null
  const from = trip.departures.map(place), to = trip.destinations.map(place)
  if (from.some(p => !p) || to.some(p => !p)) return null
  const times = trip.departures.map((stop, i) => departure(stop,
    i === 0 ? trip.departureAtMs : i === trip.departures.length - 1 ? trip.latestDepartureAtMs : undefined))
  if (times.some((t, i) => !Number.isFinite(t) || i > 0 && t < times[i - 1])) return null
  return { from, to, times, date: getRideDateTime(times[0]).date,
    key: JSON.stringify([trip.cityKey, from.map(p => p.key), to.map(p => p.key)]) }
}

/** Fresh, complete selected-day reads; callers own page/account cancellation guards. */
async function loadRideAlternatives(trip, options = {}) {
  const source = route(trip)
  if (!source) throw fail('INVALID_ALTERNATIVE_ROUTE')
  const now = () => typeof options.now === 'function' ? options.now() : options.now === undefined ? Date.now() : options.now
  if (!Number.isFinite(now())) throw fail('INVALID_ALTERNATIVE_CLOCK')
  if (!open(trip) || source.times[0] <= now()) return []
  const api = options.rides || defaultRides
  const endDateExclusive = shiftRideDate(source.date, 1)
  // Server address patterns do not cover every catalog alias, and custom
  // filters are literal substrings. Read the complete day before strict route
  // matching so valid aliases/whitespace variants cannot become false empties.
  const response = await api.callTripList({ cityKey: trip.cityKey, type: 'carpool',
    startDate: source.date, endDateExclusive })
  const result = response && response.result, page = result && result.page
  if (!result || result.success !== true || !result.data || !Array.isArray(result.data.carpool) ||
    result.data.carpool.length >= 50000 ||
    !page || page.startDate !== source.date || page.endDateExclusive !== endDateExclusive ||
    typeof page.hasMore !== 'boolean' || result.nextPage != null || page.nextPage != null) throw fail('INVALID_ALTERNATIVE_RESPONSE')
  // callTripList already exhausts HTTP pages. page.hasMore concerns later dates,
  // not an unfinished selected-day page; never stop after its first 50 rows.
  // At the API's 1,000 x 50 ceiling, completeness cannot be established.
  const checkedAt = now()
  if (!Number.isFinite(checkedAt)) throw fail('INVALID_ALTERNATIVE_CLOCK')
  if (source.times[0] <= checkedAt) return []
  const seen = new Set()
  const matches = []
  for (const candidate of result.data.carpool) {
    if (!candidate || typeof candidate._id !== 'string' || !candidate._id) throw fail('INVALID_ALTERNATIVE_RESPONSE')
    if (seen.has(candidate._id)) throw fail('RIDE_CHANGED')
    seen.add(candidate._id)
    if (candidate._id === trip._id || !open(candidate) || candidate.hasDriver !== true ||
      !Number.isInteger(candidate.availableSeats) || candidate.availableSeats <= 0 ||
      !Number.isInteger(candidate.seatCapacity) || candidate.availableSeats > candidate.seatCapacity ||
      candidate.availSeatNum !== undefined && candidate.availSeatNum !== candidate.availableSeats) continue
    const candidateRoute = route(candidate)
    if (!candidateRoute || candidateRoute.times[0] <= checkedAt || candidateRoute.key !== source.key ||
      !candidateRoute.times.every((at, i) => at >= source.times[i] - EARLIER_WINDOW && at <= source.times[i] + LATER_WINDOW &&
        getRideDateTime(at).date === getRideDateTime(source.times[i]).date)) continue
    matches.push({ trip: candidate, at: candidateRoute.times[0] })
  }
  return matches.sort((a, b) => Math.abs(a.at - source.times[0]) - Math.abs(b.at - source.times[0]) ||
    a.at - b.at || b.trip.availableSeats - a.trip.availableSeats ||
    (Number.isSafeInteger(a.trip.listedPriceCents) && a.trip.listedPriceCents >= 0 ? a.trip.listedPriceCents : Infinity) -
    (Number.isSafeInteger(b.trip.listedPriceCents) && b.trip.listedPriceCents >= 0 ? b.trip.listedPriceCents : Infinity) ||
    a.trip._id.localeCompare(b.trip._id)).slice(0, 3).map(item => item.trip)
}

module.exports = { loadRideAlternatives }
