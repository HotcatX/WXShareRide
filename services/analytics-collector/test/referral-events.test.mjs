import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { openStore } from '../src/store.mjs';
import { validateBatch } from '../src/validation.mjs';
import { accountResponseForRequest, LEGACY_PURPOSE_VERSION, LEGACY_NOTICE_VERSION } from '../src/compat/legacy.mjs';
const require = createRequire(import.meta.url);
const { createAnalyticsClient } = require('../../../utils/analyticsClient.js');

// Local isolated storage only. No production identity, endpoint, or cloud write.
test('referral visit uses the existing SDK queue and SQLite event ledger with original time and exact deduplication', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'referral-events-'));
  const store = openStore(join(dir, 'store.sqlite'), { realEnabled: true });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const now = Date.now(), occurredAt = now - 60000, openid = 'synthetic_referral_visitor_123';
  const p = store.updateAccount({ accountSubject: randomBytes(32).toString('hex'), openid, action: 'activate',
    requestId: randomUUID(), expectedStatusVersion: 0, purposeVersion: 'ride-analytics-v1',
    noticeVersion: 'ride-analytics-notice-2026-09-23' }, now).participant;
  const claims = { sub: p.participantKey, ...p }, saved = new Map(), uploads = [];
  const client = createAnalyticsClient({ now: () => now, storage: {
    get: key => saved.get(key), set: (key, value) => saved.set(key, structuredClone(value)), remove: key => saved.delete(key)
  }, transport: request => {
    const body = JSON.parse(request.body); validateBatch(body, now); uploads.push(body);
    return { statusCode: 200, data: store.receive(claims, Buffer.from(request.body), body, now) };
  } });
  // The deployed SDK still expects its original metadata. Server-side naming
  // changes keep its existing account, sealed queue and authorization intact.
  const session = accountResponseForRequest({ session: { ...p, confirmed: true,
    acceptedPurposeVersion: p.purposeVersion, token: 'synthetic-token', tokenExpiresAtMs: now + 600000 } },
  { purposeVersion: LEGACY_PURPOSE_VERSION, noticeVersion: LEGACY_NOTICE_VERSION }).session;
  assert.equal(client.setSession({ accountKey: 'synthetic-local-account', ...session }).ok, true);
  client.beginForeground();
  const eventId = randomUUID(), metadata = client.getEventMetadata();
  assert.notEqual(metadata.sessionId, eventId);
  const data = { code: 'ref_123456789abc', source: 'appShow', entry: 'trip_detail' };
  assert.equal(client.enqueue('referral_visit', data, { eventId, ...metadata, occurredAt }).ok, true);
  assert.equal(client.enqueue('referral_visit', data, { eventId, ...metadata, occurredAt }).duplicate, true);
  assert.equal((await client.flush()).ok, true);
  assert.equal(uploads.length, 1);
  const original = uploads[0];
  assert.equal(store.receive(claims, Buffer.from(JSON.stringify(original)), original, now).duplicate, true);
  const retry = { ...original, batchId: randomUUID() };
  store.receive(claims, Buffer.from(JSON.stringify(retry)), retry, now);
  const rows = store.db.prepare("SELECT openid,event_json FROM operational_events WHERE json_extract(event_json,'$.eventName')='referral_visit'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].openid, openid);
  assert.deepEqual(JSON.parse(rows[0].event_json).data, data);
  assert.equal(JSON.parse(rows[0].event_json).occurredAt, occurredAt);
  assert.equal(JSON.parse(rows[0].event_json).sessionId, metadata.sessionId);
  assert.deepEqual(JSON.parse(rows[0].event_json).context, metadata.context);
  const conflict = { ...retry, batchId: randomUUID(), events: [{ ...retry.events[0], occurredAt: now }] };
  assert.throws(() => store.receive(claims, Buffer.from(JSON.stringify(conflict)), conflict, now), { code: 'EVENT_CONFLICT' });
  const invalid = { ...retry, batchId: randomUUID(), events: [{ ...retry.events[0], eventId: randomUUID(), data: { ...data, query: { phone: 'private' } } }] };
  assert.throws(() => store.receive(claims, Buffer.from(JSON.stringify(invalid)), invalid, now), { code: 'INVALID_BATCH' });
  assert.equal(store.db.prepare('SELECT count(*) n FROM event_receipts').get().n, 1);
});
