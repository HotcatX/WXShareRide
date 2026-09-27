const defaults = require('../config/backend')
const { sha256, sha256Bytes, utf8ByteLength } = require('./hash')

const SESSION_KEY = 'linkx.backend.session.v1'
const PENDING_KEY = 'linkx.backend.pending.v1'
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const failure = (code, message, status = 0) => Object.assign(new Error(message), { code, status })
const cancelled = () => failure('REQUEST_CANCELLED', '当前操作已取消')
const validScope = value => typeof value === 'string' && /^[a-zA-Z0-9:._-]{1,240}$/.test(value)
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered)
  if (!object(value)) return value
  const result = Object.create(null)
  Object.keys(value).sort().forEach(key => { result[key] = ordered(value[key]) })
  return result
}

// Tokens and uncertain operation receipts are local, account-scoped state.
// No cloud database fallback exists in this client.
function createBackendClient(options = {}) {
  const api = options.wx || (typeof wx !== 'undefined' ? wx : null)
  const config = Object.assign({}, defaults, options.config || {})
  const now = options.now || Date.now, random = options.random || Math.random
  const setTimer = options.setTimeout || setTimeout, clearTimer = options.clearTimeout || clearTimeout
  let generation = 0, loginFlight = null, session = null, sessionRead = false, loggedOut = false, sequence = 0, cacheAccount = ''
  const inFlight = new Map(), imageCache = new Map()
  const enabled = () => config.mode === 'server'
  function requireEnabled() {
    if (!enabled() || config.origin !== 'https://collect.linkx.ink') throw failure('BACKEND_DISABLED', '业务服务尚未切换')
  }
  function requirePath(path) {
    if (typeof path !== 'string' || !/^\/api\/v1\/[A-Za-z0-9/%_?&=:+.,~!$'()*;@-]+$/.test(path) || path.includes('//')) {
      throw failure('INVALID_REQUEST', '请求地址无效')
    }
  }
  function read(key) {
    try { return api.getStorageSync(key) } catch (_) { throw failure('LOCAL_STORAGE_UNAVAILABLE', '本地存储暂不可用，请稍后重试') }
  }
  function save(key, value) {
    try { value === null ? api.removeStorageSync(key) : api.setStorageSync(key, value) }
    catch (_) { throw failure('LOCAL_STORAGE_UNAVAILABLE', '本地存储暂不可用，请稍后重试') }
  }
  function account() {
    const value = read('isGuest') ? '' : read('openid')
    return typeof value === 'string' ? value : ''
  }
  function current(epoch, identity) {
    if (epoch !== generation || (identity !== undefined && account() !== identity)) throw cancelled()
  }
  function validSession(value) {
    return object(value) && typeof value.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.token) &&
      typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt)) &&
      object(value.user) && uuid(value.user.id) && /^[A-Za-z0-9_-]{16,128}$/.test(value.user.openid) &&
      /^ref_[a-f0-9]{12}$/.test(value.user.referralCode)
  }
  function bounded(promise) {
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => reject(failure('NETWORK_ERROR', '连接超时，请重试')), 15000)
      Promise.resolve(promise).then(resolve, reject).finally(() => clearTimer(timer))
    })
  }
  async function login({ isCurrent = () => true } = {}) {
    requireEnabled()
    const epoch = generation
    if (!loginFlight) {
      const flight = bounded(Promise.resolve().then(() => api.cloud.callFunction({ name: 'backend', data: { action: 'login' } })))
      loginFlight = flight
      flight.then(() => { if (loginFlight === flight) loginFlight = null }, () => { if (loginFlight === flight) loginFlight = null })
    }
    const response = await loginFlight
    current(epoch)
    if (!isCurrent()) throw cancelled()
    const value = response && response.result && response.result.ok === true && response.result.data
    if (!validSession(value) || Date.parse(value.expiresAt) <= now() + 30000 || Date.parse(value.expiresAt) > now() + 2592000000) {
      throw failure('LOGIN_UNAVAILABLE', '登录服务暂不可用，请重试')
    }
    // Persist only this verified projection, never platform metadata/headers.
    const next = { token: value.token, expiresAt: value.expiresAt,
      user: { id: value.user.id, openid: value.user.openid, referralCode: value.user.referralCode } }
    save(SESSION_KEY, next); session = next; sessionRead = true; loggedOut = false
    return next
  }
  async function requireSession() {
    const identity = account()
    if (!identity || loggedOut) throw failure('UNAUTHORIZED', '请先登录')
    if (!sessionRead) {
      const stored = read(SESSION_KEY)
      sessionRead = true
      if (validSession(stored)) session = stored
    }
    if (session && session.user.openid === identity && Date.parse(session.expiresAt) > now() + 30000) return session
    const next = await login({ isCurrent: () => account() === identity })
    if (next.user.openid !== identity) { session = null; save(SESSION_KEY, null); throw failure('IDENTITY_CHANGED', '账号已变化，请重新登录') }
    return next
  }
  function http(path, method, data, token, key) {
    requireEnabled()
    requirePath(path)
    return new Promise((resolve, reject) => {
      let task, settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true; clearTimer(timer)
        error ? reject(error) : resolve(value)
      }
      const timer = setTimer(() => { finish(failure('NETWORK_ERROR', '连接超时，请重试')); if (task && task.abort) task.abort() }, 15000)
      try {
        task = api.request({ url: config.origin + path, method, data, timeout: 15000,
          header: { 'content-type': data instanceof ArrayBuffer ? 'application/octet-stream' : 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
          success(response) {
            const result = response.data, status = response.statusCode
            if (status >= 200 && status < 300 && object(result) && result.ok === true && Object.prototype.hasOwnProperty.call(result, 'data')) finish(null, result.data)
            else if (object(result) && result.ok === false && object(result.error) && /^[A-Z0-9_]{1,80}$/.test(result.error.code)) {
              finish(failure(result.error.code, typeof result.error.message === 'string' ? result.error.message.slice(0, 160) : '请求失败，请重试', status))
            } else finish(failure('INVALID_RESPONSE', '服务响应异常，请重试', status))
          }, fail() { finish(failure('NETWORK_ERROR', '连接失败，请重试')) }
        })
      } catch (_) { finish(failure('NETWORK_ERROR', '连接失败，请重试')) }
    })
  }
  async function request(path, method, body, { public: publicRead = false, anonymous = false, key } = {}, visitorSession) {
    requireEnabled(); requirePath(path)
    if (visitorSession && (path !== '/api/v1/locations/requests' || method !== 'POST')) throw failure('INVALID_REQUEST', '请求地址无效')
    const epoch = generation, identity = account()
    // Timeline previews must not inherit the browser's signed-in identity.
    const identityRequired = !anonymous && (!publicRead || !!identity)
    let own = visitorSession || (identityRequired ? await requireSession() : null)
    current(epoch, identity)
    let data
    try { data = await http(path, method, body, own && own.token, key) }
    catch (error) {
      current(epoch, identity)
      if (!own || error.status !== 401) throw error
      session = null; save(SESSION_KEY, null)
      if (visitorSession) {
        own = await login({ isCurrent: () => account() === identity })
        if (own.user.id !== visitorSession.user.id) throw failure('IDENTITY_CHANGED', '账号已变化，请重新操作')
      } else own = await requireSession()
      current(epoch, identity)
      data = await http(path, method, body, own.token, key)
    }
    current(epoch, identity)
    return data
  }
  function readPending() {
    const value = read(PENDING_KEY) || []
    if (!Array.isArray(value) || value.length > 40 || value.some(item => !object(item) || !uuid(item.userId) ||
      !validScope(item.scope) ||
      !/^[a-f0-9]{64}$/.test(item.fingerprint) || !/^[a-zA-Z0-9:._-]{8,128}$/.test(item.key) ||
      (item.request !== undefined && !validPendingRequest(item.request, item.fingerprint)))) {
      throw failure('LOCAL_STORAGE_UNAVAILABLE', '待确认操作记录异常，请联系管理员')
    }
    return value
  }
  function validPendingRequest(value, fingerprint) {
    if (!object(value) || !['POST', 'PATCH', 'DELETE'].includes(value.method)) return false
    try {
      requirePath(value.path)
      const body = JSON.stringify(ordered(value.body))
      return typeof body === 'string' && utf8ByteLength(body) <= 65536 && sha256(JSON.stringify([value.method, value.path, body])) === fingerprint
    } catch (_) { return false }
  }
  function releasePending(entry) {
    const next = readPending().filter(item => item.userId !== entry.userId || item.key !== entry.key)
    save(PENDING_KEY, next.length ? next : null)
  }
  async function perform(scope, method, path, body, fingerprint, validate, visitorSession) {
    requireEnabled(); requirePath(path)
    if (!validScope(scope)) throw failure('INVALID_REQUEST', '操作类型无效')
    const epoch = generation, identity = account(), own = visitorSession || await requireSession()
    current(epoch, identity)
    const lock = `${own.user.id}:${scope}`
    if (inFlight.has(lock)) {
      const running = inFlight.get(lock)
      if (running.fingerprint !== fingerprint) throw failure('OPERATION_IN_FLIGHT', '上一操作正在保存，请稍后重试')
      return running.promise
    }
    const pending = readPending()
    let entry = pending.find(item => item.userId === own.user.id && item.scope === scope)
    const wasPending = !!entry
    if (entry && entry.fingerprint !== fingerprint) throw failure('PENDING_OPERATION', '上一操作结果尚未确认，请保持内容不变后重试')
    if (!entry) {
      if (pending.length >= 40) throw failure('PENDING_OPERATIONS_FULL', '待确认操作过多，请先重试之前的操作')
      entry = { userId: own.user.id, scope, fingerprint,
        key: `op_${now().toString(36)}_${(++sequence).toString(36)}_${Array.from({ length: 4 }, () => Math.floor(random() * 0x100000000).toString(16).padStart(8, '0')).join('')}`,
        ...(body instanceof ArrayBuffer ? {} : { request: { method, path, body } }) }
      save(PENDING_KEY, [...pending, entry])
    }
    const promise = request(path, method, body, { key: entry.key }, visitorSession).then(data => {
      // Business receipts must be checked before forgetting an uncertain write.
      if (validate) {
        try { if (validate(data) === false) throw new Error() }
        catch (_) { throw failure('INVALID_RESPONSE', '服务响应异常，请重试') }
      }
      releasePending(entry); return data
    }, error => {
      // A new operation rejected with 4xx is known not to have committed. Once
      // a prior attempt is uncertain, later authorization/validation failures
      // cannot tell us whether that earlier attempt committed: retain its key.
      if (!wasPending && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status) &&
        !['IDEMPOTENCY_CONFLICT', 'UPLOAD_CONTENT_CONFLICT', 'INVALID_RESPONSE'].includes(error.code)) releasePending(entry)
      throw error
    }).finally(() => { if (inFlight.get(lock)?.promise === promise) inFlight.delete(lock) })
    inFlight.set(lock, { fingerprint, promise })
    return promise
  }
  function mutate(scope, method, path, body, { validate } = {}) {
    if (!['POST', 'PATCH', 'DELETE'].includes(method)) return Promise.reject(failure('INVALID_REQUEST', '写入方式无效'))
    let raw
    try { raw = JSON.stringify(body === undefined ? {} : body) } catch (_) { return Promise.reject(failure('INVALID_REQUEST', '内容格式无效')) }
    if (typeof raw !== 'string' || utf8ByteLength(raw) > 65536) return Promise.reject(failure('INVALID_REQUEST', '内容过大'))
    raw = JSON.stringify(ordered(JSON.parse(raw)))
    return perform(scope, method, path, JSON.parse(raw), sha256(JSON.stringify([method, path, raw])), validate)
  }
  async function retryPending(scope, { validate } = {}) {
    requireEnabled()
    const epoch = generation, identity = account(), own = await requireSession()
    current(epoch, identity)
    const entry = readPending().find(item => item.userId === own.user.id && item.scope === scope)
    if (!entry) return null
    if (!entry.request) throw failure('PENDING_OPERATION', '请使用上次相同内容重试')
    const { method, path, body } = entry.request
    return perform(scope, method, path, body, entry.fingerprint, validate)
  }
  async function submitLocationRequest(body) {
    requireEnabled()
    if (!object(body) || Object.keys(body).sort().join(',') !== 'cityKey,sourcePage' ||
      !/^[a-z0-9_:-]{1,80}$/.test(body.cityKey) || !['home', 'carpoolList'].includes(body.sourcePage)) throw failure('INVALID_REQUEST', '城市请求无效')
    const epoch = generation, identity = account()
    // A visitor's explicit city request uses the same verified technical identity,
    // but does not mark them logged in or enable unrelated private operations.
    const own = identity ? await requireSession() : await login({ isCurrent: () => account() === identity })
    current(epoch, identity)
    const scope = 'locations.request', path = '/api/v1/locations/requests'
    const entry = readPending().find(item => item.userId === own.user.id && item.scope === scope)
    const validate = intent => data => object(data) && data.cityKey ===
      (['ny', 'nj', 'ny_nj'].includes(intent.cityKey) ? 'ny_nj' : intent.cityKey) &&
      (data.status === 'recorded' && uuid(data.requestId) ||
        data.status === 'already_available' && data.cityKey === 'ny_nj' && data.requestId === null)
    if (entry) {
      if (!entry.request || entry.request.path !== path || entry.request.method !== 'POST') throw failure('PENDING_OPERATION', '上一城市请求尚未确认')
      const data = await perform(scope, 'POST', path, entry.request.body, entry.fingerprint, validate(entry.request.body), identity ? undefined : own)
      return { ...data, recovered: true }
    }
    const raw = JSON.stringify(ordered(body))
    return perform(scope, 'POST', path, JSON.parse(raw), sha256(JSON.stringify(['POST', path, raw])), validate(body), identity ? undefined : own)
  }
  async function uploadImage(filePath, scope) {
    requireEnabled()
    if (!validScope(scope) || scope.length > 223) throw failure('INVALID_REQUEST', '操作类型无效')
    const epoch = generation, identity = account()
    const result = await new Promise((resolve, reject) => api.getFileSystemManager().readFile({ filePath,
      success: resolve, fail: () => reject(failure('IMAGE_READ_FAILED', '无法读取图片，请重新选择')) }))
    current(epoch, identity)
    const bytes = result.data
    if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength || bytes.byteLength > 2 * 1024 * 1024) throw failure('INVALID_IMAGE', '请选择不超过 2MB 的图片')
    const hash = sha256Bytes(bytes)
    // Each chosen image is its own operation; concurrent A/B selection cannot
    // share a reservation. Retries of an uncertain image keep its same key.
    return perform(`${scope}:${hash.slice(0, 16)}`, 'POST', '/api/v1/files/images', bytes, hash,
      data => object(data) && uuid(data.fileId))
  }
  async function resolveImages(ids, options = {}) {
    if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => !uuid(id))) throw failure('INVALID_IMAGE', '图片编号无效')
    const unique = [...new Set(ids)]
    if (!unique.length) return []
    const epoch = generation, identity = account()
    const cacheIdentity = options.anonymous ? 'anonymous' : `account:${identity}`
    if (cacheIdentity !== cacheAccount) { imageCache.clear(); cacheAccount = cacheIdentity }
    // Keep this call's hits independent from the bounded shared cache. Adding
    // new links (or another simultaneous call) may evict one of these entries.
    const resolved = new Map()
    for (const id of unique) {
      const value = imageCache.get(id)
      if (!options.refresh && value && value.expiresAt > now()) resolved.set(id, value)
    }
    const missing = unique.filter(id => !resolved.has(id))
    if (missing.length) {
      const started = now(), data = await request('/api/v1/files/urls', 'POST', { fileIds: missing }, options)
      if (!object(data) || !Number.isInteger(data.expiresIn) || data.expiresIn < 30 || data.expiresIn > 300 ||
        !Array.isArray(data.items) || data.items.some(item => !object(item)) || data.items.length !== missing.length || new Set(data.items.map(item => item.fileId)).size !== missing.length ||
        data.items.some(item => !missing.includes(item.fileId) || typeof item.url !== 'string' || item.url.length > 8192 || !/^https:\/\/[A-Za-z0-9.-]+(?:\/[^\s#]*)?$/.test(item.url))) {
        throw failure('INVALID_RESPONSE', '图片链接暂不可用，请重试')
      }
      const expiresAt = started + (data.expiresIn - 15) * 1000
      if (expiresAt <= now()) throw failure('INVALID_RESPONSE', '图片链接已过期，请重试')
      for (const item of data.items) {
        const value = { url: item.url, expiresAt }
        resolved.set(item.fileId, value)
        if (cacheAccount === cacheIdentity) imageCache.set(item.fileId, value)
      }
      while (imageCache.size > 200) imageCache.delete(imageCache.keys().next().value)
    }
    current(epoch, identity)
    if (unique.some(fileId => resolved.get(fileId).expiresAt <= now())) throw failure('INVALID_RESPONSE', '图片链接已过期，请重试')
    return unique.map(fileId => ({ fileId, url: resolved.get(fileId).url }))
  }
  function logout() {
    let previous = session
    if (!previous) { try { const stored = read(SESSION_KEY); if (validSession(stored)) previous = stored } catch (_) {} }
    generation++; session = null; sessionRead = true; loggedOut = true; loginFlight = null; imageCache.clear(); cacheAccount = ''
    try { save(SESSION_KEY, null) } catch (_) { /* In-memory invalidation is immediate even if storage is unavailable. */ }
    if (enabled() && previous) return http('/api/v1/auth/logout', 'POST', {}, previous.token).then(() => {}, () => {})
    return Promise.resolve()
  }
  return { isBackendEnabled: enabled, login, logout, get: (path, options) => request(path, 'GET', undefined, options),
    // This existing protocol carries its own stable requestId and status version;
    // activation reconciles through status and withdrawals already persist intent.
    // Do not add a second generic mutation receipt/queue for a collector grant.
    collectionSession: body => request('/api/v1/analytics/session', 'POST', body),
    mutate, retryPending, uploadImage, resolveImages, submitLocationRequest }
}

let singleton
function client() { if (!singleton) singleton = createBackendClient(); return singleton }
module.exports = { createBackendClient, SESSION_KEY, PENDING_KEY,
  isBackendEnabled: () => defaults.mode === 'server',
  ...Object.fromEntries(['login', 'logout', 'get', 'mutate', 'retryPending', 'uploadImage', 'resolveImages', 'collectionSession', 'submitLocationRequest'].map(name => [name, (...args) => client()[name](...args)])) }
