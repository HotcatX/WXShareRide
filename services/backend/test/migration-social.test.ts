import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLegacyNotifications } from '../src/migration/notifications.ts';
import { normalizeLegacyBlocks } from '../src/migration/blocks.ts';

const appId = 'wx-social-fixture';
const users = [
  { appId, id: '11111111-1111-4111-8111-111111111111', openid: 'private-fixture-owner' },
  { appId, id: '22222222-2222-4222-8222-222222222222', openid: 'private-fixture-target' },
];
const date = (day: number) => new Date(Date.UTC(2026, 8, day, 15)).toISOString();
const notification = (patch: object = {}) => ({ _id: 'notice-fixture', _openid: users[0].openid,
  carpoolId: 'deleted-ride-fixture', title: '  Original title  ', content: 'Original content\n第二行', type: 'PASSENGER_JOIN',
  extra: { role: 'driver', passengerOpenid: users[1].openid }, read: true, createdAt: { $date: Date.parse(date(1)) }, ...patch });
const block = (patch: object = {}) => ({ _id: 'block-fixture', _openid: users[0].openid, blockerOpenid: users[0].openid,
  targetOpenid: users[1].openid, active: true, reason: '', createdAt: { $date: Date.parse(date(1)) }, updatedAt: date(2), ...patch });

test('legacy notifications preserve exact text, read state, ID and deleted navigation without creating events', () => {
  const original = notification();
  const source = structuredClone(original);
  const result = normalizeLegacyNotifications([original], users, appId);
  assert.deepEqual(result.rows, [{ id: original._id, userId: users[0].id, eventId: null, rideId: original.carpoolId,
    type: original.type, title: original.title, content: original.content, read: true, createdAt: date(1) }]);
  assert.deepEqual(original, source);
  assert.deepEqual(result.issues, [{ collection: 'other', code: 'LEGACY_METADATA_ARCHIVED', field: 'Notifications.extra', severity: 'notice', count: 1 }]);
  assert.equal(JSON.stringify(result.rows).includes('private-fixture'), false);
});

test('notification navigation aliases must agree, but missing navigation is not invented', () => {
  const same = normalizeLegacyNotifications([notification({ extra: { tripId: 'deleted-ride-fixture', requestId: 'deleted-ride-fixture' } })], users, appId);
  assert.equal(same.rows?.[0].rideId, 'deleted-ride-fixture');
  const fromExtra = normalizeLegacyNotifications([notification({ carpoolId: '', extra: { requestId: 'deleted-request' } })], users, appId);
  assert.equal(fromExtra.rows?.[0].rideId, 'deleted-request');
  const missing = normalizeLegacyNotifications([notification({ carpoolId: '', extra: {} })], users, appId);
  assert.equal(missing.rows?.[0].rideId, null);
  const conflict = normalizeLegacyNotifications([notification({ extra: { tripId: 'different-private-ride' } })], users, appId);
  assert.equal(conflict.rows, null);
  assert.ok(conflict.issues.some(issue => issue.code === 'CONFLICTING_ALIASES'));
  assert.equal(JSON.stringify(conflict.issues).includes('different-private-ride'), false);
});

test('notification invalid identities, timestamps, required values and unknown fields block the whole result', () => {
  for (const patch of [{ _openid: 'unknown-private-recipient' }, { read: 1 }, { read: undefined }, { type: '' }, { title: null },
    { content: ['private-text'] }, { createdAt: '2026-09-01 15:00:00' }, { createdAt: '2026-02-30T15:00:00Z' },
    { createdAt: null }, { carpoolId: 'private / malformed' }, { extra: null }, { unrecognizedPrivateField: 'secret' },
    { extra: { unrecognizedPrivateField: 'secret' } }]) {
    const result = normalizeLegacyNotifications([notification(), notification({ _id: 'bad-notice', ...patch })], users, appId);
    assert.equal(result.rows, null);
    assert.ok(result.issues.some(issue => issue.severity === 'error'));
    assert.doesNotMatch(JSON.stringify(result.issues), /unknown-private-recipient|private-text|unrecognizedPrivateField|secret/);
  }
  assert.equal(normalizeLegacyNotifications([notification(), notification()], users, appId).rows, null);
  assert.equal(normalizeLegacyNotifications({}, users, appId).rows, null);
});

test('known notification extra metadata is shape-checked but cannot grant rights or become event evidence', () => {
  const extra = { passengerOpenid: users[1].openid, role: 'driver', action: 'rateUser', tripId: 'deleted-ride-fixture',
    driverOpenid: users[0].openid, requestId: 'deleted-ride-fixture', by: users[1].openid, reason: 'Original private reason',
    raterOpenid: users[0].openid, raterRole: 'driver', score: 4, targetRole: 'passenger', type: 'carpool' };
  const converted = normalizeLegacyNotifications([notification({ type: 'TRIP_RATING', extra })], users, appId);
  assert.ok(converted.rows);
  assert.equal(converted.rows[0].eventId, null);
  assert.equal(converted.rows[0].type, 'TRIP_RATING');
  assert.equal('extra' in converted.rows[0], false);
  for (const patch of [{ passengerOpenid: {} }, { by: '' }, { role: 'owner' }, { action: [] }, { score: '4' },
    { score: 6 }, { score: 1.5 }, { targetRole: true }, { type: 'unknown' }, { reason: {} }]) {
    const result = normalizeLegacyNotifications([notification({ extra: { ...extra, ...patch } })], users, appId);
    assert.equal(result.rows, null);
  }
});

test('source JSON validation rejects lossy values without executing getters or exposing content', () => {
  let invoked = false;
  const getter = Object.defineProperty({}, '_id', { enumerable: true, get() { invoked = true; return 'private-getter'; } });
  const circular: Record<string, unknown> = notification(); circular.extra = circular;
  for (const raw of [getter, circular, notification({ content: 'private\u0000text' }), notification({ content: '\ud800' }), notification({ extra: { score: NaN } })]) {
    const result = normalizeLegacyNotifications([raw], users, appId);
    assert.equal(result.rows, null);
    assert.ok(result.issues.some(issue => issue.code === 'INVALID_SOURCE_JSON'));
    assert.doesNotMatch(JSON.stringify(result.issues), /private-getter|private.text/);
  }
  assert.equal(invoked, false);
});

test('block records preserve direction, current state, exact reason and evidence timestamps', () => {
  const original = block({ reason: '  Keep original wording  ' });
  const result = normalizeLegacyBlocks([original], users, appId);
  assert.deepEqual(result, { rows: [{ blockerId: users[0].id, targetId: users[1].id, active: true,
    reason: original.reason, blockedAt: date(1), updatedAt: date(2) }], issues: [] });
  const reversed = normalizeLegacyBlocks([block({ _openid: users[1].openid, blockerOpenid: users[1].openid, targetOpenid: users[0].openid })], users, appId);
  assert.equal(reversed.rows?.[0].blockerId, users[1].id);
  assert.equal(reversed.rows?.[0].targetId, users[0].id);
});

test('a supported unblock then re-block uses the active episode independent of input order', () => {
  const old = block({ _id: 'old', active: false, reason: 'Old reason', updatedAt: date(2) });
  const current = block({ _id: 'current', reason: 'Current reason', createdAt: date(3), updatedAt: date(4) });
  const first = normalizeLegacyBlocks([old, current], users, appId);
  const reverse = normalizeLegacyBlocks([current, old], users, appId);
  assert.deepEqual(first, reverse);
  assert.equal(first.rows?.length, 1);
  assert.equal(first.rows?.[0].reason, 'Current reason');
  assert.equal(first.rows?.[0].blockedAt, date(3));
  assert.equal(first.rows?.[0].updatedAt, date(4));
  assert.ok(first.issues.some(issue => issue.code === 'BLOCK_HISTORY_COLLAPSED' && issue.severity === 'notice'));
});

test('all inactive block episodes use the latest evidenced removal and ignore maintenance timestamps', () => {
  const old = block({ _id: 'old', active: false, reason: 'Old', updatedAt: date(2), dedupedAt: date(9) });
  const last = block({ _id: 'last', active: false, reason: 'Last', createdAt: date(3), updatedAt: date(4), dedupedAt: date(3) });
  const result = normalizeLegacyBlocks([last, old], users, appId);
  assert.equal(result.rows?.[0].active, false);
  assert.equal(result.rows?.[0].blockedAt, date(3));
  assert.equal(result.rows?.[0].updatedAt, date(4));
  assert.equal(result.rows?.[0].reason, 'Last');
  assert.equal('dedupedAt' in result.rows![0], false);
  assert.equal(result.issues.find(issue => issue.code === 'LEGACY_METADATA_ARCHIVED')?.count, 2);
});

test('ambiguous block histories never first-win or silently restore a removed relation', () => {
  for (const records of [
    [block({ _id: 'a' }), block({ _id: 'b' })],
    [block({ _id: 'a', active: false, updatedAt: date(5) }), block({ _id: 'b', createdAt: date(3), updatedAt: date(4) })],
    [block({ _id: 'a', active: false, reason: 'A' }), block({ _id: 'b', active: false, reason: 'B' })],
    [block({ _id: 'a', active: false, updatedAt: date(4) }), block({ _id: 'b', active: false, createdAt: date(3), updatedAt: date(4) })],
  ]) {
    const result = normalizeLegacyBlocks(records, users, appId);
    assert.equal(result.rows, null);
    assert.ok(result.issues.some(issue => ['MULTIPLE_ACTIVE_BLOCKS', 'CONFLICTING_BLOCK_HISTORY'].includes(issue.code)));
    assert.deepEqual(normalizeLegacyBlocks([...records].reverse(), users, appId), result);
  }
});

test('bad block identity, state, timestamp, text and unknown fields block migration without coercion', () => {
  for (const patch of [{ _openid: 'unknown-private-blocker' }, { blockerOpenid: users[1].openid }, { targetOpenid: 'unknown-private-target' },
    { targetOpenid: users[0].openid }, { active: 'false' }, { reason: 'x'.repeat(181) }, { reason: null },
    { createdAt: null }, { updatedAt: 'bad-private-time' }, { updatedAt: date(0) }, { dedupedAt: 'unknown' },
    { blockedUsers: [] }, { unrecognizedPrivateKey: 'private-value' }]) {
    const result = normalizeLegacyBlocks([block(patch)], users, appId);
    assert.equal(result.rows, null);
    assert.doesNotMatch(JSON.stringify(result.issues), /unknown-private|bad-private|unrecognizedPrivateKey|private-value/);
  }
  assert.equal(normalizeLegacyBlocks([block(), block()], users, appId).rows, null);
  assert.equal(normalizeLegacyBlocks(null, users, appId).rows, null);
  assert.deepEqual(normalizeLegacyBlocks([], users, appId), { rows: [], issues: [] });
});

test('both converters use the central app-scoped user index and aggregate errors without PII', () => {
  for (const mapping of [[...users, users[0]], [{ ...users[0], appId: 'other-app' }, users[1]],
    [{ ...users[0], id: 'invalid-private-uuid' }, users[1]], [{ ...users[0], openid: ' padded-private ' }, users[1]]]) {
    for (const result of [normalizeLegacyNotifications([notification()], mapping, appId), normalizeLegacyBlocks([block()], mapping, appId)]) {
      assert.equal(result.rows, null);
      assert.ok(result.issues.some(issue => issue.code === 'INVALID_USER_MAPPING'));
      assert.doesNotMatch(JSON.stringify(result.issues), /other-app|private-uuid|padded-private|private-fixture/);
    }
  }
  const errors = normalizeLegacyNotifications([notification({ read: 1 }), notification({ _id: 'second', read: 1 })], users, appId).issues;
  assert.equal(errors.find(issue => issue.field === 'Notifications.read')?.count, 2);
  assert.ok(errors.every(issue => issue.collection === 'other'));
});
