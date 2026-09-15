// Keep this helper identical in joinTrip and tripManage; each function deploys alone.
const CLOSED_FLAGS = ['isDeleted', 'deleted', 'isCancelled', 'isCanceled', 'cancelled', 'canceled', 'isEnded', 'ended', 'completed', 'deletedAt', 'cancelledAt', 'canceledAt', 'endedAt', 'completedAt']
function requestPassengerIds(doc = {}) {
  return [...new Set((Array.isArray(doc.passengerID) ? doc.passengerID : [])
    .filter(value => typeof value === 'string').map(value => value.trim()).filter(Boolean))]
}
function requestSeatCount(doc = {}) {
  const members = new Set(requestPassengerIds(doc))
  if (typeof doc._openid === 'string' && doc._openid.trim()) members.add(doc._openid.trim())
  const values = [doc.passengerCount, doc.requestPassengerCount].map(value =>
    (typeof value === 'number' || (typeof value === 'string' && value.trim())) ? Number(value) : NaN)
  const saved = values.find(value => Number.isSafeInteger(value) && value > 0)
  // One creator can book several seats, so IDs alone are not the seat count.
  return Math.max(1, members.size, saved || 0)
}
function parts(ms) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]))
}
function pointTime(point = {}) {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(point.date || ''))
  const time = /^(\d{1,2}):(\d{2})$/.exec(String(point.time || ''))
  if (!date || !time || +time[1] > 23 || +time[2] > 59) return 0
  const target = Date.UTC(+date[1], +date[2] - 1, +date[3], +time[1], +time[2])
  let result = target
  for (let i = 0; i < 2; i++) {
    const p = parts(result)
    result = target - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - result)
  }
  const p = parts(result)
  return p.year === +date[1] && p.month === +date[2] && p.day === +date[3] && p.hour === +time[1] && p.minute === +time[2] ? result : 0
}
function requestDepartureMs(doc = {}) {
  const saved = Number(doc.latestDepartureAtMs || doc.departureAtMs)
  if (Number.isFinite(saved) && saved > 0) return saved
  return Math.max(0, ...(Array.isArray(doc.departures) ? doc.departures.slice(0, 30) : []).map(point => pointTime(point || {})))
}
function requestIsActive(doc = {}, now = Date.now()) {
  return ['open', 'full'].includes(String(doc.status || 'open').toLowerCase()) &&
    !CLOSED_FLAGS.some(key => !!doc[key]) && requestDepartureMs(doc) > now
}
function requestStatusAfterChange(doc, count = requestSeatCount(doc), now = Date.now()) {
  const status = String(doc.status || 'open').toLowerCase()
  if (!['open', 'full'].includes(status) || CLOSED_FLAGS.some(key => !!doc[key])) return status
  if (requestDepartureMs(doc) <= now) return 'past'
  return count >= 4 ? 'full' : 'open'
}
module.exports = { requestPassengerIds, requestSeatCount, requestDepartureMs, requestIsActive, requestStatusAfterChange }
