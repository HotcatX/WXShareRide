import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes, generateKeyPairSync, createHmac } from 'node:crypto';
import { createCollector } from '../src/server.mjs';
import { BRIDGE_ROUTE, DEFAULT_NOTICE_VERSION } from '../src/compat/legacy.mjs';
import { readAccountDiagnostics } from '../src/diagnostics.mjs';
import { makeRideEvents } from './fixtures/ride-events.mjs';

test('expanded telemetry traverses signed identity → token → direct batch → OpenID join, with research separation and withdrawal', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ride-pipeline-')); const openid = 'synthetic_pipeline_openid_12345';
  const bridgeKey = randomBytes(32);
  const app = createCollector({ dbPath: join(dir, 'db.sqlite'), adminSocket: join(dir, 'run/admin.sock'),
    host: '127.0.0.1', port: 0, minFreeBytes: 0, realEnabled: true, purposeVersion: 'ride-research-v1',
    adminToken: randomBytes(32).toString('base64url'), bridgeKey,
    privatePem: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const address = await app.start(); const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const accounts = { real: randomBytes(32).toString('hex'), test: randomBytes(32).toString('hex') };
  async function participation(mode, action = 'activate', expectedStatusVersion = 0) {
    const body = { accountSubject: accounts[mode], openid, action, requestId: randomUUID(), expectedStatusVersion,
      purposeVersion: 'ride-research-v1', noticeVersion: DEFAULT_NOTICE_VERSION };
    if (mode === 'test') body.synthetic = true;
    const raw = JSON.stringify(body); const timestamp = String(Date.now()); const nonce = randomBytes(16).toString('hex');
    const signature = createHmac('sha256', bridgeKey).update(`${timestamp}\n${nonce}\n${raw}`).digest('hex');
    const res = await fetch(base + BRIDGE_ROUTE, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json',
      'x-linkx-timestamp': timestamp, 'x-linkx-nonce': nonce, 'x-linkx-signature': signature } });
    assert.equal(res.status, 200); return res.json();
  }
  async function upload(token, batch) {
    const res = await fetch(base + '/v1/batches', { method: 'POST', body: JSON.stringify(batch),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json() };
  }
  const real = await participation('real'); const synthetic = await participation('test');
  assert.notEqual(real.participantKey, synthetic.participantKey);
  const events = makeRideEvents(); const batch = { schemaVersion: 1, batchId: randomUUID(), events };
  const first = await upload(real.session.token, batch); assert.equal(first.status, 200); assert.equal(first.body.eventCount, events.length);
  const retry = await upload(real.session.token, batch); assert.equal(retry.status, 200); assert.equal(retry.body.duplicate, true);
  assert.equal((await upload(synthetic.session.token, { ...batch, batchId: randomUUID() })).status, 200);
  const operational = app.store.db.prepare(`SELECT openid,synthetic,tripKey,event_id,event_json FROM operational_events
    WHERE openid=? ORDER BY synthetic,event_id`).all(openid);
  assert.equal(operational.length, events.length * 2);
  const realRows = operational.filter(row => row.synthetic === 0); assert.equal(realRows.length, events.length);
  for (const event of events) {
    const row = realRows.find(item => item.event_id === event.eventId); assert.ok(row, event.eventName);
    assert.equal(row.openid, openid); assert.equal(row.tripKey, event.data.tripKey ?? null);
    const stored = JSON.parse(row.event_json); assert.deepEqual(stored.context, event.context); assert.deepEqual(stored.data, event.data);
  }
  const research = app.store.db.prepare('SELECT * FROM eligible_real_events').all(); assert.equal(research.length, events.length);
  assert.equal(JSON.stringify(research).includes(openid), false);
  assert.equal(app.store.db.prepare('PRAGMA table_info(eligible_real_events)').all().some(column => column.name === 'openid'), false);
  const timeline = readAccountDiagnostics(app.store.db, { openid, synthetic: false, from: Date.now() - 60_000, to: Date.now() + 1000, limit: 100 });
  assert.equal(timeline.account.openid, openid); assert.equal(timeline.events.length, events.length);
  const invalid = { ...batch, batchId: randomUUID(), events: [{ ...events[0], eventId: randomUUID() },
    { ...events[1], eventId: randomUUID(), data: { ...events[1].data, phone: '5550101234' } }] };
  assert.equal((await upload(real.session.token, invalid)).status, 422);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM eligible_real_events').get().n, events.length);
  assert.equal((await participation('real', 'withdraw', 1)).status, 'revoked');
  assert.equal((await upload(real.session.token, batch)).status, 403);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM eligible_real_events').get().n, 0);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM operational_events WHERE openid=? AND synthetic=1').get(openid).n, events.length);
});
