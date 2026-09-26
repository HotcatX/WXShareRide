# statistics: canonical statistics and telemetry authorization entry

`compat.js` preserves deployed wire versions, internal route and HMAC identity scopes. It is marked `TEMPORARY COMPATIBILITY` and checked against the collector/client by `tests/analytics-compatibility.test.cjs`; do not change these values without migrating all deployed callers and existing account mappings.

This is the single implementation home for independent statistics APIs and the analytics authorization bridge. It does not move transactional trip/seat/rating/referral aggregate writes out of their existing business transactions. Client analytics event batches continue to go directly to `https://collect.linkx.ink/v1/batches`; this function is not invoked once per event.

## Actions

- `{action:'publicStats'}` performs one projected read of `PublicStats/home` and returns the existing `{success,data:{_id:'home',servedTrips,coverageText}}` format. Errors retain that envelope with a generic `PUBLIC_STATS_UNAVAILABLE`, never a database error/stack. Invalid private/overlarge field values do not escape the public projection.
- `status|activate|withdraw` retain the previous five-field real authorization request contract. The only optional client field is `collectionMode:'test'`, described below. The current invocation context authenticates this mini-program's account; caller-supplied identities, cross-app identities and process-global identity fallbacks are rejected. `activate` records technical authorization under the privacy notice, not express consent. First activation is automatic only for the selected rollout; clients must not automatically reopen revoked accounts. No new popup, button or settings page is introduced.
- A genuine platform Timer with `Type:'Timer'` (or `timer`) and `TriggerName:'publicStatsHourly'`, optionally carrying `action:'publicStatsHourlyTimer'`, can acquire and publish the two-hour public snapshot. The current parsed source must equal `wx_trigger` and must have no caller/from-user identity. A mini-program fabricating Timer fields cannot authorize this path.
- `legacyPublicStatsTimer` is an HMAC-authenticated compatibility relay from the existing timer function. It reads no personal collection and publishes only the same three public fields.

## Isolated development/trial collection

Real clients omit `collectionMode`. Development/trial clients may add exactly `collectionMode:'test'`; other values and caller-supplied `synthetic` are rejected. This field selects a test namespace, **not** an attested WeChat build channel. The mini-program's runtime configuration controls which channel selects it.

Real account derivation remains `HMAC-SHA256(subjectKey, 'linkx-research-account-v1\n' + APPID + '\n' + OPENID)`. Test derivation uses the separate domain `linkx-research-test-account-v1` with the same authenticated identity. Only a test request adds `synthetic:true` to the HMAC-signed internal body. Thus the same WeChat account gets independent participant IDs, grants, operation histories and withdrawals, without converting any existing real participant or changing historical real request hashes. The root-only customer-service stop helper keeps the original real derivation and body.

Every successful test response, including `status:none`, must contain outer `synthetic:true`; the cloud bridge rejects a missing/false marker for test requests and a true marker for real requests. Real responses remain compatible when that field is absent (or explicitly false). The session/batch wire format stays unchanged: the receiver reads immutable participant type from SQLite, never from a client batch. Clients must partition account/queue state by mode and reject a response for the other namespace.

Deploy the receiver's optional signed flag support before deploying this cloud bridge or test client. Existing real callers work throughout. Synthetic batches keep their 14-day payload/30-day receipt policy; real research extraction uses `eligible_real_events`, while safe synthetic aggregate metrics support end-to-end verification. A test grant may be issued while real collection is disabled but cannot bypass the restore gate, HMAC, nonce, CAS, token or schema checks.

## Private deployment files

Provision **only in a private server-side deployment artifact**, not this repository or the client bundle:

- `participation.secret.json`: `{ "bridge":"<64 lower hex>", "subject":"<different 64 lower hex>" }`, matching the existing deployed participation bridge and pseudonym scope.
- `sync.secret`: the existing public-stats synchronization key, 64 lowercase hex characters. A configured server-side `PUBLIC_STATS_SYNC_KEY` remains supported for compatibility.

The subject key may also be present in `/etc/linkx-research-ops/subject.key` on the host, strictly root-only for an already verified customer-service stop request. The corresponding root-only bridge key copy allows the host helper to perform only status/withdraw. Neither operations directory nor subject key is mounted into the collector container. The collector's own `/etc/linkx-collector/bridge.key` remains its separate UID-1000, mode-0600 bridge credential.

For internal account debugging, the bridge now also includes **`openid` from the authenticated invocation**, inside its signed request. A client-supplied OpenID is still rejected. Receiver schema v3 stores it once on `research_accounts`, binds only an empty or identical account link, and rejects identity conflicts. Legacy internal requests without OpenID remain accepted, and the new field is excluded from operation hashes so historical retries keep working. Existing accounts are linked on their next authenticated status/activation; old HMAC subjects cannot be reversed to recover a missing original OpenID. `operational_events` joins the account link for authorized internal lookup; `eligible_real_events` remains free of OpenID for research extraction. Deploy the schema-v3 receiver before this bridge. Identity-bearing operational data and backups require restricted access; pseudonymous event IDs do not make the linked database anonymous.

## Legacy timer relay protocol

The old function first validates its genuine original Timer context. It then calls `statistics` with exactly:

```js
{ action: 'legacyPublicStatsTimer', timestamp: '<decimal epoch milliseconds>', signature: '<64 lowercase hex>' }
```

Use raw decoded 32-byte synchronization key `K`:

```text
relayKey = HMAC-SHA256(K, 'linkx-statistics-legacy-timer-relay-v1')   // 32 raw bytes
signature = HMAC-SHA256(relayKey, 'legacyPublicStatsTimer\n' + timestamp).hex
```

The receiver enforces ±5 minutes, exact fields, constant-time signature comparison, successfully parsed current invocation context, and absence of OPENID/FROM_OPENID. It deliberately does not guess a specific cross-function SOURCE string; the private, domain-separated HMAC is the primary authorization. Invalid context, client-forged Timer envelopes, missing signatures and key failures cause no database read/publish. The timestamp limits replay lifetime; the relay has no durable one-time nonce and is not claimed to reject every repeat inside that five-minute window. Its operation only rereads public totals and refreshes a signed snapshot.

## Compatibility and deployment order

`getPublicStats` remains a fixed-action wrapper to `statistics/publicStats` for already distributed packages. Each old caller incurs **one additional cloud-function invocation** until packages use `statistics` directly. The wrapper never forwards client actions or arbitrary arguments.

`syncPublicStatsReplica` retains its existing `publicStatsHourly` timer (currently minute 25), verifies the original trigger, signs this relay and delegates; it contains no active database read/publish implementation. That compatibility path also adds one invocation per hourly run. Do not remove the old function/trigger while it is the active scheduler. Do not enable two hourly triggers simultaneously. This new function intentionally has **no trigger configured initially**; direct Timer handling is ready for a later coordinated trigger transfer.

Deploy `statistics` with both private keys, install `wx-server-sdk` and verify its actual configured timeout is **15 seconds**. The JSON file alone does not prove the platform applied that timeout; new functions may default to three seconds. The HTTPS publisher has an eight-second deadline. Verify the canonical function before replacing the old timer wrapper, or the existing hourly refresh could be broken. Preserve the old public entry for installed clients. The active client module is `utils/analyticsSession.js`; the cloud function remains `statistics`. Upload `compat.js` before the updated `bridge.js` so incremental deployment cannot leave a missing dependency. Historical deployment evidence belongs in the dated deployment reports.

Only current non-sensitive status/timestamp logs are emitted. No keys, subjects, user IDs, tokens, raw database objects or request payloads are logged. The analytics configuration, policy notice, batch receiver, maintenance jobs and customer-service stop workflow remain independently controlled.

## Local checks

From repository root:

```sh
node --test tests/statistics-entry.test.cjs tests/public-stats-sync.test.cjs tests/public-stats-context.test.cjs tests/analytics-bridge.test.cjs
```

Tests use dependency injection and synthetic keys; they do not query cloud data or deploy. They cover public response compatibility/projection, unchanged participation dispatch, trusted Timer validation, domain-separated relay verification/skew/no-user context, legacy wrapper boundaries, and sanitized failures.
