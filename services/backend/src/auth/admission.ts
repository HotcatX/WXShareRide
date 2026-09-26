import { AppError } from '../errors.ts';

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 60;
const MAX_ACTIVE = 8;
const MAX_SOURCES = 1024;
type Bucket = { startedAt: number; attempts: number };

/** Single-process login budget. Pass Fastify request.ip, never a caller-supplied header. */
export function createLoginAdmission({ now = Date.now }: { now?: () => number } = {}) {
  const sources = new Map<string, Bucket>();
  let active = 0;
  let previousTime: number | undefined;

  return {
    async run<T>(ip: string, work: () => Promise<T>): Promise<T> {
      // Bound keys as well as bucket count. Fastify's direct socket address fits
      // this limit; malformed callers cannot allocate arbitrarily large keys.
      if (typeof ip !== 'string' || !ip.length || ip.length > 64) {
        throw new AppError(400, 'INVALID_CLIENT_ADDRESS', '请求来源无效');
      }
      const time = now();
      if (!Number.isFinite(time)) throw new AppError(503, 'LOGIN_BUSY', '登录服务繁忙，请稍后重试');
      // A corrected system clock must not leave windows stuck in the future.
      // Existing work keeps its slots even when its rate window is reset.
      if (previousTime !== undefined && time < previousTime) sources.clear();
      previousTime = time;
      for (const [address, bucket] of sources) {
        if (time - bucket.startedAt >= WINDOW_MS) sources.delete(address);
      }
      let bucket = sources.get(ip);
      if (!bucket) {
        if (sources.size >= MAX_SOURCES) throw new AppError(503, 'LOGIN_BUSY', '登录服务繁忙，请稍后重试');
        bucket = { startedAt: time, attempts: 0 };
        sources.set(ip, bucket);
      }
      if (bucket.attempts >= MAX_ATTEMPTS) throw new AppError(429, 'RATE_LIMITED', '登录尝试过于频繁，请稍后重试');
      bucket.attempts++;
      if (active >= MAX_ACTIVE) throw new AppError(503, 'LOGIN_BUSY', '登录服务繁忙，请稍后重试');
      active++;
      try { return await work(); }
      finally { active--; }
    }
  };
}
