const legacy = require('./compat')

const PURPOSE = 'ride-analytics-v1'
const NOTICE = 'ride-analytics-notice-2026-09-23'

function validVersions(purpose, notice) {
  return (purpose === PURPOSE && notice === NOTICE) ||
    (purpose === legacy.PURPOSE && notice === legacy.NOTICE)
}

module.exports = Object.freeze({
  ENDPOINT: 'https://collect.linkx.ink/internal/v1/analytics/accounts',
  PURPOSE, NOTICE, validVersions,
  // Existing opaque account IDs stay stable across the protocol rename.
  SUBJECT_SCOPE: legacy.SUBJECT_SCOPE,
  TEST_SUBJECT_SCOPE: legacy.TEST_SUBJECT_SCOPE
})
