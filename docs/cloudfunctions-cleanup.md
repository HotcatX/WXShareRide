# Legacy Trip Cloud Functions — Retired

Retired from the cloud environment `cloud1-7gmtcu4s3aebce27` on 2026-09-08 after the user confirmed the September release and approved deletion of all 25 migrated legacy functions. All 20 current functions remain deployed. See [the verified audit and backup record](cloudfunctions-audit-2026-09-08.md).

These entry points were previously retained during rollout. Their local source directories have also been removed at the user's request to prevent accidental redeployment. Git history and the verified cloud deployment backups preserve the retired code. The right side documents the consolidated entry point used by current pages; old request parameters are not necessarily interchangeable with the new API.

- `updateCarpoolStatus` -> `syncTripStatus`
- `updateCarpoolRequestStatus` -> `syncTripStatus`
- `updateMyTripStatusDriver` -> `syncMyTripStatus`
- `updateMyTripStatusPassenger` -> `syncMyTripStatus`
- `getCarpoolList` -> `getTripList`
- `getCarpoolRequestList` -> `getTripList`
- `getCarpoolDetail` -> `getTripDetail`
- `getCarpoolRequestDetail` -> `getTripDetail`
- `getDriverHomeTripList` -> `getHomeTripList`
- `getPassengerHomeTripList` -> `getHomeTripList`
- `addCarpoolList` -> `createTrip`
- `addCarpoolRequest` -> `createTrip`
- `updateUserCreateTrip` -> `createTrip` for trip creation
- `addCarpoolDetail` -> `joinTrip`
- `joinCarpoolRequest` -> `joinTrip`
- `updateUserJoinTrip` -> `joinTrip`
- `acceptCarpoolRequest` -> `tripManage` / `acceptRequest`
- `editMyTripDetailDriver` -> `tripManage` / `kickPassenger`, `deleteTrip`
- `editMyTripDetailPassenger` -> `tripManage` / `quitTrip`
- `editMyRequestDetailCreate` -> `tripManage` / `kickDriver`, `kickPassenger`, `deleteTrip`
- `editMyRequestDetailDriver` -> `tripManage` / `quitDriver`
