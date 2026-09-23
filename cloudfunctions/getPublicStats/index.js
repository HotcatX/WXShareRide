const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// Compatibility for previously distributed mini-program packages. New clients
// call statistics directly; this wrapper adds one cloud-function invocation.
exports.main = async () => {
  try {
    const response = await cloud.callFunction({ name: 'statistics', data: { action: 'publicStats' } })
    if (!response || !response.result || typeof response.result.success !== 'boolean') throw new Error('UNAVAILABLE')
    return response.result
  } catch (_) {
    return { success: false, data: { _id: 'home', servedTrips: null, coverageText: 'N/A' }, errorMsg: 'PUBLIC_STATS_UNAVAILABLE' }
  }
}
