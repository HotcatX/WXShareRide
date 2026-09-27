const crypto = require('crypto')
const https = require('https')
const { APPID, getIdentity } = require('./context')
const PATH = '/internal/v1/auth/cloudbase'
const ENDPOINT = 'https://collect.linkx.ink' + PATH
const DOMAIN = 'linkx-auth-bridge-v1'
const record = value => value && typeof value === 'object' && !Array.isArray(value)
const unavailable = () => ({ ok: false, error: { code: 'LOGIN_UNAVAILABLE', message: '登录服务暂不可用，请重试' } })

function projectReply(reply, identity, now = Date.now()) {
  const value = reply && reply.ok === true && reply.data
  if (!record(value) || Object.keys(value).some(key => !['token', 'expiresAt', 'user'].includes(key)) ||
      typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || !record(value.user) ||
      Object.keys(value.user).some(key => !['id', 'openid', 'referralCode'].includes(key)) ||
      typeof value.user.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.user.id) ||
      value.user.openid !== identity.openid || typeof value.user.referralCode !== 'string' || !/^ref_[a-f0-9]{12}$/.test(value.user.referralCode) ||
      typeof value.expiresAt !== 'string' || !Number.isSafeInteger(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= now || Date.parse(value.expiresAt) > now + 2592000000) throw new Error('LOGIN_UNAVAILABLE')
  return { ok: true, data: { token: value.token, expiresAt: value.expiresAt,
    user: { id: value.user.id, openid: value.user.openid, referralCode: value.user.referralCode } } }
}

function send(body, key, { request = https.request, now = Date.now } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== 32) return Promise.reject(new Error('LOGIN_UNAVAILABLE'))
  const raw = JSON.stringify(body)
  if (Buffer.byteLength(raw) > 1024) return Promise.reject(new Error('LOGIN_UNAVAILABLE'))
  const timestamp = String(now()), nonce = crypto.randomBytes(16).toString('hex')
  const signature = crypto.createHmac('sha256', key)
    .update(`${DOMAIN}\nPOST\n${PATH}\n${APPID}\n${timestamp}\n${nonce}\n${raw}`).digest('hex')
  return new Promise((resolve, reject) => {
    let settled = false, req
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(deadline)
      if (error) reject(new Error('LOGIN_UNAVAILABLE')); else resolve(value)
    }
    const deadline = setTimeout(() => { finish(true); if (req) req.destroy() }, 5000)
    try {
      req = request(ENDPOINT, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw), 'Accept-Encoding': 'identity',
        'X-Linkx-Auth-Timestamp': timestamp, 'X-Linkx-Auth-Nonce': nonce, 'X-Linkx-Auth-Signature': signature
      } }, response => {
        response.on('error', () => finish(true)); response.on('aborted', () => finish(true))
        const length = response.headers['content-length'], encoding = response.headers['content-encoding']
        if (response.statusCode !== 200 || (encoding && (typeof encoding !== 'string' || encoding.toLowerCase() !== 'identity')) ||
            (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > 8192))) {
          finish(true); response.destroy(); return
        }
        const chunks = []; let size = 0
        response.on('data', chunk => {
          size += chunk.length
          if (size > 8192) { finish(true); response.destroy(); return }
          chunks.push(chunk)
        })
        response.on('end', () => {
          try {
            if (length !== undefined && Number(length) !== size) throw new Error('INVALID_LENGTH')
            finish(false, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))))
          } catch (_) { finish(true) }
        })
      })
      req.on('error', () => finish(true)); req.end(raw)
    } catch (_) { finish(true); if (req) req.destroy() }
  })
}

function createHandler({ getKey, transport = send }) {
  return async (event, context) => {
    try {
      if (!record(event)) return unavailable()
      // Reserved platform envelope metadata never contributes to identity.
      const input = Object.fromEntries(Object.entries(event).filter(([key]) => !['userInfo', 'tcbContext'].includes(key)))
      if (Object.keys(input).length !== 1 || input.action !== 'login') return unavailable()
      const identity = getIdentity(context)
      if (!identity) return unavailable()
      const key = getKey()
      if (!Buffer.isBuffer(key) || key.length !== 32) return unavailable()
      const body = { purpose: 'login', appId: identity.appId, openid: identity.openid, source: identity.source }
      return projectReply(await transport(body, key), identity)
    } catch (_) { return unavailable() }
  }
}

module.exports = { PATH, ENDPOINT, DOMAIN, createHandler, send, projectReply }
