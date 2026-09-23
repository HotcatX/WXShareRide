const crypto = require('crypto')
const https = require('https')

const ENDPOINT = 'https://collect.linkx.ink/internal/v1/public-stats/sync'
const TRIGGER = 'publicStatsHourly'
const TTL = 2 * 60 * 60 * 1000

function authorized(event, context) {
  return !!context && context.SOURCE === 'wx_trigger' && !context.OPENID && !context.FROM_OPENID &&
    !!event && ['Timer', 'timer'].includes(event.Type) && event.TriggerName === TRIGGER
}

function makeSnapshot(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_SOURCE')
  const v = raw.servedTrips
  const n = v === undefined || v === null || v === '' ? null : Number(v)
  const servedTrips = n === null || !Number.isFinite(n) || n < 0 ? null : Math.floor(n)
  const coverageText = raw.coverageText || 'N/A'
  if (!(servedTrips === null || Number.isSafeInteger(servedTrips)) || typeof coverageText !== 'string' ||
    coverageText.length > 120 || /[\u0000-\u001f\u007f]/.test(coverageText)) throw new Error('INVALID_SOURCE')
  const data = { _id: 'home', servedTrips, coverageText }
  return { schemaVersion: 1, source: 'cloudbase-snapshot', snapshotAt: now, expiresAt: now + TTL,
    revision: crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex'), data }
}

function push(snapshot, key, request = https.request) {
  const body = JSON.stringify(snapshot)
  const timestamp = String(Date.now())
  const signature = crypto.createHmac('sha256', key).update(timestamp + '\n' + body).digest('hex')
  return new Promise((resolve, reject) => {
    let settled = false
    let req
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (error) reject(new Error('SYNC_UNAVAILABLE'))
      else resolve()
    }
    const deadline = setTimeout(() => { finish(true); if (req) req.destroy() }, 8000)
    try {
      req = request(ENDPOINT, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'X-Linkx-Timestamp': timestamp, 'X-Linkx-Signature': signature
      } }, res => {
        // Never follow redirects or log remote bodies, headers or credentials.
        let size = 0
        const chunks = []
        res.on('data', chunk => {
          size += chunk.length
          if (size > 8192) { finish(true); req.destroy(); return }
          chunks.push(chunk)
        })
        res.on('end', () => {
          try {
            const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            finish(!(res.statusCode === 200 && reply.ok === true))
          } catch (_) { finish(true) }
        })
        res.on('error', () => finish(true))
        res.on('aborted', () => finish(true))
      })
      req.on('error', () => finish(true))
      req.end(body)
    } catch (_) { finish(true) }
  })
}

function createHandler({ getContext, getKey, readPublicStats, send = push, now = Date.now, log = () => {} }) {
  return async (event, invocationContext) => {
    const context = getContext(invocationContext) || {}
    if (!authorized(event, context)) {
      log({ event: 'public-stats-sync-rejected', hasSource: !!context.SOURCE,
        timerSource: context.SOURCE === 'wx_trigger', hasUser: !!(context.OPENID || context.FROM_OPENID) })
      return { ok: false, error: 'TIMER_ONLY' }
    }
    try {
      const key = getKey()
      if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('KEY_UNAVAILABLE')
      // Timestamp describes this acquisition, never a re-stamped old snapshot.
      const acquiredAt = now()
      const snapshot = makeSnapshot(await readPublicStats(), acquiredAt)
      await send(snapshot, key)
      log({ event: 'public-stats-synced', snapshotAt: acquiredAt })
      return { ok: true, snapshotAt: acquiredAt }
    } catch (_) {
      log({ event: 'public-stats-sync-failed' })
      // Throw a generic error for platform failure metrics; never leak SDK bodies.
      throw new Error('PUBLIC_STATS_SYNC_FAILED')
    }
  }
}

module.exports = { authorized, makeSnapshot, push, createHandler }
