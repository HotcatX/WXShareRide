import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { normalizeAdminAccounts } from '../src/migration/admin.ts';
import type { MigrationIssue } from '../src/migration/types.ts';
import { serializeSource } from '../src/migration/source.ts';

const appId = 'admin-migration-fixture';
const createdAtMs = Date.parse('2026-01-02T03:04:05.006Z');
const updatedAtMs = createdAtMs + 1000;
const salt = 'ab'.repeat(32);
const hash = 'cd'.repeat(64);
const account = (patch: Record<string, unknown> = {}) => ({
  _id: 'synthetic_admin', username: 'synthetic_admin', enabled: true, role: 'admin', ownerKey: 'shared_owner',
  passwordVersion: 3, passwordDigest: { algorithm: 'scrypt', salt, hash }, createdAtMs, updatedAtMs, ...patch,
});
function convert(documents: unknown, application = appId) {
  const issues: MigrationIssue[] = [];
  const rows = normalizeAdminAccounts(documents, application, (collection, code, field = '-', severity = 'error') => {
    issues.push({ collection, code, field, severity, count: 1 });
  });
  return { rows, issues };
}
const has = (result: ReturnType<typeof convert>, code: string, field?: string) =>
  result.issues.some(issue => issue.code === code && (!field || issue.field === `WebAdminAccounts.${field}`));

test('admin migration preserves canonical identity, exact digest and times in JSON-only private rows', () => {
  const original = account();
  const before = structuredClone(original);
  const result = convert([original]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.rows, [{ id: 'synthetic_admin', appId, ownerKey: 'shared_owner', enabled: true, credentialVersion: 3,
    passwordSalt: salt, passwordHash: hash, createdAt: '2026-01-02T03:04:05.006Z', updatedAt: '2026-01-02T03:04:06.006Z' }]);
  assert.equal(Buffer.from(result.rows[0]!.passwordSalt, 'hex').length, 32);
  assert.equal(Buffer.from(result.rows[0]!.passwordHash, 'hex').length, 64);
  assert.deepEqual(JSON.parse(serializeSource(result.rows)), result.rows);
  assert.deepEqual(original, before);
  for (const alias of ['username', 'role', '_id', 'passwordVersion', 'passwordDigest', 'session']) assert.equal(alias in result.rows[0]!, false);
});

test('admin migration preserves the exact legacy scrypt password algorithm without rehashing', () => {
  const password = 'synthetic-long-password';
  const derived = scryptSync(password, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const result = convert([account({ passwordDigest: { algorithm: 'scrypt', salt, hash: derived.toString('hex') } })]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(Buffer.from(result.rows[0]!.passwordHash, 'hex'), derived);
});

test('admin migration keeps missing update time unknown rather than inventing a current timestamp', () => {
  for (const explicitNull of [false, true]) {
    const row = account();
    if (explicitNull) (row as Record<string, unknown>).updatedAtMs = null;
    else delete (row as Record<string, unknown>).updatedAtMs;
    const result = convert([row]);
    assert.equal(result.rows[0]!.updatedAt, null);
    assert.equal(result.rows[0]!.createdAt, '2026-01-02T03:04:05.006Z');
    assert.deepEqual(result.issues.map(issue => [issue.code, issue.severity]), [['UNKNOWN_UPDATED_AT', 'notice']]);
  }
});

test('admin migration rejects credential projections even for disabled accounts and never treats old sessions as accounts', () => {
  for (const enabled of [true, false]) {
    const projected = account({ enabled });
    delete (projected as Record<string, unknown>).passwordDigest;
    const result = convert([projected]);
    assert.deepEqual(result.rows, []);
    assert.ok(has(result, 'MISSING_ADMIN_CREDENTIALS', 'passwordDigest'));
  }
  const session = { _id: 'a'.repeat(64), accountId: 'synthetic_admin', tokenHash: 'a'.repeat(64),
    passwordVersion: 3, status: 'active', createdAtMs, expiresAtMs: createdAtMs + 1000 };
  assert.deepEqual(convert([session]).rows, []);
  assert.ok(has(convert([session]), 'UNMAPPED_FIELD'));
});

test('admin migration does not repair noncanonical usernames or source identity conflicts into new access', () => {
  for (const patch of [{ _id: 'other_admin' }, { username: 'other_admin' }, { username: ' SYNTHETIC_ADMIN ' },
    { _id: 'SYNTHETIC_ADMIN', username: 'SYNTHETIC_ADMIN' }, { _id: 'aa', username: 'aa' },
    { _id: 'a'.repeat(65), username: 'a'.repeat(65) }, { _id: 'synthetic_admin\n', username: 'synthetic_admin\n' },
    { username: null }, { _id: 123 }]) {
    const result = convert([account(patch)]);
    assert.deepEqual(result.rows, []);
    assert.ok(result.issues.some(issue => ['INVALID_ADMIN_IDENTITY', 'CONFLICTING_ALIASES'].includes(issue.code)));
  }
  const duplicate = convert([account(), account({ enabled: false })]);
  assert.deepEqual(duplicate.rows, []);
  assert.ok(has(duplicate, 'DUPLICATE_SOURCE_ID', '_id'));
});

test('admin migration requires exact admin role, boolean status and valid ownership and version', () => {
  for (const role of ['user', 'superadmin', 'Admin', '', null]) assert.ok(has(convert([account({ role })]), 'INVALID_ADMIN_ROLE'));
  for (const enabled of ['true', 1, null]) assert.ok(has(convert([account({ enabled })]), 'INVALID_ADMIN_ENABLED'));
  for (const ownerKey of ['', ' spaced ', 'owner/key', 'owner\n', 'x'.repeat(129), 123]) {
    assert.ok(has(convert([account({ ownerKey })]), 'INVALID_ADMIN_OWNER'));
  }
  for (const passwordVersion of [0, -1, 1.5, '1', 2147483648, null]) {
    assert.ok(has(convert([account({ passwordVersion })]), 'INVALID_ADMIN_VERSION'));
  }
  const disabled = convert([account({ enabled: false })]);
  assert.deepEqual(disabled.issues, []);
  assert.equal(disabled.rows[0]!.enabled, false);
});

test('admin migration permits multiple administrators sharing an owner but never merges their identities', () => {
  const first = account({ _id: 'aaa_admin', username: 'aaa_admin' });
  const last = account({ _id: 'zzz_admin', username: 'zzz_admin' });
  const result = convert([last, first]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.rows.map(row => row.id), ['aaa_admin', 'zzz_admin']);
  assert.ok(result.rows.every(row => row.ownerKey === 'shared_owner'));
});

test('admin migration validates digest algorithm, exact lowercase hex encodings and field allowlists', () => {
  for (const passwordDigest of [null, 'scrypt', [], {}, { algorithm: 'pbkdf2', salt, hash },
    { algorithm: 'scrypt', salt: salt.toUpperCase(), hash }, { algorithm: 'scrypt', salt, hash: hash.toUpperCase() },
    { algorithm: 'scrypt', salt: `${salt}\n`, hash }, { algorithm: 'scrypt', salt, hash: `${hash}\n` },
    { algorithm: 'scrypt', salt: 'ab'.repeat(16), hash }, { algorithm: 'scrypt', salt, hash: 'cd'.repeat(32) },
    { algorithm: 'scrypt', salt: 'gh'.repeat(32), hash }, { algorithm: 'scrypt', salt, hash: 123 },
    { algorithm: 'scrypt', salt, hash, N: 16384 }]) {
    const result = convert([account({ passwordDigest })]);
    assert.deepEqual(result.rows, []);
    assert.ok(result.issues.some(issue => issue.severity === 'error'));
  }
  assert.ok(has(convert([account({ passwordDigest: { algorithm: 'argon2', salt, hash } })]), 'UNSUPPORTED_ADMIN_PASSWORD_ALGORITHM'));
  assert.ok(has(convert([account({ passwordDigest: { algorithm: 'scrypt', salt, hash, extra: true } })]), 'UNMAPPED_FIELD', 'passwordDigest'));
});

test('admin migration only accepts trustworthy millisecond timestamps and preserves their order', () => {
  for (const createdAtMs of [0, -1, 0.5, '2026-01-02T03:04:05.006Z', null, 8640000000000001]) {
    const result = convert([account({ createdAtMs })]);
    assert.deepEqual(result.rows, []);
    assert.ok(has(result, 'MISSING_OR_INVALID_TIMESTAMP', 'createdAtMs'));
  }
  for (const updatedAtMs of [0, -1, 0.5, '', '2026-01-02T03:04:05.006Z']) {
    assert.ok(has(convert([account({ updatedAtMs })]), 'MISSING_OR_INVALID_TIMESTAMP', 'updatedAtMs'));
  }
  const backwards = convert([account({ updatedAtMs: createdAtMs - 1 })]);
  assert.deepEqual(backwards.rows, []);
  assert.ok(has(backwards, 'TIMESTAMP_ORDER', 'updatedAtMs'));
  assert.deepEqual(convert([account({ updatedAtMs: createdAtMs })]).issues, []);
});

test('admin migration validates full JSON and emits only fixed metadata even for sensitive invalid field names', () => {
  let invoked = false;
  const getter = Object.defineProperty({}, '_id', { enumerable: true, get() { invoked = true; return 'secret'; } });
  const circular: Record<string, unknown> = account(); circular.circular = circular;
  for (const value of [getter, circular, account({ unknown: undefined }), account({ extra: NaN }), account({ createdAtMs: new Date() })]) {
    const result = convert([value]);
    assert.deepEqual(result.rows, []);
    assert.ok(has(result, 'INVALID_SOURCE_JSON'));
  }
  assert.equal(invoked, false);
  const sensitive = 'synthetic-private-field-marker';
  const result = convert([account({ [sensitive]: 'synthetic-secret-value', passwordDigest: { algorithm: sensitive, salt, hash } })]);
  assert.deepEqual(result.rows, []);
  const report = JSON.stringify(result.issues);
  for (const value of [sensitive, 'synthetic-secret-value', salt, hash, 'synthetic_admin', 'shared_owner']) assert.ok(!report.includes(value));
});

test('admin migration rejects partial results, invalid collection shapes and invalid app scopes', () => {
  for (const documents of [null, {}, { data: [account()] }, 'collection', [null], [[]]]) {
    const result = convert(documents);
    assert.deepEqual(result.rows, []);
    assert.ok(result.issues.some(issue => issue.severity === 'error'));
  }
  assert.deepEqual(convert([account(), account({ _id: 'different', username: 'different', role: 'user' })]).rows, []);
  for (const app of ['', ' spaced ', 'app\n', 'bad\0app', '\ud800']) {
    const result = convert([account()], app);
    assert.deepEqual(result.rows, []);
    assert.ok(has(result, 'INVALID_APP_ID', 'appId'));
  }
  assert.deepEqual(convert([]), { rows: [], issues: [] });
});
