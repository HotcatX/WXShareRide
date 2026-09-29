import { collectionProtocol as legacy } from './compat.ts';

export const collectionProtocol = Object.freeze({
  path: '/internal/v1/analytics/accounts', purpose: 'ride-analytics-v1',
  notice: 'ride-analytics-notice-2026-09-23',
  subject: legacy.subject, testSubject: legacy.testSubject,
});

export function validCollectionVersions(purpose: string, notice: string): boolean {
  return (purpose === collectionProtocol.purpose && notice === collectionProtocol.notice)
    || (purpose === legacy.purpose && notice === legacy.notice);
}
