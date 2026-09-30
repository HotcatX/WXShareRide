import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { openStore } from '../src/store.mjs';
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
  return { ...participant, sub: participant.participantKey };
}
function put(store, account, eventName, data, occurredAt = now, eventId = randomUUID()) {
  const body = { schemaVersion: 1, batchId: randomUUID(), events: [{ eventId, eventName, schemaVersion: 1, occurredAt, data }] };
  return store.receive(account, Buffer.from(JSON.stringify(body)), body, now);
}
const outcomes = store => store.db.prepare('SELECT * FROM operational_followup_outcomes ORDER BY synthetic,trip_id,role').all();

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
