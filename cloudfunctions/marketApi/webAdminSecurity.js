const crypto = require('crypto')
const { promisify } = require('util')
const scrypt = promisify(crypto.scrypt)
const SESSION_MS = 8 * 60 * 60 * 1000
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_LIMIT = 10
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : ''
const username = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{2,63}$/.test(value.trim().toLowerCase()) ? value.trim().toLowerCase() : ''

class AdminError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status }
}
const reject = (code, status) => { throw new AdminError(code, status) }
async function read(database, collection, key) {
  const result = await database.collection(collection).doc(key).get()
  if (!result || !Object.prototype.hasOwnProperty.call(result, 'data')) throw new Error('Invalid database response')
  return result.data || null
}
async function transaction(db, work) {
  if (typeof db.runTransaction !== 'function') throw new Error('Transactions required')
  // SDK versions may return the callback value or { result: value }.
  const result = await db.runTransaction(async tx => ({ webAdminValue: await work(tx) }))
  const wrapped = result && Object.prototype.hasOwnProperty.call(result, 'webAdminValue') ? result : result && result.result
  if (!wrapped || !Object.prototype.hasOwnProperty.call(wrapped, 'webAdminValue')) throw new Error('Invalid transaction response')
  return wrapped.webAdminValue
}
function activeAccount(account, accountId) {
  return account && account.enabled === true && account.role === 'admin' && account.username === accountId &&
    !!id(account.ownerKey) && Number.isSafeInteger(account.passwordVersion) && account.passwordVersion >= 1
}
function auditData(account, action, details, time) {
  return { accountId: account.accountId, action, ...details, createdAtMs: time }
}
async function writeAudit(tx, account, action, details, time, auditId = crypto.randomBytes(16).toString('hex')) {
  await tx.collection('WebAdminAuditLogs').doc(auditId).set({ data: auditData(account, action, details, time) })
}

function createSecurity({ db, now = Date.now }) {
  async function authenticate(headers) {
    const match = /^Bearer ([a-f0-9]{64})$/.exec(headers.authorization || '')
    if (!match) reject('authentication_required', 401)
    const tokenHash = hash(match[1])
    const session = await read(db, 'WebAdminSessions', tokenHash)
    if (!session || session.status !== 'active' || session.tokenHash !== tokenHash || !Number.isSafeInteger(session.expiresAtMs) || session.expiresAtMs <= now() || !username(session.accountId)) reject('session_invalid', 401)
    const account = await read(db, 'WebAdminAccounts', session.accountId)
    if (!activeAccount(account, session.accountId) || session.passwordVersion !== account.passwordVersion) reject('session_invalid', 401)
    return { ...account, accountId: session.accountId, sessionId: tokenHash, expiresAtMs: session.expiresAtMs }
  }

  async function login(input) {
    const accountId = username(input.username)
    if (!accountId || typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 256) reject('invalid_credentials', 401)
    // Reserve every attempt atomically before password work. Success does not
    // reset this counter, preventing concurrent attempts from losing increments.
    const permitted = await transaction(db, async tx => {
      const at = now(), ref = tx.collection('WebAdminLoginAttempts').doc(hash(accountId))
      const previous = await read(tx, 'WebAdminLoginAttempts', hash(accountId))
      const global = await read(tx, 'WebAdminLoginAttempts', 'global')
      const fresh = !previous || !Number.isSafeInteger(previous.windowStartMs) || at >= previous.windowStartMs + LOGIN_WINDOW_MS
      const globalFresh = !global || !Number.isSafeInteger(global.windowStartMs) || at >= global.windowStartMs + LOGIN_WINDOW_MS
      const count = fresh ? 0 : Number(previous.count) || 0
      const globalCount = globalFresh ? 0 : Number(global.count) || 0
      if (count >= LOGIN_LIMIT || globalCount >= 120) return false
      await ref.set({ data: { windowStartMs: fresh ? at : previous.windowStartMs, count: count + 1, expiresAtMs: (fresh ? at : previous.windowStartMs) + LOGIN_WINDOW_MS } })
      await tx.collection('WebAdminLoginAttempts').doc('global').set({ data: { windowStartMs: globalFresh ? at : global.windowStartMs, count: globalCount + 1, expiresAtMs: (globalFresh ? at : global.windowStartMs) + LOGIN_WINDOW_MS } })
      return true
    })
    if (!permitted) reject('login_rate_limited', 429)
    const account = await read(db, 'WebAdminAccounts', accountId)
    const digest = record(account && account.passwordDigest)
    const validDigest = digest.algorithm === 'scrypt' && /^[a-f0-9]{64}$/.test(digest.salt || '') && /^[a-f0-9]{128}$/.test(digest.hash || '')
    // Equal-cost dummy work for absent/disabled accounts avoids username probing.
    const expected = Buffer.from(validDigest ? digest.hash : '00'.repeat(64), 'hex')
    const derived = await scrypt(input.password, Buffer.from(validDigest ? digest.salt : '00'.repeat(32), 'hex'), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
    if (!crypto.timingSafeEqual(expected, derived) || !validDigest || !activeAccount(account, accountId)) reject('invalid_credentials', 401)
    const token = crypto.randomBytes(32).toString('hex'), tokenHash = hash(token)
    const expiresAtMs = now() + SESSION_MS
    await transaction(db, async tx => {
      const fresh = await read(tx, 'WebAdminAccounts', accountId)
      if (!activeAccount(fresh, accountId) || fresh.passwordVersion !== account.passwordVersion || JSON.stringify(fresh.passwordDigest) !== JSON.stringify(account.passwordDigest)) reject('invalid_credentials', 401)
      await tx.collection('WebAdminSessions').doc(tokenHash).set({ data: { tokenHash, accountId, passwordVersion: account.passwordVersion, status: 'active', createdAtMs: now(), expiresAtMs } })
      await writeAudit(tx, { accountId }, 'login', {}, now())
    })
    return { ok: true, token, expiresAtMs, admin: { username: accountId } }
  }
  async function logout(account) {
    await transaction(db, async tx => {
      await tx.collection('WebAdminSessions').doc(account.sessionId).update({ data: { status: 'revoked', revokedAtMs: now() } })
      await writeAudit(tx, account, 'logout', {}, now())
    })
    return { ok: true }
  }
  return { authenticate, login, logout }
}

module.exports = { AdminError, reject, record, hash, id, read, transaction, writeAudit, createSecurity, SESSION_MS, LOGIN_LIMIT }
