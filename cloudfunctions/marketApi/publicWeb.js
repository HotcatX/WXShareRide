// Server-to-server read adapter for the independent Cloudflare public website.
// It can invoke only the projected publicPreview reader, never normal/admin actions.
const crypto = require('crypto')
const PUBLIC_PATH = '/public-api'
const MAX_BODY_BYTES = 2048
const OPERATIONS = new Set(['marketList', 'marketDetail', 'tripList', 'tripDetail'])
const CITIES = new Set(['all', 'ny_nj', 'ny', 'nj', 'boston', 'philadelphia', 'dc', 'la', 'bay_area', 'san_diego', 'seattle', 'chicago', 'champaign', 'ann_arbor', 'columbus', 'dallas', 'houston', 'austin', 'atlanta', 'miami', 'orlando'])

function pathsOf(event) {
  return [event && event.path, event && event.rawPath, event && event.requestContext && event.requestContext.path].filter(value => value !== undefined)
}
function matchesPublicPath(event) { return pathsOf(event).some(value => value === PUBLIC_PATH) }
function exactPublicPath(event) {
  const paths = pathsOf(event)
  return paths.length > 0 && paths.every(value => value === PUBLIC_PATH)
}
function headerValues(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null
  const values = Object.create(null)
  for (const [key, value] of Object.entries(source)) {
    const name = key.toLowerCase()
    if (Object.prototype.hasOwnProperty.call(values, name) || typeof value !== 'string' || /[\r\n]/.test(value)) return null
    values[name] = value.trim()
  }
  return values
}
function validSecret(secret) { return typeof secret === 'string' && /^[A-Za-z\d_-]{32,128}$/.test(secret) }
function loadServerSecret({ env = process.env, readConfig = () => require('./publicWeb.secret.json') } = {}) {
  // An explicitly configured environment value always wins, including invalid
  // values. Falling back after an invalid value could silently undo revocation.
  if (Object.prototype.hasOwnProperty.call(env, 'PUBLIC_WEB_API_SECRET')) return env.PUBLIC_WEB_API_SECRET
  try {
    // This optional file is deployed only into the cloud function, never Git or
    // either website. No database query is needed to authenticate a read.
    const config = readConfig()
    if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(config, 'PUBLIC_WEB_API_SECRET')) return undefined
    return config.PUBLIC_WEB_API_SECRET
  } catch (_) { return undefined }
}
function authenticated(header, secret) {
  if (typeof header !== 'string' || header.length > 140 || !/^Bearer [A-Za-z\d_-]{32,128}$/.test(header)) return false
  const digest = value => crypto.createHash('sha256').update(value).digest()
  return crypto.timingSafeEqual(digest(header.slice(7)), digest(secret))
}
function parsePublicInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !OPERATIONS.has(input.operation)) return null
  const detail = input.operation.endsWith('Detail')
  const market = input.operation.startsWith('market')
  const allowed = new Set(detail ? ['operation', 'kind', 'id', 'locale'] : ['operation', 'kind', 'limit', 'offset', 'cityKey', 'locale'])
  if (Object.keys(input).some(key => !allowed.has(key))) return null
  if (input.locale !== undefined && input.locale !== 'en') return null
  const kind = input.kind === undefined && !detail ? (market ? 'goods' : 'all') : input.kind
  if (!(market ? ['goods', 'sublet', ...(detail ? [] : ['all'])] : ['carpool', 'request', ...(detail ? [] : ['all'])]).includes(kind)) return null
  const result = { previewAction: input.operation, type: kind, locale: 'en' }
  if (detail) {
    if (typeof input.id !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(input.id)) return null
    result.id = input.id
  } else {
    const limit = input.limit === undefined ? 20 : input.limit
    const offset = input.offset === undefined ? 0 : input.offset
    if (!Number.isInteger(limit) || limit < 1 || limit > 20 || !Number.isInteger(offset) || offset < 0 || offset > 80) return null
    if (input.cityKey !== undefined && !CITIES.has(input.cityKey)) return null
    result.limit = limit
    result.offset = offset
    if (input.cityKey !== undefined) result.cityKey = input.cityKey
  }
  return result
}
function response(statusCode, body) {
  return {
    statusCode, isBase64Encoded: false,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    body: JSON.stringify(body)
  }
}
function createPublicWebHandler({ publicPreview, getSecret = loadServerSecret }) {
  return async function handlePublicWeb(event) {
    const fail = (status, error) => response(status, { ok: false, error })
    try {
      if (!exactPublicPath(event)) return fail(404, 'not_found')
      if (event.httpMethod !== 'POST') return fail(405, 'method_not_allowed')
      const headers = headerValues(event.headers)
      if (!headers) return fail(400, 'invalid_request')
      const secret = getSecret()
      if (!validSecret(secret)) return fail(503, 'service_unavailable')
      if (!authenticated(headers.authorization, secret)) return fail(401, 'authentication_required')
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers['content-type'] || '')) return fail(415, 'invalid_content_type')
      if (typeof event.body !== 'string' || Buffer.byteLength(event.body) > MAX_BODY_BYTES * 1.34) return fail(413, 'invalid_request')
      let body = event.body
      if (event.isBase64Encoded !== undefined && typeof event.isBase64Encoded !== 'boolean') return fail(400, 'invalid_request')
      if (event.isBase64Encoded === true) {
        if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(body)) return fail(400, 'invalid_request')
        body = Buffer.from(body, 'base64').toString('utf8')
      }
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) return fail(413, 'invalid_request')
      let input
      try { input = JSON.parse(body) } catch (_) { return fail(400, 'invalid_json') }
      const request = parsePublicInput(input)
      if (!request) return fail(400, 'invalid_request')
      const result = await publicPreview(request)
      if (!result || result.ok !== true) return fail(result && result.error === 'not_found' ? 404 : 503, result && result.error === 'not_found' ? 'not_found' : 'service_unavailable')
      // marketDetail intentionally supports both listing kinds in the mini-program;
      // keep the website's explicit kind contract without changing that behavior.
      if (request.id && (!result.item || result.item.kind !== request.type)) return fail(404, 'not_found')
      return response(200, request.id ? result : { ...result, hasMore: result.hasMore === true && result.nextOffset <= 80 })
    } catch (_) {
      // No credentials, payloads, database errors or private records in logs/errors.
      return fail(503, 'service_unavailable')
    }
  }
}

module.exports = { createPublicWebHandler, matchesPublicPath, parsePublicInput, loadServerSecret }
