import { readFile } from 'node:fs/promises';
import { normalizeCloudBaseExport } from './normalize.ts';

// No cloud client or write mode. Keep the full export on trusted storage; stdout is counts only.
const path = process.argv[2];
if (!path || process.argv.length !== 3) {
  process.stderr.write('Usage: node src/migration/analyze.ts /absolute/path/full-export.json\n');
  process.exitCode = 2;
} else {
  try {
    const source: unknown = JSON.parse(await readFile(path, 'utf8'));
    const { report } = normalizeCloudBaseExport(source, { timeZone: 'America/New_York' });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ready ? 0 : 1;
  } catch {
    // JSON/file errors can include source text or a private path. Do not echo the exception.
    process.stderr.write('Unable to analyze export: verify readable JSON in the documented full-export format.\n');
    process.exitCode = 2;
  }
}
