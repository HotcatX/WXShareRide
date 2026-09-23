import { createPublicReadPilot } from './server.mjs';
import { loadSyncKey } from './sync.mjs';

const port = Number(process.env.PORT || 3100);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
const readSetting = process.env.PUBLIC_STATS_READ_ENABLED || 'true';
if (!['true', 'false'].includes(readSetting)) throw new Error('PUBLIC_STATS_READ_ENABLED_INVALID');
const syncKey = loadSyncKey(process.env.PUBLIC_STATS_SYNC_KEY_FILE);
const log = value => process.stdout.write(JSON.stringify(value) + '\n');
const server = createPublicReadPilot({ snapshotPath: process.env.SNAPSHOT_PATH || './snapshot.json',
  syncKey, readEnabled: readSetting === 'true', log });
server.listen(port, process.env.HOST || '127.0.0.1', () => {
  log({ event: 'public-read-pilot-started', at: Date.now(), readEnabled: readSetting === 'true', syncEnabled: !!syncKey });
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10_000).unref();
});
