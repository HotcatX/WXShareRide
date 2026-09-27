const backend = require('../backendClient')

// Temporary CloudBase fallback selected only by deployment mode. Server errors
// are returned to the caller and never repeat a write against the old database.
async function call(action, data = {}) {
  if (!backend.isBackendEnabled()) {
    if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') throw new Error('REFERRAL_UNAVAILABLE')
    const response = await wx.cloud.callFunction({ name: 'referralApi', data: { action, ...data } })
    return response && response.result || { ok: false, error: 'INVALID_RESPONSE' }
  }
  if (action === 'getMyReferralCode') {
    const result = await backend.get('/api/v1/referrals/me')
    return { ok: true, referralCode: result.code, referralCount: result.referralCount }
  }
  if (action === 'bindReferral') {
    const result = await backend.mutate('referrals.bind', 'POST', '/api/v1/referrals/bind', { code: data.referralCode },
      { validate: response => response && typeof response.changed === 'boolean' })
    return { ok: true, bound: result.changed, existing: !result.changed }
  }
  throw new Error('UNSUPPORTED_REFERRAL_ACTION')
}
module.exports = { call, isBackendEnabled: backend.isBackendEnabled }
