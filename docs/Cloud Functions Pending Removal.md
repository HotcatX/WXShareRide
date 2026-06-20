# Cloud Functions Legacy Retention

Recorded on 2026-06-19.

Current market pages use `marketApi`, but the legacy market functions must stay in their original top-level `cloudfunctions/` directories. Do not delete, move, or classify these functions during the new-version rollout.

- `createMarketItem` - legacy entry retained; new pages call `marketApi` action `create`
- `updateMarketItem` - legacy entry retained; new pages call `marketApi` action `update`
- `deleteMarketItem` - legacy entry retained; new pages call `marketApi` action `delete`
- `trackMarketFiles` - legacy entry retained; new pages use `marketApi` file attach/delete handling
