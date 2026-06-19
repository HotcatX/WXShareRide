# Cloud Functions Pending Removal

These functions are kept for the currently published mini program version. After the new version that calls the consolidated functions is fully released and old clients are no longer active, remove the old functions below.

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
