import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { runExport } from '../scripts/export.ts';
import { auditImportManifest, importAppId, importCollections, importEnvironment } from '../src/migration/manifest.ts';
import { getLocationCatalog } from '../src/locations/routes.ts';

const at = '2026-09-01T12:00:00.000Z';
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
function fullSource() {
  const catalog = getLocationCatalog(), collections: Record<string, Record<string, unknown>[]> = Object.fromEntries(importCollections.map(name => [name, []]));
  collections.PublicStats = [{ _id: 'home', servedTrips: 0, updatedAt: at }];
  collections.CITY_TREE = catalog.regionTree.map(state => ({ _id: state.key, ...Object.fromEntries(state.groups.map(group => [group.key, group.areas])) }));
  collections.cityTree = [{ _id: 'default', version: 1, updatedAt: at, ...catalog.cityTree }];
  collections.regionTree = [{ _id: 'default', version: 1, updatedAt: at, ...catalog.marketRegionTree }];
  collections.Request_Price = catalog.requestPrices.map((row, i) => ({ _id: `price-${i}`, Departure: row.fromAddress, Destination: row.toAddress, Price: row.label }));
  for (const name of ['Departure', 'Arrival', 'Departure_Request', 'Arrival_Request']) {
    const mode = name.endsWith('_Request') ? 'request' : 'offer', field = name.startsWith('Departure') ? 'fromPlaces' : 'toPlaces';
    collections[name] = [{ _id: 'default', ...Object.fromEntries(catalog.rideAddresses[mode][field].map((value, i) => [`place${i}`, value])) }];
  }
  return collections;
}

async function fixture(t: TestContext, mode = 'ok') {
  const directory = await mkdtemp(join(tmpdir(), 'linkx-export-test-'));
  await chmod(directory, 0o700); t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'private export'), fake = join(directory, 'fake.cjs'), input = join(directory, 'fixture.json');
  const log = join(directory, 'argv.jsonl'), counts = join(directory, 'inventory-count.txt'), collections = fullSource();
  async function save() { await writeFile(input, JSON.stringify({ mode, collections }), { mode: 0o600 }); }
  await save();
  // This is a separate executable, not an in-memory transport mock: assertions
  // exercise exact argv/files, CLI envelopes and real stdout descriptor writes.
  await writeFile(fake, `#!${process.execPath}
const fs=require('node:fs'),assert=require('node:assert/strict');
const fixture=JSON.parse(fs.readFileSync(${JSON.stringify(input)},'utf8'));
const args=process.argv.slice(2),tool=args[2],get=k=>args[args.indexOf(k)+1];
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
assert.equal(args[0],'-c');assert.equal(get('--appid'),${JSON.stringify(importAppId)});assert.equal(get('--env'),${JSON.stringify(importEnvironment)});
assert.equal(args.includes('--projection'),false);assert.equal(args.includes('--projection-file'),false);assert.equal(get('--offset'),'0');
const emit=result=>process.stdout.write(JSON.stringify({ok:true,tool,clientName:'Codex',result}));
if(fixture.mode==='exit'){process.stderr.write('private-provider-value');process.exitCode=9;}
else if(fixture.mode==='timeout'){setInterval(()=>{},1000);}
else if(fixture.mode==='malformed'){process.stdout.write('{private-provider-value');}
else if(fixture.mode==='pending'){process.stdout.write(JSON.stringify({ok:true,tool,pending:true,taskId:'synthetic',result:{success:true}}));}
else if(tool==='cloud_db_read_struct'){
 assert.equal(get('--action'),'listCollections');assert.equal(get('--limit'),'100');
 const n=fs.existsSync(${JSON.stringify(counts)})?+fs.readFileSync(${JSON.stringify(counts)},'utf8'):0;fs.writeFileSync(${JSON.stringify(counts)},String(n+1));
 const rows=Object.entries(fixture.collections).map(([TableName,data])=>({TableName,Count:data.length}));
 if(fixture.mode==='unknown')rows[0].TableName='referral_codes';
 if(fixture.mode==='duplicate-name')rows[0].TableName=rows[1].TableName;
 if(fixture.mode==='count-string')rows[0].Count=String(rows[0].Count);
 if(fixture.mode==='stale-inventory')for(const row of rows)row.Count+=n?3:1;
 emit({success:true,collections:rows,pager:{Offset:0,Limit:100,Total:fixture.mode==='inventory-truncated'?50:rows.length}});
}else{
 assert.equal(tool,'cloud_db_read_doc');const limit=+get('--limit');assert.ok([1,500].includes(limit));
 assert.deepEqual(JSON.parse(fs.readFileSync(get('--sort-file'),'utf8')),[{key:'_id',direction:1}]);
 const name=get('--collection-name'),query=JSON.parse(fs.readFileSync(get('--query-file'),'utf8'));
 assert.deepEqual(Object.keys(query),['_id']);assert.ok(Object.keys(query._id).length===1&&('$gt' in query._id||query._id.$exists===true));
 let rows=fixture.collections[name].slice().sort((a,b)=>Buffer.compare(Buffer.from(a._id),Buffer.from(b._id)));
 if('$gt' in query._id&&fixture.mode!=='ignored-cursor')rows=rows.filter(row=>Buffer.compare(Buffer.from(row._id),Buffer.from(query._id.$gt))>0);
 if(fixture.mode==='inventory-drift'&&limit===1&&name==='Arrival')rows.push({_id:'late-arrival'});
 const total=rows.length;rows=rows.slice(0,limit);
 if(fixture.mode==='short-page'&&rows.length)rows=[];
 if(fixture.mode==='duplicate-id'&&name==='Arrival'&&query._id.$exists){rows=[rows[0],rows[0]];}
 if(fixture.mode==='invalid-id'&&rows.length)rows[0]={...rows[0],_id:0};
 if(fixture.mode==='wrong-collection')emit({success:true,collection:'userInfo',collectionName:name,data:rows,total,pager:{Offset:0,Limit:limit,Total:total}});
 else emit({success:true,collection:name,collectionName:name,data:rows,total:fixture.mode==='wrong-total'?total+1:total,pager:{Offset:fixture.mode==='wrong-offset'?1:0,Limit:limit,Total:total}});
}
`, { mode: 0o700 });
  const args = ['--output', output, '--expected-app-id', importAppId, '--expected-env', importEnvironment];
  return { directory, output, fake, collections, save, args, command: { executable: process.execPath, prefix: [fake] },
    log: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]) };
}

test('real fake-CLI export preserves >64KiB pages, exact raw documents and dates, explicit target, keyset and terminal empty pages', async t => {
  const b = await fixture(t);
  b.collections.userInfo = Array.from({ length: 501 }, (_, i) => ({ _id: `user-${String(i).padStart(4, '0')}`,
    _openid: `synthetic-${i}`, name: 'Example '.repeat(12), createdAt: { $date: at } }));
  await b.save(); const start = Date.now();
  const result = await runExport(b.args, b.command);
  assert.equal(result.exitCode, 0, JSON.stringify(result.result.issues)); assert.equal(result.result.auditReady, true);
  assert.equal(result.result.cutoverVerified, false); assert.equal(result.result.snapshotConsistency, 'non-atomic');
  assert.equal(result.result.collections, 49);
  const audit = await auditImportManifest(join(b.output, 'manifest.json'), importAppId);
  assert.deepEqual(audit.source.collections.userInfo, b.collections.userInfo);
  assert.ok(Date.parse(audit.observation.at) >= start && Date.parse(audit.observation.at) <= Date.now());
  assert.ok((await lstat(join(b.output, 'raw', 'userInfo-page-0000-response.json'))).size > 65536);
  const calls = await b.log(), pages = calls.filter(args => args[2] === 'cloud_db_read_doc' && args.includes('userInfo') && args[args.indexOf('--limit') + 1] === '500');
  assert.equal(pages.length, 3); assert.equal(calls.filter(args => args[2] === 'cloud_db_read_struct').length, 2);
  assert.equal(calls.filter(args => args[2] === 'cloud_db_read_doc' && args[args.indexOf('--limit') + 1] === '1').length, 49);
  assert.deepEqual(JSON.parse(await readFile(join(b.output, 'raw', 'userInfo-page-0000-query.json'), 'utf8')), { _id: { $exists: true } });
  assert.deepEqual(JSON.parse(await readFile(join(b.output, 'raw', 'userInfo-page-0001-query.json'), 'utf8')), { _id: { $gt: 'user-0499' } });
  assert.equal(JSON.parse(await readFile(join(b.output, 'raw', 'userInfo-page-0002-response.json'), 'utf8')).result.data.length, 0);
  assert.equal((await lstat(b.output)).mode & 0o777, 0o700);
  for (const directory of [b.output, join(b.output, 'raw')]) for (const name of await readdir(directory)) {
    const info = await lstat(join(directory, name)); assert.equal(info.mode & 0o077, 0);
  }
  const metadata = JSON.parse(await readFile(join(b.output, 'raw', 'inventory-before-metadata.json'), 'utf8'));
  assert.equal(metadata.exitCode, 0); assert.ok(metadata.startedAt <= metadata.finishedAt);
});

test('stale structural inventory totals never replace precise before/after query counts', async t => {
  const b = await fixture(t, 'stale-inventory');
  const result = await runExport(b.args, b.command);
  assert.equal(result.exitCode, 0);
  const manifest = JSON.parse(await readFile(join(b.output, 'manifest.json'), 'utf8'));
  for (const collection of manifest.collections) {
    assert.equal(collection.inventoryBefore, b.collections[collection.name]!.length);
    assert.equal(collection.inventoryAfter, b.collections[collection.name]!.length);
  }
  const rawBefore = JSON.parse(await readFile(join(b.output, 'raw', 'inventory-before-response.json'), 'utf8'));
  assert.equal(rawBefore.result.collections[0].Count, b.collections.Arrival!.length + 1);
  assert.equal(JSON.parse(await readFile(join(b.output, 'raw', 'Arrival-count-after-response.json'), 'utf8')).result.total, b.collections.Arrival!.length);
});

test('unknown/missing inventory, duplicate collections, nonnumeric counts and post-export count drift never publish a final manifest', async t => {
  for (const mode of ['unknown', 'duplicate-name', 'count-string', 'inventory-truncated', 'inventory-drift']) {
    const b = await fixture(t, mode);
    await assert.rejects(runExport(b.args, b.command));
    await assert.rejects(lstat(join(b.output, 'manifest.json')));
    assert.equal(JSON.parse(await readFile(join(b.output, 'failure.json'), 'utf8')).ok, false);
  }
});

test('partial pages, wrong collection/total/pager, ignored cursor and duplicate/nonstring IDs reject while retaining provider evidence', async t => {
  for (const mode of ['short-page', 'wrong-collection', 'wrong-total', 'wrong-offset', 'ignored-cursor', 'invalid-id', 'duplicate-id']) {
    const b = await fixture(t, mode);
    if (mode === 'duplicate-id') { b.collections.Arrival!.push({ ...b.collections.Arrival![0]!, _id: 'second' }); await b.save(); }
    await assert.rejects(runExport(b.args, b.command));
    await assert.rejects(lstat(join(b.output, 'manifest.json')));
    assert.ok((await lstat(join(b.output, 'raw', 'Arrival-page-0000-response.json'))).size > 0);
  }
});

test('failed/truncated/pending commands are never retried, stdout/stderr are private evidence, and timeout kills only the child', async t => {
  for (const [mode, expected] of [['exit', 'EXPORT_COMMAND_FAILED'], ['malformed', 'EXPORT_INVALID_RESPONSE'],
    ['pending', 'EXPORT_INVALID_RESPONSE'], ['timeout', 'EXPORT_COMMAND_TIMEOUT']]) {
    const b = await fixture(t, mode);
    await assert.rejects(runExport(b.args, { ...b.command, timeoutMs: mode === 'timeout' ? 200 : 60000 }), code(expected!));
    assert.equal((await b.log()).length, 1);
    const metadata = JSON.parse(await readFile(join(b.output, 'raw', 'inventory-before-metadata.json'), 'utf8'));
    assert.equal(metadata.timedOut, mode === 'timeout');
    await assert.rejects(lstat(join(b.output, 'manifest.json')));
  }
});

test('prepared receipts or undelivered outbox create only an explicitly failed audit candidate, with raw sources intact', async t => {
  for (const name of ['OperationReceipts', 'TripActions']) {
    const b = await fixture(t);
    b.collections[name] = [{ _id: 'synthetic-pending', ...(name === 'OperationReceipts' ? { state: 'prepared' } : { deliveryState: 'pending' }) }];
    await b.save(); const result = await runExport(b.args, b.command);
    assert.equal(result.exitCode, 1); assert.equal(result.result.auditReady, false); assert.equal(result.result.cutoverVerified, false);
    await assert.rejects(lstat(join(b.output, 'manifest.json')));
    assert.ok((await lstat(join(b.output, 'candidate-manifest.json'))).size > 0);
    assert.deepEqual(JSON.parse(await readFile(join(b.output, `${name}.json`), 'utf8')), b.collections[name]);
  }
});

test('invalid target/options, an existing output directory and shell-like arguments cannot invoke or overwrite evidence', async t => {
  const b = await fixture(t);
  for (const invalid of [[...b.args, '--apply'], [...b.args, '--frozen'], [...b.args, '--client', 'Codex;echo private'],
    ['--output', b.output, '--expected-app-id', 'wrong', '--expected-env', importEnvironment]]) {
    await assert.rejects(runExport(invalid, b.command), code('INVALID_EXPORT_ARGUMENTS'));
  }
  await assert.rejects(b.log());
  await runExport(b.args, b.command);
  const original = await readFile(join(b.output, 'manifest.json'), 'utf8');
  await assert.rejects(runExport(b.args, b.command), code('EXPORT_DIRECTORY_UNAVAILABLE'));
  assert.equal(await readFile(join(b.output, 'manifest.json'), 'utf8'), original);
});

test('executable CLI uses the same exporter and emits only safe summaries/errors, not private provider output', async t => {
  const b = await fixture(t, 'exit'); await symlink(b.fake, join(b.directory, 'wechatide'));
  const child = spawnSync(process.execPath, ['scripts/export.ts', ...b.args], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, PATH: b.directory }, encoding: 'utf8', timeout: 30000
  });
  assert.equal(child.status, 2); assert.equal(child.stdout, '');
  assert.deepEqual(JSON.parse(child.stderr), { ok: false, code: 'EXPORT_COMMAND_FAILED' });
  assert.doesNotMatch(child.stderr, /private-provider-value|private export/);
  assert.equal(await readFile(join(b.output, 'raw', 'inventory-before-stderr.txt'), 'utf8'), 'private-provider-value');
  const good = await fixture(t); await symlink(good.fake, join(good.directory, 'wechatide'));
  const exported = spawnSync(process.execPath, ['scripts/export.ts', ...good.args], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, PATH: good.directory }, encoding: 'utf8', timeout: 30000
  });
  assert.equal(exported.status, 0, exported.stderr); assert.equal(exported.stderr, '');
  const summary = JSON.parse(exported.stdout);
  assert.equal(summary.mode, 'export'); assert.equal(summary.auditReady, true); assert.equal(summary.cutoverVerified, false);
  assert.equal(summary.manifestSha256, (await auditImportManifest(join(good.output, 'manifest.json'), importAppId)).manifestSha256);
});
