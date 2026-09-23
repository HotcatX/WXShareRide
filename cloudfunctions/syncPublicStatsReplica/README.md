# Legacy public-stats timer wrapper

The canonical database read, normalization and HTTPS publication code now lives in `cloudfunctions/statistics/`. This function retains the existing `publicStatsHourly` Timer (minute 25) to avoid interrupting the deployed scheduler. It validates the genuine invocation context, derives a private relay HMAC key from the existing `sync.secret`, and calls only `statistics` with `action:legacyPublicStatsTimer`.

Keep the same private `sync.secret` in both deployments. No new secret is needed; neither file belongs in Git. The signature protocol and deployment order are in `../statistics/README.md`. A relay adds one cloud-function invocation per hourly run. It does not read the database itself. The timestamp limits replay to five minutes; this is not a durable nonce protocol.

Deploy/verify `statistics` first, including its actual platform timeout of 15 seconds; do not assume config.json changes that runtime setting. Then replace this wrapper while keeping this trigger. Do not also enable a second hourly trigger on statistics. Future transfer of the sole trigger and removal of this compatibility function requires a coordinated deployment.
