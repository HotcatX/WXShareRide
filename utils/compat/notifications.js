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
  const db = wx.cloud.database()
  const [rows, unread] = await Promise.all([
    db.collection('Notifications').where({ _openid: openid }).orderBy('createdAt', 'desc').limit(100).get(),
    db.collection('Notifications').where({ _openid: openid, read: false }).count()
  ])
  if (!Number.isSafeInteger(unread.total) || unread.total < 0) throw new Error('未读数量暂不可用')
  return { items: (rows.data || []).map(item => project(item, false)), nextCursor: null, unreadCount: unread.total }
}
async function markRead(id) {
  requireAccount(); validId(id)
  if (backend.isBackendEnabled()) return backend.mutate(`notifications.read:${id}`, 'POST', `/api/v1/notifications/${encodeURIComponent(id)}/read`, {},
    { validate: result => result && result.id === id && result.read === true })
  return wx.cloud.database().collection('Notifications').doc(id).update({ data: { read: true } })
}
async function markAllRead() {
  const openid = requireAccount()
  if (backend.isBackendEnabled()) return backend.mutate('notifications.readAll', 'POST', '/api/v1/notifications/read-all', {},
    { validate: result => result && Number.isSafeInteger(result.changed) && result.changed >= 0 })
  return wx.cloud.database().collection('Notifications').where({ _openid: openid, read: false }).update({ data: { read: true } })
}
async function clear() {
  requireAccount()
  if (backend.isBackendEnabled()) return backend.mutate('notifications.clear', 'DELETE', '/api/v1/notifications', {},
    { validate: result => result && Number.isSafeInteger(result.deleted) && result.deleted >= 0 })
  const response = await wx.cloud.callFunction({ name: 'clearUserNotifications', data: {} })
  if (!response || !response.result || response.result.success !== true) throw new Error('删除失败，请重试')
  return response.result
}
module.exports = { identity, signedIn, list, markRead, markAllRead, clear }
