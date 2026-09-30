import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { openDatabase } from '../src/database.mjs';
import { openStore } from '../src/store.mjs';
import { SCHEMA_VERSION } from '../src/schema.mjs';
import { backupLimits, checkDatabase, publishBackup, requireFreeSpace } from '../src/backup.mjs';
import { rotateBackups } from '../src/backup-retention.mjs';

const backupScript = new URL('../scripts/backup.mjs', import.meta.url).pathname;
const restoreScript = new URL('../scripts/restore-check.mjs', import.meta.url).pathname;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (script, args, env = {}) => spawnSync(process.execPath, [script, ...args], {
  encoding: 'utf8', env: { ...process.env, MIN_FREE_MB: '0', ...env },
});
const temporaryFiles = directory => readdirSync(directory).filter(name => /^\.collector-(?:backup|restore)-/.test(name));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'collector-backup-'));
  const source = join(dir, 'live.sqlite');
  const store = openStore(source);
  const participant = { participantKey: randomUUID(), grantId: randomUUID(), status: 'active', statusVersion: 1,
    purposeVersion: 'ride-analytics-v1', synthetic: true };
  store.applyState(participant);
  const body = { schemaVersion: 1, batchId: randomUUID(), events: Array.from({ length: 50 }, () => ({
    eventId: randomUUID(), eventName: 'page_view', schemaVersion: 1, occurredAt: Date.now(), data: { page: 'home' },
  })) };
  store.receive({ sub: participant.participantKey, ...participant }, Buffer.from(JSON.stringify(body)), body);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, source, store, participant, body };
}

test('explicit SQLite backup keeps its exact path and captures committed WAL data', t => {
  const f = fixture(t), target = join(f.dir, 'legacy-exact.sqlite');
  assert.ok(statSync(`${f.source}-wal`).size > 0);
  const result = run(backupScript, [target], { DB_PATH: f.source });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.backup, target); assert.equal(summary.compression, 'none');
  const bytes = readFileSync(target);
  assert.equal(bytes.subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.equal(summary.bytes, bytes.length); assert.equal(summary.sha256, hash(bytes));
  assert.equal(statSync(target).mode & 0o777, 0o600);
  const db = openDatabase(target, { readonly: true });
  try {
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM eligible_events').get().n, 50);
    assert.deepEqual(db.prepare('SELECT * FROM ingest_batches').all(), f.store.db.prepare('SELECT * FROM ingest_batches').all());
  } finally { db.close(); }
  assert.deepEqual(temporaryFiles(f.dir), []);
});

for (const explicit of [false, true]) test(`${explicit ? 'explicit' : 'default'} gzip backup verifies bytes and restores only a quarantined candidate`, t => {
  const f = fixture(t), requested = join(f.dir, 'explicit.sqlite.gz');
  const backup = run(backupScript, explicit ? [requested] : [], { DB_PATH: f.source, BACKUP_DIR: f.dir });
  assert.equal(backup.status, 0, backup.stderr);
  const summary = JSON.parse(backup.stdout), target = summary.backup;
  assert.equal(dirname(target), f.dir);
  if (explicit) assert.equal(target, requested);
  else assert.match(target, /collector-[\dT.Z-]+\.sqlite\.gz$/);
  assert.equal(summary.compression, 'gzip'); assert.equal(statSync(target).mode & 0o777, 0o600);
  const compressed = readFileSync(target), plain = gunzipSync(compressed);
  assert.equal(summary.bytes, compressed.length); assert.equal(summary.sha256, hash(compressed));
  assert.equal(summary.uncompressedBytes, plain.length); assert.equal(summary.uncompressedSha256, hash(plain));
  assert.ok(compressed.length < plain.length);
  const candidate = join(f.dir, 'restored.sqlite');
  const restoredRun = run(restoreScript, [target, candidate]);
  assert.equal(restoredRun.status, 0, restoredRun.stderr);
  assert.equal(JSON.parse(restoredRun.stdout).restoreGate, 'closed');
  assert.equal(statSync(candidate).mode & 0o777, 0o600);
  const restored = openStore(candidate);
  try {
    assert.equal(restored.db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(restored.db.prepare('SELECT * FROM ingest_batches').all(), f.store.db.prepare('SELECT * FROM ingest_batches').all());
    assert.equal(restored.db.prepare('SELECT COUNT(*) n FROM eligible_events').get().n, 0);
    assert.throws(() => restored.activeParticipant(f.participant.participantKey), /RESTORE_QUARANTINE/);
  } finally { restored.close(); }
  assert.equal(hash(readFileSync(target)), summary.sha256, 'restoration never mutates the archive');
  assert.deepEqual(temporaryFiles(f.dir), []);
});

test('gzip restoration upgrades a legacy v4 database without changing the source archive', t => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-old-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = join(dir, 'old.sqlite'), archive = join(dir, 'old.sqlite.gz'), target = join(dir, 'candidate.sqlite');
  const db = openDatabase(old);
  db.exec(readFileSync(new URL('./fixtures/schema-v4.sql', import.meta.url), 'utf8'));
  db.prepare('INSERT INTO collector_settings VALUES (?,?)').run('restore_gate', 'open');
  db.close();
  writeFileSync(archive, gzipSync(readFileSync(old)), { mode: 0o600 });
  const before = hash(readFileSync(archive));
  const result = run(restoreScript, [archive, target]);
  assert.equal(result.status, 0, result.stderr);
  const restored = openDatabase(target, { readonly: true });
  try {
    assert.equal(restored.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    assert.equal(restored.prepare("SELECT value FROM collector_settings WHERE key='restore_gate'").get().value, 'closed');
    assert.deepEqual(restored.pragma('foreign_key_check'), []);
  } finally { restored.close(); }
  assert.equal(hash(readFileSync(archive)), before);
});

test('truncated or corrupt gzip never publishes a candidate and removes its private temporary files', t => {
  const f = fixture(t), good = join(f.dir, 'good.sqlite.gz');
  assert.equal(run(backupScript, [good], { DB_PATH: f.source }).status, 0);
  const bytes = readFileSync(good), crc = Buffer.from(bytes); crc[crc.length - 8] ^= 255;
  for (const [name, data] of [['truncated', bytes.subarray(0, bytes.length - 8)], ['crc', crc], ['not-sqlite', gzipSync('not a SQLite database')]]) {
    const source = join(f.dir, `${name}.sqlite.gz`), target = join(f.dir, `${name}-candidate.sqlite`);
    writeFileSync(source, data);
    const result = run(restoreScript, [source, target]);
    assert.notEqual(result.status, 0, name);
    assert.ok(!readdirSync(f.dir).includes(`${name}-candidate.sqlite`));
    assert.deepEqual(temporaryFiles(f.dir), []);
  }
  assert.deepEqual(readFileSync(good), bytes);
});

for (const corruption of ['gzip', 'receipt']) test(`SQLite-valid ${corruption} corruption fails backup and restore even behind a closed restore gate`, async t => {
  const f = fixture(t), row = f.store.db.prepare('SELECT payload,codec FROM ingest_batches').get();
  assert.equal(row.codec, 'gzip');
  if (corruption === 'gzip') {
    const payload = Buffer.from(row.payload); payload[payload.length - 8] ^= 255;
    f.store.db.prepare('UPDATE ingest_batches SET payload=?').run(payload);
  } else f.store.db.prepare('UPDATE batch_receipts SET payload_hash=?').run('0'.repeat(64));
  f.store.db.prepare("UPDATE collector_settings SET value='closed' WHERE key='restore_gate'").run();
  assert.equal(f.store.db.pragma('integrity_check', { simple: true }), 'ok');
  const raw = join(f.dir, 'damaged.sqlite'); await f.store.backup(raw);
  assert.throws(() => checkDatabase(raw), /Invalid stored payload|payload hash mismatch/);
  const backupTarget = join(f.dir, 'must-not-publish.sqlite.gz');
  assert.notEqual(run(backupScript, [backupTarget], { DB_PATH: raw }).status, 0);
  const archive = join(f.dir, 'damaged.sqlite.gz'), candidate = join(f.dir, 'must-not-restore.sqlite');
  writeFileSync(archive, gzipSync(readFileSync(raw)));
  assert.notEqual(run(restoreScript, [archive, candidate]).status, 0);
  assert.ok(!readdirSync(f.dir).includes('must-not-publish.sqlite.gz'));
  assert.ok(!readdirSync(f.dir).includes('must-not-restore.sqlite'));
  assert.deepEqual(temporaryFiles(f.dir), []);
});

test('streamed restoration bounds decompressed bytes before parsing a high-ratio archive', t => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-bounded-restore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'large.sqlite.gz'), target = join(dir, 'candidate.sqlite');
  writeFileSync(source, gzipSync(Buffer.alloc(17 * 1024 * 1024)));
  const result = run(restoreScript, [source, target], { MAX_DATABASE_MB: '16' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /database size limit/);
  assert.deepEqual(readdirSync(dir), ['large.sqlite.gz']);
});

test('restoration also bounds compressed input before reading oversized headers or empty members', t => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-input-restore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'oversized.sqlite.gz'), target = join(dir, 'candidate.sqlite');
  writeFileSync(source, Buffer.alloc(17 * 1024 * 1024));
  const result = run(restoreScript, [source, target], { MAX_DATABASE_MB: '16' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Compressed backup exceeds size limit/);
  assert.deepEqual(readdirSync(dir), ['oversized.sqlite.gz']);
});

test('failed native backup preserves other files and leaves no published or temporary backup', t => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-bad-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'invalid.sqlite'), target = join(dir, 'candidate.sqlite.gz'), existing = join(dir, 'existing.sqlite.gz');
  writeFileSync(source, 'invalid SQLite'); writeFileSync(existing, 'existing evidence');
  const result = run(backupScript, [target], { DB_PATH: source });
  assert.notEqual(result.status, 0);
  assert.deepEqual(readdirSync(dir).sort(), ['existing.sqlite.gz', 'invalid.sqlite']);
  assert.equal(readFileSync(existing, 'utf8'), 'existing evidence');
});

test('backup and restore never replace an existing target or dangling target symlink', t => {
  const f = fixture(t), target = join(f.dir, 'keep.sqlite.gz');
  writeFileSync(target, 'keep these exact bytes');
  assert.notEqual(run(backupScript, [target], { DB_PATH: f.source }).status, 0);
  assert.notEqual(run(restoreScript, [f.source, target]).status, 0);
  assert.equal(readFileSync(target, 'utf8'), 'keep these exact bytes');
  const dangling = join(f.dir, 'dangling.sqlite.gz'); symlinkSync(join(f.dir, 'missing'), dangling);
  assert.notEqual(run(backupScript, [dangling], { DB_PATH: f.source }).status, 0);
  assert.ok(lstatSync(dangling).isSymbolicLink());
  assert.deepEqual(temporaryFiles(f.dir), []);
});

test('atomic publication refuses a target created after preflight', t => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-publish-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pending = join(dir, 'pending'), target = join(dir, 'winner');
  writeFileSync(pending, 'pending'); writeFileSync(target, 'winner');
  assert.throws(() => publishBackup(pending, target), /EEXIST/);
  assert.equal(readFileSync(target, 'utf8'), 'winner');
});

test('rotation applies the same seven-day boundary to native and gzip files only', t => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-rotate-gzip-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = Date.now(), day = 86400000;
  const name = (age, suffix = '.sqlite') => `collector-${new Date(now - age * day).toISOString().replaceAll(':', '-')}${suffix}`;
  for (const file of [name(7), name(7, '.sqlite.gz'), name(6), name(6, '.sqlite.gz'), name(8, '.sqlite.gz.pending'), 'operator-evidence.sqlite.gz']) writeFileSync(join(dir, file), 'data');
  symlinkSync(join(dir, 'operator-evidence.sqlite.gz'), join(dir, name(9, '.sqlite.gz')));
  mkdirSync(join(dir, name(10, '.sqlite.gz')));
  assert.equal(rotateBackups(dir, now).removed, 2);
  assert.equal(readdirSync(dir).length, 6);
  assert.ok(lstatSync(join(dir, name(9, '.sqlite.gz'))).isSymbolicLink());
});

test('backup bounds reuse validated database capacity and reserve disk space', () => {
  assert.equal(backupLimits({}).maxBytes, 1024 ** 3);
  assert.equal(backupLimits({ MAX_DATABASE_MB: '16', MIN_FREE_MB: '0' }).maxBytes, 16 * 1024 ** 2);
  for (const value of ['NaN', 'Infinity', '-1', '0', '16385', '3.5']) assert.throws(() => backupLimits({ MAX_DATABASE_MB: value }), /Invalid backup limits/);
  const disk = () => ({ bavail: 10, bsize: 1024 });
  assert.doesNotThrow(() => requireFreeSpace('.', 8 * 1024, 2 * 1024, disk));
  assert.throws(() => requireFreeSpace('.', 8 * 1024 + 1, 2 * 1024, disk), /Insufficient backup disk space/);
});
