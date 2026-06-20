# Cloud Functions Legacy Retention

These functions are legacy entry points that must remain in their original top-level `cloudfunctions/` directories during the new-version rollout. Do not delete, move, or classify them. The right side documents the new consolidated entry point used by refactored pages.

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
