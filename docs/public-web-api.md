# Cloudflare public website read API

> Historical CloudBase implementation record. Since the [2026-09-30 cutover](backend-cutover-2026-09-30.md), the supported old public HTTP URL relays to the same PostgreSQL backend; it does not read the frozen CloudBase database. The old implementation and its dedicated tests have been retired locally. Do not run their old deployment or test commands. Current deployment boundaries are in [cloudfunctions/DEPLOYMENT.md](../cloudfunctions/DEPLOYMENT.md). Protocol details and observations below describe the historical implementation, not current deployment instructions or a new website/admin verification.

The Tencent-hosted homepage, `/admin/` website and `/admin-api` authentication remain separate. The independent English Cloudflare site uses the existing HTTP prefix mapping to the `marketApi` cloud function: the external URL ends in `/admin-api/public-api`, and CloudBase forwards that suffix as the internal event path `/public-api`. No new HTTP binding, cloud function or database collection is needed. The nested URL is a separate authenticated read handler; it is not an admin operation.

## Trust boundary

- The browser calls its own Cloudflare origin using GET. The Worker permits only the four read operations below, caches public responses and applies rate limits.
- Only the Worker and cloud function runtime know `PUBLIC_WEB_API_SECRET`. The Worker sends `Authorization: Bearer <secret>` to CloudBase over HTTPS. The same randomly generated 32–128 character base64url/hex secret is stored in the cloud function environment, or in the optional private deployment file described below when only Developer Tools deployment access is available. It must not appear in browser assets, Git, logs or public configuration.
- CloudBase requires the exact `/public-api` path, POST, JSON, the server credential and a strict input allowlist. Missing or malformed secrets fail closed. Credentials are compared using fixed-size SHA-256 digests and `timingSafeEqual`.
- This path invokes only `publicPreview`. It cannot delegate to ordinary mini-program actions or any admin operation. Extra keys, identity lookups, arbitrary collections/queries, writes and caller-provided image URLs/file IDs are rejected.
- `/admin-api` keeps its existing origin, session, ownership and CSRF checks. A public-site credential is not an admin session. The public route sends no browser CORS authorization.
- The existing anonymous mini-program `publicPreview` behavior is preserved. Private mini-program actions still require the trusted WeChat OPENID.

## CloudBase request contract

```http
POST /admin-api/public-api
Content-Type: application/json
Authorization: Bearer <server-only secret>
```

```json
{"operation":"tripList","kind":"all","limit":20,"offset":0,"cityKey":"ny_nj","locale":"en"}
```

| Operation | Kind | Other accepted fields |
| --- | --- | --- |
| `tripList` | `carpool`, `request`, `all` (default) | `limit`, `offset`, `cityKey`, `locale` |
| `marketList` | `goods` (default), `sublet`, `all` | `limit`, `offset`, `cityKey`, `locale` |
| `tripDetail` | Required: `carpool` or `request` | Required `id`; optional `locale` |
| `marketDetail` | Required: `goods` or `sublet` | Required `id`; optional `locale` |

`limit` is an integer from 1 through 20 (default 20). `offset` is an integer from 0 through 80 (default 0). Use pages of 20 to access the bounded 100-item result window; `hasMore` is false when the next offset would exceed the window. `cityKey` must be one of the application's fixed public city keys or `all`. IDs contain only ASCII letters, digits, `_` and `-`, up to 128 characters. `locale` can be omitted or `en` only.

Lists return `{ok:true,items:[...],hasMore,nextOffset}`. Details return `{ok:true,item:{...}}`. No total-count query is performed. Each list scan is capped at 150 source rows per requested collection, with at most 100 projected results available. Sold/offline/expired/deleted market listings and cancelled/ended/past trips are excluded from both lists and details.

Items expose only `id`, `kind`, `title`, `description`, `priceText`, `regionText`, `timeText`, `availabilityText`, `images` and `tags`. English trip items additionally expose `fromLabel`, `toLabel`, `dateKey`, `departureAtMs`, `seats` and `full`. Routes use fixed public area labels, never raw pickup addresses. Display times use America/New_York. Date/seat availability is informational; joining and availability checks happen in the mini-program.

The current mini-program saves fares in top-level `referencePrice` (for example `10$/人`), with older `price`/`displayPrice` fields used only when preferred fields are blank. Zero fares and strict numeric fare ranges are preserved; arbitrary fare prose is never copied into the DTO. `full` means a full driver vehicle only. A passenger request that reached its group size limit still displays the number of seats wanted.

Known category labels and interface text are English. User-authored market titles/descriptions remain in their original language; no machine translation request is made. Known contacts, addresses, identifiers, URLs and common contact patterns are redacted from those text fields. Photos are intentionally public listing content and may contain information their publisher included in the image; the reader does not claim to perform image-content redaction.

Images must already be referenced by a visible market listing. Only current-environment `market/`, `market_thumb/` and the exact admin-generated `web-admin/<account>/<32-hex>.(jpg|jpeg|png|webp)` paths are resolved. Community images, arbitrary storage paths, foreign environments and arbitrary HTTP URLs cannot be requested through this API.

Error responses contain only `{ok:false,error}` and no raw database errors. Relevant HTTP statuses are 400 (invalid input), 401 (missing/wrong credential), 404 (missing/hidden/kind-mismatched item), 405 (method), 415 (content type), and 503 (unconfigured/unavailable service).

## Historical deployment and verification

The old package combined `index.js`, `publicPreview.js` and `publicWeb.js`; these are not the current deployment set. Restoring that package would restore the retired CloudBase implementation and is prohibited after the PostgreSQL cutover. The supported `marketApi` entry now loads only `publicRelay.js`.

The retired implementation supported `PUBLIC_WEB_API_SECRET` in its environment or a private `publicWeb.secret.json` fallback. This documents the old secret format only, not an instruction to recreate or deploy it. Existing backups containing credentials remain private; they must not enter Git, browser assets or logs.

Historically the private file was read only when the environment key was absent; malformed configuration failed closed. Those loader details are not the current relay's configuration contract. Use the current deployment record rather than restoring an old credential or implementation from a source backup.

The external upstream URL is `https://cloud1-7gmtcu4s3aebce27-1383643768.ap-shanghai.app.tcloudbase.com/admin-api/public-api`. CloudBase's existing `/admin-api` prefix mapping strips the prefix, so the handler must continue validating internal `/public-api` exactly. Direct `/public-api` on that hostname is not the configured binding. Do not broaden the internal path match to the admin root or allow actions to select a handler.

The old `public-web-api`, `public-preview` and `web-admin` test files were dedicated to the retired handler and have been removed; their old commands must not be run. Current compatibility coverage lives in `tests/cloud-public-relay.test.cjs`, `services/backend/test/legacy-public-relay.test.ts` and `services/backend/test/legacy-public-preview.integration.test.ts`. Canonical PostgreSQL admin, market and image tests cover the corresponding authorization and business behavior. These references describe retained tests, not a claim of new live website or administrator verification.
