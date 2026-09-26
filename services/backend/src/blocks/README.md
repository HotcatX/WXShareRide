# Blocks

`registerBlockRoutes(app, { pool, requireUser })` registers authenticated `/api/v1/blocks` routes. POST accepts only `{ targetUserId, reason? }`; DELETE uses `/:targetUserId` with an empty body. Both require the shared `idempotency-key` contract. GET accepts `page` and `limit`, returning `{ blocks, nextPage }`. Target IDs are canonical `users.id`, never client-supplied OpenIDs. Targets must exist in the same app as the actor.

The authoritative relation is one `user_blocks` row per directed pair. Re-blocking refreshes the reason; re-activation also refreshes `blockedAt`. Unblocking affects only the actor's direction and succeeds when that relation is already inactive or absent. Reasons remain optional and limited to the old 180-character limit. The owner-only list retains name/avatar/WeChat contact/reason/date display; sessions, OpenIDs and other profile fields are never projected.

The current CloudBase product checks both directions against all current participants before joining an offer, joining a request, or accepting a request as driver. The new join does the same, explicitly including the creator. Blocking does not remove existing memberships, cancel rides or send notifications. Repeating an existing identical membership succeeds; leaving remains allowed. An inactive former participant does not restrict other joins.

Concurrency order is `idempotency receipt lock → ride row (join only) → sorted undirected user-pair locks`. Block and unblock take only their one pair lock; they must not subsequently lock rides. Join reads the current participant set under its ride lock and keeps every pair lock through commit. A block that locks first is visible before a waiting join checks; a join that locks first commits before the later block takes effect. Neither operation retroactively changes the other. Unrelated user pairs stay independent. All write failures roll back the change and idempotency receipt together.

## Remaining migration work

- Import existing `UserBlocks` before enabling new authoritative joins. Preserve directed active state and source timestamps; duplicate old active/inactive documents need one explicit import policy. The unused `userInfo.blockedUsers` field must not silently become a second authority.
- Wire the existing client to canonical user IDs through authenticated participant/contact DTOs. Public ride projections intentionally do not expose account identities. The present route registration alone is not a production migration.
- Old `TripActions` contains block/unblock audit entries, including optional ride context. This slice preserves state and mutation receipts, not a replacement for that historical action log. Keep its migration as an explicit separate requirement; do not invent a ride event for a non-ride action.
- Missing or cross-app targets now return `USER_NOT_FOUND`, unlike the old arbitrary-OpenID write. Database errors now fail truthfully instead of being reported as an empty list or successful unblock. Existing historical dangling references need an import decision before cutover.
