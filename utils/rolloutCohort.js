// Shared installation-only cohort. Never send this bucket to a server.
const COHORT_KEY = 'linkxPublicStatsRolloutV1'

function readInstallationBucket(wxApi, random = Math.random) {
  let saved = wxApi.getStorageSync(COHORT_KEY)
  if (saved === undefined || saved === null || saved === '') {
    const bucket = Math.floor(random() * 10000)
    if (!Number.isInteger(bucket) || bucket < 0 || bucket >= 10000) throw new Error('cohort_unavailable')
    wxApi.setStorageSync(COHORT_KEY, { version: 1, bucket })
    saved = wxApi.getStorageSync(COHORT_KEY)
    if (!saved || saved.bucket !== bucket) throw new Error('cohort_unavailable')
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved) || Object.keys(saved).length !== 2 ||
    !['version', 'bucket'].every(key => Object.prototype.hasOwnProperty.call(saved, key)) ||
    saved.version !== 1 || !Number.isInteger(saved.bucket) || saved.bucket < 0 || saved.bucket >= 10000) {
    throw new Error('cohort_unavailable')
  }
  return saved.bucket
}

module.exports = { COHORT_KEY, readInstallationBucket }
