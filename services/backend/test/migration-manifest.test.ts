import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { getLocationCatalog } from '../src/locations/routes.ts';
import { importCollections, importAppId, importEnvironment, auditImportManifest } from '../src/migration/manifest.ts';
import type { ImportManifest } from '../src/migration/manifest.ts';
import { serializeSource, sourceHash } from '../src/migration/source.ts';
import { runImport } from '../scripts/import.ts';
import { createTestDatabase } from './helpers/database.ts';

const at = '2026-09-01T12:00:00.000Z', finish = '2026-09-01T12:10:00.000Z';
const code = (value: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === value;
function fullSource() {
  const catalog = getLocationCatalog();
  const collections: Record<string, unknown[]> = Object.fromEntries(importCollections.map(name => [name, []]));
  collections.PublicStats = [{ _id: 'home', servedTrips: 0, updatedAt: at }];
  collections.CITY_TREE = catalog.regionTree.map(state => ({ _id: state.key,
    ...Object.fromEntries(state.groups.map(group => [group.key, group.areas])) }));
  collections.cityTree = [{ _id: 'default', version: 1, updatedAt: at, ...catalog.cityTree }];
  collections.regionTree = [{ _id: 'default', version: 1, updatedAt: at, ...catalog.marketRegionTree }];
  collections.Request_Price = catalog.requestPrices.map((row, i) => ({ _id: `price-${i}`, Departure: row.fromAddress, Destination: row.toAddress, Price: row.label }));
  for (const name of ['Departure', 'Arrival', 'Departure_Request', 'Arrival_Request']) {
    const mode = name.endsWith('_Request') ? 'request' : 'offer', field = name.startsWith('Departure') ? 'fromPlaces' : 'toPlaces';
    collections[name] = [{ _id: 'default', ...Object.fromEntries(catalog.rideAddresses[mode][field].map((value, i) => [`place${i}`, value])) }];
  }
  return { kind: 'cloudbase-full-export' as const, appId: importAppId, collections };
}
async function bundle(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'linkx-import-manifest-'));
  await chmod(directory, 0o700); t.after(() => rm(directory, { recursive: true, force: true }));
  const source = fullSource(), path = join(directory, 'manifest.json');
  const manifest: ImportManifest = { kind: 'linkx-cloudbase-import-manifest', version: 1,
    appId: importAppId, environment: importEnvironment, snapshotConsistency: 'non-atomic', startedAt: at, finishedAt: finish,
    sourceSha256: '', observation: { sourceSha256: '', at: finish }, collections: [] };
  async function save() {
    manifest.collections = [];
    for (const name of importCollections) {
      const raw = serializeSource(source.collections[name]), file = `${name}.json`;
      await writeFile(join(directory, file), raw, { mode: 0o600 });
      manifest.collections.push({ name, file, bytes: Buffer.byteLength(raw), sha256: sourceHash(raw),
        rows: source.collections[name]!.length, inventoryBefore: source.collections[name]!.length,
        inventoryAfter: source.collections[name]!.length, startedAt: at, finishedAt: finish });
    }
    manifest.sourceSha256 = sourceHash(serializeSource(source));
    manifest.observation.sourceSha256 = manifest.sourceSha256;
    await saveManifest();
  }
  async function saveManifest() { await writeFile(path, JSON.stringify(manifest, null, 2), { mode: 0o600 }); }
  await save();
  const args = () => ['--manifest', path, '--expected-app-id', importAppId];
  const applyArgs = async () => [...args(), '--apply', '--expected-source-sha256', manifest.sourceSha256,
    '--accepted-manifest-sha256', sourceHash(await readFile(path, 'utf8'))];
  return { directory, path, source, manifest, save, saveManifest, args, applyArgs };
}

test('default offline audit covers all 49 arrays and binds exact files, source and explicit observation without claiming a frozen cloud', async t => {
  const b = await bundle(t), audit = await auditImportManifest(b.path, importAppId);
  assert.equal(audit.report.ready, true, JSON.stringify(audit.report.issues));
  assert.equal(audit.summary.collections, 49); assert.equal(audit.summary.cutoverVerified, false);
  assert.equal(audit.summary.snapshotConsistency, 'non-atomic');
  assert.deepEqual(audit.source, b.source);
  assert.equal(audit.observation.at, finish);
  const run = await runImport(b.args(), {});
  assert.equal(run.exitCode, 0); assert.equal(run.result.mode, 'audit'); assert.equal(run.result.imported, undefined);
  const child = spawnSync(process.execPath, ['scripts/import.ts', ...b.args()], { cwd: new URL('..', import.meta.url), env: {}, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).cutoverVerified, false);
});

test('unknown or omitted collections, duplicate names/files and false atomicity are rejected', async t => {
  const changes: ((m: any) => void)[] = [m => m.collections.pop(), m => m.collections[0].name = 'FutureUnknown',
    m => m.collections[0].name = m.collections[1].name, m => m.collections[0].file = m.collections[1].file,
    m => m.collections[0].file = 'manifest.json', m => m.snapshotConsistency = 'atomic', m => m.frozen = true,
    m => m.appId = 'wx0000000000000000', m => m.environment = 'another-cloud-environment'];
  for (const change of changes) {
    const b = await bundle(t); change(b.manifest); await b.saveManifest();
    await assert.rejects(auditImportManifest(b.path, importAppId));
  }
});

test('count drift, time drift, altered bytes, altered source or observation hashes cannot pass', async t => {
  const changes: ((m: ImportManifest) => void)[] = [m => m.collections[0]!.inventoryBefore++, m => m.collections[0]!.inventoryAfter++,
    m => m.collections[0]!.rows++, m => m.collections[0]!.bytes++, m => m.collections[0]!.sha256 = '0'.repeat(64),
    m => m.sourceSha256 = m.observation.sourceSha256 = '0'.repeat(64), m => m.observation.sourceSha256 = '0'.repeat(64),
    m => m.collections[0]!.startedAt = '2026-09-01T11:59:59.000Z', m => m.collections[0]!.finishedAt = '2026-09-01T12:11:00.000Z',
    m => m.finishedAt = '2026-09-01T11:00:00.000Z', m => m.observation.at = '2100-01-01T00:00:00.000Z'];
  for (const change of changes) {
    const b = await bundle(t); change(b.manifest); await b.saveManifest();
    await assert.rejects(auditImportManifest(b.path, importAppId));
  }
  const b = await bundle(t);
  await writeFile(join(b.directory, 'userInfo.json'), '[{"_id":"private-value"}]');
  await assert.rejects(auditImportManifest(b.path, importAppId), code('IMPORT_FILE_HASH_MISMATCH'));
});

test('private files only: reject path traversal, links, public modes, projections and malformed UTF-8', async t => {
  for (const file of ['../outside.json', '/tmp/outside.json', 'nested/inside.json']) {
    const b = await bundle(t); b.manifest.collections[0]!.file = file; await b.saveManifest();
    await assert.rejects(auditImportManifest(b.path, importAppId), code('INVALID_IMPORT_MANIFEST'));
  }
  const linked = await bundle(t), target = join(linked.directory, 'Arrival.json');
  await rm(target); await symlink(join(linked.directory, 'Carpool.json'), target);
  await assert.rejects(auditImportManifest(linked.path, importAppId), code('IMPORT_FILE_UNAVAILABLE'));
  const publicFile = await bundle(t); await chmod(join(publicFile.directory, 'Carpool.json'), 0o644);
  await assert.rejects(auditImportManifest(publicFile.path, importAppId), code('INVALID_IMPORT_FILE'));
  const publicDir = await bundle(t); await chmod(publicDir.directory, 0o755);
  await assert.rejects(auditImportManifest(publicDir.path, importAppId), code('IMPORT_DIRECTORY_NOT_PRIVATE'));
  const malformed = await bundle(t); await writeFile(join(malformed.directory, 'Carpool.json'), Buffer.from([0xff, 0xff]));
  await assert.rejects(auditImportManifest(malformed.path, importAppId), code('IMPORT_FILE_UNAVAILABLE'));
  const wrapped = await bundle(t), text = JSON.stringify({ ok: true, result: { data: [] } });
  await writeFile(join(wrapped.directory, 'Carpool.json'), text);
  Object.assign(wrapped.manifest.collections.find(row => row.name === 'Carpool')!, { bytes: Buffer.byteLength(text), sha256: sourceHash(text) }); await wrapped.saveManifest();
  await assert.rejects(auditImportManifest(wrapped.path, importAppId), code('IMPORT_COLLECTION_COUNT_MISMATCH'));
});

test('prepared receipts and pending outbox stay audit failures; no evidence flags can turn them into success', async t => {
  for (const name of ['OperationReceipts', 'TripActions']) {
    const b = await bundle(t);
    b.source.collections[name] = [{ _id: 'synthetic-pending', ...(name === 'OperationReceipts' ? { state: 'prepared' } : { deliveryState: 'pending' }) }];
    await b.save();
    const result = await runImport(b.args(), {});
    assert.equal(result.exitCode, 1); assert.equal(result.result.auditReady, false); assert.equal(result.result.cutoverVerified, false);
    await assert.rejects(runImport(await b.applyArgs(), {}), code('IMPORT_AUDIT_FAILED'));
  }
});

test('apply requires exact source and reviewed manifest hashes plus the existing staged application configuration before opening a pool', async t => {
  const b = await bundle(t), args = await b.applyArgs();
  const environment = { WECHAT_APP_ID: importAppId, DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/invalid', BUSINESS_MODE: 'staged' };
  const wrongHash = [...args]; wrongHash[wrongHash.length - 1] = '0'.repeat(64);
  await assert.rejects(runImport(wrongHash, environment), code('IMPORT_ACCEPTANCE_MISMATCH'));
  await assert.rejects(runImport(args, { ...environment, BUSINESS_MODE: 'active' }), code('IMPORT_REQUIRES_STAGED_TARGET'));
  await assert.rejects(runImport(args, { ...environment, WECHAT_APP_ID: 'wx0000000000000000' }), code('IMPORT_REQUIRES_STAGED_TARGET'));
  for (const invalid of [[...b.args(), '--apply'], [...b.args(), '--frozen'], [...b.args(), '--manifest', b.path]]) {
    await assert.rejects(runImport(invalid, environment), code('INVALID_IMPORT_ARGUMENTS'));
  }
  await b.saveManifest();
  await writeFile(b.path, (await readFile(b.path, 'utf8')) + '\n');
  await assert.rejects(runImport(args, environment), code('IMPORT_ACCEPTANCE_MISMATCH'));
});

test('executable CLI errors expose only stable codes, never private file paths or source values', async () => {
  const child = spawnSync(process.execPath, ['scripts/import.ts', '--manifest', '/private/secret-source.json', '--expected-app-id', importAppId],
    { cwd: new URL('..', import.meta.url), env: {}, encoding: 'utf8' });
  assert.equal(child.status, 2); assert.equal(child.stdout, '');
  assert.doesNotMatch(child.stderr, /secret-source|\/private/);
  assert.match(child.stderr, /IMPORT_DIRECTORY/);
});

test('real PostgreSQL apply uses the sole atomic importer, repeats the same receipt and rejects a different bundle on a nonempty target',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL, timeout: 30000 }, async t => {
    const db = await createTestDatabase(); t.after(db.close);
    const schema = (await db.pool.query('SELECT current_schema() name')).rows[0].name;
    const url = new URL(process.env.BACKEND_TEST_DATABASE_URL!); url.searchParams.set('options', `-c search_path=${schema}`);
    const environment = { DATABASE_URL: url.toString(), WECHAT_APP_ID: importAppId, BUSINESS_MODE: 'staged' };
    const b = await bundle(t);
    const child = spawnSync(process.execPath, ['scripts/import.ts', ...await b.applyArgs()],
      { cwd: new URL('..', import.meta.url), env: environment, encoding: 'utf8', timeout: 30000 });
    assert.equal(child.status, 0, child.stderr);
    const first = { exitCode: 0, result: JSON.parse(child.stdout) };
    assert.equal(first.exitCode, 0); assert.equal(first.result.imported, true); assert.equal(first.result.cutoverVerified, false);
    assert.deepEqual(await runImport(await b.applyArgs(), environment), first);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM migration_batches')).rows[0].n, 1);
    const sourceRows = (await db.pool.query('SELECT collection,source_id,document_json,sha256 FROM migration_sources')).rows;
    for (const name of importCollections) for (const document of b.source.collections[name]!) {
      const original = document as { _id: string }, stored = sourceRows.find(row => row.collection === name && row.source_id === original._id);
      assert.equal(stored.document_json, serializeSource(original)); assert.equal(stored.sha256, sourceHash(serializeSource(original)));
    }
    for (const table of ['users', 'sessions', 'business_events', 'idempotency_requests']) assert.equal((await db.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
    b.source.collections.PublicStats = [{ _id: 'home', servedTrips: 1, updatedAt: at }]; await b.save();
    await assert.rejects(runImport(await b.applyArgs(), environment), code('IMPORT_TARGET_NOT_EMPTY'));
    assert.equal((await db.pool.query('SELECT served_count FROM public_statistics')).rows[0].served_count, '0');
  });
