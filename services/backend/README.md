# LinkX backend

Single Node.js 24 application and PostgreSQL business database. Production
switched to this backend on 2026-09-30; PostgreSQL is the sole business writer.
CloudBase retains the trusted identity bridge, limited compatibility routes and
read-only recovery data. See [the cutover record](../../docs/backend-cutover-2026-09-30.md)
for the maintenance window, live verification and remaining validation limits.

## Run and verify

```sh
npm ci
# The cross-service delivery test uses the existing collector's SQLite adapter.
npm --prefix ../analytics-collector ci
npm run check
# A dedicated local PostgreSQL test database; suites create/drop only random schemas.
BACKEND_TEST_DATABASE_URL=postgresql://localhost/linkx_test npm test
DATABASE_URL=postgresql://localhost/linkx WECHAT_APP_ID=wx8a8a389199aa2a0e npm run migrate
DATABASE_URL=postgresql://localhost/linkx WECHAT_APP_ID=wx8a8a389199aa2a0e npm start
```

`BACKEND_TEST_DATABASE_URL` is required for the full test suite. Some older suites
skip without it, while migration and notification suites reject a missing URL;
a partial run is insufficient to approve transactions or schemas.
Migrations run as an explicit deployment step and never implicitly on startup.
Previously applied SQL files are immutable and checked by SHA-256.

Export the complete CloudBase inventory with an already verified, logged-in
WeChat developer-tool session, then audit the private bundle:

```sh
node scripts/export.ts --output /absolute/new-private-directory --expected-app-id wx8a8a389199aa2a0e --expected-env cloud1-7gmtcu4s3aebce27
node scripts/import.ts --manifest /absolute/private/manifest.json --expected-app-id wx8a8a389199aa2a0e
```

Export is read-only. It preserves raw CLI responses, verifies both inventories
and every keyset page through an empty terminal page, and never retries a failed
command silently. Failures retain private evidence but publish no final manifest.
The output directory must be new; a failed bundle is not reused for another run.

`src/migration/manifest.ts` defines the fixed 49-collection manifest. Every file
must be a complete document array in the same private directory, with exact
byte/hash/count and export-time observations. Default audit is offline and
does not connect to PostgreSQL. Ordinary exports are explicitly non-atomic:
`auditReady` never certifies that live writers are stopped.

After separately verifying the old writer shutdown, pending operations and
collector delivery, add `--apply --expected-source-sha256 HASH
--accepted-manifest-sha256 HASH` to accept that exact reviewed bundle. Apply
requires the existing `staged` configuration and the same AppID. It uses the
sole atomic importer, rejects a different source on a nonempty target, and
does not activate business routes or jobs. Preserve the original provider
export responses separately as migration evidence.

Only `src/config.ts` reads environment variables. `DATABASE_URL_FILE` is the
alternative for a mounted secret; configure exactly one of it and `DATABASE_URL`.
`WECHAT_APP_SECRET_FILE` enables real server-side `code2session` login. If absent,
an active deployment returns `503 LOGIN_UNAVAILABLE`; no simulated or client-supplied identity
is ever accepted. `HOST`, `PORT` and `SESSION_TTL_SECONDS` are optional.

`BUSINESS_MODE` defaults to `staged`, which rejects all business and internal
API requests before side effects, while keeping `/healthz` available. Set
`BUSINESS_MODE=active` only in an isolated test deployment or after the final
production import and old-writer handoff. There is no automatic database fallback.
`AUTH_BRIDGE_KEY_FILE` optionally loads a separate 64-hex secret for
`POST /internal/v1/auth/cloudbase`. The bridge accepts only a signed, bounded
CloudBase invocation identity and issues the same business session as code2session.
No key means no bridge route. Its nonce and session commit atomically; unsigned,
expired, cross-app and replayed requests are rejected. The companion
`cloudfunctions/backend` bridge is deployed in production; committing its source
does not automatically deploy or enable a new environment.

The temporary `POST /internal/v1/compat/cloudbase` bridge reuses that mounted key
with separate signing purposes. It supports the finite deployed template,
notification and saved-address contract, plus bounded legacy read projections.
It looks up an existing migrated user;
it cannot create identities or issue sessions. Its nonce, canonical mutation and
permanent receipt share one transaction. Completed CloudBase `OperationReceipts`
are imported into the existing `idempotency_requests` table without re-executing
their bodies. Incomplete or inconsistent receipts block the whole import.
After handoff a pending cloud request retains its original action, key and body;
neither a timeout nor an unavailable bridge permits a write back to CloudBase.
Generate the isolated cloud bundles' authority files from `config/backend.js`
with `node scripts/sync-cloud-authority.mjs`; `--check` detects stale copies.
This repository and the deployed bridges now use `server` authority following
the completed single-writer handoff. Do not restore CloudBase write authority.

The six legacy query adapters use `purpose: compat-read` and an action-specific
HMAC leaf derived from the existing mounted root. Each cloud function receives
only its own leaf; it cannot sign a login, mutation or another query. Trusted
CloudBase context supplies AppID/OpenID, never request fields. Profile, contact
and ride projections use the current canonical permissions and file references.
One repeatable-read transaction covers paginated rows, the nonce and file ACL;
avatar signing reuses that transaction's connection to avoid pool deadlock.
No profile/session is created by a query, and no archived private fields are
substituted for current data. An unsupported legacy shape or oversized complete
result fails explicitly instead of returning partial data or reading CloudBase.

Generate the five public files per query function with
`node scripts/sync-cloud-queries.mjs`; `--check` verifies exact copies. A separate
private `query-bridge.secret` is injected only into each sealed deployment pack.
These functions are not in the ordinary bulk deployment whitelist. The backend
must be deployed and verified before updating them. Once query consumers are
using this contract, an older backend image without these actions is no longer
a compatible rollback; recovery must retain this contract against the same PG.
See [cloud deployment status](../../cloudfunctions/DEPLOYMENT.md) for the actual
deployed versus staged state.

The mini-program reads that same choice through `backend`'s public `authority`
action before starting page business work. The packaged configuration is not a
client fallback. Each JavaScript runtime keeps one source; a confirmed handoff
persists only the one-way `server` marker and requires a real runtime restart.
Rechecking the same CloudBase source blocks new interactions but preserves
already-submitted results. Failed checks never grant offline CloudBase access;
pending operations remain intact. Deploy the authority action before publishing
this compatible client, and retain the old writer shutdown as a separate gate.

Collection authorization reuses the existing collector's grant store and account
derivation. `COLLECTOR_BRIDGE_KEY_FILE` and `COLLECTOR_SUBJECT_KEY_FILE` must contain
the existing, distinct 64-hex keys; replacing the subject key would split accounts.
`COLLECTOR_ORIGIN` defaults to `https://collect.linkx.ink`. The subject key belongs
only to this backend and the old trusted cloud bridge, never the collector or a
client. These optional secrets do not activate business routes or background jobs.
Compose loads optional settings from `/etc/linkx-backend/identity/config.env` and
mounts that directory read-only at `/run/secrets/identity`. Create the directory
before deployment, including staged installations. Keep its key files readable
only by the service UID, and the environment file root-only; keep all of them
outside the source tree, image, and public Git repository.

Image storage is optional until provisioned: set all of `COS_BUCKET`,
`COS_REGION`, and `COS_CREDENTIALS_FILE`. The mounted JSON secret contains only
`secretId` and `secretKey`; never commit it or put it into the mini program.
`CLOUDBASE_STORAGE_ENV` optionally enables existing `cloud://` references in
that exact same bucket. Keep the bucket private and never enable versioning
while this create-only upload adapter is active. The server checks the bucket
before each PUT; the credential should allow GetObject, GetBucketVersioning and
PutObject only under the application's new image prefix, with no delete/ACL or
bucket-management permissions. Existing objects need read permission only.
No bucket creation, public ACL change or automatic cleanup runs at startup.
Compose keeps optional storage settings in `/etc/linkx-backend/images/config.env`
and mounts that directory read-only at `/run/secrets/images`. Create the directory
before deployment even when storage is unconfigured; keep credentials readable
only by the service UID. This server-only directory survives source replacements.

## Contract

- `/api/v1/auth/login`: `POST {code}` from a fresh `wx.login` call.
- `/api/v1/auth/logout`: `POST`, Bearer token.
- `/api/v1/me`: authenticated `GET` and `PATCH` private profile. Avatars use
  `avatarFileId` (omit to retain, null to clear), never a caller-supplied URL.
  Upload first through the shared image endpoint, then attach the owned UUID.
  Changing the reference does not delete the old file.
- `/api/v1/rides`: public `GET`, authenticated `POST`; see [ride contract](src/rides/README.md).
- `/api/v1/templates`: owner-scoped weekly offer templates; `GET`, `POST`, and
  `PATCH`/`DELETE /:id`. Weekdays and local clocks use `America/New_York`, including DST.
- `/api/v1/blocks`: authenticated outgoing list/create; `DELETE /:targetUserId`.
  Bilateral blocks prevent new ride joins; they do not remove existing bookings.
- `/api/v1/notifications`: private cursor-paginated list and idempotent clear;
  `GET /unread`, `POST /read-all` and `POST /:id/read`. Ride changes and their
  recipient notifications commit together, with one notification per event/user.
- `/api/v1/rides/:rideId/ratings`: authenticated `POST {targetId,score}` and
  `GET` of the caller's own submitted scores. One rating per counterpart;
  database constraints and the ride transaction prevent duplicate scoring.
- `/api/v1/rides/calendar`: bounded monthly counts using the same route and
  bilateral block filters as `/api/v1/rides`; list date ranges use New York
  midnights and expose the next available date. Authenticated membership reads
  return the viewer's role explicitly, without using failed contact reads as a
  membership check. `/api/v1/previews/rides` exposes only fixed area names and
  schedule/price/capacity for anonymous timeline previews.
- `/api/v1/me/statistics`: private role-specific completion and rating summaries.
  `/api/v1/statistics/public`: configured-app cumulative served count and coverage.
  Both read existing facts; no second editable personal aggregate is stored.
- `/api/v1/analytics/session`: authenticated authorization/status bridge to the
  existing collector. It uses the collector's request ID and status-version
  protocol, rather than a second generic business idempotency receipt. Ordinary
  batch uploads continue directly to the collector with their separate token.
- `/api/v1/referrals/me`: private code and referral count. Login retains or issues
  the same code. `POST /api/v1/referrals/bind {code}` records the first valid
  binding with idempotency; an existing binding cannot be reassigned.
- `/api/v1/admin/auth/login`, `/api/v1/admin/auth/logout` and `/api/v1/admin/session`:
  separate password authentication for the management website. Only exact HTTPS
  origins recorded in `admin_origins` are accepted; an empty allowlist denies
  access. Login/session return `admin.role`: `admin` or `superadmin`. Migration
  028 keeps existing accounts as `admin`; changing a role increments the
  credential version and revokes sessions in a BEFORE UPDATE trigger. Every
  elevated request and receipt replay checks the current role. An admin token
  cannot authenticate a mini-program user, or vice versa.
- `/healthz`: readiness against the database; exposes no account/configuration.
- `/api/v1/market/listings`: public filtered reads and authenticated creates;
  detail/update/status/delete, own/seller lists and counted detail views are
  separate routes. Reads never increment views. Images use ordered file UUIDs.
  Seller DTOs distinguish ordinary and managed contacts. The authenticated seller
  profile endpoint resolves old OpenID share links to user UUIDs only for a
  currently public ordinary seller or the viewer themselves; it never returns
  another person's OpenID. Own listings accept a status filter.
- `/api/v1/admin/market/listings`, `/batches`, `/templates`: management publishing,
  version-checked edits, resumable bulk imports and shared reusable templates.
  Both roles can list the application's nondeleted community listings and
  `POST /listings/delete {items:[{id,expectedVersion}]}` for 1–50 distinct items.
  Deletion is atomic, version checked and idempotent; it retains tombstones,
  images and history. Ordinary edits retain the owner/shared-management scope.
  `superadmin` can edit any nondeleted listing's canonical content, retaining
  user-owned images, and `POST /listings/:id/status {expectedVersion,status}`
  with online/offline/sold. Status changes never extend expiry or revive deleted items.
- `/api/v1/community`: public display configuration; `/api/v1/admin/community`
  lets both admin roles read/update it with version checks and an
  attachment-preserving history.
- `/api/v1/ads`: public active contact ads. Authenticated `POST /:id/clicks`
  records a tap with permanent idempotency; a tap is not a successful contact.
- `/api/v1/files/images`: authenticated `POST application/octet-stream` with
  actual image bytes and an idempotency key. JPEG/PNG/WebP, at most 2MiB and
  12 million decoded pixels; clients must resize unsupported/oversized originals.
  At most two uploads are admitted per server process, including body reception.
  Overload returns 503 plus Retry-After; retry the same bytes/key, not a cloud write.
- `/api/v1/files/urls`: `POST {fileIds:[...]}` for 1–50 UUIDs, optionally authenticated.
  The entire batch must be readable by that viewer. Returns five-minute signed
  HTTPS URLs; never persist those URLs as file identity. The same two endpoints
  under `/api/v1/admin/files/` use management authentication and origin checks.
- `/api/v1/admin/console`: superadmin-only `/tables`, `/rows`, `/rows/:table/:id`,
  `/status`, `/history` and `/events`. The fixed table catalog exposes app-scoped data and
  primary-key pagination; credentials, sessions and nonces are excluded.
  At most two database reads run concurrently, with a two-second SQL timeout
  and a 1 MiB JSON limit. `POST /rows/users/:id/edit` accepts only a version
  digest and a name/profile patch, reusing normal profile validation and merging;
  other tables remain read-only. File IDs do not confer storage access.
  Host sampling runs every thirty seconds; status polling/cache refresh every ten
  seconds. History retains minute averages for thirty days and exports fixed
  day/week/month ranges once per minute, at most 720 points per range; reads are
  cached for sixty seconds and never scan the business database. Event pages use received
  time and support time/type/user UUID or OpenID filters, at most 50 events.
  Read-only socket/snapshot configuration and bounded host sampling are in the
  [monitor deployment guide](../../deploy/monitor/README.md). Missing or stale
  metrics do not interrupt business service.

Responses use `{ok:true,data,requestId}` or
`{ok:false,error:{code,message},requestId}`. Each business write requires an
`idempotency-key` of 8–128 ASCII letters, digits, dots, underscores, colons or
hyphens. Reuse the same key and exact logical payload on retry. A reused key
with different content returns `409`.

Transactions atomically store mutations, their versioned business event and the
idempotency receipt. Sessions contain a hash of a random bearer token; identity
is bound to the configured AppID and the verified OpenID. There is no mutable
user-wide driver/passenger role and no duplicate active/history trip arrays.

## Migration boundary

[SCHEMA.md](SCHEMA.md) defines the only canonical fields. Old aliases are confined
to the import normalizer and isolated temporary compatibility boundaries. A complete CloudBase export is required; the
analytics snapshot is not sufficient. Audit unknown values rather than silently
dropping them or guessing timestamps. The dry-run CLI prints aggregate issue
codes and counts only; it does not import or transmit personal data.
The internal `importSnapshot` function supports an empty, separately configured
target only. It verifies the original source, inserts all supported core models
and their private source archive in one transaction, and reads counts back.
An identical completed import replays its receipt without overwriting later
business changes. It is not a merge, incremental synchronizer or cutover command.
The target must be a dedicated application schema: under the same advisory lock
as the SQL migration runner, the importer discovers and locks every application
table and refuses any nonempty target. New tables automatically participate in
that guard; they do not automatically become supported import models.

Market HTTP, management publishing/templates, community configuration, counted
views, ads, trusted image uploads and file URL authorization are implemented.
Private converters and the bootstrap importer cover their supported historical
models, preserving expiry and unknown metadata. The COS adapter signs only
authorized references, bounds downloads and verifies uploaded bytes before a
file becomes ready. Existing cloud references can keep their original objects;
only their exact configured bucket/environment may resolve. Each new deployment
must validate its credentials, provider access and mini-program/website DTO
compatibility; the production cutover record documents the completed checks.
Profile avatars use the same file UUIDs and references: `PATCH /me` accepts
`avatarFileId` (omit to preserve, null to clear). Contact views authorize current
member/seller avatars; a detached old avatar does not remain publicly readable.
No storage deletion timer is enabled.
See `SCHEMA.md`.

## Ride event delivery

Ride mutations freeze the collector's existing event contract in
`business_events.collector_payload` in the same transaction as the ride,
notification and request receipt. Before/after snapshots retain the mutation's
version, identities and participant changes. Ratings stay in the business ledger
without pretending to be a place event. Historical rows without snapshots remain
unqueued; they must not be reconstructed from a later ride state.

`deliverBusinessEvents` sends one bounded batch with a fresh HMAC nonce and marks
only acknowledged event IDs. A receiver commit followed by a lost reply retries
the same bytes; the existing collector deduplicates them. A session advisory lock
prevents overlapping deliveries for one app without locking ride writes during
network I/O. Errors preserve pending facts instead of switching databases.

`main.ts` starts independent closure and delivery loops only with
`BUSINESS_MODE=active`; staged deployments never schedule either job. An active
executable requires `COLLECTOR_BRIDGE_KEY_FILE`, containing the existing
collector bridge key. `COLLECTOR_ORIGIN` defaults to `https://collect.linkx.ink`
and accepts only a trusted HTTPS origin. There is no second outbox or grant
database. Shutdown drains work before closing the pool, and failures retry with
bounded backoff. Production switched to PostgreSQL on 2026-09-30 after the
complete frozen import, event handoff, reconciliation and isolated restore.
See `../../docs/backend-cutover-2026-09-30.md` for deployment evidence and limits.
The existing collector remains authoritative for place and follow-up data.

The deployment Compose binds only `127.0.0.1:3101`; PostgreSQL has no host port.
The existing collector stack must already supply `linkx-collector_default`.
Only the backend joins that network as `linkx-business`; PostgreSQL remains on
the backend network. The collector Caddyfile proxies `/api/v1/*` and the two
signed internal bridges to the backend. The default staged configuration rejects
business requests; the production Compose is explicitly active after handoff. Image POST routes accept at most 2 MiB; other requests
retain the existing 128 KiB proxy limit. Publishing routes is not a cutover.
The released 5.1.0 client selects PostgreSQL through its trusted authority
handshake. Preserve existing collector storage, credentials and the read-only
CloudBase recovery data. Do not reactivate CloudBase writers after the handoff.

Compatibility protocols use the same PostgreSQL database. Writes have one
authoritative database; a timeout must never send the same booking to an
independent old writer. New client operations use the canonical HTTP API. The
remaining client recovery bridge retries only persisted pre-cutover requests;
remove it when those original requests no longer need recovery. Keep the server
protocols needed by supported released clients, independently of client cleanup.
