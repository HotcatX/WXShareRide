import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditImportManifest, importAppId, importCollections, importEnvironment } from '../src/migration/manifest.ts';
import type { ImportManifest } from '../src/migration/manifest.ts';
import { serializeSource, sourceHash } from '../src/migration/source.ts';
import type { CloudBaseExport } from '../src/migration/types.ts';

const pageSize = 500, inventoryLimit = 100, maxFileBytes = 64 * 1024 * 1024, maxBundleBytes = 256 * 1024 * 1024;
const usage = 'Usage: node scripts/export.ts --output /absolute/new-private-directory --expected-app-id wx… --expected-env cloud… [--client Codex]';
type Options = { output: string; appId: typeof importAppId; environment: typeof importEnvironment; client: string };
type Command = { executable: string; prefix?: string[]; timeoutMs?: number };
type JsonRecord = Record<string, unknown>;
export class ExportError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'ExportError'; this.code = code; }
}
function fail(code: string): never { throw new ExportError(code); }
const record = (value: unknown): value is JsonRecord => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;
const timestamp = () => new Date().toISOString();
async function save(path: string, value: unknown) { await writeFile(path, serializeSource(value), { flag: 'wx', mode: 0o600 }); }

function parseArguments(args: string[]): Options {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (!['--output', '--expected-app-id', '--expected-env', '--client'].includes(key) || values.has(key) ||
        !args[i + 1] || args[i + 1]!.startsWith('--')) fail('INVALID_EXPORT_ARGUMENTS');
    values.set(key, args[++i]!);
  }
  const output = values.get('--output') || '', appId = values.get('--expected-app-id') || '',
    environment = values.get('--expected-env') || '', client = values.get('--client') || 'Codex';
  if (!isAbsolute(output) || appId !== importAppId || environment !== importEnvironment || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(client)) fail('INVALID_EXPORT_ARGUMENTS');
  return { output, appId, environment, client };
}

async function readJson(path: string): Promise<unknown> {
  const size = (await stat(path)).size;
  if (size < 2 || size > maxFileBytes) fail('EXPORT_INVALID_RESPONSE');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(path))); }
  catch { return fail('EXPORT_INVALID_RESPONSE'); }
}

// Real CLI stdout goes straight to a private descriptor: exec/pipe maxBuffer
// truncation cannot silently turn a large document page into a partial export.
async function capture(command: Command, args: string[], rawDirectory: string, name: string) {
  const stdoutName = `${name}-response.json`, stderrName = `${name}-stderr.txt`;
  const stdout = await open(join(rawDirectory, stdoutName), 'wx', 0o600);
  const stderr = await open(join(rawDirectory, stderrName), 'wx', 0o600);
  const startedAt = timestamp(); let timedOut = false;
  let result: { exitCode: number | null; signal: NodeJS.Signals | null; spawnFailed: boolean };
  try {
    result = await new Promise(resolve => {
      const child = spawn(command.executable, [...command.prefix || [], ...args], {
        shell: false, stdio: ['ignore', stdout.fd, stderr.fd]
      });
      let spawnFailed = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, command.timeoutMs ?? 60_000);
      child.on('error', () => { spawnFailed = true; });
      child.on('close', (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal, spawnFailed }); });
    });
    await stdout.sync(); await stderr.sync();
  } finally { await Promise.all([stdout.close(), stderr.close()]); }
  const finishedAt = timestamp();
  await save(join(rawDirectory, `${name}-metadata.json`), { startedAt, finishedAt, ...result, timedOut,
    stdout: stdoutName, stderr: stderrName });
  if (timedOut || result.spawnFailed || result.exitCode !== 0 || result.signal) fail(timedOut ? 'EXPORT_COMMAND_TIMEOUT' : 'EXPORT_COMMAND_FAILED');
  return readJson(join(rawDirectory, stdoutName));
}

function resultOf(value: unknown, tool: string): JsonRecord {
  if (!record(value) || value.ok !== true || value.tool !== tool || !record(value.result) || value.result.success !== true ||
      value.pending === true || value.result.pending === true) fail('EXPORT_INVALID_RESPONSE');
  return value.result as JsonRecord;
}
function pagerOf(result: JsonRecord, limit: number, total: number) {
  const pager = result.pager;
  if (!record(pager) || pager.Offset !== 0 || pager.Limit !== limit || pager.Total !== total) fail('EXPORT_INVALID_PAGER');
}
function inventoryOf(value: unknown): Map<string, number> {
  const result = resultOf(value, 'cloud_db_read_struct'), rows = result.collections;
  pagerOf(result, inventoryLimit, importCollections.length);
  if (!Array.isArray(rows) || rows.length !== importCollections.length) fail('EXPORT_INVALID_INVENTORY');
  const inventory = new Map<string, number>();
  for (const row of rows) {
    if (!record(row) || typeof row.TableName !== 'string' || !importCollections.some(name => name === row.TableName) ||
        !count(row.Count) || inventory.has(row.TableName)) fail('EXPORT_INVALID_INVENTORY');
    inventory.set(row.TableName, row.Count);
  }
  return inventory;
}
function pageOf(value: unknown, name: string, remaining: number): JsonRecord[] {
  const result = resultOf(value, 'cloud_db_read_doc');
  if (result.collection !== name || result.collectionName !== name || result.total !== remaining || !Array.isArray(result.data)) fail('EXPORT_PAGE_DRIFT');
  pagerOf(result, pageSize, remaining);
  if (result.data.length !== Math.min(pageSize, remaining) || !result.data.every(record)) fail('EXPORT_PAGE_DRIFT');
  return result.data as JsonRecord[];
}

/** Read-only export. A matching inventory and a successful import audit do not
 * prove stopped writers: keyset pages remain a non-atomic observation. Before a
 * final handoff the operator must independently verify writers/rules/triggers,
 * drain old receipts/outbox, and check the current logged-in DevTools session.
 * The command never activates authority, freezes a function, or opens PostgreSQL.
 * `command` exists only for local fake-CLI tests, never as a user input flag. */
export async function runExport(args: string[], command: Command = { executable: 'wechatide' }) {
  const input = parseArguments(args), rawDirectory = join(input.output, 'raw');
  try { await mkdir(input.output, { mode: 0o700 }); }
  catch { return fail('EXPORT_DIRECTORY_UNAVAILABLE'); }
  let collectionCount = 0, documentCount = 0;
  try {
    await mkdir(rawDirectory, { mode: 0o700 });
    const startedAt = timestamp(), base = ['-c', input.client], target = ['--appid', input.appId, '--env', input.environment];
    const inventoryArgs = [...base, 'cloud_db_read_struct', ...target, '--action', 'listCollections', '--limit', String(inventoryLimit), '--offset', '0'];
    const before = inventoryOf(await capture(command, inventoryArgs, rawDirectory, 'inventory-before'));
    const sortPath = join(rawDirectory, 'sort.json'); await save(sortPath, [{ key: '_id', direction: 1 }]);
    const source: CloudBaseExport = { kind: 'cloudbase-full-export', appId: input.appId, collections: {} };
    const collections: ImportManifest['collections'] = []; let bundleBytes = 0;
    for (const name of importCollections) {
      const collectionStartedAt = timestamp(), expected = before.get(name)!;
      const documents: JsonRecord[] = []; let lastId: string | undefined, page = 0;
      // Always request an actual terminal empty page, even after a short page.
      for (;;) {
        const label = `${name}-page-${String(page++).padStart(4, '0')}`, queryPath = join(rawDirectory, `${label}-query.json`);
        await save(queryPath, lastId === undefined ? {} : { _id: { $gt: lastId } });
        const response = await capture(command, [...base, 'cloud_db_read_doc', ...target,
          '--collection-name', name, '--query-file', queryPath, '--sort-file', sortPath,
          '--limit', String(pageSize), '--offset', '0'], rawDirectory, label);
        const rows = pageOf(response, name, expected - documents.length);
        for (const row of rows) {
          const id = row._id;
          if (typeof id !== 'string' || !id.trim() || lastId !== undefined && Buffer.compare(Buffer.from(id), Buffer.from(lastId)) <= 0) fail('EXPORT_INVALID_CURSOR');
          lastId = id; documents.push(row);
        }
        if (!rows.length) break;
      }
      const text = serializeSource(documents), bytes = Buffer.byteLength(text);
      bundleBytes += bytes;
      if (bytes > maxFileBytes || bundleBytes > maxBundleBytes) fail('EXPORT_BUNDLE_TOO_LARGE');
      const file = `${name}.json`; await writeFile(join(input.output, file), text, { flag: 'wx', mode: 0o600 });
      source.collections[name] = documents;
      collections.push({ name, file, bytes, sha256: sourceHash(text), rows: documents.length,
        inventoryBefore: expected, inventoryAfter: expected, startedAt: collectionStartedAt, finishedAt: timestamp() });
      collectionCount++; documentCount += documents.length;
    }
    const after = inventoryOf(await capture(command, inventoryArgs, rawDirectory, 'inventory-after'));
    for (const name of importCollections) if (after.get(name) !== before.get(name)) fail('EXPORT_INVENTORY_DRIFT');
    const finishedAt = timestamp(), sourceSha256 = sourceHash(serializeSource(source));
    const manifest: ImportManifest = { kind: 'linkx-cloudbase-import-manifest', version: 1, appId: input.appId,
      environment: input.environment, snapshotConsistency: 'non-atomic', startedAt, finishedAt,
      sourceSha256, observation: { sourceSha256, at: finishedAt }, collections };
    const candidate = join(input.output, 'candidate-manifest.json'); await save(candidate, manifest);
    const audit = await auditImportManifest(candidate, input.appId);
    await save(join(input.output, 'audit.json'), audit.summary);
    if (audit.report.ready) await rename(candidate, join(input.output, 'manifest.json'));
    // On an audit failure the complete evidence and candidate remain available;
    // only a successfully audited bundle receives the final manifest filename.
    return { exitCode: audit.report.ready ? 0 : 1, result: { mode: 'export', exported: true, ...audit.summary } };
  } catch (error) {
    const code = error instanceof ExportError ? error.code : 'EXPORT_FAILED';
    await save(join(input.output, 'failure.json'), { ok: false, code, failedAt: timestamp(), collections: collectionCount, rows: documentCount }).catch(() => {});
    throw new ExportError(code);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const output = await runExport(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(output.result)}\n`); process.exitCode = output.exitCode;
  } catch (error) {
    const code = error instanceof ExportError ? error.code : 'EXPORT_FAILED';
    process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
    if (code === 'INVALID_EXPORT_ARGUMENTS') process.stderr.write(`${usage}\n`);
    process.exitCode = 2;
  }
}
