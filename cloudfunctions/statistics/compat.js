// TEMPORARY COMPATIBILITY — this cloud function deploys independently, so its
// deployed protocol identifiers must stay local to its package. The contract test
// checks them against the collector/client; do not create new account subjects or
// grants by changing a prefix. No fallback or second authorization state lives here.
// Remove only after the next production release is verified AND the server/client
// identity, route and authorization migration is complete, including old callers.
module.exports = Object.freeze({
  ENDPOINT: 'https://collect.linkx.ink/internal/v1/research/participation',
  PURPOSE: 'ride-research-v1',
  NOTICE: 'ride-research-notice-2026-09-23',
  SUBJECT_SCOPE: 'linkx-research-account-v1',
  TEST_SUBJECT_SCOPE: 'linkx-research-test-account-v1'
})
