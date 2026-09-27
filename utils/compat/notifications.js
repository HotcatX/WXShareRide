// Temporary CloudBase boundary. Remove after the released server client and
// legacy-entry cutover are verified. A server failure never writes to CloudBase.
const backend = require('../backendClient')
const signedIn = () => !wx.getStorageSync('isGuest') && !!wx.getStorageSync('openid')
const identity = () => JSON.stringify([backend.isBackendEnabled(), wx.getStorageSync('openid') || '', !!wx.getStorageSync('isGuest')])
function requireAccount() {
  if (!signedIn()) throw new Error('请先登录')
  return wx.getStorageSync('openid')
}
function validId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(id)) throw new Error('通知编号无效')
  return id
}
function project(item, server) {
  const extra = item.extra || {}
  return { _id: server ? item.id : item._id, title: item.title || '', content: item.content || '',
    type: item.type || '', read: item.read === true, createdAt: item.createdAt,
    canRate: ['rating_invitation', 'RATING_INVITE'].includes(item.type) || !server && extra.action === 'rateUser',
    rateTripId: server ? item.rideId || '' : extra.tripId || extra.requestId || item.carpoolId || '' }
}
async function list() {
  const openid = requireAccount()
  if (backend.isBackendEnabled()) {
    const result = await backend.get('/api/v1/notifications?limit=100')
    if (!result || !Array.isArray(result.items) || result.items.length > 100 || !Number.isSafeInteger(result.unreadCount) || result.unreadCount < 0 ||
      !(result.nextCursor === null || typeof result.nextCursor === 'string') ||
      result.items.some(item => !item || typeof item.read !== 'boolean' || typeof item.id !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(item.id))) throw new Error('通知响应无效，请重试')
    return { items: result.items.map(item => project(item, true)), nextCursor: result.nextCursor, unreadCount: result.unreadCount }
  }
  const result = await backend.cloudRead('notifications.list')
  if (!result || !Array.isArray(result.items) || result.items.some(row => row._openid !== openid) || !Number.isSafeInteger(result.unreadCount) || result.unreadCount < 0) throw new Error('通知响应无效，请重试')
  return { items: result.items.map(item => project(item, false)), nextCursor: null, unreadCount: result.unreadCount }
}
async function markRead(id) {
  requireAccount(); validId(id)
  if (backend.isBackendEnabled()) return backend.mutate(`notifications.read:${id}`, 'POST', `/api/v1/notifications/${encodeURIComponent(id)}/read`, {},
    { validate: result => result && result.id === id && result.read === true })
  return backend.cloudMutate(`notifications.read:${id}`, 'notifications.read', { id }, { validate: row => row && row.id === id && row.read === true })
}
async function markAllRead() {
  const openid = requireAccount()
  if (backend.isBackendEnabled()) return backend.mutate('notifications.readAll', 'POST', '/api/v1/notifications/read-all', {},
    { validate: result => result && Number.isSafeInteger(result.changed) && result.changed >= 0 })
  return backend.cloudMutate('notifications.readAll', 'notifications.readAll', {}, { validate: row => row && Number.isSafeInteger(row.changed) && row.changed >= 0 })
}
async function clear() {
  requireAccount()
  if (backend.isBackendEnabled()) return backend.mutate('notifications.clear', 'DELETE', '/api/v1/notifications', {},
    { validate: result => result && Number.isSafeInteger(result.deleted) && result.deleted >= 0 })
  return backend.cloudMutate('notifications.clear', 'notifications.clear', {}, { validate: row => row && Number.isSafeInteger(row.deleted) && row.deleted >= 0 })
}
module.exports = { identity, signedIn, list, markRead, markAllRead, clear }
