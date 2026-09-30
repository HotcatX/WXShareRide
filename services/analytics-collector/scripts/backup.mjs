import { mkdirSync, chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { backupLimits, snapshotDatabase, compressBackup, hashFile, publishBackup } from '../src/backup.mjs';

process.umask(0o077);
const source = resolve(process.env.DB_PATH || './data/collector.sqlite');
const target = resolve(process.argv[2] || join(process.env.BACKUP_DIR || './data/backups', `collector-${new Date().toISOString().replaceAll(':', '-')}.sqlite.gz`));
if (target === source || existsSync(target)) throw new Error('Backup destination must be new and distinct');
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
const temporary = mkdtempSync(join(dirname(target), '.collector-backup-'));
chmodSync(temporary, 0o700);
try {
  const limits = backupLimits();
  const snapshot = join(temporary, 'snapshot.sqlite');
  await snapshotDatabase(source, snapshot, limits);
  const compressed = target.endsWith('.gz');
  const pending = compressed ? join(temporary, 'snapshot.sqlite.gz') : snapshot;
  const summary = compressed
    ? await compressBackup(snapshot, pending, join(temporary, 'verified.sqlite'), limits)
    : await hashFile(snapshot, limits.maxBytes);
  publishBackup(pending, target);
  process.stdout.write(JSON.stringify({ ok: true, backup: target, compression: compressed ? 'gzip' : 'none', ...summary }) + '\n');
} finally { rmSync(temporary, { recursive: true, force: true }); }
