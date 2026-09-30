import { createReadStream, createWriteStream, chmodSync, closeSync, fsyncSync, linkSync, openSync, statSync, statfsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { openDatabase } from './database.mjs';
import { decodePayload } from './payload.mjs';
import { sqliteIsPatched } from './store.mjs';

const MIB = 1024 * 1024;

// Reuse the database and free-space bounds rather than introducing a separate
// unbounded restore path. Temporary files stay beside the destination on disk.
export function backupLimits(env = process.env) {
  const integer = (value, fallback, min, max) => {
    const parsed = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error('Invalid backup limits');
    return parsed;
  };
  const maxDatabaseMB = integer(env.MAX_DATABASE_MB, 1024, 16, 16384);
  return { maxDatabaseMB, maxBytes: maxDatabaseMB * MIB, minFreeBytes: integer(env.MIN_FREE_MB, 256, 0, 16384) * MIB };
}

export function requireFreeSpace(directory, requiredBytes, minFreeBytes, inspect = statfsSync) {
  const fs = inspect(directory);
  if (fs.bavail * fs.bsize < requiredBytes + minFreeBytes) throw new Error('Insufficient backup disk space');
}

function boundedFile(target, limits, maxBytes = limits.maxBytes) {
  let bytes = 0;
  const hash = createHash('sha256');
  const guard = new Transform({ transform(chunk, _encoding, callback) {
    try {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error('Backup exceeds database size limit');
      requireFreeSpace(dirname(target), chunk.length, limits.minFreeBytes);
      hash.update(chunk);
      callback(null, chunk);
    } catch (error) { callback(error); }
  } });
  return { guard, result: () => ({ bytes, sha256: hash.digest('hex') }) };
}

export async function hashFile(path, maxBytes) {
  let bytes = 0;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('Backup exceeds database size limit');
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}

export function checkDatabase(path) {
  const db = openDatabase(path, { readonly: true, fileMustExist: true, timeout: 3000 });
  try {
    if (!sqliteIsPatched(db.prepare('SELECT sqlite_version() AS v').get().v)) throw new Error('Unpatched SQLite');
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Backup integrity failed');
    if (db.pragma('foreign_key_check').length) throw new Error('Backup foreign key integrity failed');
    const columns = new Set(db.pragma('table_info(ingest_batches)').map(column => column.name));
    if (!columns.has('payload')) throw new Error('Missing backup payload table');
    // SQLite integrity_check cannot detect damaged compressed contents. Read
    // every retained payload, including expired/revoked/quarantined records,
    // and compare its original bytes with the immutable receipt hash.
    const rows = db.prepare(`SELECT b.payload, ${columns.has('codec') ? 'b.codec' : "'json'"} AS codec,
      ${columns.has('raw_bytes') ? 'b.raw_bytes' : 'NULL'} AS raw_bytes, r.payload_hash
      FROM ingest_batches b LEFT JOIN batch_receipts r
      ON r.participant_key=b.participant_key AND r.batch_id=b.batch_id`).iterate();
    for (const row of rows) {
      const raw = decodePayload(row.payload, row.codec, row.raw_bytes);
      if (createHash('sha256').update(raw).digest('hex') !== row.payload_hash) throw new Error('Backup payload hash mismatch');
    }
    return db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true });
  } finally { db.close(); }
}

export async function snapshotDatabase(source, target, limits) {
  const db = openDatabase(source, { readonly: true, fileMustExist: true, timeout: 3000 });
  try {
    if (!sqliteIsPatched(db.prepare('SELECT sqlite_version() AS v').get().v)) throw new Error('Unpatched SQLite');
    const pageSize = db.pragma('page_size', { simple: true });
    const bytes = db.pragma('page_count', { simple: true }) * pageSize;
    if (bytes > limits.maxBytes) throw new Error('Backup exceeds database size limit');
    requireFreeSpace(dirname(target), bytes, limits.minFreeBytes);
    await db.backup(target, { progress({ totalPages, remainingPages }) {
      if (totalPages * pageSize > limits.maxBytes) throw new Error('Backup exceeds database size limit');
      requireFreeSpace(dirname(target), remainingPages * pageSize, limits.minFreeBytes);
      return 200;
    } });
  } finally { db.close(); }
  chmodSync(target, 0o600);
  if (statSync(target).size > limits.maxBytes) throw new Error('Backup exceeds database size limit');
  checkDatabase(target);
}

export async function decompressBackup(source, target, limits) {
  const compressedBound = limits.maxBytes + Math.ceil(limits.maxBytes / 100) + 65536;
  if (statSync(source).size > compressedBound) throw new Error('Compressed backup exceeds size limit');
  requireFreeSpace(dirname(target), 0, limits.minFreeBytes);
  const output = boundedFile(target, limits);
  let inputBytes = 0;
  const input = new Transform({ transform(chunk, _encoding, callback) {
    inputBytes += chunk.length;
    callback(inputBytes > compressedBound ? new Error('Compressed backup exceeds size limit') : null, chunk);
  } });
  await pipeline(createReadStream(source), input, createGunzip(), output.guard, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
  return output.result();
}

export async function compressBackup(source, target, verificationPath, limits) {
  const original = await hashFile(source, limits.maxBytes);
  // Incompressible input can grow slightly. Reserve both compressed output and
  // the verified round-trip SQLite copy, in addition to the existing snapshot.
  const compressedBound = original.bytes + Math.ceil(original.bytes / 100) + 65536;
  requireFreeSpace(dirname(target), compressedBound + original.bytes, limits.minFreeBytes);
  const output = boundedFile(target, limits, compressedBound);
  await pipeline(createReadStream(source), createGzip({ level: 6 }), output.guard, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
  const compressed = output.result();
  const decoded = await decompressBackup(target, verificationPath, { ...limits, maxBytes: original.bytes });
  if (decoded.bytes !== original.bytes || decoded.sha256 !== original.sha256) throw new Error('Compressed backup round-trip mismatch');
  checkDatabase(verificationPath);
  return { bytes: compressed.bytes, uncompressedBytes: original.bytes, sha256: compressed.sha256, uncompressedSha256: original.sha256 };
}

export function publishBackup(pending, target) {
  chmodSync(pending, 0o600);
  const fd = openSync(pending, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  // Same-filesystem hard link is atomic and fails if another writer wins. It
  // never replaces a pre-existing backup, including a dangling symlink.
  linkSync(pending, target);
  try {
    const directory = openSync(dirname(target), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) { unlinkSync(target); throw error; }
}
