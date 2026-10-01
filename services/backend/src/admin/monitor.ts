import http from 'node:http';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { AppError } from '../errors.ts';

const epoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const bytes = epoch;
const percent = z.number().min(0).max(10000).nullable();
const id = z.string().regex(/^[A-Za-z0-9_-]{16,80}$/);
const processSchema = z.strictObject({ scope: z.literal('process'), sampledAt: epoch, uptimeSeconds: epoch,
  cpuPercent: percent, cpuBasis: z.literal('one_core'),
  memory: z.strictObject({ rssBytes: bytes, heapUsedBytes: bytes, heapTotalBytes: bytes }) });
const hostSchema = z.strictObject({ schemaVersion: z.literal(1), sampledAt: epoch, uptimeSeconds: epoch,
  cpu: z.strictObject({ percent, cores: z.number().int().min(1).max(1024) }),
  memory: z.strictObject({ totalBytes: bytes, availableBytes: bytes }),
  disk: z.strictObject({ totalBytes: bytes, availableBytes: bytes }),
  services: z.array(z.strictObject({ name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    state: z.string().regex(/^[A-Za-z0-9 _-]{1,32}$/), cpuPercent: percent,
    memoryBytes: bytes, memoryLimitBytes: bytes, startedAt: z.iso.datetime().nullable(), restarts: epoch })).max(10) });
const collectorSchema = z.strictObject({ ok: z.literal(true), sampledAt: epoch, process: processSchema,
  storage: z.strictObject({ databaseBytes: bytes, walBytes: bytes }),
  collection: z.strictObject({ enabled: z.boolean(), restoreGate: z.enum(['open', 'closed']),
    latestReceivedAt: epoch.nullable(), receivedLastMinute: z.number().int().min(0).max(5000),
    receivedLastMinuteCapped: z.boolean() }) });
const querySchema = z.strictObject({ limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,768}$/).optional(),
  subject: z.string().regex(/^[a-f0-9]{64}$/).optional(), synthetic: z.boolean().optional(),
  from: epoch.optional(), to: epoch.optional(), type: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/).optional() });
const eventSchema = z.strictObject({ openid: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/).nullable(),
  participantKey: id, batchId: id, receivedAt: epoch, eventId: id,
  eventName: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/), schemaVersion: z.literal(1), occurredAt: epoch,
  data: z.record(z.string(), z.unknown()), sessionId: id.optional(),
  context: z.strictObject({ clientVersion: z.string().max(80).optional(), sdkVersion: z.string().max(80).optional(),
    platform: z.enum(['ios', 'android', 'devtools', 'windows', 'mac', 'ohos', 'unknown']).optional(),
    buildMode: z.enum(['develop', 'trial', 'release', 'unknown']).optional() }).optional() });
const eventsSchema = z.strictObject({ ok: z.literal(true), sampledAt: epoch, timeBasis: z.literal('receivedAt'),
  from: epoch, to: epoch, events: z.array(eventSchema).max(50),
  nextCursor: z.string().regex(/^[A-Za-z0-9_-]{1,768}$/).nullable(), scanned: z.number().int().min(0).max(200) });
const historyRange = z.enum(['day', 'week', 'month']);
const historySchema = z.strictObject({ schemaVersion: z.literal(1), range: historyRange, sampledAt: epoch,
  from: epoch, to: epoch, points: z.array(z.strictObject({ at: epoch, cpuPercent: z.number().min(0).max(100).nullable(),
    memoryUsedBytes: bytes, memoryTotalBytes: bytes, diskUsedBytes: bytes, diskTotalBytes: bytes })).max(720) });

export type AdminMonitorConfig = { socketPath: string; token: string; hostSnapshotFile?: string };
export type ConsoleEvents = Omit<z.infer<typeof eventsSchema>, 'ok'>;
export type MonitorHistory = Omit<z.infer<typeof historySchema>, 'schemaVersion'>;
type ProcessMetrics = z.infer<typeof processSchema>;
type HostMetrics = Omit<z.infer<typeof hostSchema>, 'schemaVersion'>;
type CollectorMetrics = Omit<z.infer<typeof collectorSchema>, 'ok'>;
export type MonitorStatus = { sampledAt: number; refreshAfterMs: 10000; backend: ProcessMetrics;
  host: ({ status: 'ready' | 'stale' } & HostMetrics) | { status: 'unavailable' };
  collector: ({ status: 'ready' } & CollectorMetrics) | { status: 'unavailable' } };
const unavailable = () => new AppError(503, 'ADMIN_MONITOR_UNAVAILABLE', '控制台数据暂不可用');

function request(config: AdminMonitorConfig, path: string, body?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: config.socketPath, path, method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }) } }, res => {
      if (res.statusCode !== 200 || !/^application\/json(?:\s*;|$)/i.test(res.headers['content-type'] || '')
        || res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
        res.destroy(); reject(res.statusCode === 422
          ? new AppError(422, 'INVALID_CONSOLE_QUERY', '数据查询条件无效') : unavailable()); return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 262144) { res.destroy(); reject(unavailable()); }
        else chunks.push(chunk);
      });
      res.on('error', () => reject(unavailable()));
      res.on('end', () => {
        try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
        catch { reject(unavailable()); }
      });
    });
    const timer = setTimeout(() => req.destroy(unavailable()), 1500);
    timer.unref();
    req.once('close', () => clearTimeout(timer));
    req.once('error', () => reject(unavailable()));
    req.end(body);
  });
}

async function hostSnapshot(path: string | undefined, now: number): Promise<MonitorStatus['host']> {
  if (!path) return { status: 'unavailable' };
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > 16384) throw unavailable();
    const data = Buffer.alloc(16385);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead > 16384) throw unavailable();
    const parsed = hostSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, bytesRead))));
    if (parsed.sampledAt > now + 5000) throw unavailable();
    const { schemaVersion: _, ...value } = parsed;
    return { status: now - value.sampledAt > 60000 ? 'stale' : 'ready', ...value };
  } finally { await handle.close(); }
}

export function createAdminMonitor(config?: AdminMonitorConfig) {
  let cached: { at: number; value: Promise<MonitorStatus> } | undefined;
  let previous: { at: number; cpu: NodeJS.CpuUsage } | undefined;
  const histories = new Map<string, { at: number; value: Promise<MonitorHistory> }>();
  const status = (): Promise<MonitorStatus> => {
    const now = Date.now();
    if (cached && now - cached.at < 10000) return cached.value;
    const cpu = process.cpuUsage();
    const memory = process.memoryUsage();
    const elapsed = now - (previous?.at ?? now);
    const backend: ProcessMetrics = { scope: 'process', sampledAt: now, uptimeSeconds: Math.floor(process.uptime()),
      cpuBasis: 'one_core', cpuPercent: elapsed > 0 ? Math.max(0,
        (cpu.user + cpu.system - previous!.cpu.user - previous!.cpu.system) / (elapsed * 10)) : null,
      memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal } };
    previous = { at: now, cpu };
    const value = Promise.allSettled([hostSnapshot(config?.hostSnapshotFile, now), config
      ? request(config, '/v1/console/snapshot').then(value => { const { ok: _, ...data } = collectorSchema.parse(value); return data; }) : Promise.reject(unavailable())])
      .then(([host, collector]): MonitorStatus => ({ sampledAt: now, refreshAfterMs: 10000, backend,
        host: host.status === 'fulfilled' ? host.value as MonitorStatus['host'] : { status: 'unavailable' },
        collector: collector.status === 'fulfilled' ? { status: 'ready', ...collector.value } : { status: 'unavailable' } }));
    cached = { at: now, value };
    return value;
  };
  const events = async (input: unknown): Promise<ConsoleEvents> => {
    const query = querySchema.safeParse(input);
    if (!query.success) throw new AppError(422, 'INVALID_CONSOLE_QUERY', '数据查询条件无效');
    if (!config) throw unavailable();
    try {
      const { ok: _, ...value } = eventsSchema.parse(await request(config, '/v1/console/events', JSON.stringify(query.data)));
      return value;
    } catch (error) { if (error instanceof AppError && error.status === 422) throw error; throw unavailable(); }
  };
  const history = (input: unknown): Promise<MonitorHistory> => {
    const parsed = historyRange.safeParse(input);
    if (!parsed.success) return Promise.reject(new AppError(422, 'INVALID_CONSOLE_QUERY', '请选择有效的监控时间范围'));
    const range = parsed.data, now = Date.now(), cached = histories.get(range);
    if (cached && now - cached.at < 60000) return cached.value;
    if (!config?.hostSnapshotFile) return Promise.reject(unavailable());
    const value = (async () => {
      const handle = await open(join(dirname(config.hostSnapshotFile!), `history-${range}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size < 1 || info.size > 524288) throw unavailable();
        const data = Buffer.alloc(524289);
        const { bytesRead } = await handle.read(data, 0, data.length, 0);
        if (bytesRead > 524288) throw unavailable();
        const { schemaVersion: _, ...result } = historySchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, bytesRead))));
        if (result.range !== range || result.from > result.to || result.to > result.sampledAt || result.sampledAt > now + 5000
          || result.points.some((point, index) => point.at < result.from || point.at > result.to
            || index > 0 && point.at <= result.points[index - 1]!.at
            || point.memoryUsedBytes > point.memoryTotalBytes || point.diskUsedBytes > point.diskTotalBytes)) throw unavailable();
        return result;
      } finally { await handle.close(); }
    })().catch(() => { histories.delete(range); throw unavailable(); });
    histories.set(range, { at: now, value });
    return value;
  };
  return { status, events, history };
}
