import { openStore } from '../src/store.mjs';
process.umask(0o077);
const store = openStore(process.env.DB_PATH || './data/collector.sqlite');
try {
  process.stdout.write(JSON.stringify({ ok: true, ...store.prune() }) + '\n');
} finally { store.close(); }
