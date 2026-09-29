// TEMPORARY WIRE COMPATIBILITY — deployed clients and queued operations keep
// their original bytes. These aliases resolve to the same account and grant;
// remove only after the last old client/token/operation has been retired.
export const LEGACY_PURPOSE_VERSION = 'ride-research-v1';
export const LEGACY_NOTICE_VERSION = 'ride-research-notice-2026-09-23';
export const LEGACY_BRIDGE_ROUTE = '/internal/v1/research/participation';
export const LEGACY_TOKEN_ISSUER = 'linkx-research-collector';
export const LEGACY_TOKEN_AUDIENCE = 'linkx-research-batches';
export const LEGACY_ENV = Object.freeze({ bridgeKeyFile: 'RESEARCH_BRIDGE_KEY_FILE', noticeVersion: 'RESEARCH_NOTICE_VERSION' });

// Identity domain separators are part of the existing HMAC identity, not
// display names. Keeping these exact bytes prevents duplicate accounts and
// preserves prior withdrawals. They must not be renamed with the service.
export const SUBJECT_SCOPE = 'linkx-research-account-v1';
export const TEST_SUBJECT_SCOPE = 'linkx-research-test-account-v1';

export const canonicalVersion = value => typeof value === 'string' ? value.replace(/^ride-research-/, 'ride-analytics-') : value;
export const isLegacyVersion = value => typeof value === 'string' && value.startsWith('ride-research-');
const legacyVersion = value => typeof value === 'string' ? value.replace(/^ride-analytics-/, 'ride-research-') : value;

// Views compare historical version names without rewriting stored records.
// The column is a source constant, never an identifier supplied by a request.
export function purposeVersionSql(column) {
  if (!['p.purpose_version', 'b.purpose_version'].includes(column)) throw new Error('Unsupported purpose column');
  return `(CASE WHEN substr(${column},1,15)='ride-research-v' THEN 'ride-analytics-v'||substr(${column},16) ELSE ${column} END)`;
}

// Metadata follows the request dialect, while the signed token always uses
// the current issuer and audience. Never transform a request before hashing it.
export function accountResponseForRequest(response, request) {
  const purpose = isLegacyVersion(request.purposeVersion) ? legacyVersion : canonicalVersion;
  const notice = isLegacyVersion(request.noticeVersion) ? legacyVersion : canonicalVersion;
  return {
    ...response,
    purposeVersion: purpose(response.purposeVersion),
    noticeVersion: notice(response.noticeVersion),
    ...(response.session ? { session: {
      ...response.session,
      purposeVersion: purpose(response.session.purposeVersion),
      acceptedPurposeVersion: purpose(response.session.acceptedPurposeVersion),
    } } : {}),
  };
}
