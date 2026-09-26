// TEMPORARY COMPATIBILITY — analyticsSession and analyticsClient read these
// deployed protocol/storage identifiers so upgrading does not lose queued events,
// forget pending withdrawals, or invalidate an existing server authorization.
// This module contains identifiers only: no second state, identity, or transport.
// Remove only after the next production release is verified AND an explicit
// server-grant/local-storage migration has drained or migrated all older records.
// Renaming modules alone is not evidence that stored data is safe to discard.
module.exports = Object.freeze({
  STORAGE_KEY: 'ride_research_queue_v1',
  PENDING_KEY: 'rideResearchPendingWithdrawV1',
  purposeVersion: 'ride-research-v1',
  noticeVersion: 'ride-research-notice-2026-09-23'
})
