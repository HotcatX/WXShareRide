import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadBridgeKey, isNoticeVersion } from './bridge.mjs';
import { DEFAULT_NOTICE_VERSION, DEFAULT_PURPOSE_VERSION, ENV } from './compat/legacy.mjs';

function integer(value, fallback, min, max) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error('Invalid integer configuration');
  return parsed;
}

export function readConfig(env = process.env) {
  const adminToken = readFileSync(env.ADMIN_TOKEN_FILE || './secrets/admin.token', 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(adminToken)) throw new Error('Invalid admin secret file');
  if (env.REAL_COLLECTION_ENABLED && !['true', 'false'].includes(env.REAL_COLLECTION_ENABLED)) throw new Error('REAL_COLLECTION_ENABLED must be true or false');
  const noticeVersion = env[ENV.noticeVersion] || DEFAULT_NOTICE_VERSION;
  if (!isNoticeVersion(noticeVersion)) throw new Error('Invalid analytics notice version');
  return {
    host: env.HOST || '127.0.0.1', port: integer(env.PORT, 3000, 0, 65535),
    dbPath: resolve(env.DB_PATH || './data/collector.sqlite'),
    adminSocket: resolve(env.ADMIN_SOCKET || './data/run/admin.sock'), adminToken,
    privatePem: readFileSync(env.SIGNING_KEY_FILE || './secrets/signing.pem', 'utf8'),
    realEnabled: env.REAL_COLLECTION_ENABLED === 'true',
    bridgeKey: loadBridgeKey(env[ENV.bridgeKeyFile]), noticeVersion,
    purposeVersion: env.PURPOSE_VERSION || DEFAULT_PURPOSE_VERSION,
    maxDatabaseMB: integer(env.MAX_DATABASE_MB, 1024, 16, 16384),
    minFreeBytes: integer(env.MIN_FREE_MB, 256, 0, 16384) * 1024 * 1024,
    token: { keyId: env.SIGNING_KEY_ID || 'local-v1', ttlSeconds: integer(env.TOKEN_TTL_SECONDS, 900, 60, 900) },
  };
}
