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
  assert.equal(config.businessMode, 'staged');
  assert.equal(config.authBridgeKey, undefined);
  assert.throws(() => loadConfig({ DATABASE_URL: 'private-password', WECHAT_APP_ID: 'bad' }), error => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes('DATABASE_URL'));
    assert.ok(!error.message.includes('private-password'));
    return true;
  });
});

test('business activation is explicit and the bridge secret is file-only with safe errors', t => {
  const base = { DATABASE_URL: 'postgresql://localhost/linkx', WECHAT_APP_ID: 'wx8a8a389199aa2a0e' };
  assert.equal(loadConfig({ ...base, BUSINESS_MODE: 'active' }).businessMode, 'active');
  assert.throws(() => loadConfig({ ...base, BUSINESS_MODE: 'true' }), /Invalid configuration/);
  const dir = mkdtempSync(join(tmpdir(), 'linkx-auth-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'bridge.key');
  writeFileSync(file, 'a'.repeat(64), { mode: 0o600 });
  assert.deepEqual(loadConfig({ ...base, AUTH_BRIDGE_KEY_FILE: file }).authBridgeKey, Buffer.alloc(32, 0xaa));
  writeFileSync(file, 'invalid-secret-do-not-log');
  assert.throws(() => loadConfig({ ...base, AUTH_BRIDGE_KEY_FILE: file }), { message: 'Invalid AUTH_BRIDGE_KEY_FILE' });
  assert.throws(() => loadConfig({ ...base, AUTH_BRIDGE_KEY_FILE: join(dir, 'absent') }), { message: 'Invalid AUTH_BRIDGE_KEY_FILE' });
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

test('collector uses one file-only bridge key and a trusted HTTPS origin', t => {
  const base = { DATABASE_URL: 'postgresql://localhost/linkx', WECHAT_APP_ID: 'wx8a8a389199aa2a0e' };
  const dir = mkdtempSync(join(tmpdir(), 'linkx-collector-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'collector.key'); writeFileSync(file,'b'.repeat(64),{mode:0o600});
  assert.deepEqual(loadConfig({...base,COLLECTOR_BRIDGE_KEY_FILE:file}).collector,
    {origin:'https://collect.linkx.ink',key:Buffer.alloc(32,0xbb)});
  for(const origin of ['http://collect.linkx.ink','https://collect.linkx.ink/path','https://user:secret@collect.linkx.ink']) {
    assert.throws(()=>loadConfig({...base,COLLECTOR_ORIGIN:origin}),/Invalid configuration/);
  }
  writeFileSync(file,'do-not-echo-secret');
  assert.throws(()=>loadConfig({...base,COLLECTOR_BRIDGE_KEY_FILE:file}),{message:'Invalid COLLECTOR_BRIDGE_KEY_FILE'});
});

test('collection account subjects require the original distinct file-only key',t=>{
  const dir=mkdtempSync(join(tmpdir(),'linkx-subject-config-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const bridge=join(dir,'bridge.key'),subject=join(dir,'subject.key');
  writeFileSync(bridge,'a'.repeat(64));writeFileSync(subject,'b'.repeat(64));
  const base={DATABASE_URL:'postgresql://localhost/linkx',WECHAT_APP_ID:'wx8a8a389199aa2a0e',COLLECTOR_SUBJECT_KEY_FILE:subject};
  assert.throws(()=>loadConfig(base),/Invalid configuration/);
  assert.deepEqual(loadConfig({...base,COLLECTOR_BRIDGE_KEY_FILE:bridge}).collector?.subjectKey,Buffer.alloc(32,0xbb));
  writeFileSync(subject,'a'.repeat(64));
  assert.throws(()=>loadConfig({...base,COLLECTOR_BRIDGE_KEY_FILE:bridge}),{message:'Invalid COLLECTOR_SUBJECT_KEY_FILE'});
});
