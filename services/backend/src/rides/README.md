# Rides migration slice

This module is a tested foundation, not a complete replacement for the production CloudBase functions. Production writes must remain on CloudBase until the missing behavior and migration checks below are completed. Never retry a new-database write against CloudBase after an ambiguous response.

## Canonical HTTP contract

All routes use `/api/v1`. Public `GET /rides` accepts `cityKey=ny_nj`, optional `kind=offer|request`, `page` (default 1, at most 1000) and `limit` (default 20, at most 50). It lists only future, open rides and returns `{rides, nextPage}`. `GET /rides/:rideId` also allows historical/closed rides through the same explicit public projection; cancelled rides return 404. No account IDs, OpenID, member lists, profiles, contact data or arbitrary imported `details` are exposed. Addresses and the note are intentionally public route information. The final historical-address retention/visibility policy remains a release decision; this slice does not introduce a new private contact endpoint.

Writes require the authenticated user from `requireUser` and an `idempotency-key` header. Validation of that header exists only in `withIdempotency` in `src/db.ts`. The common envelope is `{ok:true, data, requestId}`; a replay retains the original mutation result while using the current transport request ID.

`POST /rides` accepts one canonical shape:

```json
{
  "kind": "offer",
  "cityKey": "ny_nj",
  "departureAt": "2027-01-05T20:00:00.000Z",
  "timeZone": "America/New_York",
  "origin": {"address": "Fort Lee", "placeId": "fort_lee"},
  "destination": {"address": "Columbia", "placeId": "columbia"},
  "listedPriceCents": 1200,
  "note": "",
  "seatCapacity": 3
}
```

- `origin` and `destination` are objects, never string aliases. `address` is required; `placeId` is optional. This slice creates exactly one departure and one destination.
- `departureAt` is a UTC ISO timestamp ending in `Z`; timezone is fixed to `America/New_York`. New departures must be in the future. Local weekday templates need a separate conversion boundary.
- `listedPriceCents` is a nonnegative integer or `null` for unknown. It is the listed price, not confirmed payment or actual成交价.
- An offer requires `seatCapacity` between 1 and 8; its creator becomes the driver with zero passenger seats.
- A request replaces `seatCapacity` with `partySize` between 1 and 4. Its creator is one passenger membership reserving all party seats. Request capacity is four, matching `MAX_REQUEST_PASSENGERS` in existing `joinTrip`/`tripManage` and the existing request seat-count helper.
- Unknown fields are rejected, including old aliases such as `passengerCount`, `referencePrice`, `_openid`, and `departures`.

`POST /rides/:rideId/join` accepts `{role:"passenger", seatCount:1}` or `{role:"driver"}`. Both ride types permit passengers within remaining capacity; only requests accept a driver. A different active role/seat count requires leaving first. A repeated unchanged active membership is a no-op. New `seatCount` explicitly represents the whole joining party; the legacy UI generally joined one extra person, so a multi-seat UI is not automatically enabled by this API.

`POST /rides/:rideId/leave` accepts `{reason?:string}` for non-creators; `POST /rides/:rideId/cancel` requires `{reason:string}` and creator ownership. Cancellation retains the ride, marks it cancelled, and marks active memberships left in one transaction. This preserves source records instead of deleting them.

Each mutation locks the ride row before reading or changing membership. Available seats are derived from active passenger memberships; there is no second mutable seat counter. A committed business mutation increments `rides.version` exactly once and inserts one corresponding `business_events` record in the same transaction as its idempotency receipt. A failed event write rolls everything back. No-op requests do not create extra business events. Membership and event mutation times use `clock_timestamp()` because a transaction may start before another membership joins, then acquire the ride lock only after that join commits; PostgreSQL `now()` would retain the earlier transaction-start time.

## Release blockers and deliberate differences

This module must not silently replace the old production write functions yet:

- Multi-departure/multi-destination routes, per-passenger pickup/dropoff, and route editing are not implemented. Import preserves all stops; the single-route create DTO must not flatten them. No capacity-by-segment behavior is inferred.
- Existing bilateral block relationships and block/unblock APIs are not integrated. Do not migrate joins before enforcing them with the correct transaction/locking semantics.
- Notifications, kick/remove member actions, ratings, completion accounting, user profile/contact access, vehicle fields, luggage, Zelle/payment-method presentation, weekly templates, and “my trips” are not covered by this slice.
- Business events are durable, but delivery to analytics/notifications and compatibility projection back to legacy consumers have not been implemented.
- Departed or closed rides cannot be joined, left, or cancelled here. Some legacy quit/delete paths did not enforce this. Confirm historical membership semantics and frontend behavior before routing those operations here; completed participation must not be casually rewritten.
- There is no automatic transition worker marking past rides `closed` yet; list and mutation eligibility use the timestamp directly.
- Public listing uses bounded offset pagination, not a snapshot-consistent feed. Data migration must verify quantities and preserve source IDs/ownership before client routing.
- Legacy versions still perform direct CloudBase writes and use old response shapes. Switching only newer clients to a second writable database would violate the single-authority rule. Complete the compatibility boundary and release plan first.

## Verification

`test/rides.integration.test.ts` uses `BACKEND_TEST_DATABASE_URL` and the shared test helper to create and destroy an isolated schema with synthetic fixtures. It verifies concurrent final-seat competition, competing drivers, creator group size, request replay, membership rejoin, ownership, cancellation races, ordered mutation timestamps after lock waits, public projection, pagination bounds, and transaction rollback when event insertion fails. `test/rides.routes.test.ts` exercises the actual application, sessions, headers and HTTP envelopes; only the external WeChat code exchange is replaced. These are PostgreSQL integration tests; they do not claim a production cutover has been validated.
