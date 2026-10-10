# OneDrive backup uploads

This independent host job uploads already published collector `.sqlite.gz` and
PostgreSQL `.dump` snapshots. It does not create database snapshots or modify the
database contents. The collector backup runs daily at 03:30 and PostgreSQL at
03:35 America/New_York; this upload job runs daily at 04:15, with two minutes of
jitter. The schedules follow New York daylight saving time. Files keep normal
names and are not additionally encrypted,
as requested. Destinations are `onedrive:database/collector` and
`onedrive:database/postgres`; each snapshot has a JSON manifest with its creation
time, byte count and SHA-256.

Producer names remain unchanged and use sortable UTC timestamps (`Z`):
`collector-YYYY-MM-DDTHH-MM-SS.sssZ.sqlite.gz` and
`linkx-pg-v1-YYYYMMDDTHHMMSSffffffZ-<12 lowercase hex>.dump`.
The manifest keeps that exact filename and its UTC creation time; no source
archive is renamed.

Use the official rclone binary at `/usr/local/bin/rclone` and its only configuration
at `/etc/linkx-backup/rclone.conf`. The configuration directory must be root-owned
0700 and the file root-owned 0600. The `onedrive` remote must have `type=onedrive`,
`drive_type=personal`, a nonempty OAuth `token`, and
`access_scopes=Files.ReadWrite offline_access`. Omit `disable_site_permission` or
set it to false; true overrides those scopes. `hard_delete` must also be false or
omitted. OAuth refresh can atomically rewrite
the configuration in its writable private directory. No application environment
variables or crypt remote are required.

Install the Python script in `/opt/linkx-backend/ops/upload_backups.py` and the
service/timer in `/etc/systemd/system`. Prepare private directories and stage
snapshots without any upload or deletion. Once OAuth is ready, run the service
once and confirm successful upload/check results before enabling its timer:

```sh
sudo install -d -m 0700 /etc/linkx-backup /var/backups/linkx-backup-upload
sudo python3 /opt/linkx-backend/ops/upload_backups.py --stage
sudo systemctl daemon-reload
sudo systemctl start linkx-backup-upload.service
sudo journalctl -u linkx-backup-upload.service -n 20 --no-pager
# Confirm status=ok, uploaded=2 and failed=0 before enabling the timer.
sudo systemctl enable --now linkx-backup-upload.timer
```

The first stage records a durable startup timestamp and selects only the latest
snapshot from each database. Subsequent runs select snapshots created at or after
that timestamp, plus either initially selected snapshot. Historical development
archives are not uploaded or deleted. Pending snapshots under
`/var/backups/linkx-backup-upload/pending` use hard links where available. When
separate sandbox mounts prevent hard linking (`EXDEV`), staging copies in bounded
chunks, checks that the source did not change, preserves its private permissions
and owner, then fsyncs and atomically publishes the copy. An original file's
removal cannot remove its pending copy. The systemd writable paths stay restricted
to the existing backup and configuration directories.
Staging briefly takes each producer's existing lock; network work only holds the
independent upload lock. An overlapping upload run exits without doing work.

The daily job transfers at most three packages: each database's newest pending
snapshot, followed by the oldest remaining package, so a failed day's backlog can
catch up. It uses one transfer, one checker,
an 8 MiB buffer and a 1 MiB/s limit. Each copy or check has a 15-minute process
deadline; the service has a 95-minute total deadline. `copy --immutable` never
overwrites a conflicting same-name cloud file. `check --download --one-way`
compares the downloaded contents, and the script checks the local payload's
SHA-256 again before atomically recording success. Only then are pending files
removed. Failures retain the package, suppress local retention cleanup for that
run, and report only the phase, exception type and rclone exit code. Local staging
failures also report the numeric OS error code, without file contents or credentials.

Retention runs only after uploads succeed and no pending packages remain. Both
databases' latest snapshots must be within 30 hours, match their local verified
SHA-256 records, and have matching cloud payload sizes and JSON manifests. Missing,
stale or changed files defer all cleanup. The latest snapshot of each database is
always retained.

Cloud cleanup removes only verified snapshots owned by this job and older than
seven days, including the initially selected snapshots. It uses exact `deletefile`
paths in the two dedicated folders, with `--onedrive-hard-delete=false`; unrelated
files are ignored. Payloads are removed before their JSON manifests, and an
interrupted pair can be safely completed on a later run. Any deletion failure
prevents local cleanup. Removed cloud files go to OneDrive's recycle bin; this job
never empties it. Recycle-bin files still count toward Microsoft storage until
they expire, so seven-day folder retention is not a seven-day quota bound.

Successful retention runs may remove original snapshots older than seven days only when
they were created after this job's startup timestamp and have a matching verified
manifest. Existing producer retention still applies to files that never
entered the queue, including when the upload service is stopped for over seven
days. These two databases have separate snapshot times, not one shared transaction.

Inspect `systemctl status linkx-backup-upload.timer` and
`journalctl -u linkx-backup-upload.service` for run counts or failure phases.
Pending directories indicate a backlog; verified manifests retain SHA-256 evidence.
`retention=complete` confirms both cleanup gates passed; `cloudRemoved` counts
completed archive/manifest deletions. `retention=deferred` preserves local backups.
Run `--stage` to inspect queue counts without OAuth or network access.

Downloaded `.sqlite.gz` files must be decompressed and inspected/restored with
SQLite tools; `.dump` files require PostgreSQL `pg_restore`. They are database
archives, not browser-readable reports. Restore into an isolated candidate first,
following the collector recovery gate and the existing PostgreSQL restore process.
Never overwrite a running production database with a downloaded archive.

Verification: `python3 -m unittest discover -s services/backend/ops -p '*_test.py'`.
