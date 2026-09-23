import { createHash } from 'node:crypto';
import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';

export const MAX_BYTES = 8192;
export const MAX_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_FUTURE_MS = 60_000;
export const DEFAULT_TTL_MS = 60 * 60 * 1000;
const timestamp = value => Number.isSafeInteger(value) && value > 0;
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = () => { throw new Error('SNAPSHOT_UNAVAILABLE'); };

export function validatePublicData(data) {
  if (!exact(data, ['_id', 'servedTrips', 'coverageText']) || data._id !== 'home'
    || !(data.servedTrips === null || (Number.isSafeInteger(data.servedTrips) && data.servedTrips >= 0))
    || typeof data.coverageText !== 'string' || data.coverageText.length > 120
    || /[\u0000-\u001f\u007f]/.test(data.coverageText)) fail();
  return data;
}

export const revisionOf = data => createHash('sha256').update(JSON.stringify(data), 'utf8').digest('hex');

export function validateSnapshotFormat(snapshot) {
  if (!exact(snapshot, ['schemaVersion', 'source', 'snapshotAt', 'expiresAt', 'revision', 'data'])
    || snapshot.schemaVersion !== 1 || snapshot.source !== 'cloudbase-snapshot'
    || !timestamp(snapshot.snapshotAt) || !timestamp(snapshot.expiresAt)
    || snapshot.expiresAt <= snapshot.snapshotAt
    || snapshot.expiresAt > snapshot.snapshotAt + MAX_TTL_MS
    || typeof snapshot.revision !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.revision)) fail();
  validatePublicData(snapshot.data);
  if (revisionOf(snapshot.data) !== snapshot.revision) fail();
  return snapshot;
}

export function validateSnapshot(snapshot, now = Date.now()) {
  validateSnapshotFormat(snapshot);
  if (snapshot.snapshotAt > now + MAX_FUTURE_MS || snapshot.expiresAt <= now) fail();
  return snapshot;
}

// The snapshot is trusted operator input, but still bounded, projected and validated.
// Open one immutable-file generation; replacing the host file atomically is recommended.
export function readSnapshotDocument(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) fail();
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const received = readSync(fd, bytes, count, bytes.length - count, null);
      if (!received) break;
      count += received;
    }
    if (count > MAX_BYTES) fail();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
    return validateSnapshotFormat(JSON.parse(text));
  }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function readSnapshot(path, now = Date.now()) {
  try { return validateSnapshot(readSnapshotDocument(path), now); }
  catch { fail(); }
}

export function makeSnapshot(data, { now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  validatePublicData(data);
  if (!timestamp(now) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) fail();
  // One stable field order for snapshots produced by this tool.
  const projected = { _id: 'home', servedTrips: data.servedTrips, coverageText: data.coverageText };
  return validateSnapshot({ schemaVersion: 1, source: 'cloudbase-snapshot', snapshotAt: now,
    expiresAt: now + ttlMs, revision: revisionOf(projected), data: projected }, now);
}
