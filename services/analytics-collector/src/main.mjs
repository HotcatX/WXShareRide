import { createCollector } from './server.mjs';
import { readConfig } from './config.mjs';

process.umask(0o077);
const config = readConfig();
const app = createCollector(config);
await app.start();
process.stdout.write(JSON.stringify({ event: 'started', realCollectionEnabled: config.realEnabled, sqliteVersion: app.store.sqliteVersion }) + '\n');
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  if (closing) return; closing = true;
  const deadline = setTimeout(() => process.exit(1), 15_000); deadline.unref();
  await app.close(); clearTimeout(deadline); process.exit(0);
});
