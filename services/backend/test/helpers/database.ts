import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { runMigrations } from '../../src/migration/apply.ts';

/** Each suite owns a generated schema containing synthetic data only. */
export async function createTestDatabase() {
  const connectionString = process.env.BACKEND_TEST_DATABASE_URL;
  if (!connectionString) throw new Error('BACKEND_TEST_DATABASE_URL is required for integration tests');
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, max: 12, options: `-c search_path=${schema}` });
  async function close() {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
  try { await runMigrations(pool); }
  catch (error) { await close(); throw error; }
  return { pool, close };
}
