import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const { templateId: map } = createRequire(import.meta.url)('./identity.cjs') as {
  templateId: (appId: string, sourceId: string, hash: (value: string) => string) => string;
};

/** App-scoped legacy locator, shared by import and temporary compatibility. */
export function templateId(appId: string, sourceId: string): string {
  return map(appId, sourceId, value => createHash('sha256').update(value).digest('hex'));
}
