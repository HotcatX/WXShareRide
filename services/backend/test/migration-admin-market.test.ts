import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { normalizeAdminMarket } from '../src/migration/admin-market.ts';
import type { MigrationIssue } from '../src/migration/types.ts';

const appId = 'admin-market-converter';
const ownerKey = 'fixture_owner', accountId = 'fixture_admin', batchId = 'fixture_batch';
const createdAtMs = Date.parse('2026-09-25T12:34:56.789Z');
const rowHash = 'ab'.repeat(32), batchHash = 'cd'.repeat(32);
const identity = (owner: string, key: string) => `web_${createHash('sha256').update(`${owner}:${key}`).digest('hex').slice(0, 48)}`;
const rowId = identity(ownerKey, 'explicit_original_request');
const context = { appId, adminAccounts: [{ appId, id: accountId, ownerKey }] };
function listing(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { _id: rowId, ownerKey, managedByOwnerKey: ownerKey, managedByAccountId: accountId,
    managedByAdmin: true, managedSource: 'web_admin', webAdminRequestHash: rowHash,
    clientRequestId: '', adminBatchId: batchId, adminExternalId: 'row_1', createTime: { $date: createdAtMs + 100 },
    title: 'Synthetic edited content', webAdminVersion: 4, ...patch };
}
function batch(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { _id: identity(ownerKey, batchId), accountId, ownerKey, batchId,
    type: 'market_admin_bulk', source: 'web_admin', requestHash: batchHash,
    total: 1, status: 'done', success: 1, failed: 0,
    results: [{ index: 0, id: rowId, externalId: 'row_1' }], failures: [],
    createdAtMs, updatedAtMs: createdAtMs + 200, ...patch };
}
function convert(batches: unknown = [batch()], listings: unknown = [listing()], mapping = context) {
  const issues: Omit<MigrationIssue, 'count'>[] = [];
  const rows = normalizeAdminMarket({ batches, listings }, mapping,
    (collection, code, field = '-', severity = 'error') => issues.push({ collection, code, field, severity }));
  return { ...rows, issues };
}
function rejects(batches: unknown, listings: unknown = [listing()], code?: string) {
  const result = convert(batches, listings);
  assert.deepEqual(result.batches, []); assert.deepEqual(result.requests, []);
  assert.ok(result.issues.some(issue => issue.severity === 'error'));
  if (code) assert.ok(result.issues.some(issue => issue.code === code), `Expected ${code}`);
}

test('preserves independent legacy batch and row hashes using the surviving hashed identity, not a guessed plaintext key', () => {
  const sourceBatch = batch(), sourceListing = listing(), before = structuredClone([sourceBatch, sourceListing]);
  const result = convert([sourceBatch], [sourceListing]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.batches, [{ appId, ownerKey, id: batchId, payloadHash: batchHash, payloadFormat: 'legacy-web-v1',
    total: 1, status: 'done', results: [{ index: 0, id: rowId, externalId: 'row_1' }], failures: [],
    createdAt: '2026-09-25T12:34:56.789Z', updatedAt: '2026-09-25T12:34:56.989Z' }]);
  assert.deepEqual(result.requests, [{ appId, ownerKey, operation: 'market.create', requestKey: rowId,
    payloadHash: rowHash, payloadFormat: 'legacy-web-v1', responseStatus: 201, responseBody: { id: rowId },
    createdAt: '2026-09-25T12:34:56.889Z' }]);
  assert.notEqual(rowId, identity(ownerKey, 'external_row_1'));
  assert.notEqual(rowId, identity(ownerKey, `${batchId}_row_1`));
  assert.deepEqual([sourceBatch, sourceListing], before);
  result.batches[0]!.results[0]!.externalId = 'mutated_candidate';
  result.requests[0]!.responseBody.id = 'mutated_candidate';
  assert.deepEqual([sourceBatch, sourceListing], before);
});

test('running batches retain interrupted state and committed row receipts without invented completion times', () => {
  const source = batch({ status: 'running' });
  for (const key of ['results', 'failures', 'success', 'failed', 'updatedAtMs']) delete source[key];
  const result = convert([source]);
  assert.deepEqual(result.issues, []); assert.equal(result.batches[0]!.updatedAt, null);
  assert.deepEqual(result.batches[0]!.results, []); assert.deepEqual(result.batches[0]!.failures, []);
  assert.equal(result.batches[0]!.status, 'running'); assert.equal(result.requests.length, 1);
  rejects([batch({ status: 'running' })], undefined, 'INVALID_ADMIN_MARKET_BATCH_STATE');
});

test('partial and failed batches preserve exact row indexes and failure codes without manufacturing successful rows', () => {
  const failures = [{ index: 1, error: 'invalid_item' }, { index: 2, error: 'file_not_owned' }];
  const partial = convert([batch({ total: 3, status: 'partial', failed: 2, failures })]);
  assert.deepEqual(partial.issues, []); assert.deepEqual(partial.batches[0]!.failures, failures);
  assert.equal(partial.requests.length, 1);
  const failed = convert([batch({ status: 'failed', success: 0, failed: 1, results: [], failures: [{ index: 0, error: 'invalid_item' }] })], []);
  assert.deepEqual(failed.issues, []); assert.equal(failed.batches[0]!.status, 'failed'); assert.deepEqual(failed.requests, []);
});

test('a completed batch preserves deleted listing IDs without restoring a listing or guessing a missing row hash', () => {
  const result = convert([batch()], []);
  assert.equal(result.batches.length, 1); assert.deepEqual(result.requests, []);
  assert.equal(result.batches[0]!.results[0]!.id, rowId);
  assert.deepEqual(result.issues.map(issue => [issue.code, issue.severity]), [['ADMIN_MARKET_DELETED_RESULT_PRESERVED', 'notice']]);
});

test('shared-owner admins and repeated rows across or within batches retain valid old deduplication semantics', () => {
  const nextId = 'second_batch';
  const first = batch({ total: 2, success: 2, results: [
    { index: 0, id: rowId, externalId: 'row_1' }, { index: 1, id: rowId, externalId: 'row_1' },
  ] });
  const second = batch({ _id: identity(ownerKey, nextId), batchId: nextId, accountId: 'other_admin',
    results: [{ index: 0, id: rowId, externalId: 'changed_external_label' }] });
  const result = convert([first, second], [listing()], { ...context,
    adminAccounts: [...context.adminAccounts, { appId, id: 'other_admin', ownerKey }] });
  assert.deepEqual(result.issues, []); assert.equal(result.batches.length, 2); assert.equal(result.requests.length, 1);
  assert.equal(result.batches[1]!.results[0]!.externalId, 'changed_external_label');
});

test('legacy OpenID admin goods create no website ownership or web receipts', () => {
  const source = { _id: 'legacy_openid_listing', _openid: 'synthetic_openid', managedByAdmin: true,
    managedByOpenid: 'synthetic_openid', managedSource: 'admin_bulk', clientRequestId: 'legacy_request' };
  const result = convert([], [source]);
  assert.deepEqual(result, { batches: [], requests: [], issues: [] });
});

test('exact batch identity, owner/account scope and source metadata are required; errors reject both candidate groups', () => {
  for (const patch of [{ _id: `web_${'f'.repeat(48)}` }, { _id: `${identity(ownerKey, batchId)}\n` },
    { batchId: 'invalid key' }, { accountId: 'unknown_admin' }, { ownerKey: 'other_owner' },
    { type: 'other' }, { source: 'admin_bulk' }, { requestHash: rowHash.toUpperCase() }, { requestHash: `${rowHash}\n` },
    { secret_unknown_field: 'private-fixture' }]) rejects([batch(patch)]);
  rejects([batch(), batch()], undefined, 'INVALID_ADMIN_MARKET_BATCH_ID');
  for (const mapping of [
    { appId: '', adminAccounts: [] }, { ...context, adminAccounts: [{ ...context.adminAccounts[0]!, appId: 'wrong_app' }] },
    { ...context, adminAccounts: [...context.adminAccounts, ...context.adminAccounts] },
  ]) {
    const result = convert([batch()], [listing()], mapping);
    assert.deepEqual(result.batches, []); assert.deepEqual(result.requests, []); assert.ok(result.issues.length);
  }
});

test('batch summaries must form a complete disjoint index partition with state-appropriate exact counts', () => {
  for (const patch of [{ total: 0 }, { total: 51 }, { total: '1' }, { total: 1.5 }, { success: '1' }, { success: 0 },
    { failed: 1 }, { status: 'partial' }, { status: 'failed' }, { status: 'other' }, { results: [] },
    { results: [{ index: 1, id: rowId, externalId: 'row_1' }] },
    { results: [{ index: '0', id: rowId, externalId: 'row_1' }] },
    { results: [{ index: 0, id: 'non_web_item', externalId: 'row_1' }] },
    { results: [{ index: 0, id: rowId, externalId: 'row_1', ignored: true }] },
    { results: [{ index: 0, id: rowId, externalId: 'row_1' }], failures: [{ index: 0, error: 'invalid_item' }] },
  ]) rejects([batch(patch)]);
  rejects([batch({ total: 2, success: 2, results: [
    { index: 0, id: rowId, externalId: 'row_1' }, { index: 0, id: rowId, externalId: 'row_2' },
  ] })], undefined, 'INVALID_ADMIN_MARKET_BATCH_INDEX');
  for (const error of ['PRIVATE MESSAGE', 'invalid_item\n', '', 123]) {
    rejects([batch({ status: 'failed', success: 0, failed: 1, results: [], failures: [{ index: 0, error }] })]);
  }
});

test('row receipts require the trusted web owner, original creation batch, exact hash and valid surviving client key when present', () => {
  for (const patch of [{ ownerKey: 'other_owner' }, { managedByOwnerKey: 'other_owner' }, { managedByAccountId: 'unknown_admin' },
    { managedByAdmin: false }, { managedSource: 'other' }, { _openid: 'synthetic_openid' }, { managedByOpenid: 'synthetic_openid' },
    { _id: 'not_web' }, { webAdminRequestHash: rowHash.toUpperCase() }, { adminExternalId: '' }, { adminBatchId: '' },
    { clientRequestId: null }, { clientRequestId: 'wrong_explicit_key' }, { adminBatchId: 'missing_batch' }]) rejects([batch()], [listing(patch)]);
  rejects([batch()], [listing(), listing()], 'INVALID_ADMIN_MARKET_LISTING_ID');
  const retained = convert([batch()], [listing({ clientRequestId: 'explicit_original_request' })]);
  assert.deepEqual(retained.issues, []); assert.equal(retained.requests[0]!.requestKey, rowId);
  const wrongOwner = { ...context, adminAccounts: [...context.adminAccounts, { appId, id: 'other_admin', ownerKey: 'other_owner' }] };
  const foreignBatch = batch({ ownerKey: 'other_owner', accountId: 'other_admin', _id: identity('other_owner', batchId) });
  const result = convert([batch(), foreignBatch], [listing()], wrongOwner);
  assert.deepEqual(result.batches, []); assert.ok(result.issues.some(issue => issue.code === 'ADMIN_MARKET_BATCH_RESULT_OWNER_MISMATCH'));
});

test('timestamps preserve producer clocks and reject missing or invented times', () => {
  for (const patch of [{ createdAtMs: null }, { createdAtMs: 0 }, { createdAtMs: 0.5 }, { createdAtMs: '2026-09-25T12:34:56.789Z' },
    { updatedAtMs: null }, { updatedAtMs: createdAtMs - 1 }]) rejects([batch(patch)], undefined, 'INVALID_ADMIN_MARKET_BATCH_TIMESTAMP');
  const missing = batch(); delete missing.updatedAtMs; rejects([missing], undefined, 'INVALID_ADMIN_MARKET_BATCH_COMPLETION');
  for (const createTime of [null, '2026-09-25', 0, { $date: 'invalid' }]) rejects([batch()], [listing({ createTime })], 'INVALID_ADMIN_MARKET_REQUEST_TIMESTAMP');
});

test('invalid sources and diagnostics do not leak identities, hashes or unknown field names, nor invoke getters', () => {
  rejects({}, [], 'INVALID_ADMIN_MARKET_COLLECTIONS'); rejects([], {}, 'INVALID_ADMIN_MARKET_COLLECTIONS');
  rejects([null], [], 'INVALID_ADMIN_MARKET_BATCH'); rejects([], [null], 'INVALID_ADMIN_MARKET_LISTING_ID');
  let invoked = false;
  const source = Object.defineProperty({}, '_id', { enumerable: true, get() { invoked = true; return 'never'; } });
  rejects([source], [], 'INVALID_SOURCE_JSON'); assert.equal(invoked, false);
  const result = convert([batch({ private_field_marker: 'private_value_marker' })]);
  for (const privateValue of [accountId, ownerKey, batchId, rowId, rowHash, batchHash, 'private_field_marker', 'private_value_marker']) {
    assert.equal(JSON.stringify(result.issues).includes(privateValue), false);
  }
});
