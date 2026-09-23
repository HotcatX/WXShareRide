import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const base = process.env.COLLECTOR_BASE_URL || 'http://127.0.0.1:3000';
const adminToken = readFileSync(process.env.ADMIN_TOKEN_FILE || './secrets/admin.token', 'utf8').trim();
async function admin(path, body) {
  const raw = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: process.env.ADMIN_SOCKET || './data/run/admin.sock', path, method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch { reject(new Error('Invalid admin reply')); } });
    });
    req.on('error', reject); req.end(raw);
  });
}
const state = { participantKey: randomUUID(), grantId: randomUUID(), status: 'active', statusVersion: 1, purposeVersion: 'ride-research-v1', synthetic: true };
const batch = { schemaVersion: 1, batchId: randomUUID(), events: [{ eventId: randomUUID(), eventName: 'page_view', schemaVersion: 1, occurredAt: Date.now(), data: { page: 'home' } }] };
const raw = JSON.stringify(batch);
let created = false;
try {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await admin('/v1/participants/state', state)).status, 200); created = true;
  const issued = await admin('/v1/tokens', { participantKey: state.participantKey }); assert.equal(issued.status, 200);
  const send = async value => {
    const res = await fetch(`${base}/v1/batches`, { method: 'POST', headers: { Authorization: `Bearer ${issued.body.token}`, 'Content-Type': 'application/json' }, body: value });
    return { status: res.status, body: await res.json() };
  };
  const first = await send(raw); assert.equal(first.status, 200); assert.equal(first.body.duplicate, false);
  assert.equal(first.body.payloadHash, createHash('sha256').update(raw).digest('hex'));
  const retry = await send(raw); assert.equal(retry.status, 200); assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.receivedAt, first.body.receivedAt);
  const altered = structuredClone(batch); altered.events[0].data.page = 'profile';
  assert.equal((await send(JSON.stringify(altered))).status, 409);
  assert.equal((await admin('/v1/participants/state', { ...state, status: 'revoked', statusVersion: 2 })).status, 200);
  assert.equal((await send(raw)).status, 403);
  process.stdout.write(JSON.stringify({ ok: true, checks: ['health', 'synthetic-enrollment', 'local-token', 'durable-ack', 'retry', 'hash-conflict', 'withdrawal', 'old-token-rejected'], realDataUsed: false }) + '\n');
} catch {
  // Assertions must not print their actual values (which could include a token).
  process.stderr.write('Synthetic smoke failed; inspect redacted service status.\n'); process.exitCode = 1;
} finally {
  if (created) await admin('/v1/participants/state', { ...state, status: 'revoked', statusVersion: 2 }).catch(() => {});
}
