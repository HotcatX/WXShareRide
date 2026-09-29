import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { readConfig } from '../src/config.mjs';
import { validateAccountRequest } from '../src/bridge.mjs';
import { createTokenService } from '../src/auth.mjs';
import { DEFAULT_PURPOSE_VERSION, DEFAULT_NOTICE_VERSION, ENV, isPurposeVersion, isNoticeVersion } from '../src/protocol.mjs';
import { LEGACY_PURPOSE_VERSION, LEGACY_NOTICE_VERSION, LEGACY_ENV, LEGACY_TOKEN_ISSUER, LEGACY_TOKEN_AUDIENCE } from '../src/compat/legacy.mjs';

test('account validation accepts exact old/current pairs without rewriting operation bytes', () => {
  const body = { accountSubject: randomBytes(32).toString('hex'), action: 'activate', requestId: randomUUID(),
    expectedStatusVersion: 0, purposeVersion: LEGACY_PURPOSE_VERSION, noticeVersion: LEGACY_NOTICE_VERSION };
  const raw = JSON.stringify(body);
  assert.equal(validateAccountRequest(body, DEFAULT_PURPOSE_VERSION, DEFAULT_NOTICE_VERSION), body);
  assert.equal(JSON.stringify(body), raw);
  assert.throws(() => validateAccountRequest({ ...body, noticeVersion: DEFAULT_NOTICE_VERSION }, DEFAULT_PURPOSE_VERSION, DEFAULT_NOTICE_VERSION), { code: 'INVALID_ACCOUNT_REQUEST' });
  assert.throws(() => validateAccountRequest({ ...body, purposeVersion: `${LEGACY_PURPOSE_VERSION}0` }, DEFAULT_PURPOSE_VERSION, DEFAULT_NOTICE_VERSION), { code: 'NOTICE_VERSION_MISMATCH' });
  for (const value of ['anything-v1', 'ride-analytics-v0', 'ride-analytics-v01', 'ride-analytics-v10000', 1, null]) assert.equal(isPurposeVersion(value), false);
  for (const value of ['ride-analytics-notice-not-a-date', 'other-notice-2026-09-23', 1, null]) assert.equal(isNoticeVersion(value), false);
});

test('old environment names normalize to one configuration and conflicting aliases fail closed', t => {
  const dir = mkdtempSync(join(tmpdir(), 'analytics-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const admin = join(dir, 'admin.token'), signing = join(dir, 'signing.pem'), bridge = join(dir, 'bridge.key');
  writeFileSync(admin, randomBytes(32).toString('base64url'));
  writeFileSync(signing, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeFileSync(bridge, randomBytes(32).toString('hex'));
  const env = { ADMIN_TOKEN_FILE: admin, SIGNING_KEY_FILE: signing, DB_PATH: join(dir, 'db.sqlite'),
    ADMIN_SOCKET: join(dir, 'admin.sock'), PURPOSE_VERSION: LEGACY_PURPOSE_VERSION,
    [LEGACY_ENV.bridgeKeyFile]: bridge, [LEGACY_ENV.noticeVersion]: LEGACY_NOTICE_VERSION };
  const before = readConfig(env);
  assert.equal(before.purposeVersion, DEFAULT_PURPOSE_VERSION); assert.equal(before.noticeVersion, DEFAULT_NOTICE_VERSION);
  const after = readConfig({ ...env, [ENV.bridgeKeyFile]: bridge, [ENV.noticeVersion]: DEFAULT_NOTICE_VERSION });
  assert.deepEqual(after, before);
  assert.throws(() => readConfig({ ...env, [ENV.bridgeKeyFile]: join(dir, 'different.key') }), /Conflicting analytics bridge key configuration/);
  assert.throws(() => readConfig({ ...env, [ENV.noticeVersion]: 'ride-analytics-notice-2026-09-24' }), /Conflicting analytics notice configuration/);
});

test('legacy JWT acceptance is restricted to the default collector identity', () => {
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const participant = { participantKey: randomUUID(), grantId: randomUUID(), statusVersion: 1, purposeVersion: DEFAULT_PURPOSE_VERSION };
  const token = createTokenService(pem, { issuer: LEGACY_TOKEN_ISSUER, audience: LEGACY_TOKEN_AUDIENCE }).issue(participant).token;
  assert.equal(createTokenService(pem).verify(token).sub, participant.participantKey);
  assert.throws(() => createTokenService(pem, { issuer: 'independent-service' }).verify(token), { code: 'INVALID_TOKEN' });
});
