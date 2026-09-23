const crypto = require('crypto')
const https = require('https')
const { readPendingBusinessEvents, acknowledgeBusinessEvents } = require('./businessOutbox')
const ENDPOINT = 'https://collect.linkx.ink/internal/v1/places/business-events'
const TRIGGER = 'placeBusinessFiveMinutes'

function authorizedPlaceTimer(event, context) {
  return !!context && context.SOURCE === 'wx_trigger' && !context.OPENID && !context.FROM_OPENID &&
    !!event && ['Timer', 'timer'].includes(event.Type) && event.TriggerName === TRIGGER &&
    (!event.action || event.action === 'placeBusinessTimer')
}
function pushBusinessEvents(events, key, { request = https.request, now = Date.now } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== 32) return Promise.reject(new Error('KEY_UNAVAILABLE'))
  const body = JSON.stringify({ schemaVersion: 1, events })
  if (Buffer.byteLength(body) > 131072) return Promise.reject(new Error('OUTBOX_BATCH_TOO_LARGE'))
  const timestamp = String(now()), nonce = crypto.randomBytes(16).toString('hex')
  const signature = crypto.createHmac('sha256', key).update(`${timestamp}\n${nonce}\n${body}`).digest('hex')
  return new Promise((resolve, reject) => {
    let settled = false, req
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(deadline)
      if (error) reject(new Error('PLACE_SYNC_UNAVAILABLE')); else resolve(value)
    }
    const deadline = setTimeout(() => { finish(true); if (req) req.destroy() }, 6500)
    try {
      req = request(ENDPOINT, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'X-Linkx-Timestamp': timestamp, 'X-Linkx-Nonce': nonce, 'X-Linkx-Signature': signature
      } }, res => {
        let size = 0; const chunks = []
        res.on('data', chunk => { size += chunk.length; if (size > 8192) { finish(true); req.destroy() } else chunks.push(chunk) })
        res.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            finish(!(res.statusCode === 200 && value.ok === true), value)
          } catch (_) { finish(true) }
        })
        res.on('error', () => finish(true)); res.on('aborted', () => finish(true))
      })
      req.on('error', () => finish(true)); req.end(body)
    } catch (_) { finish(true) }
  })
}
function createPlaceSynchronizer({ db, getKey, send = pushBusinessEvents, now = Date.now, log = () => {} }) {
  return async () => {
    try {
      const events = await readPendingBusinessEvents(db)
      if (!events.length) return { ok: true, delivered: 0, empty: true, synchronizedAt: now() }
      const response = await send(events, getKey())
      const delivered = await acknowledgeBusinessEvents(db, events, response)
      log({ event: 'place-business-synced', delivered })
      return { ok: true, delivered, synchronizedAt: now() }
    } catch (_) {
      log({ event: 'place-business-sync-failed' })
      throw new Error('PLACE_BUSINESS_SYNC_FAILED')
    }
  }
}
module.exports = { TRIGGER, ENDPOINT, authorizedPlaceTimer, pushBusinessEvents, createPlaceSynchronizer }
