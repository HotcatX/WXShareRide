export const SCHEMA_VERSION = 5;
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
    if (version !== SCHEMA_VERSION || current.length !== tableRenames.length
      || current.some(([, name]) => objects.get(name).type !== 'table')
      || [...baseTables, ...placeTables].some(name => objects.get(name)?.type !== 'table')
      || indexes.some(([name]) => objects.has(name))) fail();
    return;
  }
  if (!old.length) {
    if (version !== 0 || objects.size) fail();
    return;
  }
  if (version === SCHEMA_VERSION || old.some(([name]) => objects.get(name).type !== 'table')
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
