// TEMPORARY WIRE COMPATIBILITY for already-published clients.
// HMAC separators preserve existing opaque identities and withdrawal records.
// Keep these bytes until an explicit identity migration; active names live in protocol.js.
module.exports = Object.freeze({
  ENDPOINT: 'https://collect.linkx.ink/internal/v1/research/participation',
  PURPOSE: 'ride-research-v1',
  NOTICE: 'ride-research-notice-2026-09-23',
  SUBJECT_SCOPE: 'linkx-research-account-v1',
  TEST_SUBJECT_SCOPE: 'linkx-research-test-account-v1'
})
