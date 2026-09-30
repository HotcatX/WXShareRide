# Rides

This module serves production ride reads and writes from PostgreSQL, the single business database since the 2026-09-30 cutover. The active service runs completion and event-delivery jobs. Supported CloudBase compatibility routes use the same PostgreSQL authority; frozen CloudBase data is recovery material, never a write fallback. See the [cutover record](../../../../docs/backend-cutover-2026-09-30.md) and [cloud deployment boundary](../../../../cloudfunctions/DEPLOYMENT.md).

## Canonical HTTP contract

All routes use `/api/v1`. Public `GET /rides` accepts `cityKey=ny_nj`, optional `kind=offer|request`, `page` (default 1, at most 1000) and `limit` (default 20, at most 50). It lists only future, open rides and returns `{rides, nextPage}`. `GET /rides/:rideId` also allows historical/closed rides through the same explicit public projection; cancelled rides return 404. No account IDs, OpenID, member lists, profiles, contact data or arbitrary imported `details` are exposed. Addresses and the note are intentionally public route information. Private contact details use the separately authorized participants endpoint; they must never be added to this public projection.

Writes require the authenticated user from `requireUser` and an `idempotency-key` header. Header validation and receipt handling are centralized in `src/db.ts`. The common envelope is `{ok:true, data, requestId}`; a replay retains the original mutation result while using the current transport request ID.

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

## Reads, jobs and compatibility

List and calendar reads share city, ride-kind, route and optional authenticated-viewer filters. A supplied invalid session is rejected; it is not silently treated as an anonymous request. Route aliases use the canonical catalog and preserve distinctions such as EWR airport versus the broader Newark area. `GET /rides` optionally accepts a one- or two-day `startDate` / `endDateExclusive` range and returns `nextDate` for the next matching day, including when the selected day is empty. `GET /rides/calendar` aggregates the full requested month as `offerCount` and `requestCount` per date. Both use New York local dates, including 23- and 25-hour DST days. Public listing uses bounded offset pagination; consecutive pages are not a frozen snapshot.

Bilateral blocks, authorized contacts, ride history, ratings, templates and notifications are implemented against the same database. Blocking does not erase existing memberships. Joined/left/cancelled/removed notifications and matched-group rating invitations are atomic with their ride mutations. Public rides expose current `driverStatistics`; authorized participants expose current-role `statistics`. No-driver and unrated values remain null. Statistics use their underlying facts rather than exposing raw rating sums or permitting arbitrary private user lookup. Weekly templates reuse route schemas with relative weekday and local-time values.

`closeDueRides` runs in production and closes rides after their final departure, with separate personal/public counting rules documented in the [schema contract](../../SCHEMA.md). List and booking eligibility still use the first departure: departed or closed rides cannot be joined, left or cancelled. Completion facts are not rewritten to imitate the old quit/delete behavior. Durable business events are delivered to the collector through the existing signed, idempotent delivery path.

Route editing is not implemented. Imported historical stops and ownership were reconciled during cutover; missing historical pickup/dropoff instructions remain unknown rather than being invented from profile addresses. The original imported records and receipts remain available for reconciliation and original-key retry recovery. Compatibility is retained for actual published clients and persisted pending operations; release of a new client alone does not prove every old consumer or pending operation has disappeared.

## Verification

`test/rides.integration.test.ts` uses `BACKEND_TEST_DATABASE_URL` and the shared test helper to create and destroy an isolated schema with synthetic fixtures. It verifies concurrent final-seat competition, competing drivers, creator group size, request replay, membership rejoin, ownership, cancellation races, ordered mutation timestamps after lock waits, public projection, pagination bounds, and transaction rollback when event insertion fails. `test/rides.routes.test.ts` exercises the actual application, sessions, headers and HTTP envelopes; only the external WeChat code exchange is replaced. These tests use isolated PostgreSQL schemas and synthetic fixtures. Recorded production cutover and deployment evidence is separate in the linked cutover record.

`test/rides.contract.test.ts` covers stop bounds/order/UTC validation, full multi-stop persistence, first-departure cutoff, later-stop failure rollback, strict per-ride disclosure snapshots and concurrent profile updates, luggage bounds, offer/request instruction rules, rejoin replacement and sensitive-data exclusion. Blocks and notification fixtures use the same canonical route and membership DTOs.
