import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCloudBaseExport } from '../src/migration/normalize.ts';

const at = '2026-09-25T12:00:00.000Z';
const options = { timeZone: 'America/New_York' } as const;
function fixture() {
  return { kind: 'cloudbase-full-export', appId: 'app', collections: {
    userInfo: [
      { _id: 'first', _openid: 'private-first', createdAt: at, referralCode: 'ref_123456789abc', blockedUsers: [] },
      { _id: 'second', _openid: 'private-second', createdAt: at },
    ] as Record<string, unknown>[], Carpool: [], CarpoolRequest: [],
  } };
}

test('published referral codes are preserved exactly, with no synthetic code or duplicate profile field', () => {
  const input = fixture(), before = structuredClone(input);
  const result = normalizeCloudBaseExport(input, options);
  assert.equal(result.report.ready, true);
  assert.deepEqual(result.plan!.referralCodes, [{ userId: result.plan!.users[0]!.id, code: 'ref_123456789abc' }]);
  assert.equal(result.report.candidateCounts.referralCodes, 1);
  assert.deepEqual(result.plan!.users.map(user => user.profile), [{}, {}]);
  assert.equal(result.plan!.sources.length, 2);
  assert.deepEqual(input, before);
});

test('ambiguous referral ownership or invalid codes stop the entire import, without leaking values', () => {
  for (const code of ['', 'ref_123456789abc\n', 'REF_123456789ABC', 'ref_123456789abg', null, 12]) {
    const input = fixture(); input.collections.userInfo[0]!.referralCode = code;
    const result = normalizeCloudBaseExport(input, options);
    assert.equal(result.plan, null);
    assert.ok(result.report.issues.some(issue => issue.code === 'INVALID_REFERRAL_CODE'));
    assert.doesNotMatch(JSON.stringify(result.report), /private-|ref_123/);
  }
  const duplicate = fixture(); duplicate.collections.userInfo[1]!.referralCode = 'ref_123456789abc';
  assert.equal(normalizeCloudBaseExport(duplicate, options).plan, null);
  const alias = fixture(); delete alias.collections.userInfo[0]!._openid; alias.collections.userInfo[0]!.openid = 'private-first';
  assert.equal(normalizeCloudBaseExport(alias, options).plan, null, 'an unverified identity cannot claim published ownership');
});

test('only empty obsolete block arrays are archived; nonempty or malformed relations require reconciliation', () => {
  const result = normalizeCloudBaseExport(fixture(), options);
  assert.ok(result.report.issues.some(issue => issue.code === 'EMPTY_LEGACY_BLOCKS_ARCHIVED' && issue.severity === 'notice'));
  for (const value of [['private-second'], null, {}, '']) {
    const input = fixture(); input.collections.userInfo[0]!.blockedUsers = value;
    const invalid = normalizeCloudBaseExport(input, options);
    assert.equal(invalid.plan, null);
    assert.ok(invalid.report.issues.some(issue => issue.code === 'UNRESOLVED_LEGACY_BLOCKS'));
  }
});
