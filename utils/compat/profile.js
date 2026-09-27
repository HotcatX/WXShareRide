// Temporary CloudBase compatibility boundary. Remove the legacy branches after
// the released server client is verified; server failures never write to CloudBase.
const backend = require('../backendClient')
function identity() {
  return JSON.stringify([backend.isBackendEnabled(), wx.getStorageSync('openid') || '', !!wx.getStorageSync('isGuest')])
}
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
function validUser(user, openid) {
  return !!user && uuid(user.id) && user.openid === openid && typeof user.name === 'string' &&
    (user.avatarFileId === null || uuid(user.avatarFileId)) && !!user.profile && typeof user.profile === 'object' && !Array.isArray(user.profile)
}

function fromBackendUser(user = {}) {
  const p = user.profile || {}, vehicle = p.vehicle || {}, zelle = p.zelle || {}
  const region = p.region || {}, location = p.location || {}, preferences = p.preferences || {}
  return {
    _id: user.id, _openid: user.openid, name: user.name || '', avatarFileId: user.avatarFileId || null,
    wechatID: p.wechatId || '', phone: p.phone || '', regionPhone: p.phoneRegion || 'US', bio: p.bio || '',
    carNumber: vehicle.plate || '', carBrand: vehicle.brand || '', carModel: vehicle.model || '',
    zelleName: zelle.name || '', zelleAccount: zelle.account || '', defaultShowZelle: zelle.public === true,
    regionState: region.state || '', regionCounty: region.county || '', regionArea: region.area || '',
    regionKey: region.key || '', regionDisplay: region.label || '', bigregion: region.label || '',
    Apartment: location.residence || '', address: location.residence || '', buildingName: location.residence || '',
    location: { displayName: location.label || '', address: location.address || '',
      ...(typeof location.latitude === 'number' ? { lat: location.latitude } : {}),
      ...(typeof location.longitude === 'number' ? { lng: location.longitude } : {}) },
    pickupSpot: preferences.pickupAddresses || [], dropoffSpot: preferences.dropoffAddresses || [],
    commonComments: preferences.comments || [], customPrice: preferences.routePrices || {},
    profileCompleted: p.profileCompleted === true
  }
}

function toBackendPatch(data = {}) {
  const patch = {}, profile = {}
  if (typeof data.name === 'string' && data.name.trim()) patch.name = data.name.trim()
  if (own(data, 'avatarFileId')) patch.avatarFileId = data.avatarFileId
  for (const [legacy, key] of [['wechatID', 'wechatId'], ['phone', 'phone'], ['regionPhone', 'phoneRegion'], ['bio', 'bio'], ['profileCompleted', 'profileCompleted']]) {
    if (own(data, legacy)) profile[key] = data[legacy]
  }
  const nested = (key, fields) => {
    const value = {}
    for (const [legacy, target] of fields) if (own(data, legacy)) value[target] = data[legacy]
    if (Object.keys(value).length) profile[key] = value
  }
  nested('vehicle', [['carNumber', 'plate'], ['carBrand', 'brand'], ['carModel', 'model']])
  nested('zelle', [['zelleName', 'name'], ['zelleAccount', 'account'], ['defaultShowZelle', 'public']])
  nested('region', [['regionState', 'state'], ['regionCounty', 'county'], ['regionArea', 'area'], ['regionKey', 'key'], ['regionDisplay', 'label']])
  nested('location', [['Apartment', 'residence']])
  if (data.location && typeof data.location === 'object') {
    const source = data.location, location = profile.location || {}
    if (own(source, 'displayName') || own(source, 'name')) location.label = source.displayName || source.name || ''
    if (own(source, 'address')) location.address = source.address
    // Null coordinates mean unknown. Never fabricate 0,0 or erase existing
    // coordinates during a name-only save; choosing another point supplies both.
    for (const [key, alias] of [['latitude', 'lat'], ['longitude', 'lng']]) {
      const value = own(source, alias) ? source[alias] : source[key]
      if (typeof value === 'number' && Number.isFinite(value)) location[key] = value
    }
    if (Object.keys(location).length) profile.location = location
  }
  nested('preferences', [['pickupSpot', 'pickupAddresses'], ['dropoffSpot', 'dropoffAddresses'], ['commonComments', 'comments']])
  if (data.customPrice && own(data.customPrice, 'fortLeeNonCore')) {
    profile.preferences = { ...profile.preferences, routePrices: { fortLeeNonCore: data.customPrice.fortLeeNonCore } }
  }
  if (typeof data.wechatID === 'string' && data.wechatID.trim()) profile.profileCompleted = true
  if (Object.keys(profile).length) patch.profile = profile
  if (!Object.keys(patch).length) throw new Error('没有可保存的资料')
  return patch
}

function legacyDocument(response) {
  const r = response && response.result || {}
  return Array.isArray(r.data) ? r.data[0] || null : r.data || r.userInfo || r.user || null
}
async function login(options) {
  if (!backend.isBackendEnabled()) return backend.cloudLogin(options)
  const session = await backend.login(options)
  return { result: { ok: true, ...session.user } }
}
function logout() {
  return backend.logout()
}
async function getUserInfo({ summary = false } = {}) {
  if (!backend.isBackendEnabled()) return wx.cloud.callFunction({ name: 'getUserInfo', data: {} })
  const user = fromBackendUser(await backend.get('/api/v1/me'))
  if (summary) {
    const [statistics, blockedUsers] = await Promise.all([
      backend.get('/api/v1/me/statistics'), getBlockedIds()
    ])
    const all = statistics.all, driver = statistics.driver, passenger = statistics.passenger
    user.rideStats = {
      completedTrips: all.completedTrips, completedDriverTrips: driver.completedTrips, completedPassengerTrips: passenger.completedTrips,
      ratingCount: all.ratingCount, ratingAvg: all.averageRating, ratingWeightedAvg: all.weightedRating,
      driverRatingCount: driver.ratingCount, driverRatingAvg: driver.averageRating, driverRatingWeightedAvg: driver.weightedRating,
      passengerRatingCount: passenger.ratingCount, passengerRatingAvg: passenger.averageRating, passengerRatingWeightedAvg: passenger.weightedRating
    }
    user.blockedUsers = blockedUsers
  }
  return { result: { data: [user] } }
}
async function getBlockedIds() {
  const ids = [], seen = new Set()
  let page = 1
  while (page && !seen.has(page)) {
    seen.add(page)
    const data = await backend.get(`/api/v1/blocks?page=${page}&limit=100`)
    ids.push(...data.blocks.map(item => item.targetUserId))
    page = data.nextPage
  }
  return ids
}
async function getUnreadCount(openid) {
  if (backend.isBackendEnabled()) return (await backend.get('/api/v1/notifications/unread')).unreadCount
  const result = await backend.cloudRead('notifications.unread')
  if (!result || !Number.isSafeInteger(result.unreadCount) || result.unreadCount < 0) throw new Error('未读数量暂不可用')
  return result.unreadCount
}
async function updateSpot(field, value, remove = false) {
  if (!['pickupSpot', 'dropoffSpot'].includes(field) || typeof value !== 'string' || !value.trim()) throw new Error('地点无效')
  const owner = identity()
  if (backend.isBackendEnabled()) {
    const info = legacyDocument(await getUserInfo())
    if (owner !== identity()) throw new Error('当前操作已取消')
    const values = remove ? (info?.[field] || []).filter(item => item !== value) : [...new Set([...(info?.[field] || []), value])]
    await updateUser({ [field]: values }); return { field, values }
  }
  const scope = `profile.spots:${field}`, options = { validate: row => row && row.field === field && Array.isArray(row.values) && row.values.every(item => typeof item === 'string') }
  try { return await backend.cloudMutate(scope, remove ? 'profile.spots.remove' : 'profile.spots.add', { field, value }, options) }
  catch (error) {
    if (error.code !== 'PENDING_OPERATION') throw error
    return { ...await backend.retryCloudPending(scope, options), recovered: true }
  }
}
async function updateUser(data) {
  if (backend.isBackendEnabled()) {
    const patch = toBackendPatch(data), owner = identity(), openid = wx.getStorageSync('openid')
    const receipt = { validate: user => validUser(user, openid) }
    let user
    try {
      user = await backend.mutate('profile.update', 'PATCH', '/api/v1/me', patch, receipt)
    } catch (error) {
      if (!error || error.code !== 'PENDING_OPERATION') throw error
      // An explicit save first reconciles the previous uncertain PATCH using its
      // original key. Never display that historical reply as the new form.
      await backend.retryPending('profile.update', receipt)
      if (identity() !== owner) throw Object.assign(new Error('当前操作已取消'), { code: 'REQUEST_CANCELLED' })
      user = await backend.mutate('profile.update', 'PATCH', '/api/v1/me', patch, receipt)
    }
    return { result: { ok: true, data: fromBackendUser(user) } }
  }
  const firstResponse = await wx.cloud.callFunction({ name: 'updateUser', data })
  const firstResult = firstResponse && firstResponse.result || {}
  const message = String(firstResult.errorMsg || firstResult.message || firstResult.error || '')
  if (firstResult.ok || !/\b(?:region|address) is not defined\b/i.test(message)) return firstResponse
  // Legacy server version recovery only; not an HTTP-to-CloudBase fallback.
  const response = await wx.cloud.callFunction({ name: 'login', data: {} })
  const result = response && response.result || {}
  if (!result.ok) return firstResponse
  if (result.openid) {
    wx.setStorageSync('openid', result.openid)
    wx.setStorageSync('isGuest', false)
  }
  return wx.cloud.callFunction({ name: 'updateUser', data })
}
async function uploadAvatar(filePath) {
  if (backend.isBackendEnabled()) {
    const image = await backend.uploadImage(filePath, 'profile.avatar')
    return { avatarFileId: image.fileId, avatarUrl: filePath }
  }
  const extension = String(filePath).match(/\.(\w+)$/)
  const cloudPath = `userAvatar/${Date.now()}-${Math.floor(Math.random() * 1000000)}.${extension ? extension[1] : 'jpg'}`
  const image = await wx.cloud.uploadFile({ cloudPath, filePath })
  return { avatarUrl: image.fileID }
}
function avatarPatch(data) {
  if (!backend.isBackendEnabled()) return { avatarUrl: data.avatarUrl || '' }
  return own(data, 'avatarFileId') ? { avatarFileId: data.avatarFileId } : {}
}
function cacheUser(user) {
  // Signed URLs expire and are never persisted as user facts.
  const cached = { ...user }
  if (backend.isBackendEnabled()) delete cached.avatarUrl
  wx.setStorageSync('userInfo', cached)
}
module.exports = { updateSpot, identity, isBackendEnabled: backend.isBackendEnabled, fromBackendUser, toBackendPatch, legacyDocument,
  login, logout, getUserInfo, getUnreadCount, updateUser, uploadAvatar, avatarPatch, cacheUser }
