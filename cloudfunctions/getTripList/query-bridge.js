'use strict'

// Source for generated legacy query bundles. Each deployed function gets one
// action-bound leaf key, never the login/root or mutation credential.
const crypto = require('node:crypto')
const https = require('node:https')
const { TextDecoder } = require('node:util')
const PATH = '/internal/v1/compat/cloudbase'
const DOMAIN = 'linkx-compat-read-v1'
const ENDPOINT = 'https://collect.linkx.ink' + PATH
const LIMIT = 2 * 1024 * 1024
const record = value => value && typeof value === 'object' && !Array.isArray(value)
const QUERY_BUNDLES = Object.freeze({
  getUserInfo: { action: 'profile.get', fields: [] },
  getUserInfoByOpenids: { action: 'profiles.list', fields: ['openids'] },
  getHomeTripList: { action: 'rides.home', fields: ['statuses'] },
  getMyTripHistory: { action: 'rides.history', fields: [] },
  getTripList: { action: 'rides.list', fields: ['action', 'type', 'cityKey', 'limit', 'quick', 'fastOnly',
    'startDate', 'endDateExclusive', 'month', 'fromPlace', 'toPlace', 'fromPresets', 'toPresets'] },
  getTripDetail: { action: 'rides.detail', fields: ['type', 'id', 'tripId', 'requestId'] }
})
const error = (code = 'QUERY_UNAVAILABLE', status = 503) => {
  const message = /(?:REQUIRES_NEW_CLIENT|REQUIRE_NEW_CLIENT|UPGRADE_REQUIRED)$/.test(code)
    ? '请重新打开小程序，使用新版查看' : '读取失败，请稍后重试'
  return { ok: false, message, errorMsg: message, error: { code, status, message } }
}

function send(body, leaf, { request = https.request, now = Date.now } = {}) {
  if (!Buffer.isBuffer(leaf) || leaf.length !== 32) return Promise.reject(Error('QUERY_UNAVAILABLE'))
  const raw = Buffer.from(JSON.stringify(body))
  if (!raw.length || raw.length > 69632) return Promise.reject(Error('QUERY_UNAVAILABLE'))
  const at = String(now()), nonce = crypto.randomBytes(16).toString('hex')
  const signature = crypto.createHmac('sha256', leaf)
    .update(`${DOMAIN}\nPOST\n${PATH}\n${body.appId}\n${at}\n${nonce}\n`).update(raw).digest('hex')
  return new Promise((resolve, reject) => {
    let settled = false, req, res
    const finish = (failed, value) => {
      if (settled) return
      settled = true; clearTimeout(deadline)
      if (failed) { reject(Error('QUERY_UNAVAILABLE')); req?.destroy(); res?.destroy() }
      else resolve(value)
    }
    const deadline = setTimeout(() => finish(true), 10000)
    try {
      req = request(ENDPOINT, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Content-Length': raw.length,
        Accept: 'application/json', 'Accept-Encoding': 'identity',
        'X-Linkx-Compat-Timestamp': at, 'X-Linkx-Compat-Nonce': nonce,
        'X-Linkx-Compat-Signature': signature
      } }, response => {
        res = response
        if (settled) { res.destroy(); return }
        const headers = res.headers, length = headers['content-length']
        if (!Number.isInteger(res.statusCode) || res.statusCode < 200 || res.statusCode > 599 ||
          typeof headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers['content-type']) ||
          headers['content-encoding'] && headers['content-encoding'] !== 'identity' ||
          length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > LIMIT)) {
          finish(true); return
        }
        const expected = length === undefined ? null : Number(length), chunks = []
        let bytes = 0
        res.on('data', chunk => {
          if (settled) return
          bytes += chunk.length
          if (bytes > LIMIT || expected !== null && bytes > expected) { finish(true); return }
          chunks.push(Buffer.from(chunk))
        })
        res.on('error', () => finish(true)); res.on('aborted', () => finish(true))
        res.on('close', () => { if (!settled) finish(true) })
        res.on('end', () => {
          if (settled) return
          if (res.complete === false || expected !== null && expected !== bytes) { finish(true); return }
          try {
            const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
            if (res.statusCode === 200 && record(value) && value.ok === true) finish(false, value)
            else if (res.statusCode >= 400 && record(value) && record(value.error) && /^[A-Z0-9_]{1,80}$/.test(value.error.code)) {
              finish(false, error(value.error.code, res.statusCode))
            } else finish(true)
          } catch { finish(true) }
        })
      })
      req.on('error', () => finish(true)); req.end(raw)
    } catch { finish(true) }
  })
}

function createQueryHandler({ action, fields, getIdentity, getKey, transport = send }) {
  const allowed = new Set(fields)
  return async (event, context) => {
    try {
      const actor = getIdentity(context)
      if (!actor || !record(event)) return error('QUERY_UNAUTHORIZED', 401)
      const keys = Object.keys(event).filter(key => !['userInfo', 'tcbContext'].includes(key))
      if (keys.some(key => !allowed.has(key))) return error('INVALID_INPUT', 400)
      const body = Object.fromEntries(keys.map(key => [key, event[key]]))
      const reply = await transport({ purpose: 'compat-read', ...actor, action, body }, getKey())
      if (record(reply) && reply.ok === false && record(reply.error) && /^[A-Z0-9_]{1,80}$/.test(reply.error.code) &&
        Number.isInteger(reply.error.status) && reply.error.status >= 400 && reply.error.status <= 599) {
        return error(reply.error.code, reply.error.status)
      }
      if (!record(reply) || reply.ok !== true || !record(reply.data) || !record(reply.actor) ||
        reply.actor.appId !== actor.appId || reply.actor.openid !== actor.openid ||
        typeof reply.actor.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(reply.actor.id)) return error()
      // The server's bounded action projection is the original inner result;
      // never return the trusted actor, credential or bridge envelope.
      return reply.data
    } catch { return error() }
  }
}

module.exports = { createQueryHandler, send, PATH, DOMAIN, ENDPOINT, QUERY_BUNDLES }
