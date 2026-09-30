const backend = require('../backendClient')

// Keep the existing referral caller contract while using the server API only.
async function call(action, data = {}) {
  if (!backend.isBackendEnabled()) throw Object.assign(new Error('业务服务尚未切换'), { code: 'BACKEND_DISABLED' })
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
