import { readFileSync } from 'node:fs';
import { z } from 'zod';

const environmentSchema = z.object({
  DATABASE_URL: z.url().refine(value => /^postgres(ql)?:/.test(value)).optional(),
  DATABASE_URL_FILE: z.string().min(1).optional(),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  WECHAT_APP_ID: z.string().regex(/^wx[0-9a-f]{16}$/),
  WECHAT_APP_SECRET_FILE: z.string().min(1).optional(),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(2592000).default(604800)
}).refine(env => Boolean(env.DATABASE_URL) !== Boolean(env.DATABASE_URL_FILE), { path: ['DATABASE_URL'], message: 'Provide exactly one database configuration' });
export type Config = {
  databaseUrl: string; host: string; port: number; appId: string;
  appSecret?: string; sessionTtlSeconds: number;
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
  return {
    databaseUrl, host: env.HOST, port: env.PORT,
    appId: env.WECHAT_APP_ID, appSecret, sessionTtlSeconds: env.SESSION_TTL_SECONDS
  };
}
