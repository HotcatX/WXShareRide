export function createRequestCounter(clock = Date.now) {
  const startedAt = clock(), minutes = new Map();
  const record = () => {
    const at = Math.floor(clock() / 60000) * 60000;
    for (const key of minutes.keys()) if (key < at - 360000) minutes.delete(key);
    minutes.set(at, (minutes.get(at) ?? 0) + 1);
  };
  const snapshot = () => {
    const sampledAt = clock(), end = Math.floor(sampledAt / 60000) * 60000, result = [];
    for (let at = Math.max(Math.ceil(startedAt / 60000) * 60000, end - 360000); at < end; at += 60000)
      result.push({ at, collection: minutes.get(at) ?? 0 });
    return { sampledAt, startedAt, minutes: result };
  };
  return { record, snapshot };
}
