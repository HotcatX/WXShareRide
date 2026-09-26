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
- `/healthz`: readiness against the database; exposes no account/configuration.

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

Market content/date schemas and a private legacy-listing converter are available
for audit. They preserve original ownership, ordered images and historical expiry;
they do not yet provide market tables, routes or database import. File ownership,
admin authentication, permanent create deduplication and market analytics must be
integrated before that domain can move. See the market section of `SCHEMA.md`.

The deployment Compose binds only `127.0.0.1:3101`; PostgreSQL has no host port.
Keep the current mini-program on CloudBase until missing feature compatibility,
backup/restore, complete import reconciliation, trusted login and capacity checks
pass. Preserve existing collector storage, credentials and CloudBase data.

Reads may temporarily use the explicitly isolated legacy fallback. Writes must
have one authoritative database; a timeout must never send the same booking to
an independent old writer. Retire fallback only after the next production app
release and observed healthy behavior, not merely after this service starts.
