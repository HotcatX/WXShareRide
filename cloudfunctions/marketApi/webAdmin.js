const { AdminError, reject, record, read, createSecurity } = require('./webAdminSecurity')
const { createContent } = require('./webAdminContent')
const { createBusiness } = require('./webAdminBusiness')
const MAX_BODY_BYTES = 3 * 1024 * 1024
const ACTIONS = new Set(['login', 'session', 'logout', 'bootstrap', 'bulkCreate', 'getItem', 'updateItem', 'listTemplates', 'saveTemplate', 'deleteTemplate', 'getCommunity', 'updateCommunity', 'uploadImage', 'getImageURLs'])
const MESSAGES = {
  authentication_required: '请先登录管理网站', session_invalid: '登录已失效，请重新登录', invalid_credentials: '账号或密码不正确',
  login_rate_limited: '尝试次数过多，请稍后再试', origin_not_allowed: '该网站尚未获得访问授权',
  version_conflict: '内容已被其他操作修改，请刷新后再保存', idempotency_conflict: '相同发布编号的内容发生变化，请使用新的编号',
  image_not_allowed: '只能使用已授权上传的图片', invalid_image: '请上传 2 MB 以内的 JPG、PNG 或 WebP 图片',
  image_unavailable: '图片暂时无法加载，请稍后重试', service_unavailable: '服务暂时不可用，请稍后重试'
}
function isHttpEvent(event) {
  // Shape is routing, never proof of identity: SDK callers can forge it. Every
  // sensitive branch still needs a separately verified website Bearer session.
  return !!event && typeof event.httpMethod === 'string' && event.headers && typeof event.headers === 'object' && !Array.isArray(event.headers) && Object.prototype.hasOwnProperty.call(event, 'body')
}
function headersOf(source) {
  const headers = Object.create(null)
  for (const [name, value] of Object.entries(source)) {
    const key = name.toLowerCase()
    if (Object.prototype.hasOwnProperty.call(headers, key) || typeof value !== 'string' || /[\r\n]/.test(value)) reject('invalid_request')
    headers[key] = value.trim()
  }
  return headers
}
function originValue(value) {
  if (typeof value !== 'string' || value.length > 300) return ''
  try {
    const url = new URL(value)
    if (url.username || url.password || url.origin !== value) return ''
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return ''
    return value
  } catch (_) { return '' }
}

function createWebAdminHandler(dependencies) {
  const { db } = dependencies
  const security = createSecurity(dependencies)
  const content = createContent(dependencies)
  const business = createBusiness({ ...dependencies, content })
  return async function handle(event) {
    let origin = ''
    const respond = (body, statusCode = 200) => ({
      statusCode, isBase64Encoded: false,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin', ...(origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' } : {}) },
      body: statusCode === 204 ? '' : JSON.stringify(body)
    })
    try {
      if (!isHttpEvent(event)) reject('invalid_request')
      const headers = headersOf(event.headers)
      const settings = await read(db, 'WebAdminSettings', 'main')
      const requestedOrigin = originValue(headers.origin)
      if (!requestedOrigin || !settings || !Array.isArray(settings.allowedOrigins) || !settings.allowedOrigins.map(originValue).filter(Boolean).includes(requestedOrigin)) reject('origin_not_allowed', 403)
      origin = requestedOrigin
      if (event.httpMethod.toUpperCase() === 'OPTIONS') return respond(null, 204)
      if (event.httpMethod.toUpperCase() !== 'POST') reject('method_not_allowed', 405)
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers['content-type'] || '')) reject('invalid_content_type', 415)
      if (typeof event.body !== 'string' || Buffer.byteLength(event.body) > MAX_BODY_BYTES * (event.isBase64Encoded === true ? 1.34 : 1)) reject('invalid_request', 413)
      let body = event.body
      if (event.isBase64Encoded === true) {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)) reject('invalid_request')
        body = Buffer.from(body, 'base64').toString('utf8')
      }
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) reject('invalid_request', 413)
      let input
      try { input = JSON.parse(body) } catch (_) { reject('invalid_json') }
      if (input !== record(input) || !ACTIONS.has(input.action)) reject('unknown_action')
      if (input.action === 'login') return respond(await security.login(input))
      const account = await security.authenticate(headers)
      if (input.action === 'session') return respond({ ok: true, admin: { username: account.accountId }, expiresAtMs: account.expiresAtMs })
      if (input.action === 'logout') return respond(await security.logout(account))
      if (Object.prototype.hasOwnProperty.call(content, input.action) && input.action !== 'owned') return respond(await content[input.action](input, account))
      if (Object.prototype.hasOwnProperty.call(business, input.action)) return respond(await business[input.action](input, account))
      reject('unknown_action')
    } catch (error) {
      const expected = error instanceof AdminError
      const code = expected ? error.code : 'service_unavailable'
      // No raw SDK errors, credentials, input payloads or file bytes in logs.
      return respond({ ok: false, error: code, message: MESSAGES[code] || '请检查填写内容后重试' }, expected ? error.status : 503)
    }
  }
}

module.exports = { createWebAdminHandler, isHttpEvent, headersOf, originValue }
