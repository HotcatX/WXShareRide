import assert from 'node:assert/strict';
import test from 'node:test';
import { archivedAccessCollections, validateArchivedAccess } from '../src/migration/archive-access.ts';
import { normalizeCloudBaseExport } from '../src/migration/normalize.ts';
import { importSnapshot, ImportAuditError } from '../src/migration/import.ts';
import { serializeSource, sourceHash } from '../src/migration/source.ts';
import type { CloudBaseExport, Document } from '../src/migration/types.ts';
import { createTestDatabase } from './helpers/database.ts';

const appId = 'access-archive-test';
const at = Date.parse('2026-09-01T12:00:00Z'), hour = 60 * 60 * 1000;
const owner = 'synthetic-old-admin-openid';
const hash = 'ab'.repeat(32), secondHash = 'cd'.repeat(32);
type Fixture = Omit<CloudBaseExport, 'collections'> & { collections: Record<string, Document[]> };

function fixture(start = at): Fixture {
  const collections: Record<string, Document[]> = {
    userInfo: [], Carpool: [], CarpoolRequest: [], CarpoolTemplate: [], Notifications: [], UserBlocks: [], TripRatings: [],
    PublicStats: [{ _id: 'home', servedTrips: 0, updatedAt: new Date(start).toISOString() }],
    MarketAdminSessions: [{ _id: `sess_${hash.slice(0, 48)}`, _openid: owner, adminOpenid: owner,
      tokenHash: hash, status: 'active', createTime: { $date: start + 20 }, createTimeMs: start,
      updateTime: { $date: start + 40 }, updateTimeMs: start + 30, expiresAtMs: start + 12 * hour }],
    WebAdminSessions: [
      { _id: hash, tokenHash: hash, accountId: 'synthetic-admin', passwordVersion: 2, status: 'active',
        createdAtMs: start + 20, expiresAtMs: start + 8 * hour },
      { _id: secondHash, tokenHash: secondHash, accountId: 'synthetic-admin', passwordVersion: 1, status: 'revoked',
        createdAtMs: start, expiresAtMs: start + 8 * hour, revokedAtMs: start + hour },
    ],
    WebAdminLoginAttempts: [
      { _id: 'global', count: 120, windowStartMs: start, expiresAtMs: start + hour / 4 },
      { _id: hash, count: 10, windowStartMs: start, expiresAtMs: start + hour / 4 },
    ],
    sys_user: [{ _id: '1234567890123456789', uuid: '1234567890123456789', uin: '123456789012',
      sub_uin: '987654321012', app_id: '1234567890', env_id: 'synthetic-platform-env', name: 'administrator',
      createBy: 'administrator', updateBy: 'administrator', user_desc: 'Synthetic platform administrator',
      parent_user_id: '', type: 0, source: 1, internal_user_type: 1, createdAt: start, updatedAt: start + hour }],
    'sys_user-preview': [], sys_department: [], 'sys_department-preview': [],
    relation_data_depart: [], 'relation_data_depart-preview': [],
  };
  return { kind: 'cloudbase-full-export', appId, collections };
}
const convert = (source: unknown) => normalizeCloudBaseExport(source, { timeZone: 'America/New_York' });
function rejected(source: Fixture, code = 'INVALID_ACCESS_ARCHIVE_DOCUMENT') {
  const result = convert(source);
  assert.equal(result.report.ready, false);
  assert.equal(result.plan, null);
  assert.ok(result.report.issues.some(issue => issue.code === code), JSON.stringify(result.report.issues));
  // Diagnostics contain only schema names and aggregate counts, not identities,
  // archived token hashes, private descriptions, or unrecognized field values.
  assert.doesNotMatch(JSON.stringify(result.report), new RegExp(`${hash}|${owner}|synthetic-admin|123456789012|Synthetic platform|private-value`));
}

test('reviewed access archives retain original JSON without creating product or administrator identities', () => {
  const source = fixture(), original = serializeSource(source), result = convert(source);
  assert.equal(result.report.ready, true, JSON.stringify(result.report.issues));
  assert.equal(serializeSource(source), original);
  const plan = result.plan!;
  for (const kind of ['users', 'adminAccounts', 'adminOrigins', 'adminAudit', 'adminRequests'] as const) {
    assert.equal(plan[kind].length, 0);
  }
  assert.equal(plan.sources.length, 7);
  for (const row of plan.sources) {
    assert.equal(row.documentJson, serializeSource(source.collections[row.collection]!.find(item => item._id === row.sourceId)));
    assert.equal(row.sha256, sourceHash(row.documentJson));
  }
  assert.equal(result.report.issues.find(issue => issue.code === 'PLATFORM_ACCOUNT_ARCHIVED')?.count, 1);
});

test('old active sessions remain archive-only regardless of wall-clock expiry', () => {
  // The importer must not gain an implicit "already expired" authorization
  // assumption that stops being true during the final cutover export.
  for (const start of [Date.parse('2001-01-01T00:00:00Z'), Date.parse('2100-01-01T00:00:00Z')]) {
    const result = convert(fixture(start));
    assert.equal(result.report.ready, true, JSON.stringify(result.report.issues));
    assert.equal(result.plan!.users.length, 0);
    assert.equal(result.plan!.adminAccounts.length, 0);
    assert.equal(result.plan!.sources.filter(row => row.collection.endsWith('Sessions')).length, 3);
  }
});

test('retired market sessions reject conflicting owners, hashes, timestamps and unreviewed states', () => {
  const changes: ((row: Document) => void)[] = [
    row => { row._id = `sess_${'ef'.repeat(24)}`; }, row => { row.tokenHash = 'raw-private-value'; },
    row => { row.adminOpenid = 'another-synthetic-owner'; }, row => { row._openid = 'uin'; },
    row => { row.status = 'revoked'; }, row => { row.expiresAtMs = at + 12 * hour + 1; },
    row => { row.updateTimeMs = at - 1; }, row => { row.updateTime = { $date: at - 1 }; },
    row => { row.createTime = { $date: at, raw: 'private-value' }; },
    row => { row.createTimeMs = Number.MAX_SAFE_INTEGER; }, row => { row.rawToken = 'private-value'; },
  ];
  for (const change of changes) {
    const source = fixture(); change(source.collections.MarketAdminSessions![0]!); rejected(source);
  }
});

test('web sessions and rate limits reject unknown identities, state transitions and producer-impossible windows', () => {
  const sessionChanges: ((row: Document) => void)[] = [
    row => { row._id = secondHash; }, row => { row.accountId = 'private-value@example.com'; },
    row => { row.passwordVersion = 0; }, row => { row.status = 'expired'; },
    row => { row.status = 'revoked'; }, row => { row.revokedAtMs = at + hour; },
    row => { row.expiresAtMs = row.createdAtMs; }, row => { row.expiresAtMs = at + 9 * hour; },
    row => { row._openid = owner; }, row => { row.createdAtMs = '2026-09-01'; },
  ];
  for (const change of sessionChanges) {
    const source = fixture(); change(source.collections.WebAdminSessions![0]!); rejected(source);
  }
  const revoked = fixture(); revoked.collections.WebAdminSessions![1]!.revokedAtMs = at - 1; rejected(revoked);
  const attemptChanges: ((row: Document) => void)[] = [
    row => { row._id = 'synthetic-admin'; }, row => { row.count = 121; }, row => { row.count = -1; },
    row => { row.count = 1.5; }, row => { row.expiresAtMs = at + hour; },
    row => { row.status = 'private-value'; }, row => { row.windowStartMs = 0; },
  ];
  for (const change of attemptChanges) {
    const source = fixture(); change(source.collections.WebAdminLoginAttempts![0]!); rejected(source);
  }
  const accountLimit = fixture(); accountLimit.collections.WebAdminLoginAttempts![1]!.count = 11; rejected(accountLimit);
});

test('platform users accept only the reviewed default administrator schema without treating UIN as OpenID', () => {
  const changes: ((row: Document) => void)[] = [
    row => { row.openid = owner; }, row => { row._openid = owner; }, row => { row.role = 'admin'; },
    row => { row.uuid = '2234567890123456789'; }, row => { row.uin = owner; },
    row => { row.sub_uin = 123456789012; }, row => { row.app_id = 'wx1234567890123456'; },
    row => { row.env_id = 'private-value.example.com'; }, row => { row.parent_user_id = '123'; },
    row => { row.name = 'private-value'; }, row => { row.createBy = 'private-value'; },
    row => { row.updateBy = 'private-value'; }, row => { row.type = 1; },
    row => { row.source = 0; }, row => { row.internal_user_type = 0; },
    row => { row.updatedAt = at - 1; }, row => { row.user_desc = 'private-value\n'; },
  ];
  for (const change of changes) {
    const source = fixture(); change(source.collections.sys_user![0]!); rejected(source);
  }
});

test('duplicate archives, newly populated reserved collections and unknown platform models require a new audit', () => {
  for (const name of archivedAccessCollections) {
    const source = fixture(), rows = source.collections[name]!;
    if (rows.length) { rows.push(structuredClone(rows[0]!)); rejected(source, 'DUPLICATE_ACCESS_ARCHIVE_ID'); }
    else { rows.push({ _id: 'private-value' }); rejected(source, 'EXPECTED_EMPTY_COLLECTION'); }
  }
  for (const rows of [[], [{ _id: 'private-value' }]]) {
    const source = fixture(); source.collections.sys_future_model = rows; rejected(source, 'UNMAPPED_COLLECTION');
  }
  const issues: string[] = [];
  validateArchivedAccess('sys_future_model', [], (_collection, code) => issues.push(code));
  validateArchivedAccess('sys_user', null as unknown as unknown[], (_collection, code) => issues.push(code));
  assert.deepEqual(issues, ['UNSUPPORTED_ACCESS_ARCHIVE', 'INVALID_ACCESS_ARCHIVE_COLLECTION']);
});

test('real PG atomically retains private access archives but imports no login state, permissions or rate limits',
  { skip: !process.env.BACKEND_TEST_DATABASE_URL, timeout: 30000 }, async t => {
    const db = await createTestDatabase(); t.after(db.close);
    const authTables = ['users', 'sessions', 'admin_accounts', 'admin_sessions', 'admin_login_attempts', 'admin_origins'];
    const invalid = fixture(); invalid.collections.sys_user![0]!.openid = owner;
    await assert.rejects(importSnapshot(db.pool, invalid, appId), error => error instanceof ImportAuditError);
    for (const table of [...authTables, 'migration_batches', 'migration_sources']) {
      assert.equal((await db.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
    }
    const source = fixture(Date.parse('2100-01-01T00:00:00Z'));
    const receipt = await importSnapshot(db.pool, source, appId);
    const rows = (await db.pool.query('SELECT collection,source_id,document_json,sha256 FROM migration_sources')).rows;
    assert.equal(rows.length, 7);
    for (const row of rows) {
      const original = source.collections[row.collection]!.find(item => item._id === row.source_id);
      assert.equal(row.document_json, serializeSource(original));
      assert.equal(row.sha256, sourceHash(row.document_json));
    }
    for (const table of authTables) assert.equal((await db.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
    assert.deepEqual(await importSnapshot(db.pool, source, appId), receipt);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM migration_sources')).rows[0].n, rows.length);
  });
