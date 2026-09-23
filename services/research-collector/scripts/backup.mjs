import Database from 'better-sqlite3';
import { mkdirSync, chmodSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { sqliteIsPatched } from '../src/store.mjs';

process.umask(0o077);
const source = resolve(process.env.DB_PATH || './data/collector.sqlite');
const target = resolve(process.argv[2] || join(process.env.BACKUP_DIR || './data/backups', `collector-${new Date().toISOString().replaceAll(':', '-')}.sqlite`));
if (target === source || existsSync(target)) throw new Error('Backup destination must be new and distinct');
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
const db = new Database(source, { readonly: true, fileMustExist: true, timeout: 3000 });
try {
  if (!sqliteIsPatched(db.prepare('SELECT sqlite_version() AS v').get().v)) throw new Error('Unpatched SQLite');
  await db.backup(target);
  chmodSync(target, 0o600);
  const copy = new Database(target, { readonly: true, fileMustExist: true });
  try { if (copy.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Backup integrity failed'); }
  finally { copy.close(); }
  process.stdout.write(JSON.stringify({ ok: true, backup: target }) + '\n');
} catch (error) {
  if (existsSync(target)) unlinkSync(target);
  throw error;
} finally { db.close(); }
