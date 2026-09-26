// TEMPORARY COMPATIBILITY — keep deployed identities, authorizations and data.
// Ordinary service/module names use analytics. These values are storage/wire
// identifiers, not aliases for a second state or database. Do not rename them
// during a source-directory migration: old clients, cloud functions, tokens,
// backups and host operations must still address the same records.
// Remove only after the next production release is verified AND each affected
// identity/token/storage/config consumer has an explicit, validated migration.
export const DEFAULT_PURPOSE_VERSION = 'ride-research-v1';
export const DEFAULT_NOTICE_VERSION = 'ride-research-notice-2026-09-23';
export const PURPOSE_PATTERN = /^ride-research-v[1-9][0-9]{0,3}$/;
export const NOTICE_PATTERN = /^ride-research-notice-20\d\d-\d\d-\d\d(?:-[1-9]\d{0,3})?$/;
export const BRIDGE_ROUTE = '/internal/v1/research/participation';
export const TOKEN_ISSUER = 'linkx-research-collector';
export const TOKEN_AUDIENCE = 'linkx-research-batches';
export const SUBJECT_SCOPE = 'linkx-research-account-v1';
export const TEST_SUBJECT_SCOPE = 'linkx-research-test-account-v1';
export const TABLES = Object.freeze({
  participants: 'research_participants',
  accounts: 'research_accounts',
  accountOpenidIndex: 'research_account_openid',
});
export const ENV = Object.freeze({ bridgeKeyFile: 'RESEARCH_BRIDGE_KEY_FILE', noticeVersion: 'RESEARCH_NOTICE_VERSION' });
export const SUBJECT_KEY_FILE = '/etc/linkx-research-ops/subject.key';
export const BRIDGE_KEY_FILE = '/etc/linkx-research-ops/bridge.key';
