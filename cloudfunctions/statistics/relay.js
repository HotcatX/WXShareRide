const crypto = require('crypto')
const ACTION = 'legacyPublicStatsTimer'
const DOMAIN = 'linkx-statistics-legacy-timer-relay-v1'
const WINDOW_MS = 5 * 60 * 1000
function deriveRelayKey(syncKey) {
  if (!Buffer.isBuffer(syncKey) || syncKey.length !== 32) throw new Error('KEY_UNAVAILABLE')
  return crypto.createHmac('sha256', syncKey).update(DOMAIN).digest()
}
function verifyRelay(event, context, syncKey, now = Date.now()) {
  // A parsed invocation source is required, but cross-function SOURCE values are
  // intentionally not guessed. The private HMAC is the primary authorization.
  if (!context || typeof context.SOURCE !== 'string' || !context.SOURCE || context.OPENID || context.FROM_OPENID) return false
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
    Object.keys(event).length !== 3 || !['action','timestamp','signature'].every(k => Object.prototype.hasOwnProperty.call(event,k)) ||
    event.action !== ACTION || typeof event.timestamp !== 'string' || !/^[1-9][0-9]{0,15}$/.test(event.timestamp) ||
    !Number.isSafeInteger(Number(event.timestamp)) || Math.abs(now - Number(event.timestamp)) > WINDOW_MS ||
    typeof event.signature !== 'string' || !/^[a-f0-9]{64}$/.test(event.signature)) return false
  const expected = crypto.createHmac('sha256', deriveRelayKey(syncKey)).update(`${ACTION}\n${event.timestamp}`).digest()
  return crypto.timingSafeEqual(expected, Buffer.from(event.signature,'hex'))
}
module.exports = { ACTION, DOMAIN, WINDOW_MS, deriveRelayKey, verifyRelay }
