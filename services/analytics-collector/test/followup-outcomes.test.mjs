import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes, generateKeyPairSync, sign, createHash } from 'node:crypto';
import { openStore } from '../src/store.mjs';
import { createCollector } from '../src/server.mjs';
import { FOLLOWUP_QUERY_ROUTE } from '../src/places.mjs';
import { decodePayload } from '../src/payload.mjs';
import { eventSchemas } from '../src/validation.mjs';

const now = Date.now();
const followup = (extra = {}) => ({ followupId: randomUUID(), tripKey: randomUUID(), tripType: 'carpool', role: 'passenger', ...extra });
const close = (extra = {}) => ({ ...followup(), dismissalReason: 'close', assumedOutcome: 'yes', outcomeScope: 'respondent_booking', ...extra });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'followup-outcomes-'));
  const store = openStore(join(dir, 'db.sqlite'), { realEnabled: true });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}
function enroll(store, synthetic = true, openid = 'synthetic_followup_account_A') {
  const participant = store.updateAccount({ accountSubject: randomBytes(32).toString('hex'), action: 'activate',
    requestId: randomUUID(), expectedStatusVersion: 0, purposeVersion: 'ride-analytics-v1',
    noticeVersion: 'ride-analytics-notice-2026-09-23', synthetic, openid }).participant;
  return { ...participant, sub: participant.participantKey, scopes: ['batches:write', 'places:read'] };
}
function put(store, account, eventName, data, occurredAt = now, eventId = randomUUID()) {
  const body = { schemaVersion: 1, batchId: randomUUID(), events: [{ eventId, eventName, schemaVersion: 1, occurredAt, data }] };
  return store.receive(account, Buffer.from(JSON.stringify(body)), body, now);
}
const outcomes = store => store.db.prepare('SELECT * FROM operational_followup_outcomes ORDER BY synthetic,trip_id,role').all();
const query = (...trips) => ({ schemaVersion: 1, trips: trips.map(({ tripKey, tripType, role }) => ({ tripKey, tripType, role })) });

test('dismissal schema requires an explicit close-default contract and preserves legacy unknowns', () => {
  assert.equal(eventSchemas.followup_dismissed(followup()), true);
  assert.equal(eventSchemas.followup_dismissed(followup({ dismissalReason: 'hidden' })), true);
  assert.equal(eventSchemas.followup_dismissed(close({ referencePriceCents: 1300, currency: 'USD', priceKind: 'listed_reference' })), true);
  assert.equal(eventSchemas.followup_dismissed(close({ role: 'driver', outcomeScope: 'driver_any_passenger' })), true);
  for (const invalid of [
    close({ outcomeScope: 'driver_any_passenger' }), close({ assumedOutcome: 'no' }), close({ source: 'self_report' }),
    close({ dismissalReason: 'hidden' }), close({ dismissalReason: undefined }),
    followup({ dismissalReason: 'close' }), followup({ referencePriceCents: 1300 }),
    followup({ dismissalReason: 'hidden', outcomeScope: 'respondent_booking' }),
  ]) assert.equal(eventSchemas.followup_dismissed(invalid), false, JSON.stringify(invalid));
});

test('close is a source-labelled operational default; presented, legacy dismissal and hide remain unknown', t => {
  const store = fixture(t), account = enroll(store), record = followup(), eventId = randomUUID();
  put(store, account, 'followup_presented', record, now - 1000);
  const dismissal = close({ ...record, referencePriceCents: 1300, currency: 'USD', priceKind: 'listed_reference' });
  put(store, account, 'followup_dismissed', dismissal, now, eventId);
  put(store, account, 'followup_dismissed', dismissal, now, eventId);
  for (const [name, data] of [
    ['followup_presented', followup()], ['followup_dismissed', followup()],
    ['followup_dismissed', followup({ dismissalReason: 'hidden' })],
  ]) put(store, account, name, data);
  const rows = outcomes(store), assumed = rows.find(row => row.trip_id === record.tripKey);
  assert.equal(rows.length, 4);
  assert.equal(assumed.source, 'dismissed_default'); assert.equal(assumed.outcome, 'yes');
  assert.equal(assumed.event_name, 'followup_dismissed'); assert.equal(assumed.dismissal_reason, 'close');
  assert.equal(assumed.reference_price_cents, 1300); assert.equal(assumed.price_kind, 'listed_reference');
  assert.equal(rows.filter(row => row.source === 'unanswered' && row.outcome === null).length, 3);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM place_outcomes').get().n, 0,
    'default outcomes never become self-reported circle evidence');
  const counts = store.places.status(now).followupOutcomes;
  assert.equal(counts.find(row => row.source === 'dismissed_default').count, 1);
  assert.equal(counts.find(row => row.source === 'unanswered').count, 3,
    'an operational rate denominator must retain unknown opportunities');
});

test('explicit answers outrank newer or late defaults; timestamps resolve explicit corrections', t => {
  const store = fixture(t), account = enroll(store), first = followup(), second = followup();
  put(store, account, 'followup_answer', { ...first, outcome: 'no', outcomeScope: 'respondent_booking' }, now - 1000);
  put(store, account, 'followup_dismissed', close(first), now);
  put(store, account, 'followup_dismissed', close(second), now);
  put(store, account, 'followup_answer', { ...second, outcome: 'yes', outcomeScope: 'respondent_booking' }, now - 1000);
  assert.deepEqual(outcomes(store).map(row => [row.source, row.outcome]).sort(), [['self_report', 'no'], ['self_report', 'yes']]);
  put(store, account, 'followup_answer', { ...second, outcome: 'no', outcomeScope: 'respondent_booking' }, now - 500);
  put(store, account, 'followup_answer', { ...second, outcome: 'yes', outcomeScope: 'respondent_booking' }, now - 900);
  assert.equal(outcomes(store).find(row => row.trip_id === second.tripKey).outcome, 'no', 'late delivery does not replace a newer answer');
});

test('followup view isolates account, mode, trip type and role; authorization and restore gates apply', t => {
  const store = fixture(t), real = enroll(store, false), synthetic = enroll(store), other = enroll(store, false, 'synthetic_followup_account_B');
  const record = followup();
  for (const account of [real, synthetic, other]) put(store, account, 'followup_dismissed', close(record));
  put(store, real, 'followup_dismissed', close({ ...record, role: 'driver', outcomeScope: 'driver_any_passenger' }));
  put(store, real, 'followup_dismissed', close({ ...record, tripType: 'request' }));
  assert.equal(outcomes(store).length, 5);
  assert.equal(outcomes(store).filter(row => row.synthetic === 0).length, 4);
  assert.equal(outcomes(store).filter(row => row.outcome_scope === 'driver_any_passenger').length, 1);
  store.applyState({ participantKey: real.participantKey, grantId: real.grantId, status: 'revoked',
    statusVersion: real.statusVersion + 1, purposeVersion: real.purposeVersion, synthetic: false });
  assert.equal(outcomes(store).length, 2);
  store.db.prepare("UPDATE collector_settings SET value='closed' WHERE key='restore_gate'").run();
  assert.equal(outcomes(store).length, 0);
});

test('followup query returns only requested current-account outcomes, separated by synthetic mode, type and role', t => {
  const store = fixture(t), real = enroll(store, false), synthetic = enroll(store), other = enroll(store, false, 'synthetic_followup_account_B');
  const record = followup(), driver = { ...record, role: 'driver' }, request = { ...record, tripType: 'request' }, hidden = followup();
  put(store, real, 'followup_answer', { ...record, outcome: 'no', outcomeScope: 'respondent_booking' });
  put(store, synthetic, 'followup_answer', { ...record, outcome: 'yes', outcomeScope: 'respondent_booking' });
  put(store, other, 'followup_dismissed', close(record));
  put(store, real, 'followup_dismissed', close({ ...driver, outcomeScope: 'driver_any_passenger' }));
  put(store, real, 'followup_presented', request);
  put(store, real, 'followup_dismissed', close(hidden));
  const missing = followup(), result = store.followupOutcomes(real, query(record, driver, request, missing));
  assert.equal(result.ok, true); assert.equal(result.outcomes.length, 4);
  assert.deepEqual(result.outcomes.map(row => Object.keys(row).sort()), Array(4).fill(['occurredAt', 'outcome', 'role', 'source', 'tripKey', 'tripType']));
  assert.deepEqual(result.outcomes[3], { ...query(missing).trips[0], outcome: null, source: 'unanswered', occurredAt: 0 });
  assert.equal(result.outcomes.find(row => row.role === 'passenger' && row.tripType === 'carpool').outcome, 'no');
  assert.equal(result.outcomes.find(row => row.role === 'driver').source, 'dismissed_default');
  assert.equal(result.outcomes.find(row => row.tripType === 'request').outcome, null);
  assert.equal(result.outcomes.find(row => row.tripType === 'request').source, 'unanswered');
  assert.equal(store.followupOutcomes(synthetic, query(record)).outcomes[0].outcome, 'yes');
  assert.equal(store.followupOutcomes(other, query(record)).outcomes[0].source, 'dismissed_default');
  assert.deepEqual(store.followupOutcomes(enroll(store, false, 'synthetic_followup_account_C'), query(record)),
    { ok: true, outcomes: [{ ...query(record).trips[0], outcome: null, source: 'unanswered', occurredAt: 0 }] });
  assert.deepEqual(store.followupOutcomes(real, query()), { ok: true, outcomes: [] });
});

test('followup query preserves latest explicit correction over reordered defaults and duplicate deliveries', t => {
  const store = fixture(t), account = enroll(store), record = followup(), eventId = randomUUID();
  const yes = { ...record, outcome: 'yes', outcomeScope: 'respondent_booking' };
  put(store, account, 'followup_answer', yes, now - 1000, eventId);
  put(store, account, 'followup_answer', { ...yes, outcome: 'no' }, now - 2000);
  put(store, account, 'followup_dismissed', close(record), now);
  put(store, account, 'followup_answer', yes, now - 1000, eventId);
  assert.deepEqual(store.followupOutcomes(account, query(record)), { ok: true, outcomes: [{
    tripKey: record.tripKey, tripType: 'carpool', role: 'passenger', outcome: 'yes', source: 'self_report', occurredAt: now - 1000,
  }] });
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM place_outcomes').get().n, 2);
  put(store, account, 'followup_answer', { ...yes, outcome: 'no' }, now - 500);
  assert.equal(store.followupOutcomes(account, query(record)).outcomes[0].outcome, 'no');
});

test('private query decompresses only its own gzip batches and matches operational ranking and receipt deduplication', t => {
  const store = fixture(t), accounts = [], records = Array.from({ length: 4 }, () => followup());
  const event = (eventName, data, occurredAt = now) => ({ eventId: randomUUID(), eventName, schemaVersion: 1, occurredAt, data });
  for (let index = 0; index < 16; index++) {
    const account = enroll(store, true, `synthetic_query_scope_${String(index).padStart(3, '0')}`);
    accounts.push(account);
    const yes = event('followup_answer', { ...records[0], outcome: 'yes', outcomeScope: 'respondent_booking' }, now - 1000);
    for (const followups of [
      [yes, event('followup_dismissed', close(records[1]))],
      [event('followup_answer', { ...records[0], outcome: 'no', outcomeScope: 'respondent_booking' }, now - 2000), event('followup_presented', records[2])],
      [yes, event('followup_dismissed', close(records[0])), event('followup_dismissed', { ...records[3], dismissalReason: 'hidden' })],
    ]) {
      const body = { schemaVersion: 1, batchId: randomUUID(), events: [
        ...Array.from({ length: 40 }, () => event('page_view', { page: 'trip_history' })), ...followups,
      ] };
      store.receive(account, Buffer.from(JSON.stringify(body)), body, now);
    }
  }
  const expected = store.db.prepare(`SELECT trip_id AS tripKey,trip_type AS tripType,role,outcome,source,occurred_at AS occurredAt
    FROM operational_followup_outcomes WHERE participant_key=?`).all(accounts[0].participantKey);
  assert.deepEqual(new Set(expected.map(row => row.source)), new Set(['self_report', 'dismissed_default', 'unanswered']));
  const hash = value => createHash('sha256').update(value).digest('hex');
  const batches = store.db.prepare('SELECT participant_key,payload,codec FROM ingest_batches').all();
  assert.equal(batches.length, 48); assert.ok(batches.every(row => row.codec === 'gzip'));
  const owners = new Map(batches.map(row => [hash(row.payload), row.participant_key])), decoded = [];
  store.db.function('payload_json', { deterministic: true }, (payload, codec, rawBytes) => {
    decoded.push(owners.get(hash(payload)));
    return decodePayload(payload, codec, rawBytes).toString('utf8');
  });
  const actual = store.followupOutcomes(accounts[0], query(...records)).outcomes;
  assert.deepEqual(actual, records.map(record => expected.find(row => row.tripKey === record.tripKey)));
  assert.equal(actual[0].outcome, 'yes', 'late older answers and newer defaults cannot replace the explicit correction');
  assert.equal(decoded.length, 3, 'decompress each of the requested account batches once');
  assert.deepEqual(new Set(decoded), new Set([accounts[0].participantKey]), 'never inflate another participant payload');
});

test('followup HTTP query requires a scoped live grant and a bounded exact body without identity selectors', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'followup-query-http-')), keys = generateKeyPairSync('ed25519');
  const app = createCollector({ dbPath: join(dir, 'db.sqlite'), host: '127.0.0.1', port: 0,
    minFreeBytes: 0, adminSocket: join(dir, 'run/admin.sock'), adminToken: randomBytes(32).toString('base64url'),
    privatePem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), realEnabled: true });
  const address = await app.start();
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const account = enroll(app.store), record = followup();
  put(app.store, account, 'followup_dismissed', close(record));
  const token = app.tokens.issue(account).token;
  const post = async (body, auth = token) => {
    const result = await fetch(`http://127.0.0.1:${address.port}${FOLLOWUP_QUERY_ROUTE}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body),
    });
    return { status: result.status, body: await result.json(), cache: result.headers.get('cache-control') };
  };
  const valid = await post(query(record));
  assert.equal(valid.status, 200); assert.equal(valid.cache, 'no-store'); assert.equal(valid.body.outcomes[0].source, 'dismissed_default');
  assert.equal((await post(query(record), '')).status, 401);
  assert.equal((await post(query(record), app.tokens.issue(account, now - 16 * 60_000).token)).body.error, 'TOKEN_EXPIRED');
  const [header, payload] = token.split('.'), claims = JSON.parse(Buffer.from(payload, 'base64url'));
  for (const scopes of [undefined, ['batches:write']]) {
    const restricted = { ...claims, scopes };
    const input = `${header}.${Buffer.from(JSON.stringify(restricted)).toString('base64url')}`;
    const oldToken = `${input}.${sign(null, Buffer.from(input), keys.privateKey).toString('base64url')}`;
    assert.equal((await post(query(record), oldToken)).body.error, 'FOLLOWUP_SCOPE_REQUIRED');
  }
  for (const invalid of [null, {}, { ...query(record), schemaVersion: 2 }, { ...query(record), openid: 'synthetic_followup_account_B' },
    query(...Array.from({ length: 51 }, () => followup())), query(record, record),
    { schemaVersion: 1, trips: [{ ...query(record).trips[0], synthetic: false }] },
    query({ ...record, tripKey: "' OR 1=1 --" }), query({ ...record, role: 'owner' }), query({ ...record, tripType: 'other' }),
  ]) assert.equal((await post(invalid)).body.error, 'INVALID_FOLLOWUP_QUERY');
  app.store.db.prepare("UPDATE collector_settings SET value='closed' WHERE key='restore_gate'").run();
  assert.equal((await post(query(record))).body.error, 'RESTORE_QUARANTINE');
  app.store.db.prepare("UPDATE collector_settings SET value='open' WHERE key='restore_gate'").run();
  app.store.applyState({ participantKey: account.participantKey, grantId: account.grantId, status: 'active',
    statusVersion: account.statusVersion + 1, purposeVersion: account.purposeVersion, synthetic: true });
  assert.equal((await post(query(record))).body.error, 'STALE_GRANT');
  const refreshed = app.tokens.issue({ ...account, statusVersion: account.statusVersion + 1 }).token;
  assert.equal((await post(query(record), refreshed)).status, 200);
  app.store.applyState({ participantKey: account.participantKey, grantId: account.grantId, status: 'revoked',
    statusVersion: account.statusVersion + 2, purposeVersion: account.purposeVersion, synthetic: true });
  assert.equal((await post(query(record), refreshed)).body.error, 'ACCOUNT_INACTIVE');
});
