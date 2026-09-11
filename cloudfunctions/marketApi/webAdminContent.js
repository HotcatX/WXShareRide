const crypto = require('crypto')
const { reject, record, hash, read, transaction, writeAudit } = require('./webAdminSecurity')
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const clean = (value, limit = 100) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, limit) : ''
const fileKey = fileID => 'file_' + hash(fileID)
const marketKey = fileID => crypto.createHash('sha1').update(fileID).digest('hex')
function safeFileID(value, env) {
  if (typeof value !== 'string' || value.length > 2048 || !/^[a-z0-9-]+$/i.test(env || '')) return ''
  const match = /^cloud:\/\/([^/]+)\/(.+)$/.exec(value)
  if (!match || !match[1].startsWith(env + '.') || !/^[a-z0-9-]+$/i.test(match[1].slice(env.length + 1))) return ''
  if (/[\s%?#\\\u0000-\u001f]/.test(match[2]) || match[2].split('/').some(x => !x || x === '.' || x === '..')) return ''
  return /\.(png|jpe?g|webp)$/i.test(match[2]) ? value : ''
}
function safeURL(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return ''
    return ['tcb.qcloud.la', 'tcloudbaseapp.com', 'myqcloud.com', 'tencentcos.cn', 'qcloud.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host)) ? url.href : ''
  } catch (_) { return '' }
}
function time(value) {
  if (value === undefined || value === null || value === '' || value === 0) return 0
  const raw = value instanceof Date ? value.getTime() : value && typeof value === 'object' && '$date' in value ? value.$date : value
  if (typeof raw === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(raw)
    if (!match) return NaN
    const [, year, month, day, hour, minute, second] = match
    const days = new Date(Date.UTC(+year, +month, 0)).getUTCDate()
    if (+month < 1 || +month > 12 || +day < 1 || +day > days || +hour > 23 || +minute > 59 || +(second || 0) > 59) return NaN
  }
  const result = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : NaN
  return Number.isSafeInteger(result) && result > 0 && result <= 8640000000000000 ? result : NaN
}
function communityConfig(row = {}, strict = false) {
  const g = record(row.group), a = record(row.announcement)
  const group = { enabled: g.enabled === true, title: clean(g.title, 80) || '加入拼车群', imageFileID: clean(g.imageFileID, 2048), expiresAt: time(g.expiresAt) }
  const announcement = { enabled: a.enabled === true, id: clean(a.id, 128), title: clean(a.title, 80) || '最新消息', body: clean(a.body, 2000), imageFileID: clean(a.imageFileID, 2048), showGroupImage: a.showGroupImage === true, maxShows: a.maxShows === undefined ? 1 : a.maxShows, intervalHours: a.intervalHours === undefined ? 24 : a.intervalHours, startAt: time(a.startAt), endAt: time(a.endAt) }
  const validTimes = [group.expiresAt, announcement.startAt, announcement.endAt].every(Number.isFinite)
  const validFrequency = Number.isInteger(announcement.maxShows) && announcement.maxShows >= 1 && announcement.maxShows <= 100 && typeof announcement.intervalHours === 'number' && Number.isFinite(announcement.intervalHours) && announcement.intervalHours >= 0 && announcement.intervalHours <= 8760
  if (strict && (!validTimes || !validFrequency || (announcement.id && !/^[a-zA-Z0-9_-]{1,128}$/.test(announcement.id)) || (announcement.startAt && announcement.endAt && announcement.startAt >= announcement.endAt))) reject('invalid_community_config')
  if (!Number.isFinite(group.expiresAt)) group.expiresAt = 0
  if (!Number.isFinite(announcement.startAt)) announcement.startAt = 0
  if (!Number.isFinite(announcement.endAt)) announcement.endAt = 0
  if (!validFrequency) { announcement.maxShows = 1; announcement.intervalHours = 24; announcement.enabled = false }
  return { group, announcement }
}
function imageInput(input) {
  const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
  const ext = extensions[input.contentType]
  if (!ext || !['market', 'market_thumb', 'community'].includes(input.purpose)) reject('invalid_image')
  if (typeof input.filename !== 'string' || !/\.(?:jpe?g|png|webp)$/i.test(input.filename) || input.filename.length > 160) reject('invalid_image')
  const base64 = input.base64
  if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !base64.length || base64.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) reject('invalid_image')
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length < 12 || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== base64) reject('invalid_image')
  const png = bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217
  const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))
  if (!(ext === 'jpg' ? jpeg : ext === 'png' ? png : webp)) reject('invalid_image')
  return { bytes, ext, contentHash: crypto.createHash('sha256').update(bytes).digest('hex') }
}

function createContent({ db, cloud, now = Date.now, getEnvId }) {
  const env = () => getEnvId ? getEnvId() : (cloud.getWXContext().ENV || process.env.TCB_ENV || process.env.SCF_NAMESPACE || '')
  async function urls(fileIDs) {
    if (!fileIDs.length) return []
    const result = await cloud.getTempFileURL({ fileList: fileIDs })
    if (!result || !Array.isArray(result.fileList)) throw new Error('Invalid storage response')
    return fileIDs.map(fileID => {
      const rows = result.fileList.filter(x => x.fileID === fileID)
      const row = rows.length === 1 ? rows[0] : null
      const url = row && (row.status === undefined || row.status === 0) ? safeURL(row.tempFileURL) : ''
      if (!url) reject('image_unavailable', 503)
      return { fileID, url }
    })
  }
  async function owned(fileID, account, purpose, currentConfig) {
    if (!safeFileID(fileID, env())) reject('image_not_allowed')
    const ledger = await read(db, 'WebAdminUploads', fileKey(fileID))
    if (ledger && ledger.status === 'ready' && ledger.fileID === fileID && ledger.accountId === account.accountId && ledger.ownerKey === account.ownerKey && (!purpose || ledger.purpose === purpose || (purpose === 'market_thumb' && ledger.purpose === 'market'))) return
    // Previously configured community images remain eligible for editing/rollback;
    // no arbitrary cloud file can be introduced through this compatibility path.
    if ((!purpose || purpose === 'community') && currentConfig && [currentConfig.group.imageFileID, currentConfig.announcement.imageFileID].includes(fileID)) return
    if (!purpose || purpose === 'community') {
      for (const field of ['before.group.imageFileID', 'before.announcement.imageFileID', 'after.group.imageFileID', 'after.announcement.imageFileID']) {
        const history = await db.collection('CommunityConfigHistory').where({ [field]: fileID }).limit(1).get()
        if (history && Array.isArray(history.data) && history.data.length) return
      }
    }
    if (purpose === 'community') reject('image_not_allowed')
    const tracked = await read(db, 'MarketFiles', marketKey(fileID))
    if (!tracked || tracked.fileID !== fileID || tracked.status !== 'attached' || !tracked.goodsId) reject('image_not_allowed')
    const goods = await read(db, 'market_goods', tracked.goodsId)
    const images = goods && [goods.imageFileID, goods.thumbFileID, ...(goods.imageFileIDs || []), ...(goods.thumbFileIDs || [])]
    if (!goods || goods.managedByAdmin !== true || !images.includes(fileID) || !(goods.ownerKey === account.ownerKey || (!goods.ownerKey && goods._openid && (tracked._openid === goods._openid || tracked.ownerKey === account.ownerKey)))) reject('image_not_allowed')
    if (purpose === 'market' && ![goods.imageFileID, ...(goods.imageFileIDs || [])].includes(fileID)) reject('image_not_allowed')
    // A legacy listing without separate thumbnails may reuse its owned main image.
    if (purpose === 'market_thumb' && !images.includes(fileID)) reject('image_not_allowed')
  }
  async function uploadImage(input, account) {
    const parsed = imageInput(input)
    const requestId = 'request_' + hash(`${account.accountId}:${input.purpose}:${parsed.contentHash}`)
    const request = await transaction(db, async tx => {
      const existing = await read(tx, 'WebAdminUploads', requestId)
      if (existing) return existing
      const cloudPath = `web-admin/${account.accountId}/${crypto.randomBytes(16).toString('hex')}.${parsed.ext}`
      const data = { accountId: account.accountId, ownerKey: account.ownerKey, purpose: input.purpose, contentHash: parsed.contentHash, contentType: input.contentType, size: parsed.bytes.length, cloudPath, status: 'uploading', createdAtMs: now() }
      await tx.collection('WebAdminUploads').doc(requestId).set({ data })
      return data
    })
    if (request.ownerKey !== account.ownerKey) reject('image_not_allowed')
    if (request.status === 'ready' && request.fileID) return { ok: true, ...(await urls([request.fileID]))[0], deduped: true }
    // A retry uses the reserved path and identical bytes, including after a
    // successful storage upload whose database registration was interrupted.
    const uploaded = await cloud.uploadFile({ cloudPath: request.cloudPath, fileContent: parsed.bytes })
    const fileID = safeFileID(uploaded && uploaded.fileID, env())
    if (!fileID || fileID.split('/').slice(3).join('/') !== request.cloudPath) throw new Error('Unexpected storage object')
    await transaction(db, async tx => {
      const fresh = await read(tx, 'WebAdminUploads', requestId)
      if (fresh.status === 'ready') return
      const data = { ...request, fileID, status: 'ready', updatedAtMs: now() }
      await tx.collection('WebAdminUploads').doc(requestId).set({ data })
      await tx.collection('WebAdminUploads').doc(fileKey(fileID)).set({ data })
      // Community images deliberately never enter market cleanup bookkeeping.
      if (input.purpose !== 'community') await tx.collection('MarketFiles').doc(marketKey(fileID)).set({ data: { fileID, ownerKey: account.ownerKey, adminAccountId: account.accountId, type: input.purpose === 'market_thumb' ? 'thumb' : 'image', folder: input.purpose, status: 'pending', createdAtMs: now(), updatedAtMs: now() } })
      await writeAudit(tx, account, 'uploadImage', { fileID, purpose: input.purpose, size: parsed.bytes.length, contentHash: parsed.contentHash }, now(), requestId)
    })
    return { ok: true, ...(await urls([fileID]))[0] }
  }
  async function getCommunity() {
    const row = await read(db, 'community_config', 'main')
    return { ok: true, config: communityConfig(row || {}), version: row && Number.isSafeInteger(row.version) ? row.version : 0 }
  }
  async function getImageURLs(input, account) {
    if (!Array.isArray(input.fileIDs) || input.fileIDs.length > 50) reject('invalid_images')
    const fileIDs = [...new Set(input.fileIDs)]
    const current = (await getCommunity()).config
    for (const fileID of fileIDs) await owned(fileID, account, '', current)
    return { ok: true, files: await urls(fileIDs) }
  }
  async function updateCommunity(input, account) {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || !input.config || typeof input.config !== 'object' || Array.isArray(input.config)) reject('invalid_community_config')
    const config = communityConfig(input.config, true)
    const old = await getCommunity()
    for (const fileID of new Set([config.group.imageFileID, config.announcement.imageFileID].filter(Boolean))) await owned(fileID, account, 'community', old.config)
    if (config.group.enabled && (!config.group.imageFileID || config.group.expiresAt <= now())) reject('invalid_community_config')
    const announcement = config.announcement
    if (announcement.enabled && (!announcement.id || !(announcement.body || announcement.imageFileID || (announcement.showGroupImage && config.group.enabled)) || (announcement.showGroupImage && !config.group.enabled) || (announcement.endAt && announcement.endAt <= now()))) reject('invalid_community_config')
    const requestHash = hash(JSON.stringify(config))
    const version = await transaction(db, async tx => {
      const row = await read(tx, 'community_config', 'main')
      const currentVersion = row && Number.isSafeInteger(row.version) ? row.version : 0
      if (currentVersion !== input.expectedVersion) {
        // A transport retry may observe the exact write it already committed.
        if (currentVersion === input.expectedVersion + 1 && row.lastRequestHash === requestHash && row.updatedBy === account.accountId) return currentVersion
        reject('version_conflict', 409)
      }
      const next = currentVersion + 1
      await tx.collection('CommunityConfigHistory').doc(`v_${next}`).set({ data: { version: next, previousVersion: currentVersion, before: communityConfig(row || {}), after: config, updatedBy: account.accountId, updatedAtMs: now() } })
      // Store only editable fields; keep image objects for rollback, never delete.
      await tx.collection('community_config').doc('main').set({ data: { ...config, version: next, updatedBy: account.accountId, updatedAtMs: now(), lastRequestHash: requestHash } })
      await writeAudit(tx, account, 'updateCommunity', { version: next, previousVersion: currentVersion, requestHash }, now())
      return next
    })
    return { ok: true, config, version }
  }
  return { uploadImage, getImageURLs, getCommunity, updateCommunity, owned }
}

module.exports = { createContent, communityConfig, imageInput, safeFileID, safeURL, MAX_IMAGE_BYTES, clean }
