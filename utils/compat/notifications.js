// Notification page DTOs use the server API. Historical pending operations
// retain their original key and recover through the same PostgreSQL backend.
const backend = require('../backendClient')
const signedIn = () => !wx.getStorageSync('isGuest') && !!wx.getStorageSync('openid')
const identity = () => JSON.stringify([backend.isBackendEnabled(), wx.getStorageSync('openid') || '', !!wx.getStorageSync('isGuest')])
function requireAccount() {
  if (!backend.isBackendEnabled()) throw Object.assign(new Error('业务服务尚未切换'), { code: 'BACKEND_DISABLED' })
  if (!signedIn()) throw new Error('请先登录')
}
function validId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(id)) throw new Error('通知编号无效')
  return id
}
function project(item) {
  return { _id: item.id, title: item.title || '', content: item.content || '',
    type: item.type || '', read: item.read === true, createdAt: item.createdAt,
    canRate: ['rating_invitation', 'RATING_INVITE'].includes(item.type),
    rateTripId: item.rideId || '' }
}
async function list() {
  requireAccount()
  const result = await backend.get('/api/v1/notifications?limit=100')
  if (!result || !Array.isArray(result.items) || result.items.length > 100 || !Number.isSafeInteger(result.unreadCount) || result.unreadCount < 0 ||
    !(result.nextCursor === null || typeof result.nextCursor === 'string') ||
    result.items.some(item => !item || typeof item.read !== 'boolean' || typeof item.id !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(item.id))) throw new Error('通知响应无效，请重试')
  return { items: result.items.map(project), nextCursor: result.nextCursor, unreadCount: result.unreadCount }
}
async function markRead(id) {
  requireAccount(); validId(id)
  return mutate(`notifications.read:${id}`, 'POST', `/api/v1/notifications/${encodeURIComponent(id)}/read`,
    { validate: result => result && result.id === id && result.read === true })
}
async function markAllRead() {
  requireAccount()
  return mutate('notifications.readAll', 'POST', '/api/v1/notifications/read-all',
    { validate: result => result && Number.isSafeInteger(result.changed) && result.changed >= 0 })
}
async function clear() {
  requireAccount()
  return mutate('notifications.clear', 'DELETE', '/api/v1/notifications',
    { validate: result => result && Number.isSafeInteger(result.deleted) && result.deleted >= 0 })
}
async function mutate(scope, method, path, options) {
  const recovered = await backend.retryCloudPending(scope, { ...options, ifPresent: true })
  if (recovered) return { ...recovered, recovered: true }
  return backend.mutate(scope, method, path, {}, options)
}
module.exports = { identity, signedIn, list, markRead, markAllRead, clear }
