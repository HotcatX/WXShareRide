// TEMPORARY DTO ADAPTER — remove with the old history view after the next
// release is verified. Membership authority comes from /me/rides, never public
// ride fields. Only the current caller is projected into legacy OpenID slots.
const backend = require('../backendClient')
const rideTime = require('../rideTime')
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const invalid = () => Object.assign(new Error('历史行程响应异常，请重试'), { code: 'INVALID_RESPONSE' })
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))

function toHistoryRide(row, account) {
  if (!object(row) || typeof row.id !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(row.id) || !['offer', 'request'].includes(row.kind) ||
    !['open', 'closed'].includes(row.status) || !['driver', 'passenger'].includes(row.role) ||
    typeof row.isCreator !== 'boolean' || typeof row.followupEligible !== 'boolean' ||
    !instant(row.departureAt) || !instant(row.latestDepartureAt) || !Array.isArray(row.stops) || row.stops.length > 20 ||
    typeof account !== 'string' || !account || row.stops.some(stop => !object(stop) ||
      !['departure', 'destination'].includes(stop.kind) || typeof stop.address !== 'string' ||
      (stop.departureAt !== null && !instant(stop.departureAt)))) throw invalid()
  const point = stop => {
    const local = stop.departureAt ? rideTime.getRideDateTime(Date.parse(stop.departureAt)) : null
    return { address: stop.address, placeId: stop.placeId || '', ...(local ? { date: local.date, time: local.time } : {}) }
  }
  const historySource = row.kind === 'offer' ? 'carpool' : 'request'
  const historyRole = row.role === 'driver' ? row.kind === 'offer' ? 'driver_create' : 'driver_join'
    : row.kind === 'request' && row.isCreator ? 'passenger_create' : 'passenger'
  const eligible = row.followupEligible && row.status === 'closed'
  const ownCreator = eligible && row.isCreator
  const ownDriver = eligible && row.role === 'driver'
  const cents = row.listedPriceCents
  if (cents !== null && (!Number.isSafeInteger(cents) || cents < 0) ||
    row.listedPriceLabel !== null && typeof row.listedPriceLabel !== 'string' ||
    row.driverUserId != null && (typeof row.driverUserId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.driverUserId)) ||
    row.myRating != null && (!Number.isInteger(row.myRating) || row.myRating < 1 || row.myRating > 5)) throw invalid()
  return { _id: row.id, historySource, historyRole, status: row.status === 'closed' ? 'past' : 'open',
    businessVersion: row.version, cityKey: row.cityKey,
    driverUserId: row.role === 'passenger' && eligible ? row.driverUserId || '' : '',
    myRating: row.role === 'passenger' && eligible ? row.myRating || 0 : 0,
    departures: row.stops.filter(stop => stop.kind === 'departure').map(point),
    destinations: row.stops.filter(stop => stop.kind === 'destination').map(point),
    departureAtMs: Date.parse(row.departureAt), latestDepartureAtMs: Date.parse(row.latestDepartureAt),
    // Do not reparse an unresolved label into a scalar the server rejected.
    // The exact display label survives separately; followup uses proven cents.
    listedPriceLabel: row.listedPriceLabel,
    referencePrice: cents === null ? '' : (cents / 100).toFixed(2),
    _openid: ownCreator ? account : '', driverOpenid: ownDriver ? account : '',
    passengers: eligible && row.kind === 'offer' && row.role === 'passenger' ? [{ _openid: account }] : [],
    passengerID: eligible && row.kind === 'request' && row.role === 'passenger' ? [account] : [] }
}

async function loadRideHistory(account, options = {}) {
  const api = options.backend || backend
  const wxApi = options.wx || wx
  const current = () => !wxApi.getStorageSync('isGuest') && wxApi.getStorageSync('openid') === account
  if (typeof account !== 'string' || !account || !current()) throw invalid()
  if (!api.isBackendEnabled()) {
    // TEMPORARY FALLBACK — default mode retains the existing read. A server
    // failure never switches to this older source or becomes empty success.
    return wxApi.cloud.callFunction({ name: 'getMyTripHistory' })
  }
  const rows = [], seen = new Set()
  let page = 1
  while (page !== null) {
    if (!current()) throw invalid()
    const result = await api.get(`/api/v1/me/rides?scope=history&page=${page}&limit=50`)
    if (!current() || !object(result) || !Array.isArray(result.rides) || result.rides.length > 50 ||
      result.nextPage !== null && (!Number.isInteger(result.nextPage) || result.nextPage !== page + 1 || result.nextPage > 1000 || result.rides.length !== 50)) throw invalid()
    for (const row of result.rides) {
      const trip = toHistoryRide(row, account)
      if (seen.has(trip._id)) throw invalid()
      seen.add(trip._id); rows.push(trip)
    }
    page = result.nextPage
  }
  return { result: { ok: true, data: rows } }
}

module.exports = { toHistoryRide, loadRideHistory }
