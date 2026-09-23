// The public interface projects only the original three public fields.
function normalizeStats(raw = {}) {
  const value = raw && raw.servedTrips
  const number = value === undefined || value === null || value === '' ? null : Number(value)
  const trips = number === null || !Number.isFinite(number) || number < 0 ? null : Math.floor(number)
  const coverage = raw && raw.coverageText
  return { _id: 'home', servedTrips: trips === null || Number.isSafeInteger(trips) ? trips : null,
    coverageText: typeof coverage === 'string' && coverage.length > 0 && coverage.length <= 120 && !/[\u0000-\u001f\u007f]/.test(coverage) ? coverage : 'N/A' }
}
function createPublicHandler(readPublicStats) {
  return async () => {
    try { return { success: true, data: normalizeStats(await readPublicStats()) } }
    catch (_) { return { success: false, data: normalizeStats(), errorMsg: 'PUBLIC_STATS_UNAVAILABLE' } }
  }
}
module.exports = { normalizeStats, createPublicHandler }
