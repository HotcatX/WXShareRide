const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const crypto = require('node:crypto')
const { createWebAdminHandler } = require('../cloudfunctions/marketApi/webAdmin')
const { imageInput, MAX_IMAGE_BYTES } = require('../cloudfunctions/marketApi/webAdminContent')
const { hash, LOGIN_LIMIT } = require('../cloudfunctions/marketApi/webAdminSecurity')
const ENV = 'cloud1-web-admin-test'
const ORIGIN = 'https://admin.example.com'
const NOW = Date.now()
const TOKEN = 'ab'.repeat(32)
const PASSWORD = 'Test-only-strong-password-2026!'
const SALT = 'cd'.repeat(32)
const DIGEST = crypto.scryptSync(PASSWORD, Buffer.from(SALT, 'hex'), 64, { N: 16384, r: 8, p: 1 }).toString('hex')
const clone = value => structuredClone(value)
function fixture(options = {}) {
  let clock = NOW, state = new Map(), queue = Promise.resolve()
  const writes = [], calls = { uploads: [], urls: [] }, failures = new Map()
  const key = (collection, id) => collection + '/' + id
  const seed = (collection, id, value) => state.set(key(collection, id), clone(value))
  const rows = collection => [...state].filter(([key]) => key.startsWith(collection + '/')).map(([key, row]) => ({ ...clone(row), _id: key.slice(collection.length + 1) }))
  const read = (collection, id) => clone(state.get(key(collection, id)))
  const dot = (value, key) => key.split('.').reduce((obj, key) => obj && obj[key], value)
  function collectionApi(collection, target, writeLog) {
    const selected = () => target || state
    function check(op, id) {
      const failureKey = `${op}:${collection}/${id}`
      if ((failures.get(failureKey) || 0) > 0) { failures.set(failureKey, failures.get(failureKey) - 1); throw new Error('private_database_trace') }
    }
    let filter = {}, skip = 0, limit = Infinity
    const api = {
      doc(id) { return {
        async get() { check('get', id); const value = selected().get(key(collection, id)); return { data: value ? { ...clone(value), _id: id } : null } },
        async set({ data }) { check('set', id); const copy = clone(data); delete copy._id; selected().set(key(collection, id), copy); writeLog.push({ op: 'set', collection, id }); return { _id: id } },
        async update({ data }) { check('update', id); const current = selected().get(key(collection, id)); if (!current) throw new Error('missing'); selected().set(key(collection, id), { ...current, ...clone(data) }); writeLog.push({ op: 'update', collection, id }); return { stats: { updated: 1 } } },
        field() { return this }
      } },
      where(condition) { filter = condition; return api }, limit(value) { limit = value; return api }, skip(value) { skip = value; return api }, field() { return api },
      async get() { return { data: [...selected()].filter(([key, row]) => key.startsWith(collection + '/') && Object.entries(filter).every(([key, value]) => dot(row, key) === value)).slice(skip, skip + limit).map(([key, row]) => ({ ...clone(row), _id: key.slice(collection.length + 1) })) } }
    }
    return api
  }
  const db = { command: {}, serverDate: () => new Date(clock), collection: collection => collectionApi(collection, null, writes),
    async runTransaction(work) {
      const run = queue.then(async () => {
        const draft = clone(state), localWrites = []
        const result = await work({ collection: collection => collectionApi(collection, draft, localWrites) })
        state = draft; writes.push(...localWrites)
        return options.wrappedTransactions ? { result } : result
      })
      queue = run.catch(() => {})
      return run
    }
  }
  const cloud = { DYNAMIC_CURRENT_ENV: ENV, init() {}, database: () => db, getWXContext: () => ({ ENV, OPENID: options.openid === undefined ? 'mini-user' : options.openid }),
    async uploadFile(input) { calls.uploads.push(input); if (options.uploadError) throw new Error('private_upload_trace'); return { fileID: `cloud://${ENV}.bucket-123/${input.cloudPath}` } },
    async getTempFileURL(input) { calls.urls.push(input); if (options.urlError) throw new Error('private_url_trace'); return { fileList: input.fileList.map(fileID => ({ fileID, status: 0, tempFileURL: `https://bucket-123.tcb.qcloud.la/${fileID.split('/').slice(3).join('/')}?signature=temporary` })) } }
  }
  seed('WebAdminSettings', 'main', { allowedOrigins: [ORIGIN] })
  seed('WebAdminAccounts', 'admin', { username: 'admin', enabled: true, role: 'admin', ownerKey: 'web_admin_main', passwordVersion: 1, passwordDigest: { algorithm: 'scrypt', salt: SALT, hash: DIGEST } })
  seed('WebAdminSessions', hash(TOKEN), { tokenHash: hash(TOKEN), accountId: 'admin', passwordVersion: 1, status: 'active', expiresAtMs: NOW + 3600000 })
  seed('CITY_TREE', 'NJ', { 'Fort Lee': ['Fort Lee 核心区', 'Fort Lee 非核心区'] })
  const exports = {}
  const filename = path.resolve(__dirname, '../cloudfunctions/marketApi/index.js')
  const source = fs.readFileSync(filename, 'utf8') + '\nexports.helpers = { buildCreateItemForSave, normalizePayloadForSave, attachMarketFiles, collectMarketFiles };'
  vm.runInNewContext(source, { exports, require(name) {
    if (name === 'wx-server-sdk') return cloud
    if (name.startsWith('./')) return require(path.resolve(path.dirname(filename), name))
    return require(name)
  }, console, Date, Intl, Set, Map, Buffer, process }, { filename })
  const handler = createWebAdminHandler({ db, cloud, now: () => clock, getEnvId: () => ENV, ...exports.helpers })
  const event = (input, options = {}) => ({ httpMethod: options.method || 'POST', headers: { Origin: options.origin === undefined ? ORIGIN : options.origin, 'Content-Type': 'application/json', ...(options.token === false ? {} : { Authorization: 'Bearer ' + (options.token || TOKEN) }), ...options.headers }, body: JSON.stringify(input) })
  const api = async (input, options) => { const response = await handler(event(input, options)); return { status: response.statusCode, headers: response.headers, ...(response.body ? JSON.parse(response.body) : {}) } }
  return { handler, api, event, main: exports.main, db, cloud, seed, read, rows, writes, calls, failures, setNow: value => { clock = value } }
}
function png() { return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1cAAAAASUVORK5CYII=', 'base64') }
const uploadInput = (extra = {}) => ({ action: 'uploadImage', purpose: 'market', filename: 'image.png', contentType: 'image/png', base64: png().toString('base64'), ...extra })
const item = (extra = {}) => ({ title: '桌子', price: 20, category: '家具', listingType: 'goods', regionState: 'NJ', regionCounty: 'Fort Lee', regionArea: 'Fort Lee 核心区', sellerName: '卖家', sellerWechat: 'test-wechat', externalId: 'test-row', ...extra })

test('HTTP-shaped SDK events require independent auth and never dispatch mini actions', async () => {
  const f = fixture()
  for (const action of ['bulkCreate', 'uploadImage', 'updateCommunity', 'updateItem', 'saveTemplate']) {
    const result = await f.main(f.event({ action, openid: 'trusted', OPENID: 'trusted', ownerKey: 'web_admin_main', admin: true }, { token: false }))
    assert.equal(JSON.parse(result.body).error, 'authentication_required')
  }
  const forged = await f.main(f.event({ action: 'create', payload: item() }))
  assert.equal(JSON.parse(forged.body).error, 'unknown_action')
  assert.equal(f.writes.length, 0)
  for (const action of ['adminStatus', 'adminSessionStatus', 'adminVerifyPassword', 'adminBulkCreate', 'adminListTemplates', 'adminSaveTemplate', 'adminDeleteTemplate']) assert.equal((await f.main({ action, adminToken: TOKEN, password: '123456' })).error, 'unknown_action')
  assert.equal((await fixture({ openid: '' }).main({ action: 'adminBulkCreate' })).error, 'not_logged_in')
})

test('CORS fails closed and preflight does not write business data', async () => {
  const f = fixture()
  for (const origin of ['', 'null', 'https://admin.example.com.attacker.test', 'https://admin.example.com:444', 'https://admin.example.com/']) {
    const result = await f.api({ action: 'session' }, { origin })
    assert.equal(result.status, 403); assert.equal(result.headers['Access-Control-Allow-Origin'], undefined)
  }
  assert.equal((await f.api({}, { method: 'OPTIONS' })).status, 204)
  assert.equal(f.writes.length, 0)
  const allowedFailure = await f.api({ action: 'session' }, { token: false })
  assert.equal(allowedFailure.headers['Access-Control-Allow-Origin'], ORIGIN)
  assert.equal(allowedFailure.headers.Vary, 'Origin')
  f.seed('WebAdminSettings', 'main', { allowedOrigins: [] })
  assert.equal((await f.api({ action: 'session' })).status, 403)
})

test('login uses scrypt, returns only public identity, and persists no raw token/password', async () => {
  const f = fixture({ wrappedTransactions: true })
  const result = await f.api({ action: 'login', username: ' ADMIN ', password: PASSWORD }, { token: false })
  assert.equal(result.ok, true); assert.match(result.token, /^[a-f0-9]{64}$/)
  assert.deepEqual(result.admin, { username: 'admin' }); assert.equal(result.expiresAtMs, NOW + 8 * 3600000)
  const stored = f.read('WebAdminSessions', hash(result.token))
  assert.equal(stored.tokenHash, hash(result.token)); assert.ok(!JSON.stringify(stored).includes(result.token))
  assert.ok(!JSON.stringify(f.rows('WebAdminAuditLogs')).includes(PASSWORD))
  assert.equal((await f.api({ action: 'session' }, { token: result.token })).ok, true)
  assert.equal((await f.api({ action: 'login', username: 'admin', password: '123456' })).error, 'invalid_credentials')
})

test('login attempts are counted atomically across concurrent wrong passwords, with a global budget', async () => {
  const f = fixture()
  const results = await Promise.all(Array.from({ length: LOGIN_LIMIT + 2 }, (_, i) => f.api({ action: 'login', username: i % 2 ? ' ADMIN ' : 'admin', password: PASSWORD + '-wrong' }, { token: false })))
  assert.equal(results.filter(x => x.error === 'invalid_credentials').length, LOGIN_LIMIT)
  assert.equal(results.filter(x => x.error === 'login_rate_limited').length, 2)
  assert.equal(f.read('WebAdminLoginAttempts', hash('admin')).count, LOGIN_LIMIT)
  f.seed('WebAdminLoginAttempts', 'global', { windowStartMs: NOW, count: 120 })
  assert.equal((await f.api({ action: 'login', username: 'unseen-account', password: PASSWORD })).error, 'login_rate_limited')
})

test('expired/revoked sessions and disabled/password-changed accounts lose access immediately', async () => {
  for (const change of ['expiry', 'disabled', 'password', 'logout']) {
    const f = fixture()
    if (change === 'expiry') f.setNow(NOW + 3600000)
    if (change === 'disabled') f.seed('WebAdminAccounts', 'admin', { ...f.read('WebAdminAccounts', 'admin'), enabled: false })
    if (change === 'password') f.seed('WebAdminAccounts', 'admin', { ...f.read('WebAdminAccounts', 'admin'), passwordVersion: 2 })
    if (change === 'logout') assert.equal((await f.api({ action: 'logout' })).ok, true)
    assert.equal((await f.api({ action: 'session' })).error, 'session_invalid', change)
  }
})

test('image validation rejects MIME mismatch, corrupt base64, oversize data and unsupported formats', () => {
  for (const input of [uploadInput({ contentType: 'image/jpeg' }), uploadInput({ base64: 'not-base64' }), uploadInput({ filename: 'x.svg', contentType: 'image/svg+xml' }), uploadInput({ base64: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') })]) assert.throws(() => imageInput(input), /invalid_image/)
  assert.equal(imageInput(uploadInput()).bytes.length, png().length)
})

test('uploads are registered, repeated uploads reuse the same path and QR never enters MarketFiles', async () => {
  const f = fixture()
  const first = await f.api(uploadInput()), second = await f.api(uploadInput())
  assert.equal(first.ok, true); assert.equal(first.fileID, second.fileID); assert.equal(second.deduped, true)
  assert.equal(f.calls.uploads.length, 1); assert.equal(f.rows('MarketFiles')[0].status, 'pending')
  assert.match(first.fileID, /\/web-admin\/admin\/[a-f0-9]{32}\.png$/)
  assert.equal(f.rows('MarketFiles')[0]._openid, undefined)
  const qr = await f.api(uploadInput({ purpose: 'community' }))
  assert.equal(qr.ok, true); assert.notEqual(qr.fileID, first.fileID)
  assert.equal(f.rows('MarketFiles').length, 1)
  assert.equal(f.calls.uploads[1].fileContent.equals(png()), true)
  assert.equal(f.rows('WebAdminAuditLogs').filter(x => x.action === 'uploadImage').length, 2)
})

test('upload registration failure retries the reserved object path and commits only one audit', async () => {
  const f = fixture()
  const contentHash = crypto.createHash('sha256').update(png()).digest('hex')
  const requestId = 'request_' + hash(`admin:market:${contentHash}`)
  f.failures.set('set:WebAdminAuditLogs/' + requestId, 1)
  const failed = await f.api(uploadInput())
  assert.equal(failed.error, 'service_unavailable'); assert.equal(f.rows('MarketFiles').length, 0)
  const retried = await f.api(uploadInput())
  assert.equal(retried.ok, true)
  assert.equal(f.calls.uploads.length, 2)
  assert.equal(f.calls.uploads[0].cloudPath, f.calls.uploads[1].cloudPath)
  assert.equal(f.rows('WebAdminAuditLogs').filter(x => x.action === 'uploadImage').length, 1)
})

test('unregistered, cross-environment and other account images cannot be referenced', async () => {
  const f = fixture()
  const uploaded = await f.api(uploadInput())
  const unknown = `cloud://${ENV}.bucket-123/market/unknown.png`
  for (const fileID of [unknown, uploaded.fileID.replace(ENV, 'cloud1-other'), uploaded.fileID]) {
    if (fileID === uploaded.fileID) f.seed('WebAdminUploads', 'file_' + hash(fileID), { ...f.read('WebAdminUploads', 'file_' + hash(fileID)), accountId: 'another' })
    const result = await f.api({ action: 'getImageURLs', fileIDs: [fileID] })
    assert.equal(result.error, 'image_not_allowed')
  }
})

test('bulk publishes with trusted website owner, strict images, bounded rows, and stable retry deduplication', async () => {
  const f = fixture()
  const uploaded = await f.api(uploadInput())
  const input = { action: 'bulkCreate', batchId: 'batch-one', items: [item({ imageFileIDs: [uploaded.fileID], _openid: 'forged-user', ownerKey: 'forged-owner', managedByAdmin: false })] }
  const first = await f.api(input), repeat = await f.api(input)
  assert.equal(first.success, 1, JSON.stringify(first)); assert.equal(repeat.success, 1); assert.equal(repeat.results[0].deduped, true)
  assert.equal(f.rows('market_goods').length, 1)
  const saved = f.rows('market_goods')[0]
  assert.equal(saved.ownerKey, 'web_admin_main'); assert.equal(saved._openid, undefined); assert.equal(saved.managedByOpenid, undefined); assert.equal(saved.managedByAccountId, 'admin')
  assert.equal(f.rows('MarketFiles')[0].status, 'attached')
  assert.equal((await f.api({ ...input, items: [item({ title: 'changed' })] })).error, 'idempotency_conflict')
  const differentBatch = await f.api({ ...input, batchId: 'batch-two', items: [item({ title: 'changed' })] })
  assert.equal(differentBatch.failures[0].error, 'idempotency_conflict')
  assert.equal((await f.api({ action: 'bulkCreate', batchId: 'too-many', items: Array.from({length:51}, item) })).error, 'invalid_items')
})

test('partial bulk failure retries only missing work and never duplicates earlier writes', async () => {
  const f = fixture()
  const secondId = 'web_' + hash('web_admin_main:external_second').slice(0, 48)
  f.failures.set('set:market_goods/' + secondId, 1)
  const input = { action: 'bulkCreate', batchId: 'retry-batch', items: [item({ externalId: 'first' }), item({ externalId: 'second' })] }
  const first = await f.api(input)
  assert.equal(first.success, 1); assert.equal(first.failed, 1); assert.equal(first.failures[0].error, 'item_save_failed')
  const next = await f.api(input)
  assert.equal(next.success, 2); assert.equal(next.results[0].deduped, true); assert.equal(f.rows('market_goods').length, 2)
  assert.equal(f.rows('WebAdminAuditLogs').filter(x => x.action === 'createItem').length, 2)
  const invalid = await f.api({ action: 'bulkCreate', batchId: 'invalid-row', items: [item({ externalId: 'third' }), item({ externalId: 'fourth', price: -1 })] })
  assert.equal(invalid.success, 1); assert.equal(invalid.failures[0].error, 'invalid_price')
})

test('simultaneous duplicate batches commit one product and one create audit', async () => {
  const f = fixture(), input = { action: 'bulkCreate', batchId: 'same-time', items: [item()] }
  const results = await Promise.all([f.api(input), f.api(input)])
  assert.ok(results.every(x => x.success === 1), JSON.stringify(results)); assert.equal(f.rows('market_goods').length, 1)
  assert.equal(f.rows('WebAdminAuditLogs').filter(x => x.action === 'createItem').length, 1)
})

test('editing changes existing item without changing identity, status, creation or idempotency metadata', async () => {
  const f = fixture()
  const created = await f.api({ action: 'bulkCreate', batchId: 'editing', items: [item()] })
  const id = created.results[0].id, before = f.read('market_goods', id)
  const updated = await f.api({ action: 'updateItem', id, expectedVersion: 0, patch: { title: '新的标题', price: 25, _openid: 'attacker', ownerKey: 'attacker', managedByAdmin: false, status: 'deleted', createTime: 0, webAdminRequestHash: 'attacker' } })
  assert.equal(updated.ok, true, JSON.stringify(updated)); assert.equal(updated.item.title, '新的标题'); assert.equal(f.rows('market_goods').length, 1)
  const after = f.read('market_goods', id)
  for (const key of ['ownerKey', 'status', 'createTime', 'webAdminRequestHash', 'managedByAccountId']) assert.deepEqual(after[key], before[key], key)
  f.seed('market_goods', 'ordinary', { ...before, managedByAdmin: false, _openid: 'ordinary' })
  assert.equal((await f.api({ action: 'updateItem', id: 'ordinary', expectedVersion: 0, patch: { title: 'bad' } })).error, 'item_not_found')
  assert.equal((await f.api({ action: 'getItem', id: 'ordinary' })).error, 'item_not_found')
})

test('legacy managed goods remain editable across repeated image bookkeeping updates', async () => {
  const f = fixture(), fileID = `cloud://${ENV}.bucket-123/market/legacy.png`
  const legacy = { ...item(), _openid: 'legacy-admin', managedByAdmin: true, status: 'online', imageFileID: fileID, imageFileIDs: [fileID], thumbFileIDs: [], createTime: new Date(NOW), pickupStartDate: new Date(NOW).toISOString().slice(0, 10), pickupEndDate: new Date(NOW + 86400000).toISOString().slice(0, 10) }
  f.seed('market_goods', 'legacy', legacy)
  f.seed('MarketFiles', crypto.createHash('sha1').update(fileID).digest('hex'), { fileID, _openid: 'legacy-admin', goodsId: 'legacy', status: 'attached' })
  for (const [expectedVersion, title] of ['first edit', 'second edit'].entries()) {
    const result = await f.api({ action: 'updateItem', id: 'legacy', expectedVersion, patch: { title, imageFileIDs: [fileID] } })
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  assert.equal(f.read('market_goods', 'legacy')._openid, 'legacy-admin')
  assert.equal((await f.api({ action: 'getImageURLs', fileIDs: [fileID] })).ok, true)
})

test('editing retries are idempotent and cannot overwrite a newer successful edit', async () => {
  const f = fixture(), create = await f.api({ action: 'bulkCreate', batchId: 'cas-edit', items: [item()] })
  const id = create.results[0].id
  const first = { action: 'updateItem', id, expectedVersion: 0, patch: { title: 'first edit' } }
  assert.equal((await f.api(first)).item.version, 1)
  assert.equal((await f.api(first)).item.version, 1)
  assert.equal(f.rows('WebAdminAuditLogs').filter(x => x.action === 'updateItem').length, 1)
  assert.equal((await f.api({ action: 'updateItem', id, expectedVersion: 1, patch: { title: 'second edit' } })).item.version, 2)
  assert.equal((await f.api(first)).error, 'version_conflict')
  assert.equal(f.read('market_goods', id).title, 'second edit')
})

test('legacy image compatibility cannot cross an explicit website owner boundary', async () => {
  const f = fixture(), fileID = `cloud://${ENV}.bucket-123/market/other-owner.png`
  f.seed('market_goods', 'other-owner', { ...item(), _openid: 'legacy', ownerKey: 'other_owner', managedByAdmin: true, imageFileIDs: [fileID] })
  f.seed('MarketFiles', crypto.createHash('sha1').update(fileID).digest('hex'), { fileID, _openid: 'legacy', goodsId: 'other-owner', status: 'attached' })
  assert.equal((await f.api({ action: 'getImageURLs', fileIDs: [fileID] })).error, 'image_not_allowed')
})

test('community version update is atomic, retries do not bump version, and history preserves old QR metadata', async () => {
  const f = fixture()
  const oldFile = `cloud://${ENV}.bucket-123/community/original.png`
  const old = { group: { enabled: true, title: 'Old', imageFileID: oldFile, expiresAt: NOW + 86400000 }, announcement: { enabled: false, id: 'notice', body: 'old', showGroupImage: true }, hiddenSecret: 'not-visible' }
  f.seed('community_config', 'main', old)
  const image = await f.api(uploadInput({ purpose: 'community' }))
  const config = { group: { ...old.group, title: 'New', imageFileID: image.fileID }, announcement: { ...old.announcement, maxShows: 2, intervalHours: 0 }, injectedSecret: 'ignored' }
  const input = { action: 'updateCommunity', config, expectedVersion: 0 }
  const first = await f.api(input), repeat = await f.api(input)
  assert.equal(first.version, 1, JSON.stringify(first)); assert.equal(repeat.version, 1); assert.equal(f.rows('CommunityConfigHistory').length, 1)
  assert.equal(f.rows('CommunityConfigHistory')[0].before.group.imageFileID, oldFile)
  assert.equal(f.read('community_config', 'main').injectedSecret, undefined)
  assert.equal((await f.api({ ...input, config: { ...config, group: { ...config.group, title: 'conflicting' } } })).error, 'version_conflict')
  const rollback = await f.api({ action: 'updateCommunity', config: old, expectedVersion: 1 })
  assert.equal(rollback.ok, true); assert.equal(rollback.config.group.imageFileID, oldFile)
  const fetched = await f.api({ action: 'getCommunity' })
  assert.ok(!JSON.stringify(fetched).includes('hiddenSecret')); assert.equal(fetched.version, 2)
})

test('community configuration remains unchanged when its history/audit transaction fails', async () => {
  const f = fixture()
  const config = { group: { enabled: false, title: 'draft' }, announcement: { enabled: false, id: 'draft', body: 'draft' } }
  f.failures.set('set:CommunityConfigHistory/v_1', 1)
  const result = await f.api({ action: 'updateCommunity', config, expectedVersion: 0 })
  assert.equal(result.error, 'service_unavailable'); assert.equal(f.read('community_config', 'main'), undefined)
  assert.equal(f.rows('WebAdminAuditLogs').length, 0)
  assert.ok(!JSON.stringify(result).includes('private_database_trace'))
})

test('community rejects invalid date and frequency values, and concurrent version updates have one winner', async () => {
  const f = fixture()
  const config = { group: { enabled: false }, announcement: { enabled: false, id: 'notice', body: 'draft' } }
  for (const changed of [{ ...config, group: { expiresAt: '2027-02-30T00:00:00Z' } }, { ...config, announcement: { ...config.announcement, maxShows: 101 } }, { ...config, announcement: { ...config.announcement, intervalHours: -1 } }]) assert.equal((await f.api({ action: 'updateCommunity', expectedVersion: 0, config: changed })).error, 'invalid_community_config')
  const results = await Promise.all(['one', 'two'].map(body => f.api({ action: 'updateCommunity', expectedVersion: 0, config: { ...config, announcement: { ...config.announcement, body } } })))
  assert.equal(results.filter(x => x.ok).length, 1)
  assert.equal(results.filter(x => x.error === 'version_conflict').length, 1)
  assert.equal(f.rows('CommunityConfigHistory').length, 1)
})

test('bootstrap and migrated templates expose only explicitly allowed fields', async () => {
  const f = fixture()
  f.seed('MarketAdminTemplates', 'tpl_legacy', { name: '旧模板', status: 'active', _openid: 'legacy-admin', secret: 'private', data: item({ secret: 'private-data' }) })
  const result = await f.api({ action: 'bootstrap' })
  assert.equal(result.ok, true); assert.equal(result.regionTree[0].key, 'NJ'); assert.equal(result.templates[0].id, 'tpl_legacy')
  assert.ok(!JSON.stringify(result).includes('legacy-admin')); assert.ok(!JSON.stringify(result).includes('private-data'))
  const saved = await f.api({ action: 'saveTemplate', template: { id: 'tpl_legacy', name: '更新', data: item() } })
  assert.equal(saved.ok, true, JSON.stringify(saved)); assert.equal(f.read('MarketAdminTemplates', 'tpl_legacy')._openid, 'legacy-admin')
  assert.equal((await f.api({ action: 'deleteTemplate', id: 'tpl_legacy' })).ok, true)
  assert.equal((await f.api({ action: 'listTemplates' })).templates.length, 0)
})

module.exports = { fixture, item, uploadInput, ENV, ORIGIN, NOW, TOKEN }
