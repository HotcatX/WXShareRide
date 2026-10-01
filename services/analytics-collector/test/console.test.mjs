import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes, generateKeyPairSync } from 'node:crypto';
import { openStore } from '../src/store.mjs';
import { createCollector } from '../src/server.mjs';
import { createConsole, initializeConsole, CONSOLE_EVENTS_ROUTE, CONSOLE_STATUS_ROUTE } from '../src/console.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'collector-console-'));
  const config = { dbPath: join(dir, 'db.sqlite'), realEnabled: true };
  const store = openStore(config.dbPath, config); initializeConsole(store.db);
  let now = Date.now();
  const console = createConsole(store, config, { clock: () => now });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, console, now, advance: ms => { now += ms; } };
}
function account(store, synthetic = false) {
  const subject = randomBytes(32).toString('hex');
  const openid = `synthetic_${randomUUID()}`;
  const request = { accountSubject: subject, openid, action: 'activate', requestId: randomUUID(),
    expectedStatusVersion: 0, purposeVersion: 'ride-analytics-v1', noticeVersion: 'ride-analytics-notice-2026-09-23', ...(synthetic ? { synthetic: true } : {}) };
  return { subject, openid, request, participant: store.updateAccount(request).participant };
}
function put(store, p, now, event = {}) {
  const body = { schemaVersion: 1, batchId: randomUUID(), events: [{ eventId: randomUUID(),
    eventName: 'page_view', schemaVersion: 1, occurredAt: now, data: { page: 'home' }, ...event }] };
  store.receive({ sub: p.participantKey, ...p }, Buffer.from(JSON.stringify(body)), body, now);
  return body;
}

test('keyset ordering is stable for equal timestamps, deduplicates retries, and ignores new arrivals after page one', t => {
  const f = fixture(t); const a = account(f.store), b = account(f.store), synthetic = account(f.store, true);
  const expected = [];
  for (let i = 0; i < 8; i++) {
    const owner = i % 2 ? a : b;
    const body = put(f.store, owner.participant, f.now - 1000);
    expected.push(body.events[0].eventId);
    const retry = { ...body, batchId: randomUUID() };
    f.store.receive({ sub: owner.participant.participantKey, ...owner.participant }, Buffer.from(JSON.stringify(retry)), retry, f.now - 500);
  }
  put(f.store, synthetic.participant, f.now);
  const first = f.console.events({ limit: 2 });
  put(f.store, a.participant, f.now + 1);
  const actual = [...first.events]; let cursor = first.nextCursor;
  for (let page = 0; cursor && page < 10; page++) {
    const next = f.console.events({ limit: 2, cursor }); actual.push(...next.events); cursor = next.nextCursor;
  }
  assert.equal(cursor, null); assert.equal(actual.length, 8);
  assert.deepEqual([...actual.map(event => event.eventId)].sort(), expected.sort());
  assert.equal(new Set(actual.map(event => event.eventId)).size, 8);
  assert.ok(actual.every(event => event.receivedAt === f.now - 1000));
  const ordered = [...actual].sort((left, right) => right.receivedAt - left.receivedAt
    || (right.participantKey < left.participantKey ? -1 : right.participantKey > left.participantKey ? 1 : 0)
    || (right.eventId < left.eventId ? -1 : right.eventId > left.eventId ? 1 : 0));
  assert.deepEqual(actual, ordered);
  assert.equal(f.console.events({ synthetic: true }).events.length, 1);
  assert.equal(f.console.events({ subject: a.subject }).events.length, 4);
  assert.equal(f.console.events({ subject: 'a'.repeat(64) }).events.length, 0);
  for (const item of actual) for (const secret of ['subject', 'grantId', 'token', 'payloadHash']) assert.equal(secret in item, false);
});

test('query bounds and cursor binding reject malformed or altered filters', t => {
  const f = fixture(t); const a = account(f.store);
  put(f.store, a.participant, f.now - 2); put(f.store, a.participant, f.now - 1);
  const cursor = f.console.events({ limit: 1 }).nextCursor;
  for (const input of [{ limit: 51 }, { from: 0 }, { to: f.now + 400000 }, { subject: 'oops' },
    { cursor: 'invalid' }, { cursor, synthetic: true }, { cursor, from: f.now - 100 }, { cursor, subject: a.subject },
    { type: 'unknown_event' }, { token: 'extra' }, { limit: '25' }]) {
    assert.throws(() => f.console.events(input), { status: 422 });
  }
});

test('read pages enforce grant, purpose, withdrawal, TTL and restore isolation without state mutation', t => {
  const f = fixture(t); const valid = account(f.store), wrong = account(f.store), expired = account(f.store), withdrawn = account(f.store);
  put(f.store, valid.participant, f.now - 100);
  put(f.store, wrong.participant, f.now - 100);
  put(f.store, expired.participant, f.now - 181 * 86400000);
  put(f.store, withdrawn.participant, f.now - 100);
  f.store.db.prepare('UPDATE ingest_batches SET purpose_version=? WHERE participant_key=?').run('ride-analytics-v2', wrong.participant.participantKey);
  f.store.updateAccount({ ...withdrawn.request, requestId: randomUUID(), action: 'withdraw', expectedStatusVersion: 1 });
  const changes = f.store.db.prepare('SELECT total_changes() AS n').get().n;
  const result = f.console.events({}); assert.equal(result.events.length, 1); assert.equal(result.events[0].openid, valid.openid);
  f.console.status(); assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, changes);
  f.store.db.prepare("UPDATE collector_settings SET value='closed' WHERE key='restore_gate'").run();
  assert.equal(f.console.events({}).events.length, 0);
});

test('bounded selection inflates selected payloads only and paginates sparse type filters', t => {
  const f = fixture(t); const a = account(f.store);
  const bad = put(f.store, a.participant, f.now - 10000);
  f.store.db.prepare("UPDATE ingest_batches SET payload=x'ff',codec='json',raw_bytes=1 WHERE batch_id=?").run(bad.batchId);
  for (let i = 0; i < 65; i++) put(f.store, a.participant, f.now - 5000 + i);
  f.store.db.function('payload_json', () => { throw new Error('full-view expansion forbidden'); });
  assert.equal(f.console.events({ limit: 1 }).events.length, 1, 'old malformed payload is never decoded');
  const sparse = f.console.events({ type: 'trip_card_clicked' });
  assert.equal(sparse.events.length, 0); assert.equal(sparse.scanned, 50); assert.ok(sparse.nextCursor);
  assert.equal(f.console.status().collection.receivedLastMinute, 66, 'snapshot never decodes payloads');
  assert.throws(() => f.console.events({ subject: a.subject, from: f.now - 10000, to: f.now - 10000 }), { code: 'CONSOLE_SCHEMA_UNAVAILABLE' });
});

test('large event pages stop at the byte budget and continue without losing events', t => {
  const f = fixture(t); const a = account(f.store); const expected = [];
  const candidates = Array.from({ length: 50 }, (_, position) => ({ tripKey: randomUUID(), tripType: 'carpool', position,
    availableSeats: 3, serviceDate: '2026-09-30', departureMinute: 600, originArea: 'fort_lee', destinationArea: 'columbia',
    originPlaceIds: Array(10).fill('fort_lee'), destinationPlaceIds: Array(10).fill('columbia'), tripVersion: 1,
    snapshotAt: f.now, dataGeneratedAt: f.now, dataTimeSource: 'server', referencePriceCents: 1200,
    currency: 'USD', priceKind: 'listed_reference' }));
  for (let i = 0; i < 12; i++) expected.push(put(f.store, a.participant, f.now - i, { eventName: 'list_snapshot',
    data: { selectionSetId: randomUUID(), source: 'network', renderedCount: 50, hasMore: false, candidatesComplete: true, candidates } }).events[0].eventId);
  const first = f.console.events({ limit: 50 }); assert.ok(first.events.length < 12); assert.ok(first.events.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 262144); assert.ok(first.nextCursor);
  const next = f.console.events({ limit: 50, cursor: first.nextCursor });
  assert.deepEqual([...first.events, ...next.events].map(event => event.eventId), expected);
});

test('snapshot is cached for ten seconds, labels process scope, and uses ordered lookup indexes', t => {
  const f = fixture(t); const a = account(f.store);
  const first = f.console.status(); put(f.store, a.participant, f.now);
  assert.equal(f.console.status(), first); assert.equal(first.process.scope, 'process');
  assert.equal(first.process.cpuBasis, 'one_core'); assert.equal(first.process.cpuPercent, null);
  f.advance(10001); const next = f.console.status(); assert.equal(next.collection.receivedLastMinute, 1);
  assert.equal(next.collection.latestReceivedAt, f.now); assert.ok(next.process.cpuPercent >= 0);
  for (const [index, condition, params] of [['console_event_time', 'received_at>=?', [0]],
    ['console_account_event_time', 'participant_key=? AND received_at>=?', [a.participant.participantKey, 0]]]) {
    const plan = f.store.db.prepare(`EXPLAIN QUERY PLAN SELECT event_id FROM event_receipts INDEXED BY ${index}
      WHERE ${condition} ORDER BY received_at DESC,participant_key DESC,event_id DESC LIMIT 201`).all(...params);
    assert.ok(plan.some(row => row.detail.includes(`USING COVERING INDEX ${index}`) && row.detail.includes('SEARCH')));
    assert.ok(plan.every(row => !row.detail.includes('USE TEMP B-TREE')));
  }
});

test('snapshot counts are explicitly lower bounds once the indexed receipt sample reaches its cap', t => {
  const f = fixture(t); const a = account(f.store), synthetic = account(f.store, true);
  const insert = f.store.db.prepare('INSERT INTO event_receipts VALUES(?,?,?,?,?,?)');
  f.store.db.transaction(() => {
    for (let i = 0; i < 5002; i++) {
      const p = i % 2 ? a.participant : synthetic.participant;
      insert.run(p.participantKey, randomUUID(), p.grantId, 'a'.repeat(64), randomUUID(), f.now);
    }
  })();
  const value = f.console.status().collection;
  assert.equal(value.receivedLastMinuteCapped, true); assert.ok(value.receivedLastMinute <= 5000);
  assert.ok(value.receivedLastMinute > 0);
});

test('console is exposed only through authenticated private Unix admin routes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-console-http-'));
  const config = { dbPath: join(dir, 'db.sqlite'), adminSocket: join(dir, 'run/admin.sock'), host: '127.0.0.1', port: 0,
    minFreeBytes: 0, adminToken: randomBytes(32).toString('base64url'), privatePem: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const app = createCollector(config); const address = await app.start();
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const privateRequest = (path, token = config.adminToken) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: config.adminSocket, path, method: path === CONSOLE_STATUS_ROUTE ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, res => {
      let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    }); req.on('error', reject); req.end(path === CONSOLE_STATUS_ROUTE ? undefined : '{}');
  });
  for (const path of [CONSOLE_STATUS_ROUTE, CONSOLE_EVENTS_ROUTE]) {
    assert.equal((await fetch(`http://127.0.0.1:${address.port}${path}`, { method: path === CONSOLE_STATUS_ROUTE ? 'GET' : 'POST' })).status, 404);
    assert.equal((await privateRequest(path, 'bad')).status, 401);
    assert.equal((await privateRequest(path)).status, 200);
  }
});

test('activity uses deduplicated real receipts, completed minutes and no payload expansion', t => {
  const f = fixture(t), a = account(f.store), b = account(f.store), synthetic = account(f.store, true);
  const at = Math.ceil(f.now / 60000) * 60000;
  const first = put(f.store, a.participant, at + 1000);
  put(f.store, a.participant, at + 2000); put(f.store, b.participant, at + 3000);
  put(f.store, synthetic.participant, at + 4000);
  const retry = {...first,batchId:randomUUID()};
  f.store.receive({sub:a.participant.participantKey,...a.participant},Buffer.from(JSON.stringify(retry)),retry,at+5000);
  f.store.db.function('payload_json',()=>{throw new Error('must not inflate');});
  assert.equal(f.console.traffic().activity.length,0,'startup partial minute is absent');
  f.advance(at + 61000 - f.now);
  const value=f.console.traffic();
  assert.deepEqual(value.activity,[{at,activeUsers:2,events:3}]);
  assert.equal(JSON.stringify(value).includes(a.openid),false);
  assert.equal(f.console.status().collection.activeLastMinute,2);
});

test('activity cap returns unknown rather than falsely exact counts and retains bounded cached minutes', t => {
  const f=fixture(t),a=account(f.store),at=Math.ceil(f.now/60000)*60000;
  const insert=f.store.db.prepare('INSERT INTO event_receipts VALUES(?,?,?,?,?,?)');
  f.store.db.transaction(()=>{for(let i=0;i<10001;i++) insert.run(a.participant.participantKey,randomUUID(),a.participant.grantId,'a'.repeat(64),randomUUID(),at+1000);})();
  f.advance(at+61000-f.now);
  assert.deepEqual(f.console.traffic().activity,[{at,activeUsers:null,events:null}]);
  const status=f.console.status();
  assert.equal(status.collection.receivedLastMinuteCapped,true);
  assert.equal(status.collection.activeLastMinuteCapped,true);
  f.advance(10*60000);
  assert.equal(f.console.traffic().activity.length,6);
});
