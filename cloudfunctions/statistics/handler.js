const { createPublicHandler, normalizeStats } = require('./public')

function withoutPlatformMetadata(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
    !['userInfo', 'tcbContext'].some(key => Object.prototype.hasOwnProperty.call(event, key))) return event
  // WeChat can append these reserved envelope fields outside the supplied data.
  // Ignore them regardless of origin/value: identity comes only from the current
  // invocation context. Do not inspect it, mutate the event, or drop other keys.
  return Object.fromEntries(Object.keys(event).filter(key => key !== 'userInfo' && key !== 'tcbContext').map(key => [key, event[key]]))
}

function createStatisticsHandler({ account, readPublicStats, authority }) {
  const publicStats = createPublicHandler(readPublicStats)
  return async (event, invocationContext) => {
    event = withoutPlatformMetadata(event)
    const action = event && event.action
    if (authority !== 'server') return action === 'publicStats'
      ? { success: false, errorMsg: 'PUBLIC_STATS_UNAVAILABLE', data: normalizeStats() }
      : { ok: false, error: 'AUTHORITY_UNAVAILABLE', statusCode: 503 }
    if (action === 'publicStats') {
      if (Object.keys(event).length !== 1) return { success: false, errorMsg: 'INVALID_REQUEST', data: normalizeStats() }
      return publicStats()
    }
    if (['status', 'activate', 'withdraw'].includes(action)) return account(event, invocationContext)
    // Retired timer/relay actions have no implementation or credential access.
    return { ok: false, error: 'INVALID_ACTION' }
  }
}
module.exports = { createStatisticsHandler }
