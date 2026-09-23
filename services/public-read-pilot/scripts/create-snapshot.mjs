import { readFileSync } from 'node:fs';
import { makeSnapshot, MAX_BYTES } from '../src/snapshot.mjs';

// Input is exactly the three-field public data object, not a database document,
// whole cloud SDK response, or a collection export. Stdout can be atomically installed.
try {
  const raw = readFileSync(process.argv[2] || 0);
  if (raw.length > MAX_BYTES) throw new Error('INPUT_TOO_LARGE');
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  const ttlMs = process.env.SNAPSHOT_TTL_MS === undefined ? undefined : Number(process.env.SNAPSHOT_TTL_MS);
  const snapshot = makeSnapshot(data, ttlMs === undefined ? {} : { ttlMs });
  process.stdout.write(JSON.stringify(snapshot) + '\n');
} catch {
  process.stderr.write('Snapshot input rejected: provide only valid _id, servedTrips and coverageText; TTL must be at most six hours.\n');
  process.exitCode = 1;
}
