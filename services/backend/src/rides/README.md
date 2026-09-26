# Rides migration slice

This module is a tested foundation, not a complete replacement for the production CloudBase functions. Production writes must remain on CloudBase until the missing behavior and migration checks below are completed. Never retry a new-database write against CloudBase after an ambiguous response.

## Canonical HTTP contract

All routes use `/api/v1`. Public `GET /rides` accepts `cityKey=ny_nj`, optional `kind=offer|request`, `page` (default 1, at most 1000) and `limit` (default 20, at most 50). It lists only future, open rides and returns `{rides, nextPage}`. `GET /rides/:rideId` also allows historical/closed rides through the same explicit public projection; cancelled rides return 404. No account IDs, OpenID, member lists, profiles, contact data or arbitrary imported `details` are exposed. Addresses and the note are intentionally public route information. Private contact details use the separately authorized participants endpoint; they must never be added to this public projection.

Writes require the authenticated user from `requireUser` and an `idempotency-key` header. Validation of that header exists only in `withIdempotency` in `src/db.ts`. The common envelope is `{ok:true, data, requestId}`; a replay retains the original mutation result while using the current transport request ID.

`POST /rides` accepts one canonical shape:

```json
{
  "kind": "offer",
  "cityKey": "ny_nj",
  "timeZone": "America/New_York",
  "stops": [
    {"kind": "departure", "address": "Fort Lee", "placeId": "fort_lee", "departureAt": "2027-01-05T20:00:00.000Z"},
    {"kind": "destination", "address": "Columbia", "placeId": "columbia"}
  ],
  "listedPriceCents": 1200,
  "note": "",
  "seatCapacity": 3
}
```

- `stops` is the only route input: 2–20 entries, with 1–10 departures followed by 1–10 destinations. Every address is required (at most 300 characters); optional `placeId` is at most 100 characters. Array order is saved as the stop position; identical addresses and equal departure times are retained. Clients do not supply a second position field.
- Departure stops require UTC ISO `departureAt` ending in `Z`; destination stops reject time fields. Departure times must not decrease. `timeZone` is fixed to `America/New_York`. The first departure must still be future after any creation lock wait. Its timestamp becomes the indexed ride `departure_at` and response `departureAt`; Create rejects a separate top-level time. All joins, departures from the group and cancellation use this first-stop cutoff, with whole-ride seat capacity rather than segment inventory.
- `listedPriceCents` is a nonnegative integer or `null` for unknown. New quotes use the existing per-person convention. Imported historical `listedPriceLabel` retains the original text; an unspecified historical unit must not become per-person pricing. Neither field proves payment or actual成交价.
- An offer requires `seatCapacity` between 1 and 8; its creator becomes the driver with zero passenger seats. Creation reads the creator's current profile under a shared row lock and saves only the strict boolean `profile.zelle.public` as `rides.details.zelleDisplay` (missing defaults to false). Editing the profile default or replaying creation cannot change this ride's choice. No Zelle account/name or vehicle snapshot is copied into the ride.
- A request replaces `seatCapacity` with `partySize` between 1 and 4. Its creator is one passenger membership reserving all party seats. Request capacity is four, matching the existing business rule. Optional `largeLuggageCount` is an integer 0–20, defaults to zero, and persists in ride details. It describes this request, not per-member luggage or vehicle capacity.
- Unknown fields are rejected, including old aliases such as `origin`, `destination`, `passengerCount`, `referencePrice`, `_openid`, and `departures`. Offer creation does not accept a client Zelle disclosure override or request luggage.

`POST /rides/:rideId/join` accepts `{role:"passenger", seatCount:1, pickupAddress:"...", dropoffAddress:"..."}` for offers. Both instructions are required nonblank strings up to 60 characters and remain in `ride_members.details`; they are free-form instructions, not route stop IDs. Request passengers use `{role:"passenger", seatCount:1}` and reject these instructions; request drivers use `{role:"driver"}`. A different active role, seat count or instruction requires leaving first. Identical active membership is a no-op, while changed content under the same idempotency key conflicts. Rejoining replaces old instructions. No instructions or account/contact fields enter business-event or notification payloads. Seat count still represents whole-ride seats; no new multi-seat UI or segment inventory is implied.

`POST /rides/:rideId/leave` accepts `{reason?:string}` for non-creators; `POST /rides/:rideId/cancel` requires `{reason:string}` and creator ownership. Cancellation retains the ride, marks it cancelled, and marks active memberships left in one transaction. This preserves source records instead of deleting them.

`POST /rides/:rideId/members/:memberId/remove` requires `{reason:string}` and creator ownership. A request's assigned driver cannot remove members. The creator cannot be removed. Only a future open ride can change; the membership row remains as history. Only the removed member receives the notification. The same idempotency key replays the original result without removing a subsequent rejoin; removal does not create a block.

Each mutation locks the ride row before reading or changing membership. Available seats are derived from active passenger memberships; there is no second mutable seat counter. A committed business mutation increments `rides.version` exactly once and inserts one corresponding `business_events` record in the same transaction as its idempotency receipt. A failed event write rolls everything back. No-op requests do not create extra business events. Membership and event mutation times use `clock_timestamp()` because a transaction may start before another membership joins, then acquire the ride lock only after that join commits; PostgreSQL `now()` would retain the earlier transaction-start time.

## Release blockers and deliberate differences

This module must not silently replace the old production write functions yet:

- Multi-departure/multi-destination creation and offer pickup/dropoff instructions are implemented. Route editing and migration of all old stops and missing historical instructions remain separate requirements. Missing old instructions must not be invented from profile addresses.
- Bilateral block APIs and join enforcement are implemented with ordered user-pair locks. Existing relationships are not removed by blocking. Legacy block records and client adapters have not yet migrated.
- Joined/left/cancelled/removed notifications, ratings and matched-group rating invitations are atomic with the ride write. Completion accounting has an internal transactional job. Public baseline and core records support atomic empty-target import; no production import or scheduler cutover has occurred. Rating/completion summaries derive from their facts: public rides include current `driverStatistics`, while authorized participants include current-role `statistics`. No-driver and unrated values remain null. These projections share the authorization statement snapshot and never expose raw rating sums or arbitrary user lookup. Client adapters remain pending. Weekly templates reuse `placeSchema`, `offerFieldsSchema` and `orderedStopsSchema`, with their own relative local-time representation.
- Business events are durable; delivery to analytics and compatibility projection back to legacy consumers have not been implemented.
- Departed or closed rides cannot be joined, left, or cancelled here. Some legacy quit/delete paths did not enforce this, and legacy multi-departure expiry used the final departure instead of the first. The new whole-ride cutoff was explicitly chosen; keep this difference visible in client/migration rollout. Completed participation must not be casually rewritten.
- `closeDueRides` closes after the final departure and preserves separate personal/public counting rules; see [schema contract](../../SCHEMA.md). Its scheduler is not enabled in production. List and booking eligibility still use the first departure directly.
- Public listing uses bounded offset pagination, not a snapshot-consistent feed. Data migration must verify quantities and preserve source IDs/ownership before client routing.
- Legacy versions still perform direct CloudBase writes and use old response shapes. Switching only newer clients to a second writable database would violate the single-authority rule. Complete the compatibility boundary and release plan first.

## Verification

`test/rides.integration.test.ts` uses `BACKEND_TEST_DATABASE_URL` and the shared test helper to create and destroy an isolated schema with synthetic fixtures. It verifies concurrent final-seat competition, competing drivers, creator group size, request replay, membership rejoin, ownership, cancellation races, ordered mutation timestamps after lock waits, public projection, pagination bounds, and transaction rollback when event insertion fails. `test/rides.routes.test.ts` exercises the actual application, sessions, headers and HTTP envelopes; only the external WeChat code exchange is replaced. These are PostgreSQL integration tests; they do not claim a production cutover has been validated.

`test/rides.contract.test.ts` covers stop bounds/order/UTC validation, full multi-stop persistence, first-departure cutoff, later-stop failure rollback, strict per-ride disclosure snapshots and concurrent profile updates, luggage bounds, offer/request instruction rules, rejoin replacement and sensitive-data exclusion. Blocks and notification fixtures use the same canonical route and membership DTOs.
