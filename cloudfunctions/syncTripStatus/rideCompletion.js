// Completion identity is shared by both sync functions and historical replay.
// Private idempotency keys belong to userInfo, outside publicly exposed rideStats.
const TIME_ZONE = 'America/New_York'
const MAX_PARTICIPANTS = 40
const MAX_ATTEMPTS = 3
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const idText = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value.trim()) ? value.trim() : ''

function timestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : 0
  if (value && typeof value === 'object' && own(value, '$date')) return timestamp(value.$date)
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0
  if (typeof value !== 'string' || !value.trim()) return 0
  const s = value.trim()
  if (/^\d+$/.test(s)) return timestamp(Number(s))
  // Explicit ISO timestamps only; date-only trip times are interpreted in NY.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return 0
  const parsed = Date.parse(s)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function zonedParts(ms) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(ms)).filter(part => part.type !== 'literal').map(part => [part.type, +part.value]))
}

function departureTime(point) {
  if (!point || typeof point !== 'object') return 0
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(point.date || '').trim())
  const time = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(point.time || '').trim())
  if (!date || !time || +time[1] > 23 || +time[2] > 59) return 0
  const y = +date[1], m = +date[2], d = +date[3], h = +time[1], minute = +time[2]
  const local = Date.UTC(y, m - 1, d, h, minute)
  const check = new Date(local)
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return 0
  let utc = local
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(utc)
    utc = local - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utc)
  }
  const p = zonedParts(utc)
  return p.year === y && p.month === m && p.day === d && p.hour === h && p.minute === minute ? utc : 0
}

function memberId(value) {
  if (typeof value === 'string') return idText(value)
  if (!value || typeof value !== 'object') return ''
  return idText(own(value, '_openid') ? value._openid : value.openid)
}

function getCompletionFacts(type, doc, nowMs) {
  const result = { eligible: false, reason: 'invalid_trip', key: '', driverOpenid: '', passengerOpenids: [] }
  if (!['carpool', 'request'].includes(type) || !doc || typeof doc !== 'object' || !idText(doc._id)) return result
  result.key = `${type === 'carpool' ? 'Carpool' : 'CarpoolRequest'}|${idText(doc._id)}`
  const status = typeof doc.status === 'string' ? doc.status.trim().toLowerCase() : ''
  const cancelled = ['cancelled', 'canceled', 'deleted', 'isCancelled', 'isCanceled', 'isDeleted']
    .some(key => doc[key] === true || doc[key] === 1 || doc[key] === 'true') ||
    ['cancelledAt', 'canceledAt', 'deletedAt'].some(key => !!doc[key])
  if (cancelled || !['past', 'close'].includes(status)) return { ...result, reason: 'not_completed' }
  if (!Number.isFinite(nowMs) || nowMs <= 0) return { ...result, reason: 'invalid_time' }
  const departures = Array.isArray(doc.departures) ? doc.departures : []
  if (departures.length > 100) return { ...result, reason: 'invalid_departures' }
  // Taking the latest evidence also protects against stale saved departure metadata.
  const lastDeparture = Math.max(timestamp(doc.latestDepartureAtMs), timestamp(doc.departureAtMs),
    departureTime({ date: doc.firstDepartureDate, time: doc.firstDepartureTime }),
    ...departures.map(departureTime))
  const completedAt = timestamp(doc.completedAt)
  if (!lastDeparture && !completedAt) return { ...result, reason: 'missing_completion_time' }
  if ((lastDeparture || completedAt) > nowMs) return { ...result, reason: 'not_due' }
  const driver = type === 'request'
    ? idText(doc.driverOpenid)
    : idText(own(doc, '_openid') ? doc._openid : doc.driverOpenid)
  let rawPassengers
  if (type === 'carpool') {
    rawPassengers = own(doc, 'passengers') ? doc.passengers : doc.passengerID
  } else {
    // The request creator is intrinsically a passenger and cannot quit without
    // deleting the request. This is independent of the additional-member list.
    rawPassengers = [...(Array.isArray(doc.passengerID) ? doc.passengerID : []), doc._openid]
  }
  const passengers = [...new Set((Array.isArray(rawPassengers) ? rawPassengers : []).map(memberId).filter(id => id && id !== driver))].sort()
  result.driverOpenid = driver
  result.passengerOpenids = passengers
  if (!driver || !passengers.length) return { ...result, reason: 'unmatched' }
  if (passengers.length + 1 > MAX_PARTICIPANTS) return { ...result, reason: 'too_many_participants' }
  return { ...result, eligible: true, reason: 'eligible' }
}

function summary(dryRun, facts) {
  return {
    ok: true, eligible: facts.eligible, reason: facts.reason, dryRun,
    countedUsers: 0, countedDriverTrips: 0, countedPassengerTrips: 0,
    alreadyCountedUsers: 0, missingUsers: 0, duplicateUsers: 0, legacyUsers: 0
  }
}

function settledSummary(doc, dryRun) {
  if (!doc || doc._rideCompletionSettled !== true || doc._rideCompletionVersion !== 1 ||
      !Number.isInteger(doc._rideCompletionParticipantCount) || doc._rideCompletionParticipantCount < 2 ||
      doc._rideCompletionParticipantCount > MAX_PARTICIPANTS || timestamp(doc._rideCompletionCheckedAt) <= 0) return null
  return { ...summary(dryRun, { eligible: true, reason: 'already_settled' }), alreadyCountedUsers: doc._rideCompletionParticipantCount }
}

function completionState(user) {
  const stats = user.rideStats == null ? {} : user.rideStats
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return null
  const fields = ['completedDriverTrips', 'completedPassengerTrips', 'completedTrips']
  const counts = fields.map(field => stats[field] == null ? 0 : stats[field])
  if (counts.some(count => !Number.isSafeInteger(count) || count < 0)) return null
  const [driverCount, passengerCount, totalCount] = counts
  const keys = user._rideCompletionV1
  if (keys === undefined) {
    if (counts.some(count => count !== 0)) return null
    return { driverKeys: [], passengerKeys: [], driverCount: 0, passengerCount: 0 }
  }
  if (!keys || typeof keys !== 'object' || keys.version !== 1) return null
  const validList = list => Array.isArray(list) && list.length <= 10000 &&
    list.every(key => typeof key === 'string' && /^(Carpool|CarpoolRequest)\|[a-zA-Z0-9_-]{1,128}$/.test(key)) && new Set(list).size === list.length
  if (!validList(keys.driverKeys) || !validList(keys.passengerKeys)) return null
  if (keys.driverKeys.some(key => keys.passengerKeys.includes(key))) return null
  if (driverCount !== keys.driverKeys.length || passengerCount !== keys.passengerKeys.length || totalCount !== driverCount + passengerCount) return null
  return { driverKeys: keys.driverKeys.slice(), passengerKeys: keys.passengerKeys.slice(), driverCount, passengerCount }
}

function isConflict(error) {
  const exact = 'DATABASE_TRANSACTION_CONFLICT'
  if (!error) return false
  if (error.code === exact || error.errCode === exact) return true
  return [error.message, error.errMsg].some(value => typeof value === 'string' && /\bDATABASE_TRANSACTION_CONFLICT\b/.test(value))
}

function createRideCompletionCounter({ db, now = () => Date.now() }) {
  if (!db || typeof db.runTransaction !== 'function') throw new TypeError('A transactional database is required')
  return async function ensureRideCompletion({ type, id, dryRun = false } = {}) {
    if (!['carpool', 'request'].includes(type) || !idText(id) || typeof dryRun !== 'boolean') {
      return summary(dryRun === true, { eligible: false, reason: 'invalid_trip' })
    }
    id = idText(id)
    const collection = type === 'carpool' ? 'Carpool' : 'CarpoolRequest'
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const nowValue = now()
        const nowMs = nowValue instanceof Date ? nowValue.getTime() : nowValue
        const snapshot = await db.collection(collection).doc(id).get()
        const settled = settledSummary(snapshot && snapshot.data, dryRun)
        if (settled) return settled
        const initial = getCompletionFacts(type, snapshot && snapshot.data, nowMs)
        if (!initial.eligible) return summary(dryRun, initial)
        const participants = [initial.driverOpenid, ...initial.passengerOpenids].sort()
        // Transactions only support doc operations. Resolve outside, then verify
        // the same document and ownership again inside the transaction.
        const identities = new Map()
        for (const openid of participants) {
          const found = await db.collection('userInfo').where({ _openid: openid }).limit(2).get()
          const rows = found && Array.isArray(found.data) ? found.data : []
          identities.set(openid, rows.length > 1 ? { duplicate: true } : rows.length === 1 && idText(rows[0]._id) ? { id: rows[0]._id } : {})
        }
        const value = await db.runTransaction(async transaction => {
          const tripRef = transaction.collection(collection).doc(id)
          const fresh = await tripRef.get()
          const freshSettled = settledSummary(fresh && fresh.data, dryRun)
          if (freshSettled) return freshSettled
          const facts = getCompletionFacts(type, fresh && fresh.data, nowMs)
          const output = summary(dryRun, facts)
          if (!facts.eligible) return output
          const freshParticipants = [facts.driverOpenid, ...facts.passengerOpenids].sort()
          if (freshParticipants.join('|') !== participants.join('|') || facts.driverOpenid !== initial.driverOpenid) {
            const error = new Error('Completion participants changed; resolve identities again')
            error.code = 'RIDE_COMPLETION_FACTS_CHANGED'
            throw error
          }
          const updates = []
          for (const openid of freshParticipants) {
            const resolved = identities.get(openid)
            if (resolved.duplicate) { output.duplicateUsers++; continue }
            if (!resolved.id) { output.missingUsers++; continue }
            const userRef = transaction.collection('userInfo').doc(resolved.id)
            const userSnapshot = await userRef.get()
            const user = userSnapshot && userSnapshot.data
            if (!user || user._openid !== openid) { output.missingUsers++; continue }
            const state = completionState(user)
            if (!state) { output.legacyUsers++; continue }
            const driver = openid === facts.driverOpenid
            const roleKeys = driver ? state.driverKeys : state.passengerKeys
            // A completion keeps the role of its first committed snapshot even
            // if a historical document later changes that person's role.
            if (state.driverKeys.includes(facts.key) || state.passengerKeys.includes(facts.key)) { output.alreadyCountedUsers++; continue }
            roleKeys.push(facts.key)
            if (driver) { state.driverCount++; output.countedDriverTrips++ }
            else { state.passengerCount++; output.countedPassengerTrips++ }
            output.countedUsers++
            updates.push({ ref: userRef, data: {
              '_rideCompletionV1.version': 1,
              '_rideCompletionV1.driverKeys': state.driverKeys,
              '_rideCompletionV1.passengerKeys': state.passengerKeys,
              'rideStats.completedDriverTrips': state.driverCount,
              'rideStats.completedPassengerTrips': state.passengerCount,
              'rideStats.completedTrips': state.driverCount + state.passengerCount
            } })
          }
          const complete = output.missingUsers === 0 && output.duplicateUsers === 0 && output.legacyUsers === 0 &&
            output.countedUsers + output.alreadyCountedUsers === freshParticipants.length
          if (!dryRun && (updates.length || complete)) {
            // Write the source trip too: read-only snapshot access would not
            // conflict with a concurrent participant removal or cancellation.
            // Refreshing version/time must not legitimize stale settled fields
            // when this attempt could only repair some participants.
            const tripData = { _rideCompletionVersion: 1, _rideCompletionCheckedAt: new Date(nowMs), _rideCompletionSettled: false, _rideCompletionParticipantCount: 0 }
            if (complete) {
              tripData._rideCompletionSettled = true
              tripData._rideCompletionParticipantCount = freshParticipants.length
            }
            await tripRef.update({ data: tripData })
            for (const update of updates) await update.ref.update({ data: update.data })
          }
          return output
        })
        // wx-server-sdk releases differ in whether they wrap the callback result.
        return value && value.result && typeof value.result.eligible === 'boolean' ? value.result : value
      } catch (error) {
        if (attempt + 1 >= MAX_ATTEMPTS || (!isConflict(error) && error.code !== 'RIDE_COMPLETION_FACTS_CHANGED')) throw error
      }
    }
  }
}

module.exports = { createRideCompletionCounter, getCompletionFacts }
