import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTemplates } from '../src/migration/templates.ts';
import { templateDefinitionSchema, templateIdSchema } from '../src/templates/schemas.ts';
import { nextWeeklyOccurrence } from '../src/templates/time.ts';
import { listTemplates, updateTemplate } from '../src/templates/service.ts';
import { createTestDatabase } from './helpers/database.ts';

const createdAt = '2026-09-01T12:00:00.000Z';
const users = [{ id: '98d06e00-b1e3-44cc-8c0f-118b8c425740', openid: 'private-owner', appId: 'template-test' }];
const fixture = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  _id: 'legacy-template-id', _openid: 'private-owner', templateName: 'Tuesday class',
  departureAddress: 'Fort Lee', destinationAddress: 'Columbia', weekdayIndex: 1, weekdayText: '周二', departureTime: '15:00',
  passengerCount: 3, referencePrice: ' 15 USD ', comment: 'Private note', carBrand: 'Old brand', carModel: 'Old model',
  carNumber: 'Old plate', driverID: 'old-user-document-id', zelle: 'yes', createdAt: { $date: createdAt }, ...patch,
});
function convert(documents: unknown, inputUsers = users) {
  const issues: { collection: string; code: string; field?: string; severity: string }[] = [];
  const rows = normalizeTemplates(documents, inputUsers, (collection, code, field, severity = 'error') => issues.push({ collection, code, field, severity }));
  return { rows, issues, errors: issues.filter(issue => issue.severity === 'error') };
}

test('template migration maps only publication fields, preserves price text, and keeps unknown update time', () => {
  const original = fixture();
  const before = JSON.stringify(original);
  const { rows, errors, issues } = convert([original]);
  assert.deepEqual(errors, []);
  const row = rows[0]!;
  assert.equal(row.sourceId, original._id);
  assert.equal(row.userId, users[0]!.id);
  assert.ok(templateIdSchema.safeParse(row.id).success);
  assert.equal(row.weekday, 2);
  assert.equal(row.localTime, '15:00');
  assert.equal(row.timeZone, 'America/New_York');
  assert.equal(row.createdAt, createdAt);
  assert.equal(row.updatedAt, null);
  assert.deepEqual(row.definition, { kind: 'offer', cityKey: 'ny_nj', seatCapacity: 3, listedPriceCents: 1500,
    listedPriceLabel: ' 15 USD ', note: 'Private note', stops: [
      { kind: 'departure', address: 'Fort Lee', offsetMinutes: 0 }, { kind: 'destination', address: 'Columbia' },
    ] });
  assert.doesNotMatch(JSON.stringify(row), /Old plate|Old model|Old brand|old-user-document-id|vehicle|zelle|weekdayIndex/);
  assert.ok(issues.some(issue => issue.code === 'UNKNOWN_TEMPLATE_UPDATED_AT'));
  assert.ok(issues.some(issue => issue.code === 'TEMPLATE_METADATA_ARCHIVED'));
  assert.equal(JSON.stringify(original), before);
});

test('template IDs are deterministic, app-scoped, independent of profile, and preserve existing UUIDs', () => {
  const original = fixture();
  const first = convert([original]).rows[0]!;
  assert.equal(convert([original]).rows[0]!.id, first.id);
  assert.notEqual(convert([original], [{ ...users[0]!, appId: 'another-app' }]).rows[0]!.id, first.id);
  assert.equal(convert([{ ...original, carNumber: 'Changed plate' }]).rows[0]!.id, first.id);
  const uuid = '7967c755-d205-4674-9ce4-ceb50a9be057';
  assert.equal(convert([fixture({ _id: uuid })]).rows[0]!.id, uuid);
  assert.equal(convert([fixture({ _id: uuid })]).rows[0]!.sourceId, uuid);
  const upper = convert([fixture({ _id: uuid.toUpperCase() })]).rows[0]!;
  assert.equal(upper.id, uuid);
  assert.equal(upper.sourceId, uuid.toUpperCase(), 'retain exact source identity in the archive mapping');
  assert.ok(convert([fixture({ _id: uuid }), fixture({ _id: uuid.toUpperCase() })]).errors
    .some(issue => issue.code === 'DUPLICATE_TEMPLATE_ID'), 'reject PostgreSQL-equivalent UUIDs before import');
  assert.ok(convert([original, original]).errors.some(issue => issue.code === 'DUPLICATE_TEMPLATE_SOURCE_ID'));
  // A source UUID must not collide with another source's derived target UUID.
  assert.ok(convert([original, fixture({ _id: first.id })]).errors.some(issue => issue.code === 'DUPLICATE_TEMPLATE_ID'));
});

test('owner mapping rejects ambiguous identities, unknown users, mixed apps and malformed IDs', () => {
  for (const inputUsers of [
    [users[0]!, { ...users[0]!, id: '23a963f4-2511-42b5-9ca1-61cf46e3cb63' }],
    [users[0]!, { ...users[0]!, openid: 'different-owner' }],
    [{ ...users[0]!, id: 'not-a-uuid' }],
    [users[0]!, { id: '23a963f4-2511-42b5-9ca1-61cf46e3cb63', appId: 'other-app', openid: 'other-owner' }],
  ]) {
    const result = convert([fixture()], inputUsers);
    assert.deepEqual(result.rows, []);
    assert.ok(result.errors.some(issue => issue.code === 'INVALID_USER_MAPPING'));
  }
  const unknown = convert([fixture({ _openid: 'unknown-owner' })]);
  assert.deepEqual(unknown.rows, []);
  assert.ok(unknown.errors.some(issue => issue.code === 'UNKNOWN_TEMPLATE_USER'));
  assert.equal(convert([fixture({ _openid: 'old-user-document-id' })]).rows.length, 0, 'driverID cannot substitute for OpenID');
});

test('Monday-zero weekdays map to Sunday-zero once, and cached weekday text cannot conflict', () => {
  const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  for (let index = 0; index < 7; index++) {
    const result = convert([fixture({ weekdayIndex: index, weekdayText: names[index] })]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.rows[0]!.weekday, (index + 1) % 7);
  }
  for (const value of [-1, 7, 1.5, '1', null]) assert.equal(convert([fixture({ weekdayIndex: value })]).rows.length, 0);
  assert.ok(convert([fixture({ weekdayText: '周三' })]).errors.some(issue => issue.code === 'CONFLICTING_TEMPLATE_WEEKDAY'));
  assert.ok(convert([fixture({ departureTime: '25:00' })]).errors.some(issue => issue.code === 'INVALID_TEMPLATE_TIME'));
});

test('weekly templates retain New York wall-clock recurrence rather than an old concrete timestamp', () => {
  const row = convert([fixture({ weekdayIndex: 6, weekdayText: '周日', departureTime: '02:30' })]).rows[0]!;
  assert.deepEqual(nextWeeklyOccurrence(row, row.definition.stops, Date.parse('2026-03-07T12:00:00Z')), { stops: [
    { kind: 'departure', address: 'Fort Lee', departureAt: '2026-03-15T06:30:00.000Z' },
    { kind: 'destination', address: 'Columbia' },
  ] });
});

test('only the verified empty-template default becomes one seat; other malformed counts remain errors', () => {
  for (const [value, expected, code] of [[3, 3, null], ['3', 3, 'TEMPLATE_SEAT_STRING_NORMALIZED'], ['', 1, 'TEMPLATE_DEFAULT_SEAT_APPLIED']] as const) {
    const result = convert([fixture({ passengerCount: value })]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.rows[0]!.definition.seatCapacity, expected);
    if (code) assert.ok(result.issues.some(issue => issue.code === code && issue.severity === 'notice'));
  }
  for (const value of [0, 9, -1, 1.5, '3 people', '3.0', '3x', ' ', null]) {
    const result = convert([fixture({ passengerCount: value })]);
    assert.deepEqual(result.rows, []);
    assert.ok(result.errors.some(issue => issue.code === 'INVALID_TEMPLATE_SEAT_COUNT'));
  }
  const missing = fixture(); delete missing.passengerCount;
  assert.ok(convert([missing]).errors.some(issue => issue.code === 'INVALID_TEMPLATE_SEAT_COUNT'));
});

test('unpriced and ambiguous labels survive exactly, without extracting a first number or inventing a fare', () => {
  for (const [value, expected] of [['2人共30', null], ['价格面议', null], ['  ', null], ['免费', 0], ['20 USD', 2000], [null, null]] as const) {
    const result = convert([fixture({ referencePrice: value })]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.rows[0]!.definition.listedPriceLabel, value);
    assert.equal(result.rows[0]!.definition.listedPriceCents, expected);
  }
  for (const value of [{ value: 20 }, ['20'], true]) {
    const result = convert([fixture({ referencePrice: value })]);
    assert.ok(result.errors.some(issue => issue.code === 'INVALID_TEMPLATE_PRICE_VALUE'));
    assert.deepEqual(result.rows, []);
  }
  assert.equal(convert([fixture({ referencePrice: 'x'.repeat(1001) })]).rows.length, 0, 'long labels cannot be truncated');
  const definition = convert([fixture()]).rows[0]!.definition;
  assert.equal(templateDefinitionSchema.safeParse({ ...definition, listedPriceCents: 2000 }).success, false);
});

test('source times require valid instants and valid order; absent update time remains null', () => {
  const valid = convert([fixture({ updatedAt: { $date: '2026-09-02T08:00:00-04:00' } })]);
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.rows[0]!.updatedAt, '2026-09-02T12:00:00.000Z');
  for (const patch of [{ createdAt: '2026-09-01 12:00:00' }, { updatedAt: 'bad' }, { updatedAt: '2026-08-31T12:00:00Z' }]) {
    assert.equal(convert([fixture(patch)]).rows.length, 0);
  }
});

test('invalid documents and unknown fields never leak source names or values in audit issues', () => {
  const result = convert([null, [], fixture({ _id: '' }), fixture({ 'private-unknown-field': 'private-value' }),
    fixture({ _id: 'other-source', carNumber: 42 }), fixture({ _id: 'third-source', zelle: 'unknown' })]);
  assert.deepEqual(result.rows, []);
  assert.doesNotMatch(JSON.stringify(result.issues), /private-|Old|Columbia|legacy-template-id/);
  assert.ok(result.errors.some(issue => issue.code === 'UNMAPPED_TEMPLATE_FIELD'));
  assert.ok(result.errors.some(issue => issue.code === 'INVALID_TEMPLATE_METADATA'));
  assert.equal(convert({}).rows.length, 0);
  assert.ok(convert([fixture({ comment: undefined })]).errors.some(issue => issue.code === 'INVALID_SOURCE_JSON'));
});

test('real PostgreSQL preserves a converted template with null update time and price text through listing and edit', { skip: !process.env.BACKEND_TEST_DATABASE_URL }, async t => {
  const db = await createTestDatabase(); t.after(() => db.close());
  await db.pool.query('INSERT INTO users(id,app_id,openid) VALUES ($1,$2,$3)', [users[0]!.id, users[0]!.appId, users[0]!.openid]);
  const row = convert([fixture({ referencePrice: ' 2人共30 ' })]).rows[0]!;
  await db.pool.query(`INSERT INTO ride_templates(id,user_id,name,weekday,local_time,time_zone,definition,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [row.id, row.userId, row.name, row.weekday, row.localTime, row.timeZone, row.definition, row.createdAt, row.updatedAt]);
  const list = await listTemplates(db.pool, users[0]!.id, {}, Date.parse('2026-09-25T12:00:00Z'));
  assert.equal(list.items[0]!.updatedAt, null);
  assert.equal(list.items[0]!.definition.listedPriceLabel, ' 2人共30 ');
  assert.equal(list.items[0]!.definition.listedPriceCents, null);
  assert.doesNotMatch(JSON.stringify(list), /sourceId|Old plate|private-owner/);
  const edited = await updateTemplate(db.pool, users[0]!.id, 'edit-imported-template', row.id, { name: 'Edited weekly class' });
  assert.ok(edited.data.updatedAt);
  assert.equal(templateDefinitionSchema.parse(edited.data.definition).listedPriceLabel, ' 2人共30 ');
  assert.equal((await db.pool.query('SELECT count(*)::int AS count FROM rides')).rows[0].count, 0);
});
