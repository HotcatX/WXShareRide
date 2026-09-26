import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../src/migration/apply.ts';
import { createTestDatabase } from './helpers/database.ts';

async function copyMigrations(directory: string) {
  const source = new URL('../migrations/', import.meta.url);
  for (const file of await readdir(source)) {
    if (/^\d{3}_[a-z0-9_]+\.sql$/.test(file)) await writeFile(join(directory, file), await readFile(new URL(file, source), 'utf8'));
  }
}

test('migrations are repeatable, serialized, and reject changed history', async () => {
  const db = await createTestDatabase();
  const directory = await mkdtemp(join(tmpdir(), 'linkx-migrations-'));
  try {
    assert.deepEqual(await runMigrations(db.pool), []);
    const baseline = (await db.pool.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count;
    await copyMigrations(directory);
    const sql = await readFile(join(directory, '001_initial.sql'), 'utf8');
    await writeFile(join(directory, '999_probe.sql'), 'CREATE TABLE migration_probe(id integer PRIMARY KEY);');
    const results = await Promise.all([runMigrations(db.pool, directory), runMigrations(db.pool, directory)]);
    assert.equal(results.flat().filter(version => version === '999_probe.sql').length, 1);
    await writeFile(join(directory, '001_initial.sql'), `${sql}\n-- modified applied schema`);
    await assert.rejects(runMigrations(db.pool, directory), /Applied migration missing or changed/);
    assert.equal((await db.pool.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count, baseline + 1);
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a failed migration rolls back its DDL and can be retried after correction', async () => {
  const db = await createTestDatabase();
  const directory = await mkdtemp(join(tmpdir(), 'linkx-migrations-'));
  try {
    const baseline = (await db.pool.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count;
    await copyMigrations(directory);
    await writeFile(join(directory, '999_probe.sql'), 'CREATE TABLE migration_probe(id integer); SELECT missing_function();');
    await assert.rejects(runMigrations(db.pool, directory));
    assert.equal((await db.pool.query("SELECT to_regclass('migration_probe') AS name")).rows[0].name, null);
    assert.equal((await db.pool.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count, baseline);
    await writeFile(join(directory, '999_probe.sql'), 'CREATE TABLE migration_probe(id integer);');
    assert.deepEqual(await runMigrations(db.pool, directory), ['999_probe.sql']);
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('database constraints protect app identities, member role/count, one driver and event version', async () => {
  const db = await createTestDatabase();
  try {
    const user = (await db.pool.query("INSERT INTO users(app_id,openid) VALUES ('app','driver') RETURNING id")).rows[0].id;
    const second = (await db.pool.query("INSERT INTO users(app_id,openid) VALUES ('app','passenger') RETURNING id")).rows[0].id;
    await assert.rejects(db.pool.query("INSERT INTO users(app_id,openid) VALUES ('app','driver')"), { code: '23505' });
    await db.pool.query("INSERT INTO users(app_id,openid) VALUES ('another-app','driver')");
    await assert.rejects(db.pool.query("UPDATE users SET profile='[]'::jsonb WHERE id=$1", [user]), { code: '23514' });
    await db.pool.query("INSERT INTO rides(id,kind,creator_id,city_key,status,seat_capacity,departure_at,time_zone) VALUES ('old-id','offer',$1,'ny_nj','open',2,now(),'America/New_York')", [user]);
    await db.pool.query("INSERT INTO ride_members(ride_id,user_id,role,seat_count,state) VALUES ('old-id',$1,'driver',0,'active')", [user]);
    await assert.rejects(db.pool.query("INSERT INTO ride_members(ride_id,user_id,role,seat_count,state) VALUES ('old-id',$1,'driver',0,'active')", [second]), { code: '23505' });
    await assert.rejects(db.pool.query("INSERT INTO ride_members(ride_id,user_id,role,seat_count,state) VALUES ('old-id',$1,'passenger',0,'active')", [second]), { code: '23514' });
    await assert.rejects(db.pool.query("UPDATE ride_members SET state='left' WHERE user_id=$1", [user]), { code: '23514' });
    await db.pool.query("INSERT INTO business_events(id,ride_id,ride_version,action,actor_id,payload) VALUES ('event-1','old-id',1,'publish',$1,'{}')", [user]);
    await assert.rejects(db.pool.query("INSERT INTO business_events(id,ride_id,ride_version,action,actor_id,payload) VALUES ('event-2','old-id',1,'publish',$1,'{}')", [user]), { code: '23505' });
    await assert.rejects(db.pool.query("DELETE FROM users WHERE id=$1", [user]), { code: '23503' });
    await assert.rejects(db.pool.query("INSERT INTO ride_stops(ride_id,position,kind,address) VALUES ('old-id',0,'departure','Place')"), { code: '23514' });
    await assert.rejects(db.pool.query("UPDATE rides SET status='full' WHERE id='old-id'"), { code: '23514' });
  } finally { await db.close(); }
});

test('historical unknowns cannot open a ride and private source evidence retains exact serialized JSON', async () => {
  const db = await createTestDatabase();
  try {
    const user = (await db.pool.query("INSERT INTO users(app_id,openid,updated_at) VALUES ('app','historical',NULL) RETURNING id,updated_at")).rows[0];
    assert.equal(user.updated_at, null);
    await db.pool.query("INSERT INTO rides(id,kind,creator_id,status,departure_at,time_zone,updated_at) VALUES ('historical','offer',$1,'closed','2026-01-01T00:00:00Z','America/New_York',NULL)", [user.id]);
    await db.pool.query("INSERT INTO ride_members(ride_id,user_id,role,seat_count,state,joined_at) VALUES ('historical',$1,'driver',0,'active',NULL)", [user.id]);
    for (const status of ['open', 'cancelled']) await assert.rejects(db.pool.query("UPDATE rides SET status=$1 WHERE id='historical'", [status]), { code: '23514' });
    await assert.rejects(db.pool.query("UPDATE rides SET seat_capacity=0 WHERE id='historical'"), { code: '23514' });
    await assert.rejects(db.pool.query("UPDATE rides SET city_key='' WHERE id='historical'"), { code: '23514' });
    await db.pool.query("UPDATE rides SET city_key='ny_nj',seat_capacity=2,status='open' WHERE id='historical'");
    const { migrationSource, sourceHash } = await import('../src/migration/source.ts');
    const source = migrationSource('Carpool', { _id: 'old-id', price: ' 15 USD ', raw: { obsolete: true }, count: 0 });
    const batch = (await db.pool.query("INSERT INTO migration_batches(app_id,source_sha256) VALUES ('app',$1) RETURNING id", [sourceHash(source.documentJson)])).rows[0].id;
    const params = [batch, source.collection, source.sourceId, source.documentJson, source.sha256];
    const insert = 'INSERT INTO migration_sources(batch_id,collection,source_id,document_json,sha256) VALUES ($1,$2,$3,$4,$5)';
    await db.pool.query(insert, params);
    assert.equal((await db.pool.query('SELECT document_json FROM migration_sources')).rows[0].document_json, source.documentJson);
    await assert.rejects(db.pool.query(insert, params), { code: '23505' });
    await assert.rejects(db.pool.query("UPDATE migration_sources SET document_json='[]'"), { code: '23514' });
    await assert.rejects(db.pool.query("UPDATE migration_sources SET sha256='bad'"), { code: '23514' });
    await assert.rejects(db.pool.query("UPDATE migration_sources SET sha256=$1", ['0'.repeat(64)]), { code: '23514' });
    await assert.rejects(db.pool.query("DELETE FROM migration_batches WHERE id=$1", [batch]), { code: '23503' });
  } finally { await db.close(); }
});
