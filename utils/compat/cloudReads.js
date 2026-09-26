// TEMPORARY FALLBACK — remove only after the next production release is verified
// Caller: publicStatsClient. Read-only statistics projection, no business writes.
// Retire only after server read success/latency and old-client coverage are checked.
function readPublicStats(wxApi) {
  return wxApi.cloud.callFunction({ name: 'statistics', data: { action: 'publicStats' } })
}
module.exports = { readPublicStats }
