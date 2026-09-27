import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { createPool } from '../src/db.ts';
import { importSnapshot, ImportAuditError } from '../src/migration/import.ts';
import { auditImportManifest, ImportManifestError } from '../src/migration/manifest.ts';

const usage = 'Usage: node scripts/import.ts --manifest /absolute/private/manifest.json --expected-app-id wx… [--apply --expected-source-sha256 HASH --accepted-manifest-sha256 HASH]';
type Arguments = { manifest: string; appId: string; apply: boolean; sourceHash?: string; manifestHash?: string };
function parseArguments(args: string[]): Arguments {
  const values = new Map<string, string>(); let apply = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--apply' && !apply) { apply = true; continue; }
    if (!['--manifest', '--expected-app-id', '--expected-source-sha256', '--accepted-manifest-sha256'].includes(key) || values.has(key) ||
      !args[i + 1] || args[i + 1]!.startsWith('--')) throw new ImportManifestError('INVALID_IMPORT_ARGUMENTS');
    values.set(key, args[++i]!);
  }
  if (!values.has('--manifest') || !values.has('--expected-app-id') ||
      apply !== (values.has('--expected-source-sha256') && values.has('--accepted-manifest-sha256')) ||
      !apply && (values.has('--expected-source-sha256') || values.has('--accepted-manifest-sha256'))) throw new ImportManifestError('INVALID_IMPORT_ARGUMENTS');
  return { manifest: values.get('--manifest')!, appId: values.get('--expected-app-id')!, apply,
    sourceHash: values.get('--expected-source-sha256'), manifestHash: values.get('--accepted-manifest-sha256') };
}

/** Default is offline audit. Applying accepts a concrete reviewed bundle, not
 * evidence that the cloud is frozen. Record actual writer/permission/timer and
 * collector drain verification separately before invoking this command.
 * This command neither switches authority nor activates jobs or client code. */
export async function runImport(args: string[], environment: NodeJS.ProcessEnv = process.env): Promise<{ exitCode: number; result: Record<string, unknown> }> {
  const input = parseArguments(args);
  const bundle = await auditImportManifest(input.manifest, input.appId);
  if (!input.apply) return { exitCode: bundle.report.ready ? 0 : 1, result: { mode: 'audit', ...bundle.summary } };
  if (!bundle.report.ready) throw new ImportAuditError(bundle.report);
  if (input.sourceHash !== bundle.summary.sourceSha256 || input.manifestHash !== bundle.manifestSha256) throw new ImportManifestError('IMPORT_ACCEPTANCE_MISMATCH');
  const config = loadConfig(environment);
  if (config.businessMode !== 'staged' || config.appId !== input.appId) throw new ImportManifestError('IMPORT_REQUIRES_STAGED_TARGET');
  const pool = createPool(config.databaseUrl);
  try {
    const receipt = await importSnapshot(pool, bundle.source, input.appId, bundle.observation);
    return { exitCode: 0, result: { mode: 'apply', ...bundle.summary, imported: true, receipt } };
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const output = await runImport(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(output.result)}\n`); process.exitCode = output.exitCode;
  } catch (error) {
    // Never print private file paths, source values, DB URLs or driver errors.
    const code = error instanceof ImportManifestError ? error.code : error instanceof ImportAuditError ? 'IMPORT_AUDIT_FAILED' : 'IMPORT_FAILED';
    process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
    if (code === 'INVALID_IMPORT_ARGUMENTS') process.stderr.write(`${usage}\n`);
    process.exitCode = 2;
  }
}
