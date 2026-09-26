import { loadConfig } from './config.ts';
import { createPool } from './db.ts';
import { createApp } from './app.ts';
import { createCosStorage } from './files/cos.ts';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
pool.on('error', () => process.stderr.write('{"level":"error","code":"DATABASE_CONNECTION"}\n'));
const storage = config.cos ? createCosStorage(config.cos) : undefined;
const app = await createApp({ config, pool, storage });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await pool.end();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
try {
  await app.listen({ host: config.host, port: config.port });
  process.stdout.write(JSON.stringify({ status: 'listening', port: config.port }) + '\n');
} catch {
  process.stderr.write('{"level":"error","code":"STARTUP_FAILED"}\n');
  await stop();
  process.exitCode = 1;
}
