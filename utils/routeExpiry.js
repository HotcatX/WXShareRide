const { parseRideDateTime } = require('./rideTime')

const ENDED_STATUSES = new Set([
  'past', 'close', 'closed', 'finished', 'completed', 'expired', 'ended',
  'cancelled', 'canceled', 'deleted'
])
const ENDED_FLAGS = ['isDeleted', 'deleted', 'isCancelled', 'isCanceled', 'cancelled', 'canceled',
  'isEnded', 'ended', 'completed', 'deletedAt', 'cancelledAt', 'canceledAt', 'endedAt', 'completedAt']

function timestamp(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return NaN
  const ms = Number(value)
  return Number.isFinite(ms) && ms > 0 ? ms : NaN
}

function getRouteExpiryAt(trip = {}) {
  if (!trip) return NaN
  // Use the server's absolute timestamp first; legacy wall times are New York time.
  for (const value of [trip.latestDepartureAtMs, trip.departureAtMs]) {
    const ms = timestamp(value)
    if (Number.isFinite(ms)) return ms
  }
  const departures = Array.isArray(trip.departures) ? trip.departures : []
  const times = departures.map(item => item && parseRideDateTime(item.date, item.time))
    .filter(value => Number.isFinite(value) && value > 0)
  if (times.length) return Math.max(...times)
  return parseRideDateTime(trip.firstDepartureDate, trip.firstDepartureTime)
}

function isRouteExpired(trip, now = Date.now()) {
  if (!trip) return false
  if (ENDED_STATUSES.has(String(trip.status || '').trim().toLowerCase())) return true
  if (ENDED_FLAGS.some(key => trip[key] === true || (key.endsWith('At') && !!trip[key]))) return true
  const expiresAt = getRouteExpiryAt(trip)
  return Number.isFinite(expiresAt) && expiresAt <= now
}

module.exports = { getRouteExpiryAt, isRouteExpired }
