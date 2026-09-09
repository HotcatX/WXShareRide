# Legacy Market Cloud Functions — Retired

Originally retained on 2026-06-19. All four functions below were removed from the cloud environment `cloud1-7gmtcu4s3aebce27` on 2026-09-08, following verification and the user's explicit approval. See [the verified audit and backup record](cloudfunctions-audit-2026-09-08.md).

Current market pages use `marketApi`. The local legacy source directories have also been removed at the user's request; Git history and verified cloud deployment backups preserve the retired code. `cleanupMarketImages` remains deployed with its daily timer. The old `trackMarketFiles` uploaded-file registration API was removed from the current client; the new flow attaches files after a successful create/update and marks removed files for cleanup.

- `createMarketItem` - retired; new pages call `marketApi` action `create`
- `updateMarketItem` - retired; new pages call `marketApi` action `update`
- `deleteMarketItem` - retired; new pages call `marketApi` action `delete`
- `trackMarketFiles` - retired; new pages use `marketApi` file attach/delete handling
