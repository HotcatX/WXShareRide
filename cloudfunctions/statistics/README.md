# statistics: canonical statistics and telemetry authorization entry

Production has used `server` authority since the 2026-09-30 PostgreSQL cutover. This function remains a compatibility entry for public statistics and the authenticated analytics account bridge. The old timer, relay and outbox implementations and the local `syncPublicStatsReplica` package have been removed. `statistics/config.json` has no triggers. Do not restore their old schedules or CloudBase authority. See [deployment boundaries](../DEPLOYMENT.md) and the [cutover record](../../docs/backend-cutover-2026-09-30.md).

`compat.js` preserves deployed wire versions, internal route and HMAC identity scopes. It is marked `TEMPORARY COMPATIBILITY` and checked against the collector/client by `tests/analytics-compatibility.test.cjs`; do not change these values without migrating all deployed callers and existing account mappings.

This is the single implementation home for independent statistics APIs and the analytics authorization bridge. It does not move transactional trip/seat/rating/referral aggregate writes out of their existing business transactions. Client analytics event batches continue to go directly to `https://collect.linkx.ink/v1/batches`; this function is not invoked once per event.

## Actions

- `{action:'publicStats'}` reads `https://collect.linkx.ink/api/v1/statistics/public` under server authority and returns the existing `{success,data:{_id:'home',servedTrips,coverageText}}` format. Both direct clients and this compatibility entry read the same PostgreSQL database. A server error never switches the read to CloudBase. Errors retain that envelope with a generic `PUBLIC_STATS_UNAVAILABLE`, never a database error/stack. Invalid private/overlarge field values do not escape the public projection. Missing or non-server authority also returns that same failure envelope without contacting any data source.
- `status|activate|withdraw` retain the previous five-field real authorization request contract. The only optional client field is `collectionMode:'test'`, described below. The current invocation context authenticates this mini-program's account; caller-supplied identities, cross-app identities and process-global identity fallbacks are rejected. `activate` records technical authorization under the privacy notice, not express consent. First activation is automatic only for the selected rollout; clients must not automatically reopen revoked accounts. No new popup, button or settings page is introduced.
- Retired `placeBusinessTimer`, `publicStatsHourlyTimer`, `legacyPublicStatsTimer` and raw Timer events return `INVALID_ACTION`, even with a trusted invocation context. They have no database, key-loading, synchronization or relay implementation. The PostgreSQL backend owns current business-event delivery and public totals.

## Isolated development/trial collection

Real clients omit `collectionMode`. Development/trial clients may add exactly `collectionMode:'test'`; other values and caller-supplied `synthetic` are rejected. This field selects a test namespace, **not** an attested WeChat build channel. The mini-program's runtime configuration controls which channel selects it.

Real account derivation remains `HMAC-SHA256(subjectKey, 'linkx-research-account-v1\n' + APPID + '\n' + OPENID)`. Test derivation uses the separate domain `linkx-research-test-account-v1` with the same authenticated identity. Only a test request adds `synthetic:true` to the HMAC-signed internal body. Thus the same WeChat account gets independent participant IDs, grants, operation histories and withdrawals, without converting any existing real participant or changing historical real request hashes. The root-only customer-service stop helper keeps the original real derivation and body.

Every successful test response, including `status:none`, must contain outer `synthetic:true`; the cloud bridge rejects a missing/false marker for test requests and a true marker for real requests. Real responses remain compatible when that field is absent (or explicitly false). The session/batch wire format stays unchanged: the receiver reads immutable participant type from SQLite, never from a client batch. Clients must partition account/queue state by mode and reject a response for the other namespace.

Deploy the receiver's optional signed flag support before deploying this cloud bridge or test client. Existing real callers work throughout. Synthetic batches keep their 14-day payload/30-day receipt policy; real research extraction uses `eligible_real_events`, while safe synthetic aggregate metrics support end-to-end verification. A test grant may be issued while real collection is disabled but cannot bypass the restore gate, HMAC, nonce, CAS, token or schema checks.

## Private deployment files

Provision **only in a private server-side deployment artifact**, not this repository or the client bundle:

- `analytics.secret.json`: `{ "bridge":"<64 lower hex>", "subject":"<different 64 lower hex>" }`, matching the existing deployed account bridge and pseudonym scope.

The subject key may also be present in `/etc/linkx-analytics-ops/subject.key` on the host, strictly root-only for an already verified customer-service stop request. The corresponding root-only bridge key copy allows the host helper to perform only status/withdraw. Neither operations directory nor subject key is mounted into the collector container. The collector's own `/etc/linkx-collector/bridge.key` remains its separate UID-1000, mode-0600 bridge credential.

For internal account debugging, the bridge now also includes **`openid` from the authenticated invocation**, inside its signed request. A client-supplied OpenID is still rejected. Receiver schema v5 stores it once on `analytics_accounts`, binds only an empty or identical account link, and rejects identity conflicts. Legacy internal requests without OpenID remain accepted, and the new field is excluded from operation hashes so historical retries keep working. Existing accounts are linked on their next authenticated status/activation; old HMAC subjects cannot be reversed to recover a missing original OpenID. `operational_events` joins the account link for authorized internal lookup; `eligible_real_events` remains free of OpenID for research extraction. Deploy the compatible schema-v5 receiver before this bridge. Identity-bearing operational data and backups require restricted access; pseudonymous event IDs do not make the linked database anonymous.

## Compatibility and deployment order

`getPublicStats` remains a fixed-action wrapper to `statistics/publicStats` for already distributed packages. Each old caller incurs **one additional cloud-function invocation** until packages use `statistics` directly. The wrapper never forwards client actions or arbitrary arguments.

Deploy only the current `statistics` package with server authority, its existing `analytics.secret.json` identity keys, **15-second** timeout and **no triggers**. The package uses only Node built-ins and local modules; its standard lockfile has no dependencies. Do not include the old SDK, `sync.secret` or retired synchronization modules in the deployment package. Verify actual platform configuration; a JSON file does not prove the timeout or authority was applied. Preserve the old public response for installed clients. The active client module is `utils/analyticsSession.js`; current server-mode account requests use the authenticated backend route. Existing cloud bridge callers remain supported with the same identity keys and request hashes. Package changes must keep all imported files together; historical deployment evidence belongs in the dated reports. Do not deploy `syncPublicStatsReplica` or revive either timer.

No keys, subjects, user IDs, tokens, raw database objects or request payloads are logged. The analytics configuration, policy notice, batch receiver, maintenance jobs and customer-service stop workflow remain independently controlled.

## Local checks

From repository root:

```sh
node --test tests/statistics-entry.test.cjs tests/statistics-authority.test.cjs tests/analytics-bridge.test.cjs tests/analytics-compatibility.test.cjs
```

Tests use dependency injection and synthetic keys; they do not query cloud data or deploy. They cover public response compatibility/projection, account dispatch with exact legacy operation labels, metadata filtering, unconditional rejection of retired actions, actual dependency-free entry loading, fixed PG/collector endpoints, unchanged account signatures, legacy wrapper boundaries, and sanitized failures.

## Canonical account protocol

`protocol.js` owns `/internal/v1/analytics/accounts`, `ride-analytics-v1` and the analytics notice identifier. `compat.js` only retains the already-published client labels and immutable HMAC identity separators. Requests keep their original purpose/notice fields so retry hashes remain valid; response metadata uses that same dialect. Tokens are issued by the collector with its current analytics issuer. No new account, grant or consent is created merely because a name changed. Deploy the compatible receiver and Caddy route first, then update this function code atomically while preserving server authority, timeout, the empty trigger list and identity keys.
