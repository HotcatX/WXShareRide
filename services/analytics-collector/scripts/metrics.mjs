import { openDatabase } from '../src/database.mjs';
import { readSafeMetrics } from '../src/metrics.mjs';
const db = openDatabase(process.env.DB_PATH || './data/collector.sqlite', { readonly: true, fileMustExist: true, timeout: 3000 });
try { process.stdout.write(JSON.stringify({ ok: true, ...readSafeMetrics(db) }) + '\n'); }
finally { db.close(); }
