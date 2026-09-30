import { TABLES } from '../src/schema.mjs';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { backupLimits, snapshotDatabase, decompressBackup, checkDatabase, publishBackup } from '../src/backup.mjs';

// Creates a quarantined RESTORE CANDIDATE; never overwrites the live database.
process.umask(0o077);
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: restore-check.mjs backup.sqlite[.gz] NEW-candidate.sqlite');
const source = resolve(process.argv[2]); const target = resolve(process.argv[3]);
if (source === target || existsSync(target)) throw new Error('Restore target must be new');
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
// The container's /tmp is only 32 MiB. Keep bounded temporary work on the same
// disk as the target, inside a private directory, and clean every failure path.
const temporary = mkdtempSync(join(dirname(target), '.collector-restore-'));
chmodSync(temporary, 0o700);
try {
  const limits = backupLimits();
  const pending = join(temporary, 'candidate.sqlite');
  if (source.endsWith('.gz')) {
    await decompressBackup(source, pending, limits);
    checkDatabase(pending);
  } else await snapshotDatabase(source, pending, limits);
  // Upgrade old backups only in the private candidate before it is published.
  const candidate = openStore(pending, { maxDatabaseMB: limits.maxDatabaseMB });
  const restored = candidate.db;
  let summary;
  try {
    restored.pragma('synchronous = FULL');
    if (restored.prepare("UPDATE collector_settings SET value='closed' WHERE key='restore_gate'").run().changes !== 1) throw new Error('Missing restore gate');
    if (restored.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Restored integrity failed');
    const participants = restored.prepare(`SELECT COUNT(*) AS n FROM ${TABLES.participants}`).get().n;
    const batches = restored.prepare('SELECT COUNT(*) AS n FROM ingest_batches').get().n;
    summary = { ok: true, target, restoreGate: 'closed', participants, batches };
    const checkpoint = restored.pragma('wal_checkpoint(TRUNCATE)');
    if (checkpoint.some(row => row.busy)) throw new Error('Restore checkpoint incomplete');
  } finally { candidate.close(); }
  checkDatabase(pending);
  publishBackup(pending, target);
  process.stdout.write(JSON.stringify(summary) + '\n');
} finally { rmSync(temporary, { recursive: true, force: true }); }
