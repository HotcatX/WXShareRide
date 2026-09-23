// All eligible signed-in users are included; a current server grant is required.
// Development/preview events use a separate synthetic authorization and dataset.
module.exports = Object.freeze({
  enabled: true,
  buildVersion: '2026.09.23.4',
  endpoint: 'https://collect.linkx.ink/v1/batches',
  rolloutPercent: Object.freeze({ develop: 100, trial: 100, release: 100 }),
  purposeVersion: 'ride-research-v1',
  noticeVersion: 'ride-research-notice-2026-09-23',
  schemaVersion: 1,
  maxBatchEvents: 50,
  maxBatchBytes: 64 * 1024,
  maxQueueEvents: 500,
  maxQueueBytes: 256 * 1024,
  eventTtlMs: 7 * 24 * 60 * 60 * 1000,
  minUploadIntervalMs: 15 * 1000,
  maxUploadsPerForeground: 40,
  requestTimeoutMs: 10000,
  retryBaseMs: 30000,
  retryMaxMs: 6 * 60 * 60 * 1000
})
