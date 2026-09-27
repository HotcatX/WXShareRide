import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { normalizeCloudBaseExport } from './normalize.ts';
import { serializeSource, sourceHash } from './source.ts';
import type { CloudBaseExport, ExportObservation, MigrationReport } from './types.ts';

// This is the audited environment inventory, including empty and archive-only
// collections. A future collection requires review, not silent omission.
export const importAppId = 'wx8a8a389199aa2a0e';
export const importEnvironment = 'cloud1-7gmtcu4s3aebce27';
export const importCollections = [
  'Arrival', 'Arrival_Request', 'CITY_TREE', 'Carpool', 'CarpoolRequest', 'CarpoolTemplate',
  'CommunityConfigHistory', 'Departure', 'Departure_Request', 'MarketAdFiles', 'MarketAdminSessions',
  'MarketAdminSettings', 'MarketAdminTemplates', 'MarketFiles', 'MarketImportBatches', 'MyTripHistory',
  'MyTrips', 'Notifications', 'OperationReceipts', 'PublicStats', 'Request_Price', 'TripActions',
  'TripRatings', 'UserBlocks', 'WebAdminAccounts', 'WebAdminAuditLogs', 'WebAdminLoginAttempts',
  'WebAdminSessions', 'WebAdminSettings', 'WebAdminUploads', 'cityTree', 'community_config', 'feedback',
  'houseShare', 'market_ad_events', 'market_admins', 'market_ads', 'market_goods', 'market_view_events',
  'regionTree', 'relation_data_depart', 'relation_data_depart-preview', 'ride_city_demand',
  'ride_city_demand_events', 'sys_department', 'sys_department-preview', 'sys_user', 'sys_user-preview', 'userInfo'
] as const;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const stamp = z.iso.datetime({ precision: 3 });
const count = z.number().int().min(0).max(1_000_000);
const fileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.json$/).refine(value => !value.includes('..'));
const collectionSchema = z.strictObject({
  name: z.enum(importCollections), file: fileName, sha256, bytes: z.number().int().min(2).max(64 * 1024 * 1024),
  rows: count, inventoryBefore: count, inventoryAfter: count,
  startedAt: stamp, finishedAt: stamp
});
const manifestSchema = z.strictObject({
  kind: z.literal('linkx-cloudbase-import-manifest'), version: z.literal(1),
  appId: z.literal(importAppId), environment: z.literal(importEnvironment),
  // Ordinary manual/keyset exports are not atomic snapshots. The operator must
  // separately stop and verify all old writers before treating one as final.
  snapshotConsistency: z.literal('non-atomic'),
  startedAt: stamp, finishedAt: stamp,
  sourceSha256: sha256, observation: z.strictObject({ sourceSha256: sha256, at: stamp }),
  collections: z.array(collectionSchema).length(importCollections.length)
});
export type ImportManifest = z.infer<typeof manifestSchema>;
export type ImportBundle = {
  source: CloudBaseExport; observation: ExportObservation; manifestSha256: string;
  report: MigrationReport; summary: {
    auditReady: boolean; cutoverVerified: false; sourceSha256: string; manifestSha256: string;
    collections: number; rows: number; snapshotConsistency: 'non-atomic'; observedAt: string;
    candidateCounts: MigrationReport['candidateCounts']; issues: MigrationReport['issues'];
  };
};
export class ImportManifestError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'ImportManifestError'; this.code = code; }
}
const fail = (code: string): never => { throw new ImportManifestError(code); };
const privateMode = (mode: number) => (mode & 0o077) === 0;

async function privateFile(path: string, maximum: number): Promise<{ text: string; bytes: number; sha256: string }> {
  let handle;
  try {
    // No symlink/path traversal into another export or credentials directory.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || !privateMode(stat.mode) || stat.size < 2 || stat.size > maximum) fail('INVALID_IMPORT_FILE');
    const raw = await handle.readFile();
    if (raw.length !== stat.size || raw.length > maximum) fail('IMPORT_FILE_CHANGED');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    return { text, bytes: raw.length, sha256: sourceHash(text) };
  } catch (error) {
    if (error instanceof ImportManifestError) throw error;
    return fail('IMPORT_FILE_UNAVAILABLE');
  } finally { await handle?.close(); }
}

/**
 * Read a private bundle, never the cloud. Each collection file is its complete
 * JSON document array (not a tool response/page/projection). Keep provider raw
 * responses separately for the operator's final freeze/export review.
 *
 * sourceSha256 hashes serializeSource({kind:'cloudbase-full-export',appId,
 * collections}) with collections in importCollections order and each array's
 * original document/property order. File hashes instead cover exact UTF-8 bytes.
 * This intentionally does not infer a freeze from matching counts or hashes.
 */
export async function auditImportManifest(path: string, expectedAppId: string, now = Date.now()): Promise<ImportBundle> {
  if (!isAbsolute(path) || expectedAppId !== importAppId || !Number.isSafeInteger(now)) fail('INVALID_IMPORT_TARGET');
  const directory = dirname(resolve(path));
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !privateMode(stat.mode)) fail('IMPORT_DIRECTORY_NOT_PRIVATE');
  } catch (error) { if (error instanceof ImportManifestError) throw error; fail('IMPORT_DIRECTORY_UNAVAILABLE'); }
  const rawManifest = await privateFile(path, 1024 * 1024);
  let manifest: ImportManifest;
  try { manifest = manifestSchema.parse(JSON.parse(rawManifest.text)); }
  catch { return fail('INVALID_IMPORT_MANIFEST'); }
  if (manifest.appId !== expectedAppId || manifest.observation.sourceSha256 !== manifest.sourceSha256 ||
      manifest.startedAt > manifest.finishedAt || manifest.finishedAt > manifest.observation.at ||
      Date.parse(manifest.observation.at) > now) fail('INVALID_IMPORT_OBSERVATION');
  const names = new Set(manifest.collections.map(row => row.name));
  const files = new Set(manifest.collections.map(row => row.file));
  if (names.size !== importCollections.length || files.size !== importCollections.length || files.has(basename(path))) fail('INCOMPLETE_IMPORT_MANIFEST');
  if (manifest.collections.reduce((total, row) => total + row.bytes, 0) > 256 * 1024 * 1024) fail('IMPORT_BUNDLE_TOO_LARGE');
  const source: CloudBaseExport = { kind: 'cloudbase-full-export', appId: manifest.appId, collections: {} };
  let rows = 0;
  for (const name of importCollections) {
    const entry = manifest.collections.find(row => row.name === name)!;
    if (entry.rows !== entry.inventoryBefore || entry.rows !== entry.inventoryAfter ||
        entry.startedAt < manifest.startedAt || entry.startedAt > entry.finishedAt || entry.finishedAt > manifest.finishedAt) fail('IMPORT_COLLECTION_DRIFT');
    const file = await privateFile(resolve(directory, entry.file), 64 * 1024 * 1024);
    if (file.bytes !== entry.bytes || file.sha256 !== entry.sha256) fail('IMPORT_FILE_HASH_MISMATCH');
    let documents: unknown;
    try { documents = JSON.parse(file.text); serializeSource(documents); }
    catch { return fail('INVALID_COLLECTION_JSON'); }
    if (!Array.isArray(documents) || documents.length !== entry.rows) return fail('IMPORT_COLLECTION_COUNT_MISMATCH');
    source.collections[name] = documents;
    rows += documents.length;
  }
  if (sourceHash(serializeSource(source)) !== manifest.sourceSha256) fail('IMPORT_SOURCE_HASH_MISMATCH');
  const { report } = normalizeCloudBaseExport(source, { timeZone: 'America/New_York', observation: manifest.observation });
  return { source, observation: manifest.observation, manifestSha256: rawManifest.sha256, report,
    summary: { auditReady: report.ready, cutoverVerified: false, sourceSha256: manifest.sourceSha256,
      manifestSha256: rawManifest.sha256, collections: names.size, rows, snapshotConsistency: manifest.snapshotConsistency,
      observedAt: manifest.observation.at, candidateCounts: report.candidateCounts, issues: report.issues } };
}
