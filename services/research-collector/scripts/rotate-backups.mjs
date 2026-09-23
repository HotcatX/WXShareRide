import { rotateBackups } from '../src/backup-retention.mjs';
import { resolve } from 'node:path';
process.umask(0o077);
try {
  process.stdout.write(JSON.stringify({ ok: true, ...rotateBackups(resolve(process.env.BACKUP_DIR || './data/backups')) }) + '\n');
} catch { process.stderr.write('{"ok":false,"error":"BACKUP_ROTATION_FAILED"}\n'); process.exitCode = 1; }
