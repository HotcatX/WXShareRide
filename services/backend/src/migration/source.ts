import { createHash } from 'node:crypto';

export type MigrationSource = { collection: string; sourceId: string; documentJson: string; sha256: string };

/** Reject lossy JS values before serialization; imports must contain actual JSON. */
export function serializeSource(value: unknown): string {
  const seen = new Set<object>();
  function check(item: unknown): void {
    if (typeof item === 'string') {
      // PostgreSQL UTF-8 text/jsonb cannot store NUL or lone surrogate values.
      if (/\u0000|[\uD800-\uDFFF]/u.test(item)) throw new Error('Invalid source JSON');
      return;
    }
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === null || seen.has(item)) throw new Error('Invalid source JSON');
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('Invalid source JSON');
    // Only plain JSON data properties: do not invoke getters/toJSON or lose
    // symbol/non-enumerable properties from programmatically constructed input.
    for (const key of Reflect.ownKeys(item)) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') throw new Error('Invalid source JSON');
      check(key);
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!descriptor.enumerable || !('value' in descriptor) ||
        (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))) throw new Error('Invalid source JSON');
    }
    seen.add(item);
    if (array) {
      for (let index = 0; index < item.length; index++) check(item[index]);
    } else for (const child of Object.values(item)) check(child);
    seen.delete(item);
  }
  check(value);
  return JSON.stringify(value);
}

export const sourceHash = (json: string) => createHash('sha256').update(json, 'utf8').digest('hex');

export function migrationSource(collection: string, document: Record<string, unknown>): MigrationSource {
  const documentJson = serializeSource(document);
  if (typeof document._id !== 'string' || !document._id.trim()) throw new Error('Missing source ID');
  return { collection, sourceId: document._id, documentJson, sha256: sourceHash(documentJson) };
}
