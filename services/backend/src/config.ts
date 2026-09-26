import { readFileSync } from 'node:fs';
import { z } from 'zod';

const environmentSchema = z.object({
  DATABASE_URL: z.url().refine(value => /^postgres(ql)?:/.test(value)).optional(),
  DATABASE_URL_FILE: z.string().min(1).optional(),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  WECHAT_APP_ID: z.string().regex(/^wx[0-9a-f]{16}$/),
  WECHAT_APP_SECRET_FILE: z.string().min(1).optional(),
  COS_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}-[0-9]{5,20}$/).optional(),
  COS_REGION: z.string().regex(/^[a-z]{2}-[a-z]+(?:-[0-9]+)?$/).optional(),
  COS_CREDENTIALS_FILE: z.string().min(1).optional(),
  // Optional legacy cloud:// namespace in this same bucket; never a client URL.
  CLOUDBASE_STORAGE_ENV: z.string().regex(/^[a-z0-9][a-z0-9-]{1,127}$/).optional(),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(2592000).default(604800)
}).refine(env => Boolean(env.DATABASE_URL) !== Boolean(env.DATABASE_URL_FILE), { path: ['DATABASE_URL'], message: 'Provide exactly one database configuration' })
  .refine(env => [env.COS_BUCKET, env.COS_REGION, env.COS_CREDENTIALS_FILE].filter(Boolean).length % 3 === 0 &&
    (!env.CLOUDBASE_STORAGE_ENV || !!env.COS_BUCKET), { path: ['COS_BUCKET'], message: 'Provide complete storage configuration' });
export type CosConfig = { bucket: string; region: string; secretId: string; secretKey: string; legacyEnvironment?: string };
export type Config = {
  databaseUrl: string; host: string; port: number; appId: string;
  appSecret?: string; sessionTtlSeconds: number;
  cos?: CosConfig;
};

/** The only environment boundary. Never log this object or schema values. */
export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    throw new Error(`Invalid configuration: ${result.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  }
  const env = result.data;
  const databaseUrl = env.DATABASE_URL ?? readFileSync(env.DATABASE_URL_FILE!, 'utf8').trim();
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error('Invalid DATABASE_URL_FILE');
  const appSecret = env.WECHAT_APP_SECRET_FILE ? readFileSync(env.WECHAT_APP_SECRET_FILE, 'utf8').trim() : undefined;
  if (appSecret !== undefined && !/^[a-zA-Z0-9]{16,128}$/.test(appSecret)) throw new Error('Invalid WECHAT_APP_SECRET_FILE');
  let cos: CosConfig | undefined;
  if (env.COS_CREDENTIALS_FILE) {
    try {
      const credentials = z.strictObject({ secretId: z.string().regex(/^[A-Za-z0-9]{16,128}$/),
        secretKey: z.string().regex(/^[A-Za-z0-9]{16,128}$/) }).parse(JSON.parse(readFileSync(env.COS_CREDENTIALS_FILE, 'utf8')));
      cos = { bucket: env.COS_BUCKET!, region: env.COS_REGION!, ...credentials, legacyEnvironment: env.CLOUDBASE_STORAGE_ENV };
    } catch { throw new Error('Invalid COS_CREDENTIALS_FILE'); }
  }
  return {
    databaseUrl, host: env.HOST, port: env.PORT,
    appId: env.WECHAT_APP_ID, appSecret, sessionTtlSeconds: env.SESSION_TTL_SECONDS, cos
  };
}
