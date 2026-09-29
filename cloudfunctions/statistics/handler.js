const { authorized, makeSnapshot, push } = require('./sync')
const { getInvocationContext } = require('./timer-context')
const { createPublicHandler } = require('./public')
const { verifyRelay, ACTION: RELAY_ACTION } = require('./relay')
const { authorizedPlaceTimer, TRIGGER: PLACE_TRIGGER } = require('./placesSync')

function withoutPlatformMetadata(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
    !['userInfo', 'tcbContext'].some(key => Object.prototype.hasOwnProperty.call(event, key))) return event
  // WeChat can append these reserved envelope fields outside the supplied data.
  // Ignore them regardless of origin/value: identity comes only from the current
  // invocation context. Do not inspect it, mutate the event, or drop other keys.
  return Object.fromEntries(Object.keys(event).filter(key => key !== 'userInfo' && key !== 'tcbContext').map(key => [key, event[key]]))
}

function createStatisticsHandler({ account, getSyncKey, readPublicStats, send = push,
  synchronizePlaces, authority = 'cloudbase', now = Date.now, log = () => {}, getContext = getInvocationContext }) {
  const publicStats = createPublicHandler(readPublicStats)
  // TEMPORARY FALLBACK — remove only after the next production release is verified.
  // Retire old projection writers after handoff, including authenticated relays.
  // Keep invocation checks below: migration must not turn a caller into a timer.
  const retired = () => authority === 'cloudbase' ? null : authority === 'server'
    ? { ok: true, skipped: 'AUTHORITY_MOVED' } : { ok: false, error: 'AUTHORITY_UNAVAILABLE' }
  async function synchronize() {
    try {
      const key = getSyncKey()
      if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('KEY_UNAVAILABLE')
      const acquiredAt = now()
      const snapshot = makeSnapshot(await readPublicStats(), acquiredAt)
      await send(snapshot, key)
      log({ event: 'public-stats-synced', snapshotAt: acquiredAt })
      return { ok: true, snapshotAt: acquiredAt }
    } catch (_) {
      log({ event: 'public-stats-sync-failed' })
      throw new Error('PUBLIC_STATS_SYNC_FAILED')
    }
  }
  return async (event, invocationContext) => {
    event = withoutPlatformMetadata(event)
    const action = event && event.action
    if (action === 'publicStats') {
      if (Object.keys(event).length !== 1) return { success: false, errorMsg: 'INVALID_REQUEST', data: { _id: 'home', servedTrips: null, coverageText: 'N/A' } }
      return publicStats()
    }
    if (['status', 'activate', 'withdraw'].includes(action)) return account(event, invocationContext)
    const context = getContext(invocationContext) || {}
    if (action === 'placeBusinessTimer' || (!action && event && event.TriggerName === PLACE_TRIGGER)) {
      if (!authorizedPlaceTimer(event, context)) return { ok: false, error: 'TIMER_ONLY' }
      if (retired()) return retired()
      if (typeof synchronizePlaces !== 'function') throw new Error('PLACE_BUSINESS_SYNC_UNAVAILABLE')
      return synchronizePlaces()
    }
    if (action === RELAY_ACTION) {
      let verified = false
      try { verified = verifyRelay(event, context, getSyncKey(), now()) } catch (_) {}
      if (!verified) return { ok: false, error: 'RELAY_UNAUTHORIZED' }
      if (retired()) return retired()
      return synchronize()
    }
    if (action === 'publicStatsHourlyTimer' || (!action && event && ['Timer','timer'].includes(event.Type))) {
      if (!authorized(event, context)) return { ok: false, error: 'TIMER_ONLY' }
      if (retired()) return retired()
      return synchronize()
    }
    return { ok: false, error: 'INVALID_ACTION' }
  }
}
module.exports = { createStatisticsHandler }
