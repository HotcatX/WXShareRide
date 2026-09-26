# LinkX backend

Single Node.js 24 application and PostgreSQL business database. This service is
being built alongside the live CloudBase application. **It is not yet a complete
replacement and must not receive production ride writes.**

## Run and verify

```sh
npm ci
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

Only `src/config.ts` reads environment variables. `DATABASE_URL_FILE` is the
alternative for a mounted secret; configure exactly one of it and `DATABASE_URL`.
`WECHAT_APP_SECRET_FILE` enables real server-side `code2session` login. If absent,
login returns `503 LOGIN_UNAVAILABLE`; no simulated or client-supplied identity
is ever accepted. `HOST`, `PORT` and `SESSION_TTL_SECONDS` are optional.

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

## Contract

- `/api/v1/auth/login`: `POST {code}` from a fresh `wx.login` call.
- `/api/v1/auth/logout`: `POST`, Bearer token.
- `/api/v1/me`: authenticated `GET` and `PATCH` private profile.
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
- `/api/v1/me/statistics`: private role-specific completion and rating summaries.
  `/api/v1/statistics/public`: configured-app cumulative served count and coverage.
  Both read existing facts; no second editable personal aggregate is stored.
- `/api/v1/referrals/me`: private code and referral count. Login retains or issues
  the same code. `POST /api/v1/referrals/bind {code}` records the first valid
  binding with idempotency; an existing binding cannot be reassigned.
- `/api/v1/admin/auth/login`, `/api/v1/admin/auth/logout` and `/api/v1/admin/session`:
  separate password authentication for the management website. Only exact HTTPS
  origins recorded in `admin_origins` are accepted; an empty allowlist denies
  access. An admin token cannot authenticate a mini-program user, or vice versa.
- `/healthz`: readiness against the database; exposes no account/configuration.
- `/api/v1/market/listings`: public filtered reads and authenticated creates;
  detail/update/status/delete, own/seller lists and counted detail views are
  separate routes. Reads never increment views. Images use ordered file UUIDs.
- `/api/v1/admin/market/listings`, `/batches`, `/templates`: management publishing,
  version-checked edits, resumable bulk imports and shared reusable templates.
- `/api/v1/community`: public display configuration; `/api/v1/admin/community`
  reads/updates it with version checks and an attachment-preserving history.
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

[SCHEMA.md](SCHEMA.md) defines the only canonical fields. Old aliases are accepted
only by the import normalizer. A complete CloudBase export is required; the
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
only their exact configured bucket/environment may resolve. Credentials, real
provider checks and mini-program/website DTO adaptation remain deployment gates.
Avatars still use the separate legacy profile path; this file module does not
yet authorize profile-avatar references. No storage deletion timer is enabled.
See `SCHEMA.md`.

The deployment Compose binds only `127.0.0.1:3101`; PostgreSQL has no host port.
Keep the current mini-program on CloudBase until missing feature compatibility,
backup/restore, complete import reconciliation, trusted login and capacity checks
pass. Preserve existing collector storage, credentials and CloudBase data.

Reads may temporarily use the explicitly isolated legacy fallback. Writes must
have one authoritative database; a timeout must never send the same booking to
an independent old writer. Retire fallback only after the next production app
release and observed healthy behavior, not merely after this service starts.
