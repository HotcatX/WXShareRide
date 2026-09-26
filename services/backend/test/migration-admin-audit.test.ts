import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { normalizeAdminAudit, validateLegacyMarketAdmins, validateLegacyMarketAdminSettings } from '../src/migration/admin-audit.ts';
import type { MigrationIssue } from '../src/migration/types.ts';

const appId = 'admin-audit-test';
const createdAtMs = Date.parse('2026-09-25T12:34:56.789Z');
const requestHash = 'ab'.repeat(32);
const accountId = 'fixture_admin';
const details: Record<string, Record<string, unknown>> = {
  login: {}, logout: {}, createItem: { itemId: `web_${'a'.repeat(48)}`, batchId: 'fixture-batch', externalId: 'fixture-external', requestHash },
  bulkCreate: { batchId: 'fixture-batch', total: 1, requestHash },
  updateItem: { itemId: 'legacy-item', fields: ['title', 'imageFileIDs'], requestHash, version: 2 },
  saveTemplate: { templateId: 'legacy-template' }, deleteTemplate: { templateId: 'legacy-template' },
  uploadImage: { fileID: `cloud://fixture/web-admin/${accountId}/${'a'.repeat(32)}.jpg`, purpose: 'market', size: 100, contentHash: requestHash },
  updateCommunity: { version: 2, previousVersion: 1, requestHash },
};
function audit(action = 'login', patch: Record<string, unknown> = {}): Record<string, unknown> {
  const row: Record<string, unknown> = { accountId, action, createdAtMs, ...details[action], ...patch };
  const sourceId = action === 'uploadImage'
    ? `request_${createHash('sha256').update(`${row.accountId}:${row.purpose}:${row.contentHash}`).digest('hex')}`
    : createHash('md5').update(action).digest('hex');
  return { _id: sourceId, ...row };
}
function convert(documents: unknown, application = appId) {
  const issues: Omit<MigrationIssue, 'count'>[] = [];
  const rows = normalizeAdminAudit(documents, application,
    (collection, code, field = '-', severity = 'error') => issues.push({ collection, code, field, severity }));
  return { rows, issues };
}
function rejects(documents: unknown, code?: string) {
  const result = convert(documents); assert.deepEqual(result.rows, []); assert.ok(result.issues.length);
  if (code) assert.ok(result.issues.some(issue => issue.code === code), `Expected ${code}`);
}

test('every audited action preserves only its original details, actor and millisecond time without creating an account', () => {
  const input = Object.keys(details).map(action => audit(action));
  const before = structuredClone(input), result = convert(input);
  assert.deepEqual(result.issues, []); assert.equal(result.rows.length, 9);
  for (const row of result.rows) {
    assert.deepEqual(row.details, details[row.action]);
    assert.equal(row.accountId, accountId); assert.equal(row.appId, appId);
    assert.equal(row.createdAt, '2026-09-25T12:34:56.789Z');
    assert.match(row.id, /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    for (const forbidden of ['password', 'credentials', 'session', 'ownerKey', 'role']) assert.equal(forbidden in row, false);
  }
  assert.deepEqual(input, before);
  (result.rows.find(row => row.action === 'updateItem')!.details.fields as string[]).push('price');
  assert.deepEqual(input, before);
});

test('UUID mapping is stable, app-scoped and preserves request_ upload audits without random IDs', () => {
  const input = [audit('login'), audit('uploadImage')];
  const first = convert(input), replay = convert(structuredClone(input)), other = convert(input, 'other-app');
  assert.deepEqual(first.issues, []); assert.deepEqual(first, replay);
  assert.notEqual(first.rows[0]!.id, first.rows[1]!.id);
  assert.ok(first.rows.every((row, index) => row.id !== other.rows[index]!.id));
  assert.equal(first.rows.find(row => row.action === 'uploadImage')!.details.contentHash, requestHash);
});

test('unknown actions, action-specific fields and missing details reject the entire candidate collection', () => {
  rejects([audit('login'), audit('deleteItem')], 'UNKNOWN_ADMIN_AUDIT_ACTION');
  rejects([audit('login', { token: 'sensitive-fixture' })], 'UNMAPPED_ADMIN_AUDIT_FIELD');
  rejects([audit('bulkCreate', { itemId: 'other-item' })], 'UNMAPPED_ADMIN_AUDIT_FIELD');
  for (const action of Object.keys(details)) {
    for (const field of Object.keys(details[action]!)) {
      const row = audit(action); delete row[field];
      rejects([row], 'INVALID_ADMIN_AUDIT_DETAILS');
    }
  }
  rejects([audit('constructor')], 'UNKNOWN_ADMIN_AUDIT_ACTION');
});

test('source IDs and canonical actor names cannot be normalized, duplicated or used to synthesize permissions', () => {
  rejects([audit(), audit()], 'INVALID_ADMIN_AUDIT_ID');
  for (const _id of ['', 'a'.repeat(31), `${'a'.repeat(32)}\n`, 'A'.repeat(32), `request_${'a'.repeat(64)}`]) {
    rejects([audit('login', { _id })], 'INVALID_ADMIN_AUDIT_ID');
  }
  for (const accountId of ['', 'Aaa_admin', ' padded_admin ', 'aa', 'admin\n', 1, null]) {
    rejects([audit('login', { accountId })], 'INVALID_ADMIN_AUDIT_ACTOR');
  }
  assert.equal(convert([audit('login', { accountId: 'historical_deleted_admin' })]).rows.length, 1);
  assert.ok(convert([audit()], '').issues.some(issue => issue.code === 'INVALID_ADMIN_AUDIT_APP'));
});

test('upload receipts verify request hash, exact account path, image purpose and bounded upload size', () => {
  for (const patch of [{ _id: `request_${'b'.repeat(64)}` }, { fileID: 'https://fixture/a.jpg' },
    { fileID: `cloud://fixture/web-admin/other_admin/${'a'.repeat(32)}.jpg` },
    { fileID: `cloud://fixture/web-admin/${accountId}/../${'a'.repeat(32)}.jpg` },
    { fileID: `cloud://fixture/web-admin/${accountId}/${'a'.repeat(32)}.exe` },
    { purpose: 'other' }, { size: 11 }, { size: 2 * 1024 * 1024 + 1 }, { size: '100' },
    { contentHash: requestHash.toUpperCase() }, { contentHash: `${requestHash}\n` }]) rejects([audit('uploadImage', patch)]);
  for (const purpose of ['market', 'market_thumb', 'community']) assert.deepEqual(convert([audit('uploadImage', { purpose })]).issues, []);
});

test('batch quantities, hashes, ordered edited field names and sequential versions follow the actual old producer', () => {
  for (const total of [0, 51, 1.5, '1']) rejects([audit('bulkCreate', { total })], 'INVALID_ADMIN_AUDIT_DETAILS');
  for (const fields of [[], ['status'], ['ownerKey'], ['title', 'title'], [1], 'title']) {
    rejects([audit('updateItem', { fields })], 'INVALID_ADMIN_AUDIT_DETAILS');
  }
  for (const patch of [{ version: 3, previousVersion: 1 }, { version: 0, previousVersion: -1 }, { version: '2' }, { previousVersion: '1' }]) {
    rejects([audit('updateCommunity', patch)], 'INVALID_ADMIN_AUDIT_DETAILS');
  }
  for (const requestHash of ['', 'ab', null, 'AB'.repeat(32)]) rejects([audit('bulkCreate', { requestHash })], 'INVALID_ADMIN_AUDIT_DETAILS');
  rejects([audit('createItem', { itemId: 'legacy-item' })], 'INVALID_ADMIN_AUDIT_DETAILS');
});

test('audit times must be exact numeric source milliseconds, not a fallback now or guessed ISO string', () => {
  for (const createdAtMs of [null, 0, -1, 0.5, '2026-09-25T12:34:56.789Z', 8640000000000001]) {
    rejects([audit('login', { createdAtMs })], 'INVALID_ADMIN_AUDIT_TIMESTAMP');
  }
  const row = audit(); delete row.createdAtMs; rejects([row], 'INVALID_ADMIN_AUDIT_TIMESTAMP');
});

test('invalid JSON and diagnostics never invoke getters or reveal source actors, paths, hashes or unknown field text', () => {
  rejects({}, 'INVALID_ADMIN_AUDIT_COLLECTION'); rejects([null], 'INVALID_ADMIN_AUDIT_DOCUMENT');
  let invoked = false;
  const raw = Object.defineProperty({}, 'action', { enumerable: true, get() { invoked = true; return 'login'; } });
  rejects([raw], 'INVALID_SOURCE_JSON'); assert.equal(invoked, false);
  const result = convert([audit('uploadImage', { private_field_marker: 'private-value' })]);
  for (const text of [accountId, requestHash, details.uploadImage!.fileID as string, 'private_field_marker', 'private-value']) {
    assert.equal(JSON.stringify(result.issues).includes(text), false);
  }
});

function oldAdmin(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { _id: 'fixture-openid', openid: 'fixture-openid', role: 'market_admin', status: 'active',
    note: 'Synthetic historical note', createdAtMs, updatedAtMs: createdAtMs + 100, ...patch };
}
function oldSettings(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { _id: 'bulk_publish_password', code: '123456', mode: 'fixture_mode', status: 'active',
    updateTimeMs: createdAtMs, updatedAtMs: createdAtMs + 100, ...patch };
}
function validate(validator: typeof validateLegacyMarketAdmins, input: unknown) {
  const issues: Omit<MigrationIssue, 'count'>[] = [];
  const result = validator(input, (collection, code, field = '-', severity = 'error') => issues.push({ collection, code, field, severity }));
  assert.equal(result, undefined); return issues;
}

test('obsolete administrator collections only validate archival facts and do not return new authentication rows', () => {
  const admin = oldAdmin(), settings = oldSettings();
  const before = JSON.stringify([admin, settings]);
  assert.deepEqual(validate(validateLegacyMarketAdmins, [admin]), []);
  const result = validate(validateLegacyMarketAdminSettings, [settings]);
  assert.deepEqual(result.map(issue => [issue.code, issue.severity]), [['LEGACY_MARKET_ADMIN_SETTINGS_DISTINCT_CLOCKS_ARCHIVED', 'notice']]);
  assert.equal(JSON.stringify([admin, settings]), before);
  assert.deepEqual(validate(validateLegacyMarketAdmins, []), []);
  assert.deepEqual(validate(validateLegacyMarketAdminSettings, []), []);
});

test('obsolete OpenID administrators require matching identities, proven role, valid state and ordered real times', () => {
  for (const patch of [{ openid: 'other-fixture' }, { role: 'admin' }, { status: true }, { note: 3 },
    { createdAtMs: null }, { updatedAtMs: createdAtMs - 1 }, { extra: true }]) {
    assert.ok(validate(validateLegacyMarketAdmins, [oldAdmin(patch)]).some(issue => issue.severity === 'error'));
  }
  assert.ok(validate(validateLegacyMarketAdmins, [oldAdmin(), oldAdmin()]).some(issue => issue.code === 'INVALID_LEGACY_MARKET_ADMIN_IDENTITY'));
});

test('obsolete code settings validate a single known source record while keeping independent metadata clocks private', () => {
  for (const patch of [{ _id: 'other' }, { code: 123456 }, { code: '12345' }, { code: '123456\n' },
    { status: 'unknown' }, { mode: '' }, { updatedAtMs: 'not-a-time' }, { updateTimeMs: 0 }, { secret_extra: 'private-fixture' }]) {
    const issues = validate(validateLegacyMarketAdminSettings, [oldSettings(patch)]);
    assert.ok(issues.some(issue => issue.severity === 'error'));
    assert.equal(JSON.stringify(issues).includes('123456'), false);
    assert.equal(JSON.stringify(issues).includes('private-fixture'), false);
  }
  assert.ok(validate(validateLegacyMarketAdminSettings, [oldSettings(), oldSettings()]).some(issue => issue.severity === 'error'));
  for (const status of ['active', 'disabled', 'inactive']) {
    assert.ok(validate(validateLegacyMarketAdminSettings, [oldSettings({ status })]).every(issue => issue.severity === 'notice'));
  }
});
