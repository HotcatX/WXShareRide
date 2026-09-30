import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compatOperation } from '../src/compat/contract.ts';
import { runCompatAction } from '../src/compat/service.ts';
import { transaction, withIdempotency } from '../src/db.ts';
import { importSnapshot, ImportAuditError } from '../src/migration/import.ts';
import { normalizeCloudBaseExport } from '../src/migration/normalize.ts';
import { normalizeOperationReceipts } from '../src/migration/operation-receipts.ts';
import { migrationUserId } from '../src/migration/users.ts';
import { serializeSource, sourceHash } from '../src/migration/source.ts';
import type { Document } from '../src/migration/types.ts';
import { createTestDatabase } from './helpers/database.ts';

const appId = 'wx8a8a389199aa2a0e', openid = 'synthetic-receipt-owner';
const userId = migrationUserId(appId, openid), at = Date.parse('2026-09-01T12:00:00Z');
const form = { templateName: '周二上课', departureAddress: 'Fort Lee', destinationAddress: '哥大',
  weekdayIndex: 1, weekdayText: '周二', departureTime: '15:00', passengerCount: 3,
  referencePrice: '11-13$', comment: '{"$date": 1788264000000}' };
type Snapshot = { kind: 'cloudbase-full-export'; appId: string; collections: Record<string, Document[]> };
const convert = (source: unknown) => normalizeCloudBaseExport(source, { timeZone: 'America/New_York' });
const pgOptions = { skip: !process.env.BACKEND_TEST_DATABASE_URL, timeout: 30000 };

// Fixed synthetic records captured from the retired producer, including its
// separate ISO wire replies. Never regenerate these from today's PG behavior.
const original: { source: Snapshot; wire: Record<string, Document> } = JSON.parse(
  readFileSync(new URL('./fixtures/cloud-operation-receipts.json', import.meta.url), 'utf8'));
const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, ordered(item)])) : value;
const hash = (value: unknown) => createHash('sha256').update(serializeSource(ordered(value))).digest('hex');
const fixture = () => structuredClone(original.source);
const receipt = (source: Snapshot, action: string) => source.collections.OperationReceipts!.find(row => row.action === action)!;
function refreshIdentity(row: Document) {
  row.payloadHash = hash(row.payload);
  row.id = row._id = hash([row.appId, row.openid, row.action, row.key]);
}
function rejected(source: Snapshot, expected?: string) {
  const result = convert(source);
  assert.equal(result.plan, null);
  if (expected) assert.ok(result.report.issues.some(issue => issue.code === expected), JSON.stringify(result.report.issues));
  assert.doesNotMatch(JSON.stringify(result.report), /synthetic-receipt-owner|original-templates|legacy-template-id|private-value/);
}

test('fixed historical cloud receipts preserve original intent and wire replies after their entities were deleted', () => {
  const source = fixture(), raw = serializeSource(source), result = convert(source);
  assert.equal(result.report.ready, true, JSON.stringify(result.report.issues));
  assert.equal(serializeSource(source), raw);
  assert.equal(result.plan!.operationReceipts.length, 10);
  assert.equal(result.plan!.templates.length, 0);
  assert.equal(result.plan!.notifications.length, 0);
  for (const row of result.plan!.operationReceipts) {
    const sourceRow = source.collections.OperationReceipts!.find(item => item.key === row.requestKey)!;
    assert.equal(row.operation, `compat.${sourceRow.action}`);
    assert.equal(row.userId, userId); assert.equal(row.payloadHash, sourceRow.payloadHash); assert.equal(row.responseStatus, 200);
    assert.deepEqual(row.responseBody, original.wire[row.requestKey]);
    const archive = result.plan!.sources.find(item => item.collection === 'OperationReceipts' && item.sourceId === sourceRow._id)!;
    assert.equal(archive.documentJson, serializeSource(sourceRow));
    assert.equal(archive.sha256, sourceHash(archive.documentJson));
  }
  const created = result.plan!.operationReceipts.find(row => row.operation === 'compat.templates.create')!;
  assert.equal(created.responseBody.comment, form.comment, 'date-looking business text is never recursively rewritten');
  assert.equal(typeof created.responseBody.createdAt, 'string');
  assert.equal(typeof (receipt(source, 'templates.create').response as Document).createdAt, 'object');
  const add = result.plan!.operationReceipts.find(row => row.operation === 'compat.profile.spots.add')!;
  assert.deepEqual(add.responseBody.values, ['Fort Lee', 'JFK']);
  assert.deepEqual(source.collections.userInfo![0]!.pickupSpot, ['Fort Lee']);
});

test('empty receipts are explicitly supported while malformed collections, mappings and prepared operations block the full plan', () => {
  const empty = fixture(); empty.collections.OperationReceipts = [];
  assert.equal(convert(empty).report.ready, true);
  const prepared = fixture(); receipt(prepared, 'notifications.clear').state = 'prepared';
  rejected(prepared, 'OPERATION_RECEIPT_NOT_COMPLETED');
  const unknown = fixture(); receipt(unknown, 'templates.create').state = 'pending'; rejected(unknown, 'INVALID_OPERATION_RECEIPT');
  const issues: string[] = [], report = (_collection: string, code: string) => { issues.push(code); };
  assert.deepEqual(normalizeOperationReceipts(null, { appId, users: [] }, report), []);
  assert.ok(issues.includes('INVALID_OPERATION_RECEIPT_COLLECTION'));
  issues.length = 0;
  assert.deepEqual(normalizeOperationReceipts([], { appId, users: [{ id: userId, appId: 'other-app', openid }] }, report), []);
  assert.ok(issues.includes('INVALID_USER_MAPPING'));
});

test('wrong app, owner, row identity, payload, unknown field and replay collisions cannot seed a trusted receipt', () => {
  const mutations: ((row: Document) => void)[] = [
    row => { row.appId = 'another-app'; refreshIdentity(row); }, row => { row.openid = 'synthetic-unknown-owner'; refreshIdentity(row); },
    row => { row._id = 'a'.repeat(64); }, row => { row.id = 'a'.repeat(64); }, row => { row.payloadHash = 'a'.repeat(64); },
    row => { row.key = 'short'; refreshIdentity(row); }, row => { row.actorId = 'private-value'; },
    row => { (row.payload as Document).unknown = 'private-value'; refreshIdentity(row); },
    row => { ((row.payload as Document).form as Document).weekdayIndex = 2; refreshIdentity(row); },
    row => { row.action = 'identity'; row.payload = {}; refreshIdentity(row); },
    row => { row.action = 'arbitrary.write'; refreshIdentity(row); },
    row => { row.payload = {}; refreshIdentity(row); }, row => { row.completedAt = { $date: at - 1 }; },
    row => { row.createdAt = { $date: at, extra: 'private-value' }; },
    row => { row.targets = []; row.offset = 0; row.affected = 0; },
  ];
  for (const mutate of mutations) { const source = fixture(); mutate(receipt(source, 'templates.create')); rejected(source); }
  const duplicate = fixture(); duplicate.collections.OperationReceipts!.push(structuredClone(duplicate.collections.OperationReceipts![0]!));
  rejected(duplicate, 'DUPLICATE_OPERATION_RECEIPT');
  const goodFirst = fixture(), last = goodFirst.collections.OperationReceipts!.at(-1)!;
  last.payloadHash = 'a'.repeat(64); rejected(goodFirst, 'INVALID_OPERATION_RECEIPT_HASH');
});

test('bulk receipts require immutable sorted targets and completed progress matching the exact response', () => {
  const mutations: ((row: Document) => void)[] = [
    row => { row.targets = ['same', 'same']; row.offset = 2; },
    row => { row.targets = ['later', 'earlier']; row.offset = 2; },
    row => { row.targets = ['invalid/id']; row.offset = 1; }, row => { row.offset = 0; },
    row => { row.affected = -1; }, row => { row.affected = 100; },
    row => { row.response = { deleted: 1 }; }, row => { row.response = { changed: 3 }; },
    row => { row.response = { deleted: 3, arbitrary: 'private-value' }; }, row => { delete row.targets; },
    row => { row.targets = Array.from({ length: 5000 }, (_, i) => `n${String(i).padStart(5, '0')}${'x'.repeat(150)}`); row.offset = 5000; row.affected = 0; row.response = { deleted: 0 }; },
  ];
  for (const mutate of mutations) { const source = fixture(); mutate(receipt(source, 'notifications.clear')); rejected(source); }
  const empty = fixture(), row = receipt(empty, 'notifications.clear');
  Object.assign(row, { targets: [], offset: 0, affected: 0, response: { deleted: 0 } });
  assert.equal(convert(empty).report.ready, true);
});

test('only producer-valid historical responses are accepted; no current state is used to repair them', () => {
  const changes: [string, (row: Document) => void][] = [
    ['templates.create', row => { (row.response as Document)._openid = 'synthetic-other-owner'; }],
    ['templates.create', row => { (row.response as Document)._id = 'legacy-id'; }],
    ['templates.create', row => { (row.response as Document).driverID = 'unwritten-metadata'; }],
    ['templates.create', row => { (row.response as Document).departureTime = '17:00'; }],
    ['templates.create', row => { (row.response as Document).createdAt = { $date: at }; }],
    ['templates.create', row => { (row.response as Document).updatedAt = { $date: Date.parse('2100-01-01T00:00:00Z') }; }],
    ['templates.update', row => { (row.response as Document)._id = 'wrong-id'; }],
    ['templates.update', row => { (row.response as Document).unknown = 'private-value'; }],
    ['templates.delete', row => { row.response = { id: 'wrong-id', deleted: true }; }],
    ['notifications.read', row => { row.response = { id: 'notification-1', read: false }; }],
    ['profile.spots.add', row => { row.response = { field: 'pickupSpot', values: ['Fort Lee'] }; }],
    ['profile.spots.add', row => { row.response = { field: 'pickupSpot', values: ['JFK', 'JFK'] }; }],
    ['profile.spots.add', row => { row.response = { field: 'dropoffSpot', values: ['JFK'] }; }],
    ['profile.spots.add', row => { row.response = { field: 'pickupSpot', values: [...Array.from({ length: 20 }, (_, i) => `area-${i}`), 'JFK'] }; }],
    ['profile.spots.remove', row => { row.response = { field: 'pickupSpot', values: ['JFK'] }; }],
  ];
  for (const [action, mutate] of changes) { const source = fixture(); mutate(receipt(source, action)); rejected(source, 'INVALID_OPERATION_RECEIPT_RESPONSE'); }
  const removed = fixture(); receipt(removed, 'profile.spots.remove').response = { field: 'pickupSpot', values: ['Fort Lee', 'Fort Lee'] };
  assert.equal(convert(removed).report.ready, true, 'remove preserves pre-existing duplicates unrelated to the removed value');
});

test('real PG imports and replays cloud receipts without repeating deleted entities or later profile side effects', pgOptions, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const source = fixture(), imported = await importSnapshot(db.pool, source, appId);
  assert.equal(imported.counts.operationReceipts, 10);
  const stored = (await db.pool.query('SELECT * FROM idempotency_requests')).rows;
  assert.equal(stored.length, 10);
  for (const originalRow of source.collections.OperationReceipts!) {
    const reply = await withIdempotency(db.pool, userId, compatOperation(originalRow.action as string), originalRow.key, originalRow.payload,
      async () => { assert.fail('a migrated receipt must replay before executing the business mutation'); });
    assert.deepEqual(reply, { status: 200, data: original.wire[originalRow.key as string] });
    // Exercise the actual bridge's dispatcher too: receipt lookup must precede
    // its legacy-ID mapping, missing-entity reads and all mutation helpers.
    const dispatched = await transaction(db.pool, client => runCompatAction(client, appId, openid,
      originalRow.action as string, originalRow.payload, originalRow.key));
    assert.deepEqual(dispatched, { ok: true, actor: { appId, openid, id: userId }, data: reply.data });
    const archived = (await db.pool.query('SELECT document_json,sha256 FROM migration_sources WHERE collection=$1 AND source_id=$2',
      ['OperationReceipts', originalRow._id])).rows[0];
    assert.equal(archived.document_json, serializeSource(originalRow));
    assert.equal(archived.sha256, sourceHash(archived.document_json));
    const row = stored.find(item => item.request_key === originalRow.key)!;
    assert.equal(row.created_at.toISOString(), new Date((originalRow.createdAt as { $date: number }).$date).toISOString());
    assert.equal(row.payload_hash, originalRow.payloadHash);
  }
  assert.deepEqual((await db.pool.query('SELECT profile FROM users WHERE id=$1', [userId])).rows[0].profile.preferences.pickupAddresses, ['Fort Lee']);
  for (const table of ['ride_templates', 'notifications', 'business_events', 'sessions']) {
    assert.equal((await db.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
  }
  assert.deepEqual(await importSnapshot(db.pool, source, appId), imported);
  const create = receipt(source, 'templates.create');
  await assert.rejects(withIdempotency(db.pool, userId, 'compat.templates.create', create.key, { form: { ...form, departureTime: '18:00' } },
    async () => { assert.fail('same key with different intent cannot execute'); }), (error: unknown) => (error as { code: string }).code === 'IDEMPOTENCY_CONFLICT');
  await assert.rejects(transaction(db.pool, client => runCompatAction(client, appId, openid, 'templates.create',
    { form: { ...form, departureTime: '18:00' } }, create.key)), (error: unknown) => (error as { code: string }).code === 'IDEMPOTENCY_CONFLICT');
  let canonicalCalls = 0;
  const canonical = await withIdempotency(db.pool, userId, 'templates.create', create.key, create.payload, async () => {
    canonicalCalls++; return { status: 201, data: { canonical: true } };
  });
  assert.equal(canonicalCalls, 1); assert.equal(canonical.status, 201, 'canonical namespace does not masquerade as a compat replay');
});

test('real PG rejects one malformed or prepared receipt without importing any other row, and rolls back storage failure', pgOptions, async t => {
  const db = await createTestDatabase(); t.after(db.close);
  const zero = async () => {
    for (const table of ['users', 'idempotency_requests', 'migration_batches', 'migration_sources', 'public_statistics']) {
      assert.equal((await db.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
    }
  };
  for (const broken of ['hash', 'prepared']) {
    const source = fixture(), last = source.collections.OperationReceipts!.at(-1)!;
    if (broken === 'hash') last.payloadHash = '0'.repeat(64); else last.state = 'prepared';
    await assert.rejects(importSnapshot(db.pool, source, appId), error => error instanceof ImportAuditError);
    await zero();
  }
  await db.pool.query(`CREATE FUNCTION reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic receipt storage failure'; END; $$`);
  await db.pool.query('CREATE TRIGGER reject_receipt BEFORE INSERT ON idempotency_requests FOR EACH ROW EXECUTE FUNCTION reject_receipt()');
  await assert.rejects(importSnapshot(db.pool, fixture(), appId), /synthetic receipt storage failure/);
  await zero();
  await db.pool.query('DROP TRIGGER reject_receipt ON idempotency_requests');
  assert.equal((await importSnapshot(db.pool, fixture(), appId)).counts.operationReceipts, 10);
});
