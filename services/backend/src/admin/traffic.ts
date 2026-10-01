export type RequestMinute = { at: number; direct: number; bridge: number; collection: number };
export function createRequestCounter(clock = Date.now) {
  const startedAt = clock(), minutes = new Map<number, RequestMinute>();
  const record = (method: string, route: string | undefined) => {
    if (method === 'OPTIONS' || !route || route.startsWith('/api/v1/admin/')) return;
    const group = ['/internal/v1/auth/cloudbase', '/internal/v1/compat/cloudbase'].includes(route) ? 'bridge'
      : route === '/api/v1/analytics/session' ? 'collection' : route.startsWith('/api/v1/') ? 'direct' : null;
    if (!group) return;
    const at = Math.floor(clock() / 60000) * 60000;
    for (const key of minutes.keys()) if (key < at - 360000) minutes.delete(key);
    const value = minutes.get(at) ?? { at, direct: 0, bridge: 0, collection: 0 };
    value[group]++; minutes.set(at, value);
  };
  const snapshot = () => {
    const sampledAt = clock(), end = Math.floor(sampledAt / 60000) * 60000;
    const result: RequestMinute[] = [];
    for (let at = Math.max(Math.ceil(startedAt / 60000) * 60000, end - 360000); at < end; at += 60000)
      result.push(minutes.get(at) ?? { at, direct: 0, bridge: 0, collection: 0 });
    return { sampledAt, startedAt, minutes: result };
  };
  return { record, snapshot };
}
export type RequestCounter = ReturnType<typeof createRequestCounter>;
