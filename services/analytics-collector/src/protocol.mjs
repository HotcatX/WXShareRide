import { canonicalVersion } from './compat/legacy.mjs';

export const DEFAULT_PURPOSE_VERSION = 'ride-analytics-v1';
export const DEFAULT_NOTICE_VERSION = 'ride-analytics-notice-2026-09-23';
export const BRIDGE_ROUTE = '/internal/v1/analytics/accounts';
export const TOKEN_ISSUER = 'linkx-analytics-collector';
export const TOKEN_AUDIENCE = 'linkx-analytics-batches';
export const ENV = Object.freeze({ bridgeKeyFile: 'ANALYTICS_BRIDGE_KEY_FILE', noticeVersion: 'ANALYTICS_NOTICE_VERSION' });
export const SUBJECT_KEY_FILE = '/etc/linkx-analytics-ops/subject.key';
export const BRIDGE_KEY_FILE = '/etc/linkx-analytics-ops/bridge.key';
export const PURPOSE_PATTERN = /^ride-analytics-v[1-9][0-9]{0,3}$/;
export const NOTICE_PATTERN = /^ride-analytics-notice-20\d\d-\d\d-\d\d(?:-[1-9]\d{0,3})?$/;
export const canonicalPurposeVersion = canonicalVersion;
export const canonicalNoticeVersion = canonicalVersion;
export const isPurposeVersion = value => typeof value === 'string' && PURPOSE_PATTERN.test(canonicalPurposeVersion(value));
export const isNoticeVersion = value => typeof value === 'string' && NOTICE_PATTERN.test(canonicalNoticeVersion(value));
export const samePurposeVersion = (left, right) => isPurposeVersion(left) && isPurposeVersion(right)
  && canonicalPurposeVersion(left) === canonicalPurposeVersion(right);
export const sameNoticeVersion = (left, right) => isNoticeVersion(left) && isNoticeVersion(right)
  && canonicalNoticeVersion(left) === canonicalNoticeVersion(right);
