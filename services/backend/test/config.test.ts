import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('one config boundary validates required values without exposing secrets', () => {
  const config = loadConfig({ DATABASE_URL: 'postgresql://localhost/linkx', WECHAT_APP_ID: 'wx8a8a389199aa2a0e' });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3100);
  assert.equal(config.appSecret, undefined);
  assert.throws(() => loadConfig({ DATABASE_URL: 'private-password', WECHAT_APP_ID: 'bad' }), error => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes('DATABASE_URL'));
    assert.ok(!error.message.includes('private-password'));
    return true;
  });
});

test('storage config is all-or-nothing and credentials stay in a server secret file', t => {
  const base = { DATABASE_URL: 'postgresql://localhost/linkx', WECHAT_APP_ID: 'wx8a8a389199aa2a0e' };
  for (const extra of [{ COS_BUCKET: 'images-1234567890' }, { COS_REGION: 'ap-shanghai' },
    { CLOUDBASE_STORAGE_ENV: 'cloud-test' }]) assert.throws(() => loadConfig({ ...base, ...extra }), /Invalid configuration/);
  const dir = mkdtempSync(join(tmpdir(), 'linkx-storage-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'credentials.json');
  const credentials = { secretId: 'SyntheticAccessId000000', secretKey: 'SyntheticSecretKey000000' };
  writeFileSync(file, JSON.stringify(credentials), { mode: 0o600 });
  const environment = { ...base, COS_BUCKET: 'images-1234567890', COS_REGION: 'ap-shanghai', COS_CREDENTIALS_FILE: file,
    CLOUDBASE_STORAGE_ENV: 'cloud-test' };
  assert.deepEqual(loadConfig(environment).cos, { bucket: 'images-1234567890', region: 'ap-shanghai',
    ...credentials, legacyEnvironment: 'cloud-test' });
  writeFileSync(file, '{"secretId":"do-not-echo-this-value"}');
  assert.throws(() => loadConfig(environment), { message: 'Invalid COS_CREDENTIALS_FILE' });
  assert.throws(() => loadConfig({ ...environment, COS_REGION: 'ap-shanghai.attacker.test' }), /Invalid configuration/);
});
