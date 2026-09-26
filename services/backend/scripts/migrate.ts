import { loadConfig } from '../src/config.ts';
import { createPool } from '../src/db.ts';
import { runMigrations } from '../src/migration/apply.ts';
const pool = createPool(loadConfig().databaseUrl);
try { console.log(JSON.stringify({ applied: await runMigrations(pool) })); }
finally { await pool.end(); }
