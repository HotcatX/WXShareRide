# Analytics naming migration

This procedure updates only the analytics collector. CloudBase remains the business writer; the PostgreSQL backend stays staged. A short collector outage is acceptable, but do not stop or recreate the business backend, database, public statistics pilot, Caddy, or the whole Compose project.

## Invariants

- Keep the Compose project `linkx-collector`, `/var/lib/linkx-collector/collector.sqlite`, its mounts, signing key, admin token, account HMAC keys and all participant/grant/event IDs.
- Schema version 5 renames the existing account, participant, account-operation and place-membership tables/indexes. Stored purpose/notice strings, blocked-notice settings, operation hashes, raw batches and receipts are preserved. Protocol normalization handles supported old values at the boundary.
- `/internal/v1/analytics/accounts` is the normal account bridge. The old bridge path stays as one explicitly marked compatibility alias while deployed callers still use it. Never generate a second identity by changing the existing HMAC account scope.
- Operations use `/etc/linkx-analytics-ops`. Existing identity and bridge key bytes are copied unchanged; the directory stays root-owned 0700, files root-owned 0600. The collector's separate `/etc/linkx-collector/bridge.key` mount and ownership do not change.
- Compose uses `ANALYTICS_BRIDGE_KEY_FILE` and `ANALYTICS_NOTICE_VERSION`. The application alone accepts old environment variable names during transition; do not maintain duplicate environment values.

## Prepare without changing live service

1. Record container image IDs, restart counts, mounts, current health, the effective Caddy routes, collector environment **key names and non-secret settings only**, and the installed maintenance timer. Keep private deployment evidence outside Git. Save the current source/image/configuration for rollback.
2. Use `scripts/backup.mjs` in the running collector for an online SQLite backup into a new private destination. It uses SQLite's backup API, checks integrity and writes 0600. Never copy only a live `.sqlite` file and discard its WAL. Record the backup SHA-256 without printing account data.
3. Build the replacement image under a new pinned tag. Run its tests. Copy the backup into a separate private rehearsal directory and run the new schema migration on that copy, without any public listener, real credentials or network.
4. Compare the same rehearsal snapshot before and after migration in a read transaction. Require `integrity_check=ok`, no foreign-key violations, no duplicate old/new account tables, schema 4→5, equal logical-table row counts, and equal SHA-256 digests of every table's sorted rows. Also compare account/OpenID link counts and real/test active/revoked counts. Only table/index names and schema version may differ; raw values and identities must not.
5. Verify both current and old supported account-bridge requests, token validation, retry receipts, withdrawal and local diagnostic/stop helpers with synthetic data. Do not run a withdrawal test against a real account.
6. Prepare the operations directory using the same key bytes, not key generation. If a destination file exists, compare it privately and fail on a mismatch instead of overwriting it. Check each source/destination is a regular non-symlink file with the expected owner/mode; verify equality with `cmp -s`. Do not print either key or hashes of keys. Remove the old operations directory only after the new helpers and rollback plan are verified.

## Collector-only deployment

1. Save the current environment file privately. Replace its old bridge-key variable name with `ANALYTICS_BRIDGE_KEY_FILE` using the same path value. Set `ANALYTICS_NOTICE_VERSION=ride-analytics-notice-2026-09-23`. Preserve real-collection enablement, database path and every unrelated setting. Do not rotate credentials as part of a naming change.
2. Pause only the collector backup timer if it would race this operation. Stop **only** the `collector` service. Confirm its process is stopped; Caddy, statistics pilot and business services must remain running. Create a final consistent backup of the stopped database and audit it. This is the authoritative rollback snapshot for this collector upgrade.
3. Run the verified migration against the existing database with the new image while its listener is still stopped. Audit it against the final pre-migration snapshot, requiring the full equality checks above. Abort before starting the listener if any check fails.
4. Start only `collector`, using `docker compose ... up -d --no-deps collector`. Confirm its image ID, schema version, private database mode, health, local management access and no startup errors. Keep an old-client compatibility bridge while updating cloud callers.
5. Validate and reload Caddy with the reviewed **effective live configuration plus the new bridge route**. Retain every business, auth/compat, image upload, place, batch, public-statistics and statistics-sync route and body-size limit. Do not reload an old mounted file merely because it is named `/etc/caddy/Caddyfile`.
6. Update the authenticated cloud bridge only after the collector accepts both protocols; verify it still targets the same account state. Check normal and old alias routes with unauthenticated probes, which must reject access and create no accounts. Verify public statistics still responds and business routes remain staged. Restart counts for unrelated containers must not change.
7. Resume the existing collector backup timer. Confirm the next maintenance schedule and an online backup with the new image. Remove only rehearsal copies and disposable synthetic data whose identities are recorded; do not delete historical production data.

### Existing Caddy binding

The September 29 read-only inspection found that the running Caddy uses `/tmp/linkx-staged-https.Caddyfile`, while its bind-mounted `/etc/caddy/Caddyfile` still references an older inode. The repository Caddyfile matches that effective live configuration before this change. Verify this again at deployment. For this collector update, validate a new temporary configuration and reload the existing Caddy process; keep the host configuration in sync without recreating unrelated services. The business cutover procedure owns the later bind-mount repair.

## Rollback boundaries

Before the new collector accepts any write, stop it and restore the final consistent pre-migration snapshot with its matching old image/environment. Preserve the failed state for diagnosis. Do not overwrite a database while a process has it open.

After the new collector accepts events, grants, withdrawals or account changes, the old snapshot is stale. Restoring it would discard data and could re-enable withdrawn state. Prefer a forward fix. A return to the older schema requires a reviewed reverse naming migration of the **current** stopped database, verified by the same full-table equality checks, plus a matching protocol-compatible image. Never point the old image at schema 5 or simply replace the database with a pre-upgrade backup.

This naming migration does not perform the CloudBase→PostgreSQL business cutover and does not change its scheduled maintenance window.
