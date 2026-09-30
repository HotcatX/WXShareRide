// TEMPORARY FALLBACK — remove only after the next production release is verified.
// Package this single source as publicRelay.js beside each legacy index.js.
// Old cloud URLs retain read compatibility; no CloudBase SDK or second writer.
'use strict'
const https = require('node:https')
const ORIGIN = 'https://collect.linkx.ink'
const RESPONSE_LIMIT = 512 * 1024
function response(statusCode, value) {
  return { statusCode, isBase64Encoded: false, headers: { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, body: JSON.stringify(value) }
}
function unavailable(event) {
  const value = { ok: false, success: false, code: 'MAINTENANCE', error: { code: 'MAINTENANCE', status: 503,
    message: '服务已升级，请重新打开小程序' }, errorMsg: 'MAINTENANCE', message: '服务已升级，请重新打开小程序' }
  return event && (event.httpMethod || event.requestContext?.http?.method) ? response(503, value) : value
}
function headersOf(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const headers = Object.create(null)
  for (const [key, value] of Object.entries(input)) {
    const name = key.toLowerCase()
    if (Object.hasOwn(headers, name) || typeof value !== 'string' || /[\r\n]/.test(value)) return null
    headers[name] = value
  }
  return headers
}
function send(url, method, headers, body, request) {
  return new Promise(resolve => {
    let settled = false, req
    const finish = value => { if (!settled) { settled = true; clearTimeout(deadline); resolve(value) } }
    const fail = () => finish(response(503, { ok: false, error: 'service_unavailable' }))
    const deadline = setTimeout(() => { fail(); req?.destroy() }, 6500)
    try {
      req = request(url, { method, headers }, res => {
        const status = res.statusCode
        if (!Number.isInteger(status) || status < 200 || status > 599 || status >= 300 && status < 400 ||
          res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { fail(); res.destroy(); return }
        let bytes = 0; const chunks = []
        res.on('data', chunk => {
          bytes += chunk.length
          if (bytes > RESPONSE_LIMIT) { fail(); res.destroy(); return }
          chunks.push(Buffer.from(chunk))
        })
        res.on('aborted', fail); res.on('error', fail)
        res.on('end', () => {
          try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
            if (status !== 204) JSON.parse(text)
            const result = response(status, null); result.body = status === 204 ? '' : text
            for (const key of ['access-control-allow-origin','access-control-allow-methods','access-control-allow-headers','access-control-max-age','vary','allow','retry-after']) {
              const value = res.headers[key]
              if (typeof value === 'string' && value.length <= 2048 && !/[\r\n]/.test(value)) result.headers[key] = value
            }
            finish(result)
          } catch { fail() }
        })
      })
      req.on('error', fail); req.end(body)
    } catch { fail(); req?.destroy() }
  })
}
function createLegacyPublicRelay(kind, { request = https.request } = {}) {
  if (!['public-web', 'house-share'].includes(kind)) throw Error('Unknown read relay')
  return async event => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return unavailable(event)
    const method = event.httpMethod || event.requestContext?.http?.method
    if (!method) return unavailable(event)
    const headers = headersOf(event.headers)
    if (!headers) return response(400, { ok: false, error: 'invalid_request' })
    if (kind === 'public-web') {
      const paths = [event.path,event.rawPath,event.requestContext?.path].filter(v => v !== undefined)
      if (!paths.length || paths.some(v => v !== '/public-api')) return unavailable(event)
      if (method !== 'POST') return response(405, { ok: false, error: 'method_not_allowed' })
      if (!/^Bearer [A-Za-z\d_-]{32,128}$/.test(headers.authorization || '')) return response(401, { ok: false, error: 'authentication_required' })
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers['content-type'] || '')) return response(415, { ok: false, error: 'invalid_content_type' })
      if (typeof event.body !== 'string' || Buffer.byteLength(event.body) > 2745 ||
        event.isBase64Encoded !== undefined && typeof event.isBase64Encoded !== 'boolean') return response(413, { ok: false, error: 'invalid_request' })
      if (event.isBase64Encoded && !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(event.body)) return response(400, { ok: false, error: 'invalid_request' })
      const body = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8')
      if (body.length > 2048) return response(413, { ok: false, error: 'invalid_request' })
      return send(ORIGIN+'/api/v1/compat/public-web','POST',{'content-type':'application/json','content-length':String(body.length),authorization:headers.authorization},body,request)
    }
    if (!['GET','OPTIONS'].includes(method)) return response(405, { ok: false, error: 'method_not_allowed' })
    let query = event.queryStringParameters || {}
    if (!Object.keys(query).length && typeof event.rawQueryString === 'string') {
      if (event.rawQueryString.length > 2048) return response(400, { ok: false, error: 'invalid_query' })
      const params = new URLSearchParams(event.rawQueryString)
      if (new Set(params.keys()).size !== Array.from(params).length) return response(400, { ok: false, error: 'invalid_query' })
      query = Object.fromEntries(params)
    }
    if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(k => !['operation','kind','id','cursor','limit'].includes(k)) ||
      Object.values(query).some(v => typeof v !== 'string' || v.length > 256)) return response(400, { ok: false, error: 'invalid_query' })
    return send(ORIGIN+'/api/v1/compat/house-share?'+new URLSearchParams(query),method,
      { accept:'application/json', ...(headers.origin ? { origin:headers.origin } : {}) },undefined,request)
  }
}
module.exports = { createLegacyPublicRelay }
