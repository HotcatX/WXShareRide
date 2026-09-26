# LinkX analytics collector

This service receives bounded client telemetry using Node.js and local SQLite. Real collection remains **off by default**. A dedicated authenticated bridge can establish server authorization for the limited privacy-notice rollout; it does not record or imply an explicit user-consent action. The mini-program uses its existing privacy policy and customer-service entry, with no additional collection popup, button or settings page. Client page hooks and CloudBase deployment are separate components; this receiver alone does not activate them.

## Naming and deployment compatibility

The source directory and package are `services/analytics-collector` / `linkx-analytics-collector`. `src/compat/legacy.mjs` is the single source of deployed SQLite table/index names, JWT issuer/audience, purpose/notice versions, bridge route, account HMAC scopes, environment keys and operations key paths. SQL uses these immutable identifiers; there is no renamed duplicate database, account mapping or grant state.

`TEMPORARY COMPATIBILITY` values cannot be removed just because the directory changed. First verify the next production release, then explicitly migrate old clients, tokens, grants, stored queues, database/backup readers and host operations. Table names and account scopes need a data migration; changing their spelling would disconnect existing users. The CloudBase package keeps its own deployable `compat.js`, with a cross-package contract test to prevent drift.

The Compose image tag remains the last deployed image until the deployment owner builds and pins a replacement. Keep the existing `/opt/linkx-collector` host directory, Compose project identity, data/secret mounts, socket and backup jobs during this rename. Do not start a second Compose project against the same SQLite file. Directory or package changes alone are not a deployment.

## Boundaries

- Public listener: `GET /healthz`, `POST /v1/batches`, and the strictly HMAC-authenticated `POST /internal/v1/research/participation`. Default native binding is `127.0.0.1:3000`; Docker binds internally to all interfaces but publishes only host loopback.
- Management: HTTP over a mode-0600 Unix socket, authenticated by a random admin token. It has no TCP port. Never proxy it, copy its token into the mini program, or expose it to Caddy.
- Default `REAL_COLLECTION_ENABLED=false` rejects enrollment and ingestion for non-synthetic participants. Tests generate random identifiers and no real users.
- Event bodies allow only opaque generated event identifiers. **Never put an OpenID, name, phone, WeChat ID, raw residential address, exact coordinate, or a personal value encoded as an ID in an event.** The trusted account bridge separately stores the original OpenID once for restricted operational lookup. Schema validation cannot determine that an opaque event ID was derived improperly.
- Trusted business events arrive through the signed `/internal/v1/places/business-events` bridge. Yes/no follow-up answers use the bounded event batch schema. A client click or self-reported answer is not proof of a booking, payment, or completed ride.
- The identity bridge, 180-day real-payload policy, seven-day managed-backup rotation, and conservative restore reset are implemented here. COS/off-machine archive and deletion of external analysis copies are not. The deployment owner activates real collection only together with the matching privacy notice, authenticated cloud bridge, client rollout and customer-service stop workflow.

## Run locally

Requires Node.js 22+ and build support for `better-sqlite3`. The lockfile pins the dependency; this implementation has been tested with SQLite 3.53.4. Startup rejects SQLite versions without the official WAL-reset fix (3.51.3+, or the documented 3.50.7/3.44.6 backports).

```sh
cd services/analytics-collector
npm ci
npm run init-local
npm test
npm start
```

In another terminal, `node scripts/smoke.mjs` tests the running process with a random synthetic participant. It checks health, local token issuance, upload, retry, conflict, withdrawal, and old-token rejection. Tokens stay in memory; output is an aggregate result. Successful/failing smoke tests attempt to revoke their synthetic grant afterwards.

`npm run init-local` creates `secrets/signing.pem` (Ed25519) and `secrets/admin.token`, refuses overwrite, and does not print secrets. Keep these outside Git and outside build contexts. No production credentials are included.

## Docker deployment

The Dockerfile uses separate build/runtime stages. Python, make and g++ compile SQLite only in the build stage. The runtime is non-root, read-only except the mounted data and backup directories. The default Compose process memory limit is 512 MiB; it is an initial bound, not a throughput guarantee.

Create the host directories with owner UID/GID matching `COLLECTOR_UID/COLLECTOR_GID` (defaults `1000:1000`). Secrets should be mode 0700 and individual files 0600; data/backups should not be world-readable. Generate secrets on the destination server; do not transfer or reuse a server login password as an application secret.

Suggested deployment `.env` (contains paths/settings, no secrets):

```dotenv
COLLECTOR_DATA_DIR=/var/lib/linkx-collector
COLLECTOR_SECRETS_DIR=/etc/linkx-collector
COLLECTOR_BACKUP_DIR=/var/backups/linkx-collector
COLLECTOR_UID=1000
COLLECTOR_GID=1000
REAL_COLLECTION_ENABLED=false
# Set only after generating this independent 32-byte hex key on the destination:
RESEARCH_BRIDGE_KEY_FILE=/secrets/bridge.key
RESEARCH_NOTICE_VERSION=ride-research-notice-2026-09-23
COLLECTOR_PORT=3000
COLLECTOR_DOMAIN=collect.linkx.ink
```

```sh
docker compose build collector
# First time only: secrets mount is temporarily writable for local generation.
docker compose run --rm -v /etc/linkx-collector:/secrets:rw \
  -e SECRETS_DIR=/secrets collector node scripts/init-local.mjs
docker compose up -d collector
docker compose exec -T collector node scripts/smoke.mjs
docker compose exec -T collector npm test
docker compose exec -T collector node scripts/admin.mjs status
```

Adapt the explicit secrets path in the first command if using a different host layout. `docker compose run` may still need the data/backup host directories to exist and be writable by the configured UID.

Caddy is an optional **`https` profile**, so ordinary `up -d collector` does not open ports 80/443 or request a certificate. Only after the domain/DNS, HTTPS and mini-program server-domain requirements are confirmed, `docker compose --profile https up -d` starts it. Caddy stores certificates/config in separate persistent volumes and sees no SQLite, management socket, or signing key. Its configuration proxies only exact health, batch, HMAC participation, public-statistics read and statistics-sync routes. The public-statistics sidecar and its separate sync secret remain isolated from the collector. HTTP plaintext is suitable only for host-loopback tests.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST`, `PORT` | `127.0.0.1`, `3000` | Native process public binding; Compose internally uses `0.0.0.0` |
| `DB_PATH` | `./data/collector.sqlite` | Local persistent filesystem only; never NFS/COS or ephemeral container layer |
| `ADMIN_SOCKET` | `./data/run/admin.sock` | Management Unix socket |
| `SIGNING_KEY_FILE`, `ADMIN_TOKEN_FILE` | `./secrets/signing.pem`, `./secrets/admin.token` | Private readable files, no built-in fallback secrets |
| `REAL_COLLECTION_ENABLED` | `false` | Controls real activation, token issuance and batch ingestion; state lookup/withdrawal remain available |
| `RESEARCH_BRIDGE_KEY_FILE` | unset | Independent 64-hex-character key file, decoded to 32 bytes; absent disables the bridge |
| `RESEARCH_NOTICE_VERSION` | `ride-research-notice-2026-09-23` | Current privacy-notice version; restore requires a newly deployed version |
| `PURPOSE_VERSION` | `ride-research-v1` | Exact accepted purpose |
| `TOKEN_TTL_SECONDS` | `900` | 60–900 seconds; refresh through the authenticated bridge or local management |
| `SIGNING_KEY_ID` | `local-v1` | Pinned JWT key ID; no remote key lookup |
| `MAX_DATABASE_MB` | `1024` | SQLite page cap; WAL, backups and logs require additional disk |
| `MIN_FREE_MB` | `256` | Stop accepting new HTTP batches below this filesystem reserve |
| `BACKUP_DIR` | `./data/backups` | Native backup output; Docker defaults `/backups` |

Initial admission limits are 600 batch requests/minute globally, 60/minute per verified participant, 64 in-flight batch requests, 64 separate bridge slots, 64 separate management slots, and 128 sockets per listener. The authenticated bridge additionally permits 120 requests/minute globally and 20/minute per account subject. Counters are bounded in-memory safeguards for one instance, not durable billing limits. They reset on restart. Source IP/forwarded IP is not an identity and is not stored. Run exactly one collector service against this database. A second live management socket is rejected; replicas require a different database design.

## Frozen client wire contract

```json
{"schemaVersion":1,"batchId":"<opaque-id-16-to-80-chars>","events":[{"eventId":"<opaque-id-16-to-80-chars>","eventName":"page_view","schemaVersion":1,"occurredAt":1790000000000,"data":{"page":"home"}}]}
```

`POST /v1/batches` uses `Authorization: Bearer <token>` and `Content-Type: application/json`. Send the **compact original `JSON.stringify(body)` string**, not pretty JSON or a newly serialized/reordered retry. Strict equality to the parsed compact serialization rejects duplicate JSON keys that could hide excluded personal fields. No gzip encoding. Entire UTF-8 body ≤65,536 bytes; 1–50 events. IDs are `[A-Za-z0-9_-]{16,80}`. Epoch times use milliseconds; new events may be at most seven days old or five minutes in the future. `sessionId` is optional. Unknown fields, event names and schema versions fail the entire batch.

The server computes SHA-256 over the original UTF-8 body. ACK is sent **after SQLite commits**:

```json
{"ok":true,"batchId":"...","payloadHash":"<sha256-hex>","eventCount":1,"receivedAt":1790000000000,"duplicate":false}
```

Same participant + batch ID + grant + same bytes returns the original receipt with `duplicate:true`. Another payload or grant returns `409 BATCH_CONFLICT`. Receipt lookup happens before age rejection, so a still-retained accepted receipt can acknowledge an older retry. Token expiry, withdrawal, and grant/version checks still apply to all retries.

Across different batches, `(participant,eventId)` is indexed with a canonical event-content hash. Identical events may be stored in a retransmitted raw batch but appear only once in **`eligible_events`**; differing content/grant returns `409 EVENT_CONFLICT` and rolls back the whole batch. Do not count raw `ingest_batches` or expand `eligible_batches` without deduplication. Payloads remain client reports, not trusted business evidence.

Error body: `{"ok":false,"error":"CODE"}`. Important classes: `400 INVALID_JSON/NON_CANONICAL_JSON`, `401 INVALID_TOKEN/TOKEN_EXPIRED`, `403 PARTICIPATION_INACTIVE/STALE_GRANT`, `409 BATCH_CONFLICT/EVENT_CONFLICT`, `413 BATCH_TOO_LARGE`, `415 JSON_REQUIRED/ENCODING_NOT_SUPPORTED`, `422 INVALID_BATCH`, `429 RATE_LIMITED`, `503 COLLECTION_DISABLED/RESTORE_QUARANTINE/STORAGE_UNAVAILABLE`. Retry 429/503 with backoff and the identical sealed batch; respect `Retry-After`. On 401 refresh trusted authentication; on 403 stop collecting and purge that grant's queue. Conflicts require quarantine/diagnosis, not a new batch ID containing the same disputed event.

## Event data allowlist

All fields below are required unless followed by `?`. Null is not a substitute for an omitted optional field. The executable contract is `src/validation.mjs`.

| Event | `data` fields |
| --- | --- |
| `page_view` | `page` |
| `search_submitted` | `searchId`, `tripType`, `serviceDate`, `originArea?`, `destinationArea?`, `partySize?`, `intentId?` |
| `result_set_rendered` | `searchId`, `selectionSetId`, `source`, `renderedCount`, `loadedDateCount`, `hasMore`, `candidatesComplete`, `zeroReason?`, `candidates?` |
| `result_card_visible` | `selectionSetId`, `tripKey`, `tripType`, `position`, `visibilityBucket` |
| `trip_detail_opened` | `tripKey`, `tripType`, `source` |
| `contact_entry_clicked` | `tripKey`, `tripType`, `method` (method only; never the actual contact value) |
| `no_suitable_option` | `searchId`, `intentId?`, `reason` |
| `collection_diagnostic` | `reason`, `droppedCount` |

Pages: `home/carpool_list/trip_detail/request_detail/trip_history/market/profile`. Areas: `fort_lee/columbia/other/unknown`, with no dynamic text or exact positions. Trip types: `carpool/request`, plus `all` for searches. Contact method: `phone/wechat/zelle/other`. Search service dates are valid `YYYY-MM-DD`; party size is 1–8. Detail source: `list/history/share/other`. Visibility bucket: `half_1s/full_1s`. No-suitable reason: `time/place/price/full/none/other/unspecified`. Diagnostic reason: `queue_limit/expired/invalid_event/upload_failed`, count 0–500.

Rendered-set source: `network/cache`; `renderedCount` 0–500, loaded dates 0–31, `hasMore` and `candidatesComplete` boolean. Zero reason: `none/empty/filtered/load_error`. A candidate list has at most 50 entries; each contains `tripKey/tripType/position/availableSeats`, optional `tripVersion/referencePriceCents/currency/priceKind`. Positions are 0–999, seats 0–20, integer cents 0–100000; currency is `USD/unknown`; price kind is `driverReference/configuredRequestReference/unknown`. `candidatesComplete:true` requires a list whose length equals renderedCount; `false` explicitly represents a partial or unrecorded snapshot. Reference price is not actual payment, agreed price, or willingness to pay. Missing currency stays unknown in analysis.

## Trusted participation bridge

`POST /internal/v1/research/participation` accepts compact UTF-8 JSON up to 8192 bytes. This is a server-to-server route, not a way for a mini-program to claim its own identity. CloudBase derives the account subject from the authenticated invocation identity using a separate scoped HMAC identity key and supplies its trusted `openid` for internal account debugging. The identity key can also be kept in a root-only host operations directory for verified customer-service requests; it is **not** mounted into the collector or bundled in the mini-program. The research `accountSubject` and random `participantKey` remain pseudonymous identifiers; the operational database is explicitly linked to original OpenIDs.

The independent **bridge** key file is 64 hexadecimal characters, decoded to 32 raw bytes. It must differ from the identity key, public-statistics sync key, local admin token and Ed25519 signing key. Required headers, exactly once each:

- `x-linkx-timestamp`: decimal epoch milliseconds, within ±5 minutes after the body arrives.
- `x-linkx-nonce`: fresh 16 random bytes encoded as 32 lowercase hex characters.
- `x-linkx-signature`: lowercase `HMAC-SHA256(bridgeKeyBytes, timestamp + "\n" + nonce + "\n" + rawBodyBytes)`.

The request contains `accountSubject` (64 lowercase hex), `action` (`status|activate|withdraw`), `requestId` (opaque 16–80-character ID), `expectedStatusVersion` (0–2147483647), `purposeVersion` and `noticeVersion`, plus optional `synthetic:true` and `openid` (`[A-Za-z0-9_-]{16,128}`). Old requests may omit both. Explicit false/non-boolean synthetic flags are rejected. Both versions must match server configuration. Unknown fields, the obsolete `consent` action and pretty/ambiguous JSON are rejected. Only the authenticated cloud invocation may supply `openid`; a client-provided identity is never forwarded.

On startup, schema v3 atomically adds nullable `research_accounts.openid` and its lookup index without changing participant IDs, tokens or grants. A trusted request fills an existing empty link or checks an identical link; another OpenID or a duplicate OpenID assigned to a different account in the same real/test namespace returns `ACCOUNT_IDENTITY_CONFLICT`. Unknown `status` still creates no account. Existing records are linked on their next trusted status/activation, and OpenID is excluded from the operation-content hash to preserve older idempotent retries. The legacy customer-service helper remains compatible without sending the new field. Deploy this receiver before the updated cloud bridge.

For development/trial verification, the cloud bridge accepts optional client `collectionMode:'test'`, derives `accountSubject` using the distinct HMAC domain `linkx-research-test-account-v1` and adds `synthetic:true` inside its authenticated body. Real callers retain `linkx-research-account-v1` and omit the mode/type flags; the updated bridge supplies trusted `openid` in either mode. This is an explicitly requested test namespace, not server attestation of a WeChat build channel. Identity still comes exclusively from the authenticated current invocation. Existing account type is immutable for status, activation and withdrawal; test and real subject namespaces have independent random participant/grant IDs and state. Batch bodies cannot select or change type. Test responses always include outer `synthetic:true`, including unknown status, while real responses preserve the original shape. Clients must reject a wrong-mode reply and clear/partition queued data when switching modes.

Synthetic activation/token issuance is available even when `REAL_COLLECTION_ENABLED=false`, but still requires the signed bridge, current notice/purpose, exact CAS and open restore gate. The conservative recovered-real-notice block applies to real grants; it is not a test authorization shortcut around quarantine. The original customer-service helper remains real-only without any protocol changes. Deploy this receiver before the updated cloud bridge and trial package.

Nonce use is committed to SQLite and survives restart. A repeated nonce returns 409 `BRIDGE_REPLAY`. Its validity ends at signing timestamp + five minutes (at most about ten minutes from receipt with allowed future skew); expired entries are deleted during subsequent authenticated requests or scheduled maintenance, with a hard 5000-entry cap. A retry must use a new timestamp/nonce/signature while preserving the original operation's `requestId` and body.

`status` never creates a participant and ignores expected version; unknown accounts return `status:none,statusVersion:0`. `activate` is **technical authorization under the privacy notice**, not evidence of explicit consent. Normal clients may automatically activate only a previously unknown account in the configured rollout. A withdrawn/revoked account must not be automatically reactivated; any later reactivation requires a separately verified request through the trusted operational workflow. The server requires exact version matching and never silently replaces a newer state. It creates a random participant ID and a fresh grant, stores the action truthfully as `activate`, and associates the current notice/purpose. The collection service does not implement its own independent sampling: the mini-program/cloud caller controls rollout recruitment.

State mutation and operation receipts use one immediate SQLite transaction. Same request ID and canonical content is idempotent while its resulting state version remains current. Different content returns `OPERATION_CONFLICT`; an operation superseded by withdrawal or a later grant returns `OPERATION_SUPERSEDED`, without replaying the old mutation. A stale expected version returns `STATE_CONFLICT`; fetch current status and do not blindly retry an activation or withdrawal against a different grant. Unknown-account withdrawal creates a revoked tombstone/version 1, blocking a racing activation prepared with expected version zero.

Responses contain `ok,status,statusVersion,purposeVersion,noticeVersion`; active/revoked also include the stable outer `participantKey`. A currently enabled active grant adds `session:{participantKey,grantId,statusVersion,status:'active',confirmed:true,purposeVersion,acceptedPurposeVersion,token,tokenExpiresAtMs}`. `confirmed` means **server authorization confirmed**, and the legacy `acceptedPurposeVersion` field identifies the authorized purpose; neither field claims an express user-consent event. Tokens are Ed25519 JWTs with fixed issuer/audience/algorithm/key ID and a default 15-minute lifetime. During a global pause, restore quarantine or notice mismatch, `status` can still return active metadata but omits `session`; clients must stop collection without a valid session and may still request withdrawal.

Bridge errors use the ordinary `{ok:false,error}` envelope. Relevant errors include `BRIDGE_DISABLED`, `BRIDGE_UNAUTHORIZED`, `BRIDGE_REPLAY`, `BRIDGE_CAPACITY`, `INVALID_PARTICIPATION_REQUEST`, `NOTICE_VERSION_MISMATCH`, `STATE_CONFLICT`, `OPERATION_CONFLICT`, `OPERATION_SUPERSEDED`, `VERSION_EXHAUSTED`, `COLLECTION_DISABLED` and `RESTORE_QUARANTINE`. The compatibility error identifier `RECOVERY_RECONSENT_NOTICE_REQUIRED` means recovery requires a new notice deployment; it is a legacy code, not a record of user consent. `CONSENT_REQUIRED` likewise denotes missing server account/notice authorization for a real grant. No secret, body, original account ID, IP or token is logged.

## Local management and customer-service stop requests

Management remains HTTP over a protected UNIX socket only. `scripts/admin.mjs state` and `token` are retained for synthetic tests and tightly controlled operations; they are never proxied. A real manually inserted participant without its trusted account/notice mapping cannot receive a valid upload authorization. Synthetic and real identity types cannot be changed. A grant cannot change purpose while active, and revoked grant IDs cannot be reused.

`ops/diagnose-account.mjs` provides direct OpenID lookup through the authenticated UNIX-only `/v1/diagnostics/account` endpoint. It returns account state and a bounded timeline of retained, authorized events/batch receipts, without grants, tokens or keys. Default is the last 24 hours of real data, at most 50 events and 50 receipts; test mode is explicit and limits cap at 100. See [the short operations guide](ops/diagnose-account.md). `operational_events` joins the single account OpenID and each event's `tripKey` for internal analysis; do not use that identity-bearing view as the research export.

A customer-service stop request must be verified against the current mini-program account. Authorized operations derive its account subject with the same scoped identity key, then call the authenticated bridge `status` followed by `withdraw` with the exact current version. The separate host-only operations helper accepts the account ID through private stdin/file, and must not log it, its derived subject, participant ID or any token. It must not share identity secrets with Caddy, the collector container or clients. The existing customer-service channel remains the user entry; no new self-service button or collection settings page is claimed here.

Withdrawal and batch receive transactions mutually exclude one another. Successful withdrawal immediately blocks old grants and deletes the participant's online payloads, while retaining minimal authorization/anti-replay metadata. It does **not** certify instantaneous forensic erasure of WAL, disk sectors, backups or exported copies. Report success only after server acknowledgment; a locally cleared queue does not prove server withdrawal.

`node scripts/metrics.mjs` and local `admin.mjs status` expose only safe aggregates: separate real/synthetic active/revoked participant counts, eligible batch/event counts, event-name totals and latest eligible receipt time. `syntheticParticipants` remains the total test participant count. These counters support trial ingestion verification without including tests in real counts. They do not expose account subjects, participant IDs, payloads or tokens.

## Backups, restore quarantine and retention

```sh
docker compose exec -T collector node scripts/backup.mjs
# Optional exact NEW target path as first argument.
docker compose exec -T collector node scripts/restore-check.mjs \
  /backups/collector-TIMESTAMP.sqlite /backups/restore-candidate.sqlite
```

The backup tool uses SQLite's online backup API while the service runs, checks integrity, and writes mode 0600. Never copy just a live `.sqlite` file while discarding `-wal`. Backups contain research data and require private access. A local backup is not protection against whole-machine loss; no COS backup destination is configured in this package. The daily host maintenance script applies the seven-day managed-backup policy described below. The root task's host integration lives in `ops/` if present.

Restore-check creates a **new candidate**, never replaces the live DB. It writes a temporary candidate, closes the restore gate, checks integrity, closes the connection, then atomically publishes the new filename. A failed/interrupted `.pending-*` file is not a valid restore candidate. A restored candidate blocks token issuance, ingestion, and the eligible SQL views, even for synthetic users.

For actual recovery: stop the collector, preserve the failed state, install a checked candidate, and restart with real collection disabled. The local `recovery-complete` command still requires `{"stateReconciliationConfirmed":true}`, but cannot simply reopen historical real grants: in one transaction it deletes **all restored real payloads**, revokes every restored real grant, and blocks activation under the current notice. This also happens for an empty/pre-activation backup, whose missing account/nonce/operation history cannot prove that no later withdrawal occurred. Deploy a fresh notice version consistently to server, cloud bridge and client before permitting any new activation. Previously revoked accounts must still not be automatically reopened. This deliberately conservative recovery sacrifices historic real research payloads rather than making revoked data eligible again; it is not automatic reconciliation with CloudBase. Source backup files remain private and age out through rotation.

`node scripts/prune.mjs` implements the real-data policy: payloads are excluded from `eligible_*` views at **180 days after server receipt**, then physically deleted by scheduled maintenance; real batch/event deduplication receipts and operation hashes are removed after 187 days. Synthetic payloads retain the prior 14-day limit and receipts 30 days. Minimal account mappings, current authorization versions and revoked-grant markers remain to prevent reactivation/replay and are not research observations. The authorization records do not assert express user consent.

`ops/backup.sh` is the daily host timer target. It first invokes `scripts/rotate-backups.mjs` to delete managed `collector-<timestamp>.sqlite` files at least seven days old, then runs `prune.mjs`, then creates and verifies a fresh online backup. Rotation runs even if creation of a new backup later fails. It only deletes regular generated snapshot files within the private backup directory; explicit operator evidence/candidate files and symlinks are not automatically deleted and must be tracked and removed separately after use. A daily scheduler gives physical deletion up to one scheduling interval of delay; the seven-day backup period is additional to online data removal, not a claim that all copies vanish immediately. The host must actually install/update and monitor this script/timer; merely building the container does not schedule maintenance.

The database cap fails new uploads rather than silently dropping acknowledged records. Local backups do not protect against whole-machine loss, and no off-machine/COS backup is configured here. WAL and logs consume space outside the database page cap. The collection protocol commits to local SQLite durability, not zero data loss across machine failure.

Use **`eligible_real_events`** for authorized, deduplicated real research extraction; `eligible_real_batches` is its raw-batch counterpart. Both always exclude synthetic participants. The existing generic `eligible_events` and `eligible_batches` intentionally retain both types for diagnostics, and must not be treated as a real research cohort. These views are not yet a complete export job API. An external analysis transaction must not hold a stale snapshot across a withdrawal and then publish a new result without rechecking current authorization. There is no automatic cancellation of already-copied external data in this starter service.

## Validation and remaining work

`npm test` covers public/admin separation, unknown/default-off participation, hash retries/conflicts, cross-batch event deduplication and rollback, monotone withdrawal/reactivation, restart persistence, input/privacy allowlists, candidate coverage, concurrent withdrawal, online backup/quarantined restore, and recovery after a real child process SIGKILL.

The participation tests additionally cover signed bridge bodies/times, persisted nonce replay rejection, CAS races, true action receipts, stale operations, paused token suppression, empty-backup recovery, 180/187-day retention and seven-day backup rotation. Run them with the pinned Node 24 container runtime (or its matching local runtime), rather than changing global native dependencies.

Deployment must wire the matching cloud bridge, privacy notice, current mini-program domain, existing customer-service stop process and limited page hooks before enabling the real switch. Business transaction outbox, actual-ride follow-up, full candidate/trip pseudonym mapping, COS archive and external export deletion remain separate tasks. No booking behavior is modified by deploying this service.

References: [SQLite WAL and patch history](https://www.sqlite.org/wal.html), [SQLite backup API](https://www.sqlite.org/backup.html). The repository research plans supply the research meaning and missingness constraints; this receiver does not turn telemetry into causal evidence.

### Place recommendations and business evidence (schema 4)

`POST /v1/place-suggestions` uses the existing short-lived signed identity token
with the explicit `places:read` scope. Old scope-less tokens still ingest batches
but cannot read recommendations. The request is `{schemaVersion:1,cityKey,field,
mode,counterpartPlaceId?}` (`field`: departure/destination; `mode`:
driver/passenger/filter). OpenID is resolved on the server, never accepted from a
client body or URL. Responses are private/no-store; the client additionally
isolates its five-minute cache by account and panel context.

`POST /internal/v1/places/business-events` accepts the existing HMAC timestamp /
nonce / exact JSON-byte protocol. The envelope is `{schemaVersion:1,events:[...]}`,
at most 50 events **and 131,072 serialized bytes**. Client `/v1/batches` remains
limited to 65,536 bytes; only the trusted business route has the larger cap. Its strict nested event schema
is exported as `validateBusinessEvents` in `src/places.mjs`. The entire batch
commits atomically; a matching retry returns `acceptedEventIds` and also
`duplicateEventIds`. Changed event IDs or trip versions fail with 409. The sender
must acknowledge only returned IDs, not a high-water timestamp. A captured
business fact and its original before/after state remain stored after deletion.
Version-zero `legacy_snapshot` events are explicitly partial observed snapshots;
they cannot overwrite a later transaction. Their historical-usage clock uses the
planned service date; circle evidence retains the observation timestamp and does
not pretend the baseline was known earlier.

The eight standards use the bundled `place-catalog.cjs`, kept byte-identical to
`utils/placeCatalog.js` and checked in tests. Bare Newark is not EWR, Jersey City
is not JSQ, and Long Island is not LIC. Public POI suggestions require BOTH a
verified catalog entry and a trusted successful publication/baseline using it.
Unknown text goes into an admin-only pending/private table; it never becomes a
public suggestion merely because its name sounds public. Private unit/phone
patterns cannot be approved through the public-place approval endpoint. The
server does not return user identity, raw private endpoints or publisher IDs.

Local UNIX admin operations (stdin JSON; no secrets in argv):

- `node scripts/admin.mjs places-status`: safe counts, real/test split, sync
  freshness, source-separated historical/transaction counts, followup eligible
  population and actual presentation/answer counts.
- `places-pending`: `{ "limit": 25 }`; only pending candidates, private entries
  excluded. The response contains internal candidate labels, so keep it private.
- `places-approve`: `{candidateId,label,parentRegionId,verification:
  "manual_public_poi",verificationReference:"https://official-source/..."}`.
- `places-seed`: `{label,aliases:[...],cityKey:"ny_nj",parentRegionId,
  verificationReference:"https://official-source/..."}`. Use `unknown` for a POI
  whose parent region is not one of the supported non-airport regions. Seeding
  does not fabricate usage or cause an unused POI to appear.

New public candidates reserve one deterministic rotating slot; the other eight
slots rank by deduplicated confirmed selections, with a separate, explicitly
labelled historical-usage fallback. One vote is OpenID/place/side/New York day;
raw valid events still remain available for research. Multi-circle overlap never
adds a vote twice. Circles come from trusted business participation as of the
selection/publication time, exclude airports as anchors and respect exits,
deletions and explicit negative followups. Delayed outbox facts reconcile stored
vote/usage circle attribution; immutable rank response snapshots preserve what
was actually returned. A later public classification does not invent an earlier
route-circle association for a then-unknown endpoint.

All new tables inherit the global SQLite `max_page_count` (default 1 GiB), both
new public write paths enforce the existing free-disk reserve, and queries have
explicit row caps. Exceeding a cap returns a retryable service error so the client
uses its fixed/public and own-local fallback. Per-request ranking reuses indexed
account history and groups votes once per place. Snapshots reuse the same account
and context for five minutes. Maintenance prunes real payloads/projections at
180 days and synthetic data at 14 days; candidate text with no approval is
removed after 180 inactive days. Official deployment requires a pre-migration
backup: schema-3 code deliberately refuses schema 4, so rollback needs its paired
backup, not an old image pointed at an upgraded database.
