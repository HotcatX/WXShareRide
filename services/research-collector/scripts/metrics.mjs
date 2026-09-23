import Database from 'better-sqlite3';
import { readSafeMetrics } from '../src/metrics.mjs';
const db = new Database(process.env.DB_PATH || './data/collector.sqlite', { readonly: true, fileMustExist: true, timeout: 3000 });
try { process.stdout.write(JSON.stringify({ ok: true, ...readSafeMetrics(db) }) + '\n'); }
finally { db.close(); }
