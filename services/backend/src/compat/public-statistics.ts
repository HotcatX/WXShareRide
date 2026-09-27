import { createHash } from 'node:crypto';

// TEMPORARY FALLBACK — remove only after the next production release is verified
// and no supported client uses /v1/public-stats. The old source string is a
// required v1 wire discriminator, not the current database provider. All values
// come from the same PostgreSQL query as the canonical statistics endpoint.
export function legacyPublicStatistics(value: { servedCount: number; coverageText: string | null }, acquiredAt: number) {
  const data = { _id: 'home', servedTrips: value.servedCount, coverageText: value.coverageText || 'N/A' };
  return { ok: true, schemaVersion: 1, source: 'cloudbase-snapshot', snapshotAt: acquiredAt,
    expiresAt: acquiredAt + 60_000, revision: createHash('sha256').update(JSON.stringify(data)).digest('hex'), data };
}
