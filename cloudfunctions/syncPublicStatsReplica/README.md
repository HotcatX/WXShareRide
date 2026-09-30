# Retired public-stats timer wrapper

**TEMPORARY FALLBACK — recovery reference only. Do not deploy or schedule this function.** Its hourly timer was removed during the 2026-09-30 cutover, and its deployed entry is a maintenance barrier. `config.json` intentionally has no triggers. Current public statistics come from PostgreSQL; installed clients retain the `statistics/publicStats` compatibility read to that same database.

The source here records the old trusted Timer validation and signed `legacyPublicStatsTimer` relay for recovery review and existing contract tests. Its original private key stays in protected recovery material, never Git. The retained protocol is documented in [statistics](../statistics/README.md); it does not authorize resuming CloudBase publication.

See [deployment boundaries](../DEPLOYMENT.md) and the [completed cutover](../../docs/backend-cutover-2026-09-30.md). Once PostgreSQL has accepted writes, restoring this old schedule is not a valid rollback.
