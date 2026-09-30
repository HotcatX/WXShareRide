import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/database.mjs';
import { encodePayload, decodePayload } from '../src/payload.mjs';
import { SCHEMA_VERSION } from '../src/schema.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Run against an isolated copy or while the collector is stopped. Each chunk
// is atomic; an interrupted run can safely restart and reverify earlier rows.
// No receipt, ID, timestamp, authorization, view or schema is changed here.
export function compressPayloads(db, { apply = false, batchSize = 100 } = {}) {
  if (db.pragma('user_version', { simple: true }) !== SCHEMA_VERSION) throw new Error('Payload compression requires the current schema');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000 || db.inTransaction) throw new Error('Invalid compression options');
  const select = db.prepare(`SELECT b.rowid AS row_id,b.payload,b.codec,b.raw_bytes,r.payload_hash
    FROM ingest_batches b LEFT JOIN batch_receipts r
      ON r.participant_key=b.participant_key AND r.batch_id=b.batch_id
    WHERE (? IS NULL OR b.rowid>?) ORDER BY b.rowid LIMIT ?`);
  const update = apply ? db.prepare('UPDATE ingest_batches SET payload=?,codec=?,raw_bytes=? WHERE rowid=?') : null;
  const step = db.transaction(cursor => {
    const rows = select.all(cursor, cursor, batchSize);
    const result = { rows: rows.length, lastRow: cursor, rewritten: 0, rawBytes: 0, storedBytesBefore: 0, storedBytesAfter: 0 };
    for (const row of rows) {
      const raw = decodePayload(row.payload, row.codec, row.raw_bytes);
      if (hash(raw) !== row.payload_hash) throw new Error('Payload receipt hash mismatch');
      const encoded = row.codec === 'gzip'
        ? { payload: row.payload, codec: row.codec, rawBytes: raw.length } : encodePayload(raw);
      if (!decodePayload(encoded.payload, encoded.codec, encoded.rawBytes).equals(raw)) throw new Error('Payload round-trip mismatch');
      const changed = row.codec !== encoded.codec || row.raw_bytes !== encoded.rawBytes || !row.payload.equals(encoded.payload);
      if (changed && apply) update.run(encoded.payload, encoded.codec, encoded.rawBytes, row.row_id);
      result.lastRow = row.row_id; result.rewritten += Number(changed);
      result.rawBytes += raw.length; result.storedBytesBefore += row.payload.length; result.storedBytesAfter += encoded.payload.length;
    }
    return result;
  });
  const result = { ok: true, applied: apply, batches: 0, rewritten: 0, rawBytes: 0, storedBytesBefore: 0, storedBytesAfter: 0 };
  let cursor = null;
  for (;;) {
    const chunk = apply ? step.immediate(cursor) : step.deferred(cursor);
    if (!chunk.rows) break;
    cursor = chunk.lastRow;
    result.batches += chunk.rows;
    for (const key of ['rewritten', 'rawBytes', 'storedBytesBefore', 'storedBytesAfter']) result[key] += chunk[key];
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const [path, mode, ...extra] = process.argv.slice(2);
  if (!path || extra.length || (mode !== undefined && mode !== '--apply')) throw new Error('Usage: compress-payloads.mjs DATABASE [--apply]');
  const db = openDatabase(resolve(path), { readonly: mode !== '--apply', fileMustExist: true, timeout: 3000 });
  try { process.stdout.write(JSON.stringify(compressPayloads(db, { apply: mode === '--apply' })) + '\n'); }
  finally { db.close(); }
}
