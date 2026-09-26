import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

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
