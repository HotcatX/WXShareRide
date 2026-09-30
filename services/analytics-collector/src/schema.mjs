export const SCHEMA_VERSION = 6;
export const TABLES = Object.freeze({
  participants: 'analytics_participants',
  accounts: 'analytics_accounts',
  operations: 'analytics_operations',
  accountOpenidIndex: 'analytics_account_openid',
});

// One-time storage upgrade. ALTER TABLE preserves records, primary keys,
// foreign keys and dependent views; no parallel legacy state is retained.
const tableRenames = [
  ['research_participants', TABLES.participants],
  ['research_accounts', TABLES.accounts],
  ['participation_operations', TABLES.operations],
  ['place_participation_history', 'place_membership_history'],
];
const indexes = [
  ['research_account_openid', 'research_accounts', TABLES.accountOpenidIndex],
  ['participation_operation_age', 'participation_operations', 'analytics_operation_age'],
  ['place_participation_account', 'place_participation_history', 'place_membership_account'],
  ['place_participation_trip_version', 'place_participation_history', 'place_membership_trip_version'],
];
const baseTables = ['collector_settings', 'revoked_grants', 'batch_receipts', 'ingest_batches', 'event_receipts', 'bridge_nonces'];
const placeTables = ['place_catalog', 'place_aliases', 'place_candidates', 'place_business_events', 'place_public_usage',
  'place_selection_votes', 'place_outcomes', 'place_rank_snapshots', 'place_followup_population'];

export function migrateTableNames(db) {
  if (!db.inTransaction) throw new Error('Schema migration requires an enclosing transaction');
  const version = db.pragma('user_version', { simple: true });
  if (version < 0 || version > SCHEMA_VERSION) throw new Error('Unsupported database schema version');
  const objects = new Map(db.prepare("SELECT name,type,tbl_name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all().map(row => [row.name, row]));
  const old = tableRenames.filter(([name]) => objects.has(name));
  const current = tableRenames.filter(([, name]) => objects.has(name));
  const fail = () => { throw new Error('Unsupported mixed or incomplete collector schema'); };
  if (old.length && current.length) fail();
  if (current.length) {
    if (![5, 6].includes(version) || current.length !== tableRenames.length
      || current.some(([, name]) => objects.get(name).type !== 'table')
      || [...baseTables, ...placeTables].some(name => objects.get(name)?.type !== 'table')
      || indexes.some(([name]) => objects.has(name))) fail();
    return;
  }
  if (!old.length) {
    if (version !== 0 || objects.size) fail();
    return;
  }
  if (version >= 5 || old.some(([name]) => objects.get(name).type !== 'table')
    || tableRenames.slice(0, 3).some(([name]) => !objects.has(name))
    || baseTables.some(name => objects.get(name)?.type !== 'table')
    || (version >= 4 && old.length !== tableRenames.length)
    || (version >= 4 && placeTables.some(name => objects.get(name)?.type !== 'table'))
    || indexes.some(([, , name]) => objects.has(name))) fail();
  for (const [name, table] of indexes) {
    const index = objects.get(name);
    if (index && (index.type !== 'index' || index.tbl_name !== table)) fail();
  }
  if (db.pragma('foreign_key_check').length) throw new Error('Collector schema has foreign key violations');
  for (const [name] of indexes) db.exec(`DROP INDEX IF EXISTS ${name}`);
  for (const [oldName, newName] of old) db.exec(`ALTER TABLE ${oldName} RENAME TO ${newName}`);
}

// Add metadata only. Existing JSON bytes and receipts stay untouched; bulk
// compression is an explicit, separately audited offline operation.
export function migratePayloadColumns(db) {
  if (!db.inTransaction) throw new Error('Schema migration requires an enclosing transaction');
  const version = db.pragma('user_version', { simple: true });
  const columns = new Map(db.prepare('PRAGMA table_info(ingest_batches)').all().map(column => [column.name, column]));
  if (!columns.size) {
    if (version !== 0) throw new Error('Unsupported incomplete collector schema');
    return;
  }
  const codec = columns.get('codec'), rawBytes = columns.get('raw_bytes');
  if (version === SCHEMA_VERSION) {
    if (!codec || !rawBytes || codec.type !== 'TEXT' || codec.notnull !== 1 || codec.dflt_value !== "'json'"
      || rawBytes.type !== 'INTEGER' || rawBytes.notnull !== 0 || rawBytes.dflt_value !== null) {
      throw new Error('Unsupported payload schema');
    }
    return;
  }
  if (codec || rawBytes) throw new Error('Unsupported mixed payload schema');
  db.exec(`ALTER TABLE ingest_batches ADD COLUMN codec TEXT NOT NULL DEFAULT 'json' CHECK(codec IN ('json','gzip'));
    ALTER TABLE ingest_batches ADD COLUMN raw_bytes INTEGER
      CHECK((raw_bytes IS NULL AND codec='json') OR (raw_bytes IS NOT NULL AND raw_bytes BETWEEN 1 AND 65536));`);
}
