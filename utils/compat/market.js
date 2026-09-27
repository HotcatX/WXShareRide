// Temporary CloudBase boundary. Delete the legacy branches after the released
// server client and imported market records are verified. HTTP failures never
// read or write the old database. Legacy field names below belong only to the
// existing page view models; canonical requests contain no CloudBase aliases.
const backend = require('../backendClient')
const profile = require('./profile')
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
const fail = (code, message) => Object.assign(new Error(message), { code })
const identity = () => backend.isBackendEnabled() ? profile.identity() : 'cloudbase'
const current = (page, owner) => {
  try { return !page._marketUnloaded && owner === identity() }
  catch (_) { return false } // authority is being rechecked; discard stale UI work
}
const loggedIn = () => !!wx.getStorageSync('openid') && !wx.getStorageSync('isGuest')
function query(values) {
  return Object.entries(values).filter(([, value]) => value !== undefined && value !== '' && value !== '全部' && value !== 'ALL')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')
}
function listQuery(input) {
  const f = input.filters || {}, sort = input.sort || {}
  return query({ listingType: input.listingType || f.listingType || 'goods', category: f.category,
    regionState: f.regionState, regionCounty: f.regionCounty, regionArea: f.regionArea, keyword: f.keyword,
    offset: input.skip || 0, limit: Math.min(50, Number(input.limit) || 20), status: input.status,
    sort: sort.by === 'distance' ? 'distance' : 'created',
    latitude: sort.by === 'distance' ? sort.origin?.lat : undefined,
    longitude: sort.by === 'distance' ? sort.origin?.lng : undefined })
}
function money(value, optional = false) {
  if (optional && (value === '' || value === undefined || value === null)) return null
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value === '' || value === undefined ? '0' : value))
  if (!match) throw fail('INVALID_PRICE', '金额最多保留两位小数')
  const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'))
  if (!Number.isSafeInteger(cents) || cents > 10000000000) throw fail('INVALID_PRICE', '金额超出范围')
  return cents
}
function content(input = {}) {
  const originals = input.imageFileIDs || [], thumbs = input.thumbFileIDs || []
  const images = originals.map((fileId, index) => ({ fileId, ...(thumbs[index] ? { thumbFileId: thumbs[index] } : {}) }))
  if (images.some(image => !uuid(image.fileId) || image.thumbFileId && !uuid(image.thumbFileId))) throw fail('INVALID_IMAGE', '图片尚未上传完成')
  const location = input.location || {}, latitude = location.lat ?? location.latitude, longitude = location.lng ?? location.longitude
  const located = typeof latitude === 'number' && typeof longitude === 'number'
  const sublet = input.listingType === 'sublet'
  return { listingType: sublet ? 'sublet' : 'goods', title: input.title, description: input.desc || '',
    priceCents: money(input.price), category: input.category, condition: input.condition || '',
    region: { state: input.regionState, county: input.regionCounty, area: input.regionArea },
    buildingName: input.buildingName || input.Apartment || '',
    location: Object.keys(location).length ? { displayName: location.displayName || location.name || '', address: location.address || '',
      latitude: located ? latitude : null, longitude: located ? longitude : null } : null,
    startDate: input.pickupStartDate, endDate: input.pickupEndDate,
    // A normal user's current contact comes from the authenticated seller
    // projection. Editing must preserve an existing explicit contact snapshot.
    sellerContact: input.sellerContact || null,
    sublet: sublet ? { housingType: input.housingType || '', depositCents: money(input.deposit, true),
      furnished: input.furnished === true, utilitiesIncluded: input.utilitiesIncluded === true,
      genderPreference: input.genderPreference || '', roommateCount: input.roommateCount === '' || input.roommateCount == null ? null : Number(input.roommateCount) } : null,
    images }
}
function sellerProfile(seller = {}) {
  return { userId: seller.userId || null, name: seller.name || '', nameDisplay: seller.name || '',
    avatarFileId: seller.avatarFileId || null, avatarRaw: seller.avatarUrl || '', avatarDisplay: seller.avatarUrl || '',
    region: seller.regionLabel || '', regionDisplay: seller.regionLabel || '', apartment: seller.residence || '',
    apartmentDisplay: seller.residence || '', bio: seller.bio || '', wechatID: seller.wechatId || '', phone: seller.phone || '' }
}
function item(value) {
  if (!value || typeof value.id !== 'string' || !Array.isArray(value.images)) throw fail('INVALID_RESPONSE', '商品信息暂不可用')
  const s = value.seller, images = value.images, location = value.location, sublet = value.sublet || {}
  return { _id: value.id, id: value.id, listingType: value.listingType, title: value.title, desc: value.description,
    price: value.priceCents / 100, category: value.category, condition: value.condition,
    regionState: value.region?.state || '', regionCounty: value.region?.county || '', regionArea: value.region?.area || '',
    region: [value.region?.state, value.region?.county, value.region?.area].filter(Boolean).join(' / '),
    buildingName: value.buildingName || '', Apartment: value.buildingName || '',
    location: location ? { displayName: location.displayName, address: location.address, lat: location.latitude, lng: location.longitude } : {},
    pickupStartDate: value.startDate, pickupEndDate: value.endDate, availableStartDate: value.startDate, leaseEndDate: value.endDate,
    expiresAtText: value.endDate, expireTime: Date.parse(value.expiresAt), createTime: value.createdAt, updateTime: value.updatedAt,
    status: value.status, version: value.version, isOwner: value.isOwner === true, viewCount: value.viewCount,
    sellerId: s?.userId || '', seller: s ? sellerProfile(s) : null, sellerContact: value.sellerContact || null,
    managedByAdmin: s?.kind === 'managed' || s?.managed === true,
    sellerName: s?.name || '', sellerWechat: s?.wechatId || '', sellerPhone: s?.phone || '', sellerAvatarFileId: s?.avatarFileId || null,
    sellerAvatar: s?.avatarUrl || '', sellerNote: s?.bio || '',
    roomType: value.category, housingType: sublet.housingType || '', deposit: sublet.depositCents == null ? '' : sublet.depositCents / 100,
    furnished: sublet.furnished === true, utilitiesIncluded: sublet.utilitiesIncluded === true,
    genderPreference: sublet.genderPreference || '', roommateCount: sublet.roommateCount ?? '',
    imageFileIDs: images.map(image => image.fileId), thumbFileIDs: images.map(image => image.thumbFileId || ''),
    imageFileID: images[0]?.fileId || '', thumbFileID: images[0]?.thumbFileId || '', hasImage: images.length > 0 }
}
async function imageURLs(ids, options = {}) {
  const unique = [...new Set(ids.filter(Boolean))]
  if (!unique.length) return {}
  if (!backend.isBackendEnabled()) {
    const result = await wx.cloud.getTempFileURL({ fileList: unique })
    return Object.fromEntries((result.fileList || []).filter(file => file.tempFileURL).map(file => [file.fileID, file.tempFileURL]))
  }
  const map = {}
  for (let i = 0; i < unique.length; i += 50) {
    const entries = await backend.resolveImages(unique.slice(i, i + 50), { public: true, ...options })
    entries.forEach(entry => { map[entry.fileId] = entry.url })
  }
  return map
}
async function hydrate(rows) {
  const ids = rows.flatMap(row => [...row.imageFileIDs, ...row.thumbFileIDs, row.sellerAvatarFileId].filter(Boolean))
  // A removed/expired attachment must not turn a successful listing read into
  // an empty market. Keep its stable ID and show the existing placeholder.
  let urls = {}
  try { urls = await imageURLs(ids) } catch (_) {}
  return rows.map(row => ({ ...row, imageUrls: row.imageFileIDs.map(id => urls[id] || (row.listingType === 'sublet' ? '/images/sublease.png' : '/images/market.png')),
    imageUrl: urls[row.imageFileID] || '', thumbUrl: urls[row.thumbFileID || row.imageFileID] || '',
    imageSrc: urls[row.thumbFileID || row.imageFileID] || (row.listingType === 'sublet' ? '/images/sublease.png' : '/images/market.png'), sellerAvatar: urls[row.sellerAvatarFileId] || row.sellerAvatar,
    seller: row.seller ? { ...row.seller, avatarDisplay: urls[row.sellerAvatarFileId] || row.seller.avatarDisplay } : null }))
}
async function call({ name = 'marketApi', data = {}, ...callbacks } = {}) {
  const owner = identity()
  if (name === 'getUserInfo') {
    const promise = profile.getUserInfo().then(async response => {
      const user = response?.result?.data?.[0]
      if (backend.isBackendEnabled() && user?.avatarFileId) {
        try { user.avatarUrl = (await imageURLs([user.avatarFileId]))[user.avatarFileId] || '' } catch (_) {}
      }
      if (owner !== identity()) throw fail('REQUEST_CANCELLED', '当前操作已取消')
      return response
    })
    if (callbacks.success || callbacks.fail) promise.then(callbacks.success, callbacks.fail)
    return promise
  }
  if (!backend.isBackendEnabled()) return wx.cloud.callFunction({ name, data, ...callbacks })
  const action = data.action, id = encodeURIComponent(data.id || ''), path = '/api/v1/market/listings'
  let result
  if (['list', 'myList', 'sellerList'].includes(action)) {
    const prefix = action === 'myList' ? '/api/v1/me/market/listings' : action === 'sellerList'
      ? `/api/v1/market/sellers/${encodeURIComponent(data.sellerId || data.openid || '')}/listings` : path
    const response = await backend.get(`${prefix}?${listQuery(data)}`, { public: action !== 'myList' })
    const rows = await hydrate(response.items.map(item))
    result = { items: rows, hasMore: response.hasMore, nextSkip: response.nextOffset }
  } else if (action === 'detail') {
    const response = await backend.get(`${path}/${id}`, { public: true })
    const value = (await hydrate([item(response)]))[0]
    result = { item: value, isOwner: value.isOwner, imgUrls: value.imageUrls.filter(Boolean), imgUrl: value.imageUrl }
    // Counting a view is independent of reading, never an implicit mutation in
    // GET. An uncertain observation retains its operation key in the SDK.
    if (data.trackView && loggedIn()) backend.mutate(`market.view:${data.id}`, 'POST', `${path}/${id}/views`, {}).catch(() => {})
  } else if (action === 'create' || action === 'update') {
    const scope = action === 'create' ? 'market.create' : `market.update:${data.id}`
    const validate = value => !!value && typeof value.id === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value.id) &&
      Number.isSafeInteger(value.version) && value.version >= 0 && ['online', 'offline', 'sold'].includes(value.status) &&
      (action === 'create' || value.id === data.id)
    const pending = await backend.retryPending(scope, { validate })
    result = pending || await backend.mutate(scope, action === 'create' ? 'POST' : 'PATCH', action === 'create' ? path : `${path}/${id}`,
      action === 'create' ? content(data.payload) : { expectedVersion: data.expectedVersion, patch: content(data.patch) }, { validate })
    if (pending) result = { ...result, recovered: true }
  } else if (action === 'delete' || action === 'status') {
    const validate = value => !!value && value.id === data.id && Number.isSafeInteger(value.version) && value.version >= 0 &&
      (action === 'delete' ? value.status === 'deleted' : value.status === data.status)
    result = await backend.retryPending(`market.${action}:${data.id}`, { validate }) || await backend.mutate(`market.${action}:${data.id}`, action === 'delete' ? 'DELETE' : 'POST', `${path}/${id}${action === 'status' ? '/status' : ''}`,
      { expectedVersion: data.expectedVersion, ...(action === 'status' ? { status: data.status } : {}) }, { validate })
  } else if (action === 'listAds') {
    const response = await backend.get(`/api/v1/ads?${query({ placement: data.placement || 'market_feed', limit: data.limit || 20 })}`, { public: true })
    let urls = {}; try { urls = await imageURLs(response.items.flatMap(ad => [ad.imageFileId, ad.thumbFileId])) } catch (_) {}
    result = { ads: response.items.map(ad => ({ ...ad, _id: ad.id, imageFileID: ad.imageFileId, thumbFileID: ad.thumbFileId,
      imageSrc: urls[ad.thumbFileId || ad.imageFileId] || '', targetType: ad.target.kind,
      contactSessionFrom: ad.target.sessionFrom, contactShowMessageCard: ad.target.messageCard.enabled,
      contactMessageTitle: ad.target.messageCard.title, contactMessagePath: ad.target.messageCard.path })) }
  } else if (action === 'trackAdClick') {
    result = loggedIn() ? await backend.mutate(`ads.click:${data.adId}`, 'POST', `/api/v1/ads/${encodeURIComponent(data.adId)}/clicks`,
      { placement: data.placement || 'market_feed', listingType: data.listingType || 'goods' }) : { recorded: false }
  } else if (action === 'tradeList') {
    if (data.type === 'bought') throw fail('TRADE_UNAVAILABLE', '当前没有买入记录功能')
    const response = await backend.get(`/api/v1/me/market/listings?${listQuery({ ...data, listingType: 'all', status: 'sold' })}`)
    result = { items: await hydrate(response.items.map(item)), hasMore: response.hasMore, nextSkip: response.nextOffset }
  } else throw fail('UNSUPPORTED_ACTION', '暂不支持此操作')
  if (owner !== identity()) throw fail('REQUEST_CANCELLED', '当前操作已取消')
  return { result: { ok: true, ...result } }
}
async function getSeller(id) {
  const owner = identity()
  const value = await backend.get(`/api/v1/market/sellers/${encodeURIComponent(id)}`)
  const result = sellerProfile(value)
  if (result.avatarFileId) {
    try { result.avatarDisplay = (await imageURLs([result.avatarFileId]))[result.avatarFileId] || '' } catch (_) {}
  }
  if (owner !== identity()) throw fail('REQUEST_CANCELLED', '当前操作已取消')
  return result
}
async function refreshImages(page, options = {}) {
  if (!backend.isBackendEnabled() || page.data.imageUploading) return
  const owner = identity(), rows = [], fields = ['allGoods', 'filteredGoods', 'displayGoods', 'displayFeed', 'goods', 'list']
  fields.forEach(key => { if (Array.isArray(page.data[key])) rows.push(...page.data[key]) })
  if (page.data.item) rows.push(page.data.item)
  if (page.data.seller) rows.push(page.data.seller)
  rows.push(page.data)
  const ids = row => [row.imageFileID, row.thumbFileID, row.sellerAvatarFileId, row.avatarFileId,
    ...(row.imageFileIDs || []), ...(row.thumbFileIDs || [])].filter(uuid)
  const urls = await imageURLs(rows.flatMap(ids), options)
  if (!current(page, owner) || page.data.imageUploading) return
  const update = row => {
    const main = urls[row.imageFileID], thumbnail = urls[row.thumbFileID || row.imageFileID]
    const avatar = urls[row.sellerAvatarFileId || row.avatarFileId]
    return { ...row, ...(main ? { imageUrl: main, fallbackImageSrc: main } : {}),
      ...(thumbnail ? { thumbUrl: thumbnail, imageSrc: thumbnail } : {}),
      ...(avatar ? { sellerAvatar: avatar, avatarDisplay: avatar } : {}) }
  }
  const patch = {}
  fields.forEach(key => { if (Array.isArray(page.data[key])) patch[key] = page.data[key].map(update) })
  if (page.data.item) {
    patch.item = update(page.data.item)
    patch.imgUrls = (page.data.item.imageFileIDs || []).map((id, index) => urls[id] || page.data.imgUrls?.[index] || '').filter(Boolean)
    patch.imgUrl = patch.imgUrls[0] || ''
  }
  if (page.data.seller) patch.seller = update(page.data.seller)
  if (Array.isArray(page.data.imageFileIDs)) {
    patch.images = page.data.imageFileIDs.map((id, index) => urls[id] || page.data.images?.[index] || '/images/market.png')
    patch.image = patch.images[0] || ''
  }
  page.setData(patch)
}
// Scope page writes to one lifetime/account and refresh expiring presentation
// links while visible. The backend's own identity guards also reject late I/O.
function page(definition) {
  // Module registration precedes the handshake. Always install these wrappers;
  // only lifecycle calls inspect the runtime's fixed authority.
  const originalLoad = definition.onLoad, originalShow = definition.onShow
  const originalHide = definition.onHide, originalUnload = definition.onUnload
  const initial = JSON.parse(JSON.stringify(definition.data || {}))
  function stop(target) { if (target._marketImageTimer) clearTimeout(target._marketImageTimer); target._marketImageTimer = null }
  function schedule(target) {
    stop(target)
    if (!backend.isBackendEnabled() || target._marketUnloaded) return
    target._marketImageTimer = setTimeout(() => {
      if (current(target, target._marketOwner) && target.refreshMarketImages) Promise.resolve(target.refreshMarketImages()).catch(() => {})
      schedule(target)
    }, 240000)
  }
  definition.onLoad = function(options) {
    this._marketUnloaded = false; this._marketOwner = identity(); this._marketOptions = options
    if (!this._marketSetData) {
      this._marketSetData = this.setData
      this.setData = (patch, callback) => {
        if (current(this, this._marketOwner)) this._marketSetData.call(this, patch, callback)
      }
    }
    return originalLoad?.call(this, options)
  }
  definition.onShow = function() {
    if (backend.isBackendEnabled() && this._marketOwner !== identity()) {
      this._marketOwner = identity()
      this._marketSetData?.call(this, JSON.parse(JSON.stringify(initial)))
      originalLoad?.call(this, this._marketOptions)
    }
    schedule(this)
    refreshImages(this).catch(() => {})
    return originalShow?.call(this)
  }
  definition.onHide = function() { stop(this); return originalHide?.call(this) }
  definition.onUnload = function() { this._marketUnloaded = true; stop(this); return originalUnload?.call(this) }
  definition.onMarketImageError = function() {
    if (this._marketUnloaded || this._marketImageRetry || Date.now() - (this._marketImageErrorAt || 0) < 30000) return
    this._marketImageErrorAt = Date.now()
    this._marketImageRetry = refreshImages(this, { refresh: true }).catch(() => {}).finally(() => { this._marketImageRetry = null })
  }
  definition.refreshMarketImages = definition.refreshMarketImages || function() { return refreshImages(this) }
  return definition
}
async function upload(localPath, folder, onProgress) {
  if (backend.isBackendEnabled()) {
    if (onProgress) onProgress(1)
    const result = await backend.uploadImage(localPath, folder === 'market_thumb' ? 'market.thumbnail' : 'market.image')
    if (onProgress) onProgress(100)
    return result.fileId
  }
  const match = String(localPath).match(/\.([a-z0-9]+)(?:\?|$)/i)
  const ext = match ? match[1] : 'jpg'
  return new Promise((resolve, reject) => {
    const task = wx.cloud.uploadFile({ cloudPath: `${folder}/${Date.now()}_${Math.random().toString(16).slice(2)}.${ext}`,
      filePath: localPath, success: value => resolve(value.fileID || ''), fail: reject })
    if (task?.onProgressUpdate && onProgress) task.onProgressUpdate(value => onProgress(value.progress))
  })
}
const UPLOADS_KEY = 'linkx.market.uploads.v1'
function pendingUploads() {
  if (!backend.isBackendEnabled()) return []
  const entries = wx.getStorageSync(UPLOADS_KEY) || []
  if (!Array.isArray(entries) || entries.length > 12 || entries.some(entry => !entry || typeof entry.owner !== 'string' ||
    typeof entry.localPath !== 'string' || typeof entry.mainPath !== 'string' || typeof entry.thumbPath !== 'string')) {
    throw fail('LOCAL_STORAGE_UNAVAILABLE', '待上传图片记录异常，请稍后重试')
  }
  return entries.filter(entry => entry.owner === identity())
}
function saveUpload(entry, remove = false) {
  const all = wx.getStorageSync(UPLOADS_KEY) || []
  if (!Array.isArray(all)) throw fail('LOCAL_STORAGE_UNAVAILABLE', '待上传图片记录异常')
  const next = all.filter(value => value.owner !== entry.owner || value.localPath !== entry.localPath)
  if (!remove) next.push(entry)
  wx.setStorageSync(UPLOADS_KEY, next)
}
async function prepareUpload(localPath, mainPath, thumbPath) {
  if (!backend.isBackendEnabled()) return { localPath, mainPath, thumbPath }
  const owner = identity(), previous = pendingUploads().find(entry => entry.localPath === localPath)
  if (previous) return previous
  if (pendingUploads().length >= 6 || (wx.getStorageSync(UPLOADS_KEY) || []).length >= 12) throw fail('PENDING_OPERATION', '请先重试未完成的图片上传')
  for (const filePath of [...new Set([mainPath, thumbPath].filter(Boolean))]) {
    const bytes = await new Promise((resolve, reject) => wx.getFileSystemManager().readFile({ filePath,
      success: result => resolve(result.data), fail: () => reject(fail('IMAGE_READ_FAILED', '图片读取失败，请重试')) }))
    const info = await new Promise((resolve, reject) => wx.getImageInfo({ src: filePath, success: resolve,
      fail: () => reject(fail('INVALID_IMAGE', '请选择有效的 JPEG、PNG 或 WebP 图片')) }))
    if (!bytes?.byteLength || bytes.byteLength > 2 * 1024 * 1024 || !['jpg', 'jpeg', 'png', 'webp'].includes(info.type) ||
      !Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width <= 0 || info.height <= 0 || info.width * info.height > 12000000) {
      throw fail('INVALID_IMAGE', '请选择不超过 2MB、1200 万像素的 JPEG、PNG 或 WebP 图片')
    }
  }
  const preserve = path => !path ? Promise.resolve('') : new Promise((resolve, reject) => wx.saveFile({ tempFilePath: path,
    success: result => resolve(result.savedFilePath), fail: () => reject(fail('IMAGE_SAVE_FAILED', '图片暂存失败，请重试')) }))
  // Preserve the exact compressed bytes before HTTP. Retries after timeout or
  // restart read these files rather than recompressing into a different key.
  const savedMain = await preserve(mainPath)
  let savedThumb
  try { savedThumb = thumbPath === mainPath ? savedMain : await preserve(thumbPath) }
  catch (error) { if (wx.removeSavedFile) wx.removeSavedFile({ filePath: savedMain, fail() {} }); throw error }
  if (owner !== identity()) throw fail('REQUEST_CANCELLED', '当前操作已取消')
  const entry = { owner, localPath, mainPath: savedMain, thumbPath: savedThumb }
  saveUpload(entry)
  return entry
}
async function uploadPrepared(entry, mainProgress, thumbProgress) {
  const active = () => !backend.isBackendEnabled() || entry.owner === identity()
  if (!active()) throw fail('REQUEST_CANCELLED', '当前操作已取消')
  const send = async (property, path, folder, progress) => {
    if (entry[property]) return entry[property]
    if (!path) return ''
    const value = await upload(path, folder, progress)
    if (!active()) throw fail('REQUEST_CANCELLED', '当前操作已取消')
    entry[property] = value
    if (backend.isBackendEnabled()) saveUpload(entry)
    return value
  }
  // Wait for both uploads to settle, including partial failure: a successful
  // sibling records its ID before the user is allowed to retry.
  const results = await Promise.allSettled([send('fileID', entry.mainPath, 'market', mainProgress),
    send('thumbFID', entry.thumbPath, 'market_thumb', thumbProgress)])
  const error = results.find(result => result.status === 'rejected')
  if (error) throw error.reason
  let previewPath = entry.localPath
  if (backend.isBackendEnabled()) {
    try { previewPath = (await imageURLs([results[0].value]))[results[0].value] || previewPath } catch (_) {}
    saveUpload(entry, true)
    for (const filePath of [entry.mainPath, entry.thumbPath].filter(Boolean)) {
      if (typeof wx.removeSavedFile === 'function') wx.removeSavedFile({ filePath, fail() {} })
    }
  }
  return { fileID: results[0].value, thumbFID: results[1].value, previewPath }
}
module.exports = { call, item, content, money, hydrate, imageURLs, sellerProfile, getSeller, identity, current, loggedIn, upload, page, refreshImages,
  pendingUploads, prepareUpload, uploadPrepared,
  isBackendEnabled: backend.isBackendEnabled, isFileId: value => backend.isBackendEnabled() ? uuid(value) : typeof value === 'string' && value.startsWith('cloud://') }
