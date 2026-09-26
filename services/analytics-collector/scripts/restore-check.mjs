import { TABLES } from '../src/compat/legacy.mjs';
import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, linkSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { sqliteIsPatched } from '../src/store.mjs';

// Creates a quarantined RESTORE CANDIDATE; never overwrites the live database.
process.umask(0o077);
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: restore-check.mjs backup.sqlite NEW-candidate.sqlite');
const source = resolve(process.argv[2]); const target = resolve(process.argv[3]);
if (source === target || existsSync(target)) throw new Error('Restore target must be new');
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
const pending = `${target}.pending-${randomUUID()}`;
const db = new Database(source, { readonly: true, fileMustExist: true });
try {
  if (!sqliteIsPatched(db.prepare('SELECT sqlite_version() AS v').get().v)) throw new Error('Unpatched SQLite');
  if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Source integrity failed');
  await db.backup(pending);
} finally { db.close(); }
chmodSync(pending, 0o600);
const restored = new Database(pending);
let summary;
try {
  restored.pragma('synchronous = FULL');
  if (restored.prepare("UPDATE collector_settings SET value='closed' WHERE key='restore_gate'").run().changes !== 1) throw new Error('Missing restore gate');
  if (restored.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Restored integrity failed');
  const participants = restored.prepare(`SELECT COUNT(*) AS n FROM ${TABLES.participants}`).get().n;
  const batches = restored.prepare('SELECT COUNT(*) AS n FROM ingest_batches').get().n;
  summary = { ok: true, target, restoreGate: 'closed', participants, batches };
} finally { restored.close(); }
// Publish only an already-quarantined, closed candidate; link fails if target exists.
linkSync(pending, target);
unlinkSync(pending);
process.stdout.write(JSON.stringify(summary) + '\n');
