const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
module.exports = function profileApi(wx, backend = { isBackendEnabled: () => false }) {
  if (!backend.isBackendEnabled() && !backend.cloudRead) backend = { ...backend, async cloudRead(action) {
    if (action !== 'notifications.unread') throw new Error(action)
    const result = await wx.cloud.database().collection('Notifications').where({ _openid: wx.getStorageSync('openid'), read: false }).count()
    return { unreadCount: result.total }
  } }
  if (!backend.isBackendEnabled()) backend = { cloudLogin: () => wx.cloud.callFunction({ name: 'login', data: {} }), logout() {}, ...backend }
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../utils/compat/profile.js'), 'utf8'), {
    module, wx, require(name) { if (name === '../backendClient') return backend; throw new Error(name) }
  })
  return module.exports
}
