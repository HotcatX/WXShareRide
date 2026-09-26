import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { AppError } from './errors.ts';

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    statement_timeout: 10000, idle_in_transaction_session_timeout: 10000 });
}

export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const json = JSON.stringify(value);
    if (json === undefined) throw new AppError(400, 'INVALID_INPUT', '请求必须为 JSON');
    return json;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

export type MutationResult = { status: number; data: Record<string, unknown> };
export type MutationReceipt = { payload_hash: string; response_status: number; response_body: Record<string, unknown> };

export function idempotencyInput(key: unknown, payload: unknown): { key: string; hash: string } {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9._:-]{8,128}$/.test(key)) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请提供 8–128 位 idempotency-key');
  }
  return { key, hash: createHash('sha256').update(canonicalJson(payload)).digest('hex') };
}

/** Receipts share replay semantics, while each identity domain owns its SQL and authorization. */
export async function runIdempotentMutation(client: PoolClient, options: {
  lockKey: string[]; hash: string;
  beforeReceipt?: () => Promise<void>;
  read: () => Promise<MutationReceipt | undefined>;
  save: (result: MutationResult) => Promise<void>;
}, work: (client: PoolClient) => Promise<MutationResult>): Promise<MutationResult> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(options.lockKey)]);
  await options.beforeReceipt?.();
  const previous = await options.read();
  if (previous) {
    if (previous.payload_hash !== options.hash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '该请求编号已用于其他内容');
    return { status: previous.response_status, data: previous.response_body };
  }
  const result = await work(client);
  await options.save(result);
  return result;
}

/** One database, one transaction. An ambiguous timeout must retry the SAME key here. */
export async function withIdempotency(
  pool: Pool, userId: string, operation: string, key: unknown, payload: unknown,
  work: (client: PoolClient) => Promise<MutationResult>
): Promise<MutationResult> {
  const input = idempotencyInput(key, payload);
  return transaction(pool, client => runIdempotentMutation(client, {
    lockKey: [userId, operation, input.key], hash: input.hash,
    read: async () => (await client.query<MutationReceipt>(
      'SELECT payload_hash, response_status, response_body FROM idempotency_requests WHERE user_id=$1 AND operation=$2 AND request_key=$3',
      [userId, operation, input.key]
    )).rows[0],
    save: async result => { await client.query(
      'INSERT INTO idempotency_requests(user_id,operation,request_key,payload_hash,response_status,response_body) VALUES($1,$2,$3,$4,$5,$6)',
      [userId, operation, input.key, input.hash, result.status, result.data]
    ); }
  }, work));
}
