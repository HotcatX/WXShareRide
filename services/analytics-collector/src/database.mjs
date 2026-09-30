import Database from 'better-sqlite3';
import { decodePayload } from './payload.mjs';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// All readers of persisted views register the same bounded decoder. This does
// not migrate, write to, or relax authorization on the opened database.
export function openDatabase(path, options = {}) {
  const db = new Database(path, options);
  db.function('payload_json', { deterministic: true }, (payload, codec, rawBytes) => {
    const raw = decodePayload(payload, codec, rawBytes);
    try { return utf8.decode(raw); }
    catch { throw new Error('Invalid stored payload'); }
  });
  return db;
}
