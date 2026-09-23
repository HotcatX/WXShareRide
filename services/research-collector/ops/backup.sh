#!/bin/sh
set -eu
umask 077
exec 9>/run/linkx-collector-backup.lock
flock -n 9 || exit 0
cd /opt/linkx-collector
# Keep the seven-day backup limit even if today's new backup later fails.
docker compose --env-file /etc/linkx-collector/compose.env exec -T collector node scripts/rotate-backups.mjs
docker compose --env-file /etc/linkx-collector/compose.env exec -T collector node scripts/prune.mjs
docker compose --env-file /etc/linkx-collector/compose.env exec -T collector node scripts/backup.mjs
