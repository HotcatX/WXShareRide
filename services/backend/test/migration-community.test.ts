import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { normalizeCommunity } from '../src/migration/community.ts';
import type { MigrationIssue } from '../src/migration/types.ts';

const context = { appId: 'community-test', adminOwners: [{ accountId: 'fixture-admin', ownerKey: 'fixture-owner' }] };
const at = Date.parse('2026-09-01T12:00:00.000Z');
const image = 'cloud://fixture/community/a.jpg';
function snapshot(body = 'Fixture notice', file = image) {
  return { group: { enabled: true, title: 'Fixture group', imageFileID: file, expiresAt: at + 86400_000 },
    announcement: { enabled: false, id: 'fixture-notice', title: 'Notice', body, imageFileID: '', showGroupImage: true,
      maxShows: 1, intervalHours: 24, startAt: 0, endAt: 0 } };
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture() {
  const first = snapshot(), second = snapshot('Changed notice'), third = snapshot('Changed again', 'cloud://fixture/community/b.jpg');
  return { configs: [{ _id: 'main', ...structuredClone(third), version: 2, updatedBy: 'fixture-admin', updatedAtMs: at + 1045, lastRequestHash: hash(third) }],
    history: [{ _id: 'legacy_original_id', version: 1, previousVersion: 0, before: first, after: second, updatedBy: 'old-operator', updatedAtMs: at },
      { _id: 'v_2', version: 2, previousVersion: 1, before: structuredClone(second), after: structuredClone(third), updatedBy: 'fixture-admin', updatedAtMs: at + 1000 }] };
}
function convert(input: { configs: unknown; history: unknown } = fixture(), ctx = context) {
  const issues: Omit<MigrationIssue, 'count'>[] = [];
  const result = normalizeCommunity(input, ctx, (collection, code, field = '-', severity = 'error') => issues.push({ collection, code, field, severity }));
  return { ...result, issues, errors: issues.filter(issue => issue.severity === 'error') };
}
function rejects(input: { configs: unknown; history: unknown }, code?: string) {
  const result = convert(input);
  assert.ok(result.errors.length);
  if (code) assert.ok(result.errors.some(issue => issue.code === code), `Expected ${code}`);
  assert.deepEqual(result.configs, []); assert.deepEqual(result.revisions, []); assert.deepEqual(result.references, []);
}

test('singleton and revisions preserve content, original IDs, actors and independent update times', () => {
  const input = fixture(), before = JSON.stringify(input), result = convert(input);
  assert.deepEqual(result.errors, []); assert.equal(result.configs.length, 1); assert.equal(result.revisions.length, 2);
  const current = result.configs[0]!;
  assert.equal(current.version, 2); assert.equal(current.updatedAt, new Date(at + 1045).toISOString());
  assert.equal(result.revisions[1]!.updatedAt, new Date(at + 1000).toISOString());
  assert.equal(result.revisions[0]!.id, 'legacy_original_id'); assert.equal(result.revisions[0]!.updatedByAdminId, null);
  assert.equal(current.updatedByAdminId, 'fixture-admin');
  assert.ok(result.issues.some(issue => issue.code === 'UNKNOWN_COMMUNITY_ACTOR' && issue.severity === 'notice'));
  assert.equal('lastRequestHash' in current, false); assert.equal('imageFileID' in current.group, false);
  assert.equal('imageFileID' in current.announcement, false); assert.equal('updatedBy' in current, false);
  assert.equal(JSON.stringify(input), before);
});

test('all explicit current and historical image slots share one resource without derived duplicate images', () => {
  const result = convert(); assert.deepEqual(result.errors, []);
  assert.deepEqual(result.references.map(ref => ref.slot), ['history.1.before.group', 'history.1.after.group', 'history.2.before.group', 'history.2.after.group', 'group']);
  assert.ok(result.references.every(ref => ref.appId === context.appId && ref.resourceKind === 'community' && ref.resourceId === 'main'));
  assert.ok(result.references.every(ref => /^[a-z][a-z0-9_.-]{0,63}$/.test(ref.slot)));
  assert.equal(new Set(result.references.map(ref => ref.locator)).size, 2);
  assert.equal(result.configs[0]!.announcement.showGroupImage, true);
});

test('explicit announcement images remain referenced while group-image mode is selected', () => {
  const input = fixture();
  const announcementImage = 'cloud://fixture/community/notice.jpg';
  for (const value of [input.configs[0]!, ...input.history.flatMap(row => [row.before, row.after])]) {
    value.announcement.imageFileID = announcementImage;
  }
  input.configs[0]!.lastRequestHash = hash({ group: input.configs[0]!.group, announcement: input.configs[0]!.announcement });
  const result = convert(input);
  assert.deepEqual(result.errors, []); assert.equal(result.references.length, 10);
  assert.equal(result.references.find(ref => ref.slot === 'announcement')!.locator, announcementImage);
  assert.equal(result.configs[0]!.announcement.showGroupImage, true);
});

test('automatic switch remains distinct from manual availability and expired history stays unchanged', () => {
  const input = fixture();
  for (const item of [input.configs[0]!, ...input.history.flatMap(row => [row.before, row.after])]) {
    item.group.expiresAt = Date.parse('2000-01-01T00:00:00Z');
    item.announcement.enabled = false;
  }
  input.configs[0]!.lastRequestHash = hash({ group: input.configs[0]!.group, announcement: input.configs[0]!.announcement });
  const result = convert(input);
  assert.deepEqual(result.errors, []); assert.equal(result.configs[0]!.group.enabled, true);
  assert.equal(result.configs[0]!.group.expiresAt, '2000-01-01T00:00:00.000Z');
  assert.equal(result.configs[0]!.announcement.enabled, false);
  assert.equal('available' in result.configs[0]!.announcement, false, 'reader derives availability at request time');
  assert.equal(result.configs[0]!.announcement.startAt, null); assert.equal(result.configs[0]!.announcement.endAt, null);
});

test('source property order cannot change the producer hash or revision comparison', () => {
  const input = fixture();
  const reverse = (value: unknown): unknown => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverse(child)])) : value;
  const result = convert(reverse(input) as typeof input);
  assert.deepEqual(result.errors, []); assert.equal(result.configs.length, 1);
  const badHash = fixture(); badHash.configs[0]!.lastRequestHash = '0'.repeat(64);
  rejects(badHash, 'COMMUNITY_REQUEST_HASH_MISMATCH');
});

test('history must be complete, unique and continuous including image relationships', () => {
  const missing = fixture(); missing.history.shift(); rejects(missing, 'INCOMPLETE_COMMUNITY_HISTORY');
  const duplicate = fixture(); duplicate.history.push(structuredClone(duplicate.history[0]!)); rejects(duplicate, 'INVALID_COMMUNITY_REVISION');
  const conflictingContent = fixture(); conflictingContent.history[1]!.before.announcement.body = 'Divergent'; rejects(conflictingContent, 'CONFLICTING_COMMUNITY_HISTORY');
  const conflictingImage = fixture(); conflictingImage.history[1]!.before.group.imageFileID = 'cloud://fixture/community/other.jpg'; rejects(conflictingImage, 'CONFLICTING_COMMUNITY_HISTORY');
  const invalidPrevious = fixture(); invalidPrevious.history[1]!.previousVersion = 0; rejects(invalidPrevious, 'INVALID_COMMUNITY_REVISION');
  const backwards = fixture(); backwards.history[1]!.updatedAtMs = at - 1; rejects(backwards, 'INVALID_COMMUNITY_TIMESTAMP_ORDER');
});

test('history never creates a current record or overrides a conflicting current snapshot', () => {
  const noCurrent = fixture(); rejects({ configs: [], history: noCurrent.history }, 'INVALID_COMMUNITY_SINGLETON');
  const duplicate = fixture(); duplicate.configs.push(structuredClone(duplicate.configs[0]!)); rejects(duplicate, 'INVALID_COMMUNITY_SINGLETON');
  const wrongId = fixture(); wrongId.configs[0]!._id = 'another'; rejects(wrongId, 'INVALID_COMMUNITY_SINGLETON');
  const state = fixture(); state.configs[0]!.group.imageFileID = 'cloud://fixture/community/unrelated.jpg';
  state.configs[0]!.lastRequestHash = hash({ group: state.configs[0]!.group, announcement: state.configs[0]!.announcement });
  rejects(state, 'COMMUNITY_CURRENT_HISTORY_MISMATCH');
  const actor = fixture(); actor.configs[0]!.updatedBy = 'different-operator'; rejects(actor, 'COMMUNITY_CURRENT_ACTOR_MISMATCH');
});

test('missing source update times remain null rather than using expiry or current time', () => {
  const input = fixture() as { configs: Record<string, unknown>[]; history: Record<string, unknown>[] };
  for (const row of [...input.configs, ...input.history]) delete row.updatedAtMs;
  const result = convert(input);
  assert.deepEqual(result.errors, []); assert.equal(result.configs[0]!.updatedAt, null);
  assert.ok(result.revisions.every(row => row.updatedAt === null));
  assert.ok(result.issues.some(issue => issue.code === 'UNKNOWN_COMMUNITY_UPDATED_AT'));
  for (const value of [0, '2026-09-01', 1.5, false]) {
    const invalid = fixture(); (invalid.configs[0] as Record<string, unknown>).updatedAtMs = value;
    rejects(invalid, 'INVALID_COMMUNITY_TIMESTAMP');
  }
});

test('empty full source remains empty and a genuine version zero singleton needs no fabricated history', () => {
  assert.deepEqual(convert({ configs: [], history: [] }).errors, []);
  const initial = { _id: 'main', ...snapshot(), version: 0 };
  const result = convert({ configs: [initial], history: [] });
  assert.deepEqual(result.errors, []); assert.equal(result.configs[0]!.version, 0); assert.equal(result.revisions.length, 0);
  assert.equal(result.configs[0]!.updatedAt, null); assert.equal(result.configs[0]!.updatedByAdminId, null);
});

test('windows, frequency, booleans and images reject contradictions without inventing defaults', () => {
  for (const patch of [{ maxShows: 0 }, { maxShows: 101 }, { maxShows: '1' }, { intervalHours: -1 },
    { intervalHours: 8761 }, { enabled: 'false' }, { id: 'invalid id' },
    { startAt: at + 1, endAt: at }, { startAt: { $date: '2026-02-30T00:00:00Z' } }]) {
    const input = fixture(); Object.assign(input.history[0]!.before.announcement, patch); rejects(input);
  }
  for (const file of ['https://fixture/image.jpg', 'cloud://fixture/a/../b.jpg', 'cloud://fixture/a/%2e.jpg']) {
    const input = fixture(); input.history[0]!.before.group.imageFileID = file; rejects(input, 'INVALID_COMMUNITY_IMAGE');
  }
  const missingGroup = fixture(); missingGroup.history[0]!.before.group.imageFileID = ''; rejects(missingGroup, 'INVALID_COMMUNITY_GROUP');
  const groupOff = fixture(); Object.assign(groupOff.history[0]!.before.group, { enabled: false });
  Object.assign(groupOff.history[0]!.before.announcement, { enabled: true }); rejects(groupOff, 'INVALID_COMMUNITY_ANNOUNCEMENT');
});

test('unknown fields and unsafe JSON reject the whole slice without exposing raw keys or invoking getters', () => {
  const input = fixture(); (input.history[0]!.before.group as Record<string, unknown>)['private-unknown-field'] = 'sensitive-value';
  const result = convert(input); assert.ok(result.errors.some(issue => issue.code === 'UNMAPPED_COMMUNITY_FIELD'));
  assert.equal(JSON.stringify(result.issues).includes('private-unknown-field'), false); assert.equal(JSON.stringify(result.issues).includes('sensitive-value'), false);
  let invoked = false;
  const unsafe = fixture(); Object.defineProperty(unsafe.history[0], 'extra', { enumerable: true, get() { invoked = true; return 'private'; } });
  rejects(unsafe, 'INVALID_SOURCE_JSON'); assert.equal(invoked, false);
  rejects({ configs: null, history: [] }, 'INVALID_COMMUNITY_COLLECTION');
  for (const adminOwners of [[context.adminOwners[0]!, context.adminOwners[0]!], [{ accountId: '', ownerKey: 'owner' }]]) {
    const result = convert(fixture(), { ...context, adminOwners }); assert.ok(result.errors.length); assert.deepEqual(result.configs, []);
  }
  assert.deepEqual(convert(fixture(), { ...context, adminOwners: [context.adminOwners[0]!, { accountId: 'second', ownerKey: 'fixture-owner' }] }).errors, []);
});
