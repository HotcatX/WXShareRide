const crypto = require('crypto')
const https = require('https')
const { getIdentity } = require('./context')

const ENDPOINT = 'https://collect.linkx.ink/internal/v1/research/participation'
const PURPOSE = 'ride-research-v1'
const NOTICE = 'ride-research-notice-2026-09-23'
const ID = /^[A-Za-z0-9_-]{16,80}$/
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const version = v => Number.isSafeInteger(v) && v >= 0 && v <= 2147483647
const ERRORS = new Set(['STALE_STATE', 'STATE_CONFLICT', 'REQUEST_CONFLICT', 'STATUS_CONFLICT',
  'OPERATION_CONFLICT', 'NOTICE_VERSION_MISMATCH', 'VERSION_EXHAUSTED', 'RECOVERY_RECONSENT_NOTICE_REQUIRED',
  'COLLECTION_DISABLED', 'RESTORE_QUARANTINE', 'PURPOSE_MISMATCH', 'NOTICE_MISMATCH',
  'RATE_LIMITED', 'STORAGE_UNAVAILABLE', 'SERVER_BUSY', 'RECONSENT_REQUIRED', 'OPERATION_SUPERSEDED', 'PARTICIPANT_KIND_IMMUTABLE', 'ACCOUNT_IDENTITY_CONFLICT', 'BRIDGE_UNAVAILABLE'])

function validRequest(event) {
  const fields = ['action', 'requestId', 'expectedStatusVersion', 'purposeVersion', 'noticeVersion']
  return object(event) && Object.keys(event).every(k => fields.includes(k) || k === 'collectionMode') && fields.every(k => own(event, k)) &&
    (!own(event, 'collectionMode') || event.collectionMode === 'test') &&
    ['status', 'activate', 'withdraw'].includes(event.action) && typeof event.requestId === 'string' && ID.test(event.requestId) &&
    version(event.expectedStatusVersion) && event.purposeVersion === PURPOSE && event.noticeVersion === NOTICE
}

function projectResponse(value, now = Date.now(), expectedSynthetic = false) {
  if (!object(value) || value.ok !== true || !['none', 'active', 'revoked'].includes(value.status) ||
    !version(value.statusVersion) || value.purposeVersion !== PURPOSE || value.noticeVersion !== NOTICE ||
    (own(value, 'synthetic') && typeof value.synthetic !== 'boolean') ||
    (value.synthetic === true) !== expectedSynthetic) throw new Error('BAD_RESPONSE')
  const result = { ok: true, status: value.status, statusVersion: value.statusVersion,
    purposeVersion: PURPOSE, noticeVersion: NOTICE }
  if (own(value, 'synthetic')) result.synthetic = value.synthetic
  if (value.status !== 'none') {
    if (typeof value.participantKey !== 'string' || !ID.test(value.participantKey) || value.statusVersion < 1) throw new Error('BAD_RESPONSE')
    result.participantKey = value.participantKey
  }
  // A disabled collector still exposes the current version for withdrawal,
  // without issuing authorization to upload.
  if (value.status === 'active' && value.session !== undefined) {
    const s = value.session
    if (!object(s) || typeof s.participantKey !== 'string' || typeof s.grantId !== 'string' ||
      !ID.test(s.participantKey) || s.participantKey !== value.participantKey || !ID.test(s.grantId) || s.status !== 'active' || value.statusVersion < 1 ||
      s.statusVersion !== value.statusVersion || s.confirmed !== true || s.purposeVersion !== PURPOSE ||
      s.acceptedPurposeVersion !== PURPOSE || typeof s.token !== 'string' || s.token.length > 2048 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s.token) ||
      !Number.isSafeInteger(s.tokenExpiresAtMs) || s.tokenExpiresAtMs <= now ||
      s.tokenExpiresAtMs > now + 930000) throw new Error('BAD_RESPONSE')
    result.session = { participantKey: s.participantKey, grantId: s.grantId, status: 'active',
      statusVersion: s.statusVersion, confirmed: true, purposeVersion: PURPOSE, acceptedPurposeVersion: PURPOSE,
      token: s.token, tokenExpiresAtMs: s.tokenExpiresAtMs }
  }
  return result
}

function send(body, key, { request = https.request, now = Date.now, nonce = () => crypto.randomBytes(16).toString('hex') } = {}) {
  const raw = JSON.stringify(body)
  const timestamp = String(now())
  const requestNonce = nonce()
  const signature = crypto.createHmac('sha256', key).update(`${timestamp}\n${requestNonce}\n${raw}`).digest('hex')
  return new Promise((resolve, reject) => {
    let settled = false; let req
    const finish = (error, result) => {
      if (settled) return
      settled = true; clearTimeout(deadline)
      if (error) reject(new Error('BRIDGE_UNAVAILABLE')); else resolve(result)
    }
    // CloudBase's verified default is three seconds. Leave time to return a
    // controlled failure and reconcile an uncertain activation/withdrawal result.
    const deadline = setTimeout(() => { finish(true); if (req) req.destroy() }, 2200)
    try {
      req = request(ENDPOINT, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw),
        'X-Linkx-Timestamp': timestamp, 'X-Linkx-Nonce': requestNonce, 'X-Linkx-Signature': signature
      } }, res => {
        let size = 0; const chunks = []
        res.on('data', chunk => {
          size += chunk.length
          if (size > 8192) { finish(true); req.destroy(); return }
          chunks.push(chunk)
        })
        res.on('end', () => {
          try {
            const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (res.statusCode === 200) return finish(false, projectResponse(reply, Date.now(), body.synthetic === true))
            // Do not forward arbitrary upstream diagnostics, IDs or credentials.
            if ([400, 401, 403, 409, 422, 429, 500, 503].includes(res.statusCode) && reply.ok === false) {
              return finish(false, { ok: false, error: ERRORS.has(reply.error) ? reply.error : 'BRIDGE_UNAVAILABLE', statusCode: res.statusCode })
            }
            finish(true)
          } catch (_) { finish(true) }
        })
        res.on('error', () => finish(true)); res.on('aborted', () => finish(true))
      })
      req.on('error', () => finish(true))
      req.end(raw)
    } catch (_) { finish(true) }
  })
}

function createHandler({ getKeys, transport = send, identity = getIdentity }) {
  return async (event, context) => {
    const user = identity(context)
    if (!user) return { ok: false, error: 'LOGIN_REQUIRED', statusCode: 401 }
    if (!validRequest(event)) return { ok: false, error: 'INVALID_REQUEST', statusCode: 422 }
    try {
      const keys = getKeys()
      if (!keys || !Buffer.isBuffer(keys.bridge) || keys.bridge.length !== 32 ||
        !Buffer.isBuffer(keys.subject) || keys.subject.length !== 32 || keys.bridge.equals(keys.subject)) throw new Error('KEY_UNAVAILABLE')
      const synthetic = event.collectionMode === 'test'
      const subjectScope = synthetic ? 'linkx-research-test-account-v1' : 'linkx-research-account-v1'
      const accountSubject = crypto.createHmac('sha256', keys.subject)
        .update(`${subjectScope}\n${user.appid}\n${user.openid}`).digest('hex')
      // Only the authenticated invocation supplies the operational account link.
      // Caller-supplied identities and all other client extra fields stop here.
      const body = { accountSubject, openid: user.openid, action: event.action, requestId: event.requestId,
        expectedStatusVersion: event.expectedStatusVersion, purposeVersion: PURPOSE, noticeVersion: NOTICE }
      // Test is an explicitly requested namespace, not proof of a WeChat build channel.
      // Preserve real request bytes/hash shape and the customer-service helper contract.
      if (synthetic) body.synthetic = true
      const response = await transport(body, keys.bridge)
      return response?.ok === true ? projectResponse(response, Date.now(), synthetic) : response
    } catch (_) { return { ok: false, error: 'BRIDGE_UNAVAILABLE', statusCode: 503 } }
  }
}

module.exports = { createHandler, validRequest, projectResponse, send, PURPOSE, NOTICE, ENDPOINT }
