# Public statistics service

A zero-dependency Node service for the first, limited migration of `getPublicStats`. CloudBase remains the source of truth. An authenticated cloud timer sends a public snapshot every hour (target TTL: two hours); this service serves that snapshot without database credentials or outbound calls. It has no research payloads, personal records or business mutations. Timer deployment and rollout configuration live outside this directory.

## Public read

`GET /v1/public-stats` accepts no query string, body or alternate path. The old `/trial/v1/public-stats` path returns 404. Success is `{ok:true,...snapshot}`. Missing, invalid, oversized or expired snapshots return 503 `SNAPSHOT_UNAVAILABLE`; `PUBLIC_STATS_READ_ENABLED=false` returns 503 `PUBLIC_READ_DISABLED` so the mini-program can fall back to its existing CloudBase read. This switch does not stop authenticated sync. Every response is `Cache-Control: no-store`; the homepage retains its existing 24-hour application cache for both transports, and explicit refresh bypasses that cache.

```json
{
  "schemaVersion": 1,
  "source": "cloudbase-snapshot",
  "snapshotAt": 1790000000000,
  "expiresAt": 1790007200000,
  "revision": "<sha256 of JSON.stringify(data)>",
  "data": { "_id": "home", "servedTrips": 123, "coverageText": "NY / NJ" }
}
```

This is an illustrative example, not current data. Every field is required and extra fields at either level are rejected. `servedTrips` is a nonnegative safe integer or `null`; `coverageText` is at most 120 JavaScript code units with no control characters. Epoch timestamps are milliseconds. Expiry must follow snapshot time by at most six hours. Public reads reject snapshots more than 60 seconds in the future. Snapshot JSON is UTF-8 and at most 8192 bytes. Revision is lowercase SHA-256 of `JSON.stringify(data)`, preserving data property order. Never export the raw PublicStats document: it can contain internal trip identifiers and bookkeeping. Only the three public fields above may be synchronized.

## Authenticated cloud sync

`POST /internal/v1/public-stats/sync` is the only write route. It is intentionally reachable through the HTTPS proxy but always requires HMAC; its name alone is not access control. The body is the snapshot itself, without the public response's `ok` field. Content type is `application/json` (optional UTF-8 charset); compressed bodies are rejected. Queries, trailing slashes and encoded aliases return 404; wrong methods return 405.

Required headers, each exactly once:

- `x-linkx-timestamp`: positive decimal epoch milliseconds, within ±5 minutes at body completion.
- `x-linkx-signature`: 64 lowercase hexadecimal characters, computed as `HMAC-SHA256(secretBytes, timestamp + "\n" + rawBodyBytes)`.

`secretBytes` is the **32-byte decoded value** of the shared 64-character hexadecimal key, not the UTF-8 bytes of that hex text. Use the same raw UTF-8 body bytes for signing and transmission. Load the service's key from `PUBLIC_STATS_SYNC_KEY_FILE`, mounted read-only; never place it in the repository, image, URLs or mini-program bundle. The key is read once at startup; rotation requires updating both sender and receiver then restarting the service. With no key path configured, sync is disabled (503). A configured unreadable or malformed key fails startup.

The signed body must pass the complete public schema and hash check, be unexpired, and have `snapshotAt` within ±5 minutes. The existing stricter future limit of 60 seconds also applies, matching the mini-program reader. Sync runs hourly with a two-hour lifetime; clock skew should normally be much smaller than these bounds.

Updates compare the persisted generation even if it has expired. An older `snapshotAt` or equal time with differing data/revision/expiry returns 409 `SNAPSHOT_CONFLICT`. An identical generation within the freshness/auth window returns 200 `{ok:true,duplicate:true,snapshotAt,revision}` without replacing it. A newer generation returns 200 with `duplicate:false`. Incorrect signatures/timestamp headers return 401; invalid snapshots return 400; oversized bodies return 413. Signatures can be replayed within five minutes, but identical generations are idempotent and cannot roll state backward. A corrupt existing snapshot fails closed with 503 `SNAPSHOT_STATE_UNAVAILABLE` and needs operator repair; it is never silently overwritten as though there were no prior state.

The single Node process validates, compares and commits synchronously with no asynchronous gap: it writes a same-directory temporary file with mode 0600, fsyncs it, atomically renames it onto the snapshot, then fsyncs the directory. Readers see one complete generation. **Run one process/replica and one writer for this snapshot directory**; this file protocol is not a distributed compare-and-swap or multi-process lock. Stop the old process before starting its replacement; do not use rolling overlapping replicas. Do not manually replace the live file while sync is enabled. A crash may leave an unreferenced `.public-stats-*.tmp`; it cannot become public data and can be removed while the service is stopped. Never restore an older snapshot while the writer is active.

Logs contain only event name, response status, timestamp and startup enablement booleans, with no payload, source IP, paths, headers or secrets. The proxy must likewise avoid request body/header logging. Failed or expired public reads fall back on the client; sync failures do not mutate business data.

## Run and verify

```sh
node --test test/*.test.mjs
SNAPSHOT_PATH=./snapshot/snapshot.json \
PUBLIC_STATS_SYNC_KEY_FILE=/run/secrets/public-stats-sync-key \
PUBLIC_STATS_READ_ENABLED=true \
node src/main.mjs
```

Create the snapshot directory beforehand, owned by the service user. The key file contains 64 hex characters (an optional final newline is accepted); generate it on the destination through the deployment owner and keep it out of command output. No key or snapshot is embedded in the image. Native execution binds `127.0.0.1:3100`; Docker listens internally on `0.0.0.0:3100` as UID/GID 1000. Build this directory without npm install. Keep the container root filesystem read-only, mount only `/snapshot` writable, mount the key read-only, drop capabilities, set resource limits, and route only the two exact paths through Caddy. Do not mount the research collector database, keys or admin socket. The parent deployment owns Compose/Caddy and the hourly CloudBase timer.

Tests cover exact routes, shape/privacy projection, expiry/hash/size limits, signed raw bytes and timestamp bounds, stale/equal/conflicting generations, concurrent arrivals in one process, file permissions, disabled sync, public-read pause and corrupt existing state. They use only synthetic public values and ephemeral test secrets.

## Manual bootstrap or recovery

While sync is stopped, obtain one successful read-only `getPublicStats` response and save **only** its three public `result.data` fields. Generate immediately after acquisition; do not re-stamp old data as newly fetched. The optional generator accepts that exact data object from a filename or stdin:

```sh
SNAPSHOT_TTL_MS=7200000 node scripts/create-snapshot.mjs public-data.json > snapshot.next.json
chmod 600 snapshot.next.json
mv snapshot.next.json snapshot/snapshot.json
```

The manual generator defaults to one hour and allows a positive lifetime up to six hours. It writes only stdout; the service itself performs authenticated atomic synchronization. These statistics are hourly snapshots, not real-time results. Preserving the existing 24-hour homepage cache limits extra network calls; actual CloudBase savings depend on cache misses and the rollout share and must be measured rather than inferred from total account billing calls.
