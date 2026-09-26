// Manual, synthetic-only integration check. Not included by *.test.cjs globs.
// Run inside the collector container with ADMIN_SOCKET and ADMIN_TOKEN_FILE set.
// This is an injected loopback test transport, not an SDK HTTP/IP fallback.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { randomUUID, createHash } = require('node:crypto')

const LOOPBACK_HOST = '127.0.0.1'
const LOOPBACK_PORT = 3000
const TEST_ENDPOINT = 'https://collect.linkx.ink/v1/batches'
const clone = value => JSON.parse(JSON.stringify(value))

function requestJSON(target, raw = '', token = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...target, timeout: 10000, headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    } }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        text += chunk
        if (Buffer.byteLength(text) > 65536) response.destroy(new Error('REPLY_TOO_LARGE'))
      })
      response.on('error', () => reject(new Error('REPLY_FAILED')))
      response.on('end', () => {
        try { resolve({ statusCode: response.statusCode, data: JSON.parse(text), headers: response.headers }) }
        catch (_) { reject(new Error('INVALID_REPLY')) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('REQUEST_TIMEOUT')))
    req.on('error', () => reject(new Error('REQUEST_FAILED')))
    req.end(raw)
  })
}

async function main() {
  let stage = 'initialization'
  let admin = null
  let enrollmentAttempted = false
  let client = null
  let result = { ok: false, syntheticOnly: true, realDataUsed: false }
  const participant = { participantKey: randomUUID(), grantId: randomUUID(), status: 'active', statusVersion: 1,
    purposeVersion: 'ride-research-v1', synthetic: true }
  try {
    // Supports the repo tests/ layout or a copied /integration/<script> layout.
    const sdkPaths = [path.join(__dirname, '../utils/analyticsClient.js'), path.join(__dirname, 'utils/analyticsClient.js')]
    const sdkPath = sdkPaths.find(filename => fs.existsSync(filename))
    assert.ok(sdkPath)
    const { createAnalyticsClient } = require(sdkPath)
    const adminSocket = process.env.ADMIN_SOCKET
    const adminTokenFile = process.env.ADMIN_TOKEN_FILE
    assert.ok(adminSocket && adminTokenFile)
    const adminToken = fs.readFileSync(adminTokenFile, 'utf8').trim()
    assert.ok(adminToken.length >= 32)
    admin = (route, body) => requestJSON({ socketPath: adminSocket, path: route, method: 'POST' }, JSON.stringify(body), adminToken)
    const publicRequest = (body, token) => requestJSON({ hostname: LOOPBACK_HOST, port: LOOPBACK_PORT,
      path: '/v1/batches', method: 'POST' }, body, token)

    stage = 'health'
    assert.equal((await requestJSON({ hostname: LOOPBACK_HOST, port: LOOPBACK_PORT, path: '/healthz', method: 'GET' })).statusCode, 200)
    stage = 'synthetic_enrollment'
    enrollmentAttempted = true
    assert.equal((await admin('/v1/participants/state', participant)).statusCode, 200)
    stage = 'token_issue'
    const issued = await admin('/v1/tokens', { participantKey: participant.participantKey })
    assert.equal(issued.statusCode, 200)
    assert.equal(issued.data.synthetic, true)
    assert.equal(issued.data.participantKey, participant.participantKey)
    const trustedSession = { ...issued.data, accountKey: `synthetic-local-${randomUUID()}` }

    const stored = new Map()
    const storage = { get: key => stored.has(key) ? clone(stored.get(key)) : undefined,
      set: (key, value) => stored.set(key, clone(value)), remove: key => stored.delete(key) }
    let clock = Date.now()
    let sdkRequests = 0
    let originalBody = ''
    let firstAck = null
    let replayAck = null
    const makeClient = transport => createAnalyticsClient({ storage, transport, now: () => clock, random: () => 0,
      makeId: randomUUID, config: { enabled: true, endpoint: TEST_ENDPOINT, purposeVersion: participant.purposeVersion } })

    stage = 'sdk_enqueue'
    client = makeClient(async request => {
      sdkRequests += 1
      assert.equal(request.url, TEST_ENDPOINT)
      assert.equal(request.token, trustedSession.token)
      originalBody = request.body
      const response = await publicRequest(request.body, request.token)
      assert.equal(response.statusCode, 200)
      assert.equal(response.data.duplicate, false)
      assert.equal(response.data.eventCount, 30)
      assert.equal(response.data.payloadHash, createHash('sha256').update(request.body).digest('hex'))
      firstAck = response.data
      // The service committed and replied; deliberately lose only the SDK's ACK.
      throw new Error('SIMULATED_ACK_LOSS')
    })
    assert.equal(client.setSession(trustedSession).ok, true)
    client.beginForeground()
    for (let i = 0; i < 30; i += 1) assert.equal(client.enqueue('page_view', { page: 'home' }).ok, true)
    assert.equal(sdkRequests, 0)
    assert.equal(client.getStatus().queuedCount, 30)

    stage = 'durable_send_lost_ack'
    const lost = await client.flush()
    assert.equal(lost.reason, 'upload_failed')
    assert.ok(firstAck)
    assert.equal(sdkRequests, 1)
    assert.equal(client.getStatus().queuedCount, 30)
    assert.equal(client.getStatus().pendingCount, 30)

    stage = 'sdk_restart_retry'
    // Advance only the injected client clock; do not sleep or change server time.
    clock = Math.max(clock + 300001, client.getStatus().nextAttemptAt + 1)
    assert.ok(trustedSession.tokenExpiresAtMs > clock, 'Smoke requires a token TTL longer than the simulated five-minute retry interval')
    client = makeClient(async request => {
      sdkRequests += 1
      assert.equal(request.url, TEST_ENDPOINT)
      assert.equal(request.body, originalBody)
      const response = await publicRequest(request.body, request.token)
      assert.equal(response.statusCode, 200)
      assert.equal(response.data.duplicate, true)
      assert.equal(response.data.receivedAt, firstAck.receivedAt)
      assert.equal(response.data.payloadHash, firstAck.payloadHash)
      replayAck = response.data
      return response
    })
    assert.equal(client.setSession(trustedSession).ok, true)
    assert.equal(client.getStatus().queuedCount, 30)
    client.beginForeground()
    const retried = await client.flush()
    assert.equal(retried.ok, true)
    assert.equal(retried.duplicate, true)
    assert.equal(retried.eventCount, 30)
    assert.ok(replayAck)
    assert.equal(client.getStatus().queuedCount, 0)
    assert.equal(client.getStatus().pendingCount, 0)
    assert.equal(sdkRequests, 2)

    stage = 'server_withdrawal'
    assert.equal((await admin('/v1/participants/state', { ...participant, status: 'revoked', statusVersion: 2 })).statusCode, 200)
    // Replay the already-confirmed body: revocation must precede duplicate ACK.
    const blocked = await publicRequest(originalBody, trustedSession.token)
    assert.equal(blocked.statusCode, 403)
    assert.equal(client.withdraw().ok, true)
    assert.equal(client.getStatus().participating, false)
    assert.equal(stored.size, 0)

    result = { ok: true, syntheticOnly: true, realDataUsed: false, enqueuedEvents: 30, sdkRequestsBeforeFlush: 0,
      sdkRequests: 2, replayedIdenticalBody: true, duplicateAcknowledged: true, queueEmpty: true,
      oldTokenRejectedAfterWithdrawal: true, checks: ['loopback-health', 'synthetic-grant', 'signed-token',
        'sdk-low-call-enqueue', 'committed-batch-lost-ack', 'sdk-restart', 'byte-identical-retry',
        'hash-ack', 'duplicate-ack', 'queue-drained', 'server-revocation', 'old-token-403', 'local-withdrawal'] }
  } catch (_) {
    // Never print assertion actuals, response bodies, participant IDs or tokens.
    result = { ok: false, stage, syntheticOnly: true, realDataUsed: false }
  } finally {
    let cleanupSucceeded = !enrollmentAttempted
    if (enrollmentAttempted && admin) {
      try {
        cleanupSucceeded = (await admin('/v1/participants/state', { ...participant, status: 'revoked', statusVersion: 2 })).statusCode === 200
      } catch (_) { cleanupSucceeded = false }
    }
    if (client) {
      try { cleanupSucceeded = client.withdraw().ok && cleanupSucceeded } catch (_) { cleanupSucceeded = false }
    }
    result.cleanupSucceeded = cleanupSucceeded
    if (!cleanupSucceeded) result.ok = false
    if (!result.ok) process.exitCode = 1
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }
}

main().catch(() => {
  process.stderr.write('Synthetic SDK smoke failed before redacted completion.\n')
  process.exitCode = 1
})
