// Existing collector identifiers, retained only at this protocol boundary.
// Changing a subject prefix/key would create new accounts and lose their grants.
export const collectionProtocol = Object.freeze({
  path: '/internal/v1/research/participation', purpose: 'ride-research-v1',
  notice: 'ride-research-notice-2026-09-23', subject: 'linkx-research-account-v1',
  testSubject: 'linkx-research-test-account-v1',
});
