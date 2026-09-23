const crypto = require('crypto')
const { getInvocationContext } = require('./context')
const DOMAIN = 'linkx-statistics-legacy-timer-relay-v1'
const ACTION = 'legacyPublicStatsTimer'
function authorized(event, context) {
  return !!context && context.SOURCE === 'wx_trigger' && !context.OPENID && !context.FROM_OPENID &&
    !!event && ['Timer','timer'].includes(event.Type) && event.TriggerName === 'publicStatsHourly'
}
function makeRelay(syncKey, now = Date.now()) {
  if (!Buffer.isBuffer(syncKey) || syncKey.length !== 32) throw new Error('KEY_UNAVAILABLE')
  const timestamp = String(now)
  const key = crypto.createHmac('sha256', syncKey).update(DOMAIN).digest()
  return { action: ACTION, timestamp, signature: crypto.createHmac('sha256', key).update(`${ACTION}\n${timestamp}`).digest('hex') }
}
function createLegacyTimer({ getKey, invoke, now = Date.now, getContext = getInvocationContext, log = () => {} }) {
  return async (event, invocationContext) => {
    if (!authorized(event, getContext(invocationContext))) return { ok: false, error: 'TIMER_ONLY' }
    try {
      const response = await invoke({ name: 'statistics', data: makeRelay(getKey(), now()) })
      if (!response || !response.result || response.result.ok !== true || !Number.isSafeInteger(response.result.snapshotAt)) throw new Error('SYNC_FAILED')
      return { ok: true, snapshotAt: response.result.snapshotAt }
    } catch (_) {
      log({ event: 'public-stats-legacy-relay-failed' })
      throw new Error('PUBLIC_STATS_SYNC_FAILED')
    }
  }
}
module.exports = { authorized, makeRelay, createLegacyTimer }
