import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

type QueryResult = { rows: Array<Record<string, unknown>> };
type MigrationClient = {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  release(): void;
};
export type MigrationPool = { connect(): Promise<MigrationClient> };
const defaultDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url));
const lockName = 'linkx-backend-schema';

/** Apply checked-in SQL once. Existing migrations are immutable, including whitespace. */
export async function runMigrations(pool: MigrationPool, directory = defaultDirectory): Promise<string[]> {
  const files = (await readdir(directory)).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!files.length) throw new Error('No migration files found');
  const versions = files.map(file => file.slice(0, 3));
  if (new Set(versions).size !== versions.length) throw new Error('Duplicate migration version');
  const migrations = await Promise.all(files.map(async version => {
    const sql = await readFile(`${directory}/${version}`, 'utf8');
    return { version, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
  const client = await pool.connect();
  let locked = false;
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockName]);
    locked = true;
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const previous = await client.query('SELECT version, checksum FROM schema_migrations ORDER BY version');
    for (const row of previous.rows) {
      const local = migrations.find(item => item.version === row.version);
      if (!local || local.checksum !== row.checksum) throw new Error('Applied migration missing or changed');
    }
    for (const migration of migrations) {
      if (previous.rows.some(row => row.version === migration.version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)', [migration.version, migration.checksum]);
        await client.query('COMMIT');
        applied.push(migration.version);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return applied;
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
    } finally { client.release(); }
  }
}
