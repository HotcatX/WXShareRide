#!/usr/bin/env python3
"""Consistent, compressed PostgreSQL backup through the existing local container."""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import uuid

BACKUP_DIR = Path('/var/backups/linkx-backend')
DOCKER = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', 'exec']
CONTAINER = 'linkx-backend-database-1'
CONNECTION = ['--host=/var/run/postgresql', '--username=linkx_admin', '--dbname=linkx', '--no-password']
MIN_FREE_BYTES = 512 * 1024 * 1024
RESERVE_BYTES = 256 * 1024 * 1024
BACKUP_NAME = re.compile(r'linkx-pg-v1-\d{8}T\d{12}Z-[a-f0-9]{12}\.dump\Z')


def docker(arguments, *, source=None, target=subprocess.PIPE, timeout=900):
    # Killing the Docker client alone can leave the container-side read running.
    # Its own process-group deadline expires first, while this host still holds
    # the overlap lock; the outer deadline leaves time for termination/drain.
    command = DOCKER + (['-i'] if source is not None else []) + [CONTAINER,
        'timeout', '--signal=TERM', '--kill-after=5s', f'{max(1, timeout - 15)}s'] + arguments
    return subprocess.run(command, stdin=source or subprocess.DEVNULL, stdout=target,
                          stderr=subprocess.PIPE, timeout=timeout, check=True)


def run_backup():
    os.umask(0o077)
    BACKUP_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = BACKUP_DIR.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
        raise RuntimeError('UNSAFE_BACKUP_DIRECTORY')
    BACKUP_DIR.chmod(0o700)
    lock = os.open(BACKUP_DIR / '.linkx-pg-backup.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    temporary = None
    try:
        os.fchmod(lock, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'status': 'already-running'}
        size = int(docker(['psql', *CONNECTION, '-X', '-A', '-t', '-c',
                          'SELECT pg_database_size(current_database())'], timeout=30).stdout.strip())
        if size <= 0 or shutil.disk_usage(BACKUP_DIR).free < max(MIN_FREE_BYTES, size * 2 + RESERVE_BYTES):
            raise RuntimeError('INSUFFICIENT_BACKUP_SPACE')
        fd, name = tempfile.mkstemp(prefix='.linkx-pg-v1-', suffix='.pending', dir=BACKUP_DIR)
        temporary = Path(name)
        with os.fdopen(fd, 'wb') as output:
            # pg_dump owns one consistent transaction snapshot; normal writes continue.
            docker(['pg_dump', *CONNECTION, '--format=custom', '--compress=6'], target=output)
            output.flush()
            os.fsync(output.fileno())
        # The subprocess inherits the raw descriptor. Buffered read-ahead while
        # checking the header would otherwise leave that descriptor mid-file.
        with temporary.open('rb', buffering=0) as source:
            if source.read(5) != b'PGDMP':
                raise RuntimeError('INVALID_BACKUP_ARCHIVE')
            source.seek(0)
            # Read/decompress the entire archive, not merely its table of contents.
            # No database connection or SQL execution occurs in this validation.
            docker(['pg_restore', '--exit-on-error', '--file=/dev/null'], source=source, target=subprocess.DEVNULL)
        if shutil.disk_usage(BACKUP_DIR).free < RESERVE_BYTES:
            raise RuntimeError('INSUFFICIENT_REMAINING_SPACE')
        checksum = hashlib.sha256()
        with temporary.open('rb') as source:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                checksum.update(block)
        digest = checksum.hexdigest()
        now = datetime.datetime.now(datetime.timezone.utc)
        final = BACKUP_DIR / f'linkx-pg-v1-{now:%Y%m%dT%H%M%S%fZ}-{uuid.uuid4().hex[:12]}.dump'
        # Same-filesystem hard-link publication is atomic and refuses replacement.
        # A failed backup can never overwrite a previous good archive.
        os.link(temporary, final)
        temporary.unlink()
        temporary = None
        directory = os.open(BACKUP_DIR, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
            removed = 0
            rotation_errors = 0
            cutoff = now.timestamp() - 7 * 86400
            for old in BACKUP_DIR.iterdir():
                if not BACKUP_NAME.fullmatch(old.name) or old == final:
                    continue
                details = old.lstat()
                if stat.S_ISREG(details.st_mode) and details.st_uid == os.geteuid() and details.st_mtime < cutoff:
                    try:
                        old.unlink()
                        removed += 1
                    except OSError:
                        rotation_errors += 1
            os.fsync(directory)
        finally:
            os.close(directory)
        return {'status': 'ok' if not rotation_errors else 'rotation-failed', 'path': str(final),
                'bytes': final.stat().st_size, 'sha256': digest, 'removed': removed, 'rotationErrors': rotation_errors}
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        os.close(lock)


if __name__ == '__main__':
    try:
        if os.geteuid() != 0:
            raise RuntimeError('ROOT_REQUIRED')
        result = run_backup()
        print(json.dumps(result), flush=True)
        raise SystemExit(1 if result['status'] == 'rotation-failed' else 0)
    except Exception as error:
        # Do not print command output, environment, credentials, or data records.
        code = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(json.dumps({'status': 'failed', 'code': code}), flush=True)
        raise SystemExit(1)
