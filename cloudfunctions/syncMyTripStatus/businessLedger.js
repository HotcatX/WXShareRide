// Kept byte-identical in each independently deployed ride cloud function.
const crypto = require('crypto')

const clean = (value, max = 200) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, max)
const unique = values => Array.from(new Set(values.filter(Boolean)))
const boundedInt = (value, max) => Number.isSafeInteger(finite(value)) && finite(value) >= 0 && finite(value) <= max ? finite(value) : null
const validDate = value => /^20\d\d-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null
const { resolvePlaceId } = require('./placeCatalog')
function placeId(value) { const id = resolvePlaceId(clean(value)); return id === 'unknown' ? '' : id }
function points(items) {
  const raw = (Array.isArray(items) ? items : []).slice(0, 12)
  // Unknown legacy endpoints stay explicitly blank; malformed old data must not
  // poison the durable outbox or be silently recast as a known public place.
  return (raw.length ? raw : [{}]).map(point => ({
    address: clean(point && point.address), placeId: placeId(point && point.address),
    date: validDate(clean(point && point.date, 10)) ? clean(point.date, 10) : '', time: clean(point && point.time, 8)
  }))
}
function snapshot(type, doc, version) {
  if (!doc) return null
  const creatorOpenid = clean(doc._openid, 128)
  const driverOpenid = type === 'request' ? clean(doc.driverOpenid, 128) : creatorOpenid
  const passengerOpenids = unique((type === 'request'
    ? [creatorOpenid].concat(Array.isArray(doc.passengerID) ? doc.passengerID : [])
    : (Array.isArray(doc.passengers) ? doc.passengers : []).map(p => typeof p === 'string' ? p : p && p._openid))
    .map(id => clean(id, 128))).slice(0, 100)
  const departures = points(doc.departures)
  const destinations = points(doc.destinations)
  const rawPrice = clean(doc.referencePrice).replace(/^\$\s*/, '')
  const parsedPrice = /^\d+(?:\.\d{1,2})?$/.test(rawPrice) ? Math.round(Number(rawPrice) * 100) : null
  const count = boundedInt(doc.passengerCount, 100)
  const rawCity = clean(doc.cityKey, 80)
  const rawStatus = clean(doc.status || 'open', 32)
  const serviceDate = clean(doc.firstDepartureDate || (departures[0] && departures[0].date), 10)
  return {
    cityKey: ['ny', 'nj', 'ny_nj', ''].includes(rawCity) || !/^[A-Za-z0-9_.:-]{1,80}$/.test(rawCity) ? 'ny_nj' : rawCity,
    status: /^[A-Za-z0-9_-]{1,32}$/.test(rawStatus) ? rawStatus : 'unknown', departures, destinations,
    referencePriceCents: parsedPrice !== null && parsedPrice <= 1000000 ? parsedPrice : null,
    currency: 'USD', priceKind: 'listed_reference',
    availableSeats: type === 'request' ? Math.max(0, 4 - (count || passengerOpenids.length)) : boundedInt(doc.availSeatNum == null ? doc.passengerCount : doc.availSeatNum, 20),
    passengerCount: count === null ? passengerOpenids.length : count, creatorOpenid, driverOpenid, passengerOpenids,
    participantEdges: (driverOpenid ? [{ openid: driverOpenid, role: 'driver' }] : []).concat(passengerOpenids.filter(id => id !== driverOpenid).map(openid => ({ openid, role: 'passenger' }))),
    serviceDate: validDate(serviceDate) ? serviceDate : '',
    departureAtMs: boundedInt(doc.departureAtMs, Number.MAX_SAFE_INTEGER), latestDepartureAtMs: boundedInt(doc.latestDepartureAtMs, Number.MAX_SAFE_INTEGER),
    tripVersion: version
  }
}
function nextVersion(doc) {
  const value = Number(doc && doc.businessVersion)
  return Number.isSafeInteger(value) && value >= 0 ? value + 1 : 1
}
function isSyntheticContext(context) {
  // Only the trusted invocation context can mark newly created records as tests.
  try {
    const env = typeof (context && context.environment) === 'string' ? JSON.parse(context.environment) :
      Object.fromEntries(String(context && context.environ || '').split(';').map(entry => { const at = entry.indexOf('='); return at > 0 ? [entry.slice(0, at), entry.slice(at + 1)] : ['', ''] }))
    return env.TCB_SOURCE === 'wx_devtools'
  } catch (_) { return false }
}
async function appendBusinessEvent(transaction, db, { type, tripId, action, actorOpenid, before = null, after = null, reason = '', now = Date.now() }) {
  const version = nextVersion(before)
  const eventId = crypto.createHash('sha256').update(`ride-business-v1\n${type}\n${tripId}\n${version}`).digest('hex')
  const beforeSnapshot = snapshot(type, before, Math.max(0, version - 1))
  const afterSnapshot = snapshot(type, after, version)
  const event = {
    schemaVersion: 1, eventId, tripId, tripType: type, action, actorOpenid: clean(actorOpenid, 128),
    eventAtMs: Number(now), version, before: beforeSnapshot, after: afterSnapshot,
    affectedOpenids: unique([...(beforeSnapshot ? beforeSnapshot.participantEdges : []), ...(afterSnapshot ? afterSnapshot.participantEdges : [])].map(edge => edge.openid)),
    synthetic: !!((after || before || {}).businessSynthetic)
  }
  // The outbox row is the durable action log. It must commit with the trip;
  // failure propagates so a successful business operation never loses its fact.
  await transaction.collection('TripActions').add({ data: {
    _id: eventId, action, type, tripId, actorOpenid: event.actorOpenid,
    reason: clean(reason, 180), event, deliveryState: 'pending', createdAt: db.serverDate()
  } })
  return event
}
module.exports = { appendBusinessEvent, snapshot, nextVersion, placeId, isSyntheticContext }
