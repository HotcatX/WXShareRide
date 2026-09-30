const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Older page fixtures describe the display DTO. Adapt those synthetic fixtures
// at the transport boundary so the actual facade always exercises server paths.
// Supplying a backend bypasses this adapter for HTTP/receipt contract tests.
module.exports = function profileApi(wx, backend) {
  const module = { exports: {} }
  let document = {}
  const canonical = value => {
    document = value || {}
    const patch = module.exports.toBackendPatch({ bio: '', ...document })
    return { id: document._id || '00000000-0000-4000-8000-000000000001',
      openid: document._openid || wx.getStorageSync('openid') || 'synthetic-profile',
      name: document.name || '', avatarFileId: document.avatarFileId || null, profile: patch.profile || {} }
  }
  const ratings = (stats, role = '') => ({
    completedTrips: stats[role ? `completed${role === 'driver' ? 'Driver' : 'Passenger'}Trips` : 'completedTrips'] || 0,
    ratingCount: stats[role ? `${role}RatingCount` : 'ratingCount'] || 0,
    averageRating: stats[role ? `${role}RatingAvg` : 'ratingAvg'] || 0,
    weightedRating: stats[role ? `${role}RatingWeightedAvg` : 'ratingWeightedAvg'] || 0
  })
  backend ||= {
    isBackendEnabled: () => true,
    async login(options = {}) {
      const response = await wx.cloud.callFunction({ name: 'login', data: {} })
      if (options.isCurrent && !options.isCurrent()) throw Object.assign(new Error('cancelled'), { code: 'REQUEST_CANCELLED' })
      const result = response.result || {}
      if (!result.ok || !result.openid) throw new Error(result.message || 'Login fixture rejected')
      return { user: result }
    },
    logout() {},
    async get(url) {
      if (url === '/api/v1/me') {
        const response = await wx.cloud.callFunction({ name: 'getUserInfo', data: {} })
        const value = module.exports.legacyDocument(response)
        if (!value) throw new Error('Profile fixture unavailable')
        return canonical(value)
      }
      if (url === '/api/v1/me/statistics') {
        const stats = document.rideStats || {}
        return { all: ratings(stats), driver: ratings(stats, 'driver'), passenger: ratings(stats, 'passenger') }
      }
      if (url.startsWith('/api/v1/blocks?')) return { blocks: (document.blockedUsers || []).map(targetUserId => ({ targetUserId })), nextPage: null }
      if (url === '/api/v1/notifications/unread') {
        const result = await wx.cloud.database().collection('Notifications').where({ _openid: wx.getStorageSync('openid'), read: false }).count()
        return { unreadCount: result.total }
      }
      throw new Error(`Unexpected profile fixture request: ${url}`)
    },
    async mutate() { throw new Error('Supply a canonical backend fixture for profile writes') },
    async uploadImage() { throw new Error('Supply a canonical backend fixture for avatar uploads') },
    async retryCloudPending() { return null }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../utils/compat/profile.js'), 'utf8'), {
    module, wx, require(name) { if (name === '../backendClient') return backend; throw new Error(name) }
  })
  return module.exports
}
