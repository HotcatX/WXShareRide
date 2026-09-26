const test = require('node:test')
const assert = require('node:assert/strict')
const { generateKeyPairSync, sign, randomBytes } = require('node:crypto')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

// These deployable packages cannot import each other's production files. Lock
// their compatibility boundary together without introducing a shared runtime.
test('independent client, cloud bridge and collector preserve one deployed protocol and identity namespace', async () => {
  const client = require('../utils/compat/analyticsLegacy')
  const cloud = require('../cloudfunctions/statistics/compat')
  const server = await import('../services/analytics-collector/src/compat/legacy.mjs')
  assert.equal(client.purposeVersion, 'ride-research-v1')
  assert.equal(client.noticeVersion, 'ride-research-notice-2026-09-23')
  assert.equal(cloud.PURPOSE, client.purposeVersion)
  assert.equal(server.DEFAULT_PURPOSE_VERSION, client.purposeVersion)
  assert.equal(cloud.NOTICE, client.noticeVersion)
  assert.equal(server.DEFAULT_NOTICE_VERSION, client.noticeVersion)
  assert.equal(new URL(cloud.ENDPOINT).pathname, server.BRIDGE_ROUTE)
  assert.equal(server.BRIDGE_ROUTE, '/internal/v1/research/participation')
  assert.equal(cloud.SUBJECT_SCOPE, 'linkx-research-account-v1')
  assert.equal(cloud.TEST_SUBJECT_SCOPE, 'linkx-research-test-account-v1')
  assert.equal(server.SUBJECT_SCOPE, cloud.SUBJECT_SCOPE)
  assert.equal(server.TEST_SUBJECT_SCOPE, cloud.TEST_SUBJECT_SCOPE)
})

test('renamed service verifies an already-issued token without changing issuer, audience or purpose', async () => {
  const { createTokenService } = await import('../services/analytics-collector/src/auth.mjs')
  const keys = generateKeyPairSync('ed25519')
  const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' })
  const claims = { iss: 'linkx-research-collector', aud: 'linkx-research-batches',
    sub: 'old_participant_000001', grantId: 'old_grant_0000000001', statusVersion: 4,
    purposeVersion: 'ride-research-v1', iat: 1800000000, exp: 1800000900, jti: 'old_token_000000000001' }
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const raw = `${encode({ alg: 'EdDSA', typ: 'JWT', kid: 'local-v1' })}.${encode(claims)}`
  const token = `${raw}.${sign(null, Buffer.from(raw), keys.privateKey).toString('base64url')}`
  assert.deepEqual(createTokenService(privatePem).verify(token, 1800000001000), claims)
})

test('renamed configuration still reads the existing host environment and bridge key file', async t => {
  const { readConfig } = await import('../services/analytics-collector/src/config.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'analytics-config-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bridge = randomBytes(32), pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
  writeFileSync(join(dir, 'bridge.key'), bridge.toString('hex'))
  writeFileSync(join(dir, 'signing.pem'), pem)
  writeFileSync(join(dir, 'admin.token'), randomBytes(32).toString('base64url'))
  const config = readConfig({ ADMIN_TOKEN_FILE: join(dir, 'admin.token'), SIGNING_KEY_FILE: join(dir, 'signing.pem'),
    RESEARCH_BRIDGE_KEY_FILE: join(dir, 'bridge.key'), RESEARCH_NOTICE_VERSION: 'ride-research-notice-2026-09-24',
    REAL_COLLECTION_ENABLED: 'true', DB_PATH: join(dir, 'collector.sqlite'), ADMIN_SOCKET: join(dir, 'admin.sock') })
  assert.deepEqual(config.bridgeKey, bridge)
  assert.equal(config.noticeVersion, 'ride-research-notice-2026-09-24')
  assert.equal(config.purposeVersion, 'ride-research-v1')
  assert.equal(config.realEnabled, true)
  assert.equal(config.dbPath, join(dir, 'collector.sqlite'))
  assert.equal(config.adminSocket, join(dir, 'admin.sock'))
})
