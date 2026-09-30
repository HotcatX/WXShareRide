# PostgreSQL backups

`backup.py` runs as root on the host. It uses the existing database container's
Unix socket (`linkx_admin`, database `linkx`) and does not need another password.
Each custom-format dump is compressed, fully read by `pg_restore` without
executing SQL, and atomically published under `/var/backups/linkx-backend`.
The directory is mode `0700` and files are `0600`. Overlapping runs skip safely.
Container-side `timeout` terminates the dump/validation process group before the
host command deadline, so a timed-out Docker client does not leave an orphan job.

The script requires free space of at least 512 MiB or twice the current database
size plus 256 MiB, whichever is larger. It retains a 256 MiB reserve after dumping.
Only successful publication permits rotation: regular files matching the exact
new `linkx-pg-v1-*.dump` naming format and older than seven days are removed.
Other backups, cutover recovery materials, directories and symlinks are untouched.
Capacity checks cannot reserve disk space against concurrent processes.

After deploying the source to `/opt/linkx-backend`, install explicitly:

```sh
sudo install -d -o root -g root -m 0700 /var/backups/linkx-backend
sudo docker exec linkx-backend-database-1 timeout --version
sudo install -m 0644 /opt/linkx-backend/ops/linkx-backend-backup.service /etc/systemd/system/
sudo install -m 0644 /opt/linkx-backend/ops/linkx-backend-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start linkx-backend-backup.service
sudo journalctl -u linkx-backend-backup.service --no-pager -n 10
# Verify the first archive and a restore to an isolated database before enabling.
sudo systemctl enable --now linkx-backend-backup.timer
```

The timer runs approximately every six hours, with five minutes of jitter, and
catches up after host downtime. These are local backups on the same server;
they do not protect against loss of that server/disk. Restoring over production
requires a separate stopped-writer procedure and must never undo newer writes.
`pg_restore --file=/dev/null` checks archive readability, not a full restore drill.

Run the failure/retention tests with
`python3 -m unittest discover -s services/backend/ops -p '*_test.py'` from the repo root.
