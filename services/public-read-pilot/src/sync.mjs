import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { openSync, closeSync, fstatSync, readSync, writeFileSync, fsyncSync, renameSync, unlinkSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { MAX_BYTES, validateSnapshot, readSnapshotDocument } from './snapshot.mjs';

export const SYNC_ROUTE = '/internal/v1/public-stats/sync';
export const SYNC_SKEW_MS = 5 * 60 * 1000;
export class SyncError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const reject = (status, code) => { throw new SyncError(status, code); };

// Secrets are loaded once at startup. Rotation requires replacing this file and restarting.
export function loadSyncKey(path) {
  if (!path) return null;
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 64 || stat.size > 128) throw new Error();
    const bytes = Buffer.alloc(129);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const hex = bytes.subarray(0, count).toString('ascii').trim();
    if (!/^[a-fA-F0-9]{64}$/.test(hex)) throw new Error();
    // Reject non-ASCII bytes rather than accepting their ASCII-decoded aliases.
    if (!bytes.subarray(0, count).equals(Buffer.from(bytes.subarray(0, count).toString('ascii'), 'ascii'))) throw new Error();
    return Buffer.from(hex, 'hex');
  } catch { throw new Error('PUBLIC_STATS_SYNC_KEY_INVALID'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function verifySyncSignature({ key, timestamp, signature, rawBody, now = Date.now() }) {
  if (!key) reject(503, 'SYNC_DISABLED');
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('PUBLIC_STATS_SYNC_KEY_INVALID');
  const at = Number(timestamp);
  if (typeof timestamp !== 'string' || !/^[1-9][0-9]{0,15}$/.test(timestamp)
    || !Number.isSafeInteger(at) || Math.abs(now - at) > SYNC_SKEW_MS
    || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) reject(401, 'UNAUTHORIZED');
  const expected = createHmac('sha256', key).update(timestamp + '\n', 'utf8').update(rawBody).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) reject(401, 'UNAUTHORIZED');
}

function stableSnapshot(snapshot) {
  return JSON.stringify({ schemaVersion: snapshot.schemaVersion, source: snapshot.source,
    snapshotAt: snapshot.snapshotAt, expiresAt: snapshot.expiresAt, revision: snapshot.revision,
    data: { _id: snapshot.data._id, servedTrips: snapshot.data.servedTrips, coverageText: snapshot.data.coverageText } });
}

// Call only after authentication. All comparison and file operations are synchronous:
// a single Node process is the sole writer, including during rolling deployments.
export function installSnapshot({ snapshotPath, rawBody, now = Date.now() }) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > MAX_BYTES) reject(400, 'INVALID_SNAPSHOT');
  let incoming;
  try {
    incoming = validateSnapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)), now);
    if (Math.abs(now - incoming.snapshotAt) > SYNC_SKEW_MS) throw new Error();
  } catch { reject(400, 'INVALID_SNAPSHOT'); }
  let current;
  try { current = readSnapshotDocument(snapshotPath); }
  catch (error) {
    if (error.code !== 'ENOENT') reject(503, 'SNAPSHOT_STATE_UNAVAILABLE');
  }
  if (current) {
    if (incoming.snapshotAt < current.snapshotAt) reject(409, 'SNAPSHOT_CONFLICT');
    if (incoming.snapshotAt === current.snapshotAt) {
      if (stableSnapshot(incoming) !== stableSnapshot(current)) reject(409, 'SNAPSHOT_CONFLICT');
      return { ok: true, duplicate: true, snapshotAt: incoming.snapshotAt, revision: incoming.revision };
    }
  }
  const directory = dirname(snapshotPath);
  const temporary = join(directory, `.public-stats-${randomUUID()}.tmp`);
  let fileFd, directoryFd;
  try {
    fileFd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    // Preserve data property order: revision hashes JSON.stringify(data) in that order.
    writeFileSync(fileFd, JSON.stringify(incoming), { encoding: 'utf8' });
    fsyncSync(fileFd);
    closeSync(fileFd); fileFd = undefined;
    renameSync(temporary, snapshotPath);
    directoryFd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY || 0));
    fsyncSync(directoryFd);
    return { ok: true, duplicate: false, snapshotAt: incoming.snapshotAt, revision: incoming.revision };
  } catch { reject(503, 'SNAPSHOT_WRITE_FAILED'); }
  finally {
    if (fileFd !== undefined) closeSync(fileFd);
    if (directoryFd !== undefined) closeSync(directoryFd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') { /* No path or payload logging. */ } }
  }
}
