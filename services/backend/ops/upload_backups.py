#!/usr/bin/env python3
"""Upload verified daily snapshots and retain seven days of owned OneDrive backups."""
import argparse
import configparser
import datetime
import errno
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time

STATE_DIR = Path('/var/backups/linkx-backup-upload')
CONFIG = Path('/etc/linkx-backup/rclone.conf')
RCLONE = '/usr/local/bin/rclone'
SOURCES = {
    'collector': (Path('/var/backups/linkx-collector'), Path('/run/linkx-collector-backup.lock'),
                  re.compile(r'collector-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)\.sqlite\.gz\Z')),
    'postgres': (Path('/var/backups/linkx-backend'), Path('/var/backups/linkx-backend/.linkx-pg-backup.lock'),
                 re.compile(r'linkx-pg-v1-(\d{8}T\d{12}Z)-[a-f0-9]{12}\.dump\Z')),
}


def created_at(kind, name):
    match = SOURCES[kind][2].fullmatch(name)
    if not match:
        return None
    format = '%Y-%m-%dT%H-%M-%S.%fZ' if kind == 'collector' else '%Y%m%dT%H%M%S%fZ'
    try:
        return datetime.datetime.strptime(match[1], format).replace(tzinfo=datetime.timezone.utc).timestamp()
    except ValueError:
        return None


def directory(path, *, create=False, source=False):
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    # Collector publishes as its existing container UID 1000; PG/state are root.
    owners = {os.geteuid(), 1000} if source else {os.geteuid()}
    if not stat.S_ISDIR(info.st_mode) or info.st_uid not in owners or info.st_mode & 0o077:
        raise RuntimeError('UNSAFE_DIRECTORY')
    if create:
        sync_directory(path.parent)
    return info.st_uid


def regular(path, owner):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_mode & 0o077:
        raise RuntimeError('UNSAFE_FILE')
    return info


def digest(path, owner):
    info = regular(path, owner)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            raise RuntimeError('CHANGED_FILE')
        checksum = hashlib.sha256()
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                checksum.update(block)
        after = os.fstat(descriptor)
        if (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise RuntimeError('CHANGED_FILE')
        return opened.st_size, checksum.hexdigest()
    finally:
        os.close(descriptor)


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def save(path, value):
    # A killed writer must not leave a partial JSON file inside an upload package.
    descriptor, temporary = tempfile.mkstemp(prefix='.manifest-', dir=STATE_DIR)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(value, stream, sort_keys=True)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def load(path):
    regular(path, os.geteuid())
    with path.open() as stream:
        return json.load(stream)


def lock(path, *, wait=False):
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise RuntimeError('UNSAFE_LOCK')
        deadline = time.monotonic() + (5 if wait else 0)
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return descriptor
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    os.close(descriptor)
                    return None
                time.sleep(0.05)
    except Exception:
        os.close(descriptor)
        raise


def snapshots(kind):
    root = SOURCES[kind][0]
    owner = directory(root, source=True)
    result = []
    for path in root.iterdir():
        stamp = created_at(kind, path.name)
        if stamp is None:
            continue
        try:
            regular(path, owner)
        except RuntimeError:
            continue
        result.append((stamp, path))
    return sorted(result, key=lambda row: (row[0], row[1].name))


def eligible(state, kind, name):
    stamp = created_at(kind, name)
    return stamp is not None and (stamp >= state['startedAt'] or state['initial'].get(kind) == name)


def verification(kind, name):
    record = load(STATE_DIR / 'verified' / kind / (name + '.json'))
    if (not isinstance(record, dict) or record.get('version') != 1 or record.get('kind') != kind
            or record.get('name') != name or record.get('createdAt') != created_at(kind, name)
            or type(record.get('bytes')) is not int or record['bytes'] < 0
            or not isinstance(record.get('sha256'), str) or not re.fullmatch('[a-f0-9]{64}', record['sha256'])
            or type(record.get('verifiedAt')) not in (int, float) or not math.isfinite(record['verifiedAt']) or record['verifiedAt'] <= 0):
        raise RuntimeError('INVALID_VERIFICATION')
    return record


def stage(kind, path):
    package = STATE_DIR / 'pending' / kind / path.name
    directory(package, create=True)
    sync_directory(package.parent)
    owner = directory(SOURCES[kind][0], source=True)
    payload = package / path.name
    if not payload.exists():
        original = regular(path, owner)
        try:
            os.link(path, payload, follow_symlinks=False)
        except OSError as error:
            if error.errno != errno.EXDEV:
                raise
            # The systemd sandbox mounts source and queue paths separately.
            source = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                before = os.fstat(source)
                fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
                if any(getattr(before, field) != getattr(original, field) for field in fields):
                    raise RuntimeError('CHANGED_FILE')
                descriptor, temporary = tempfile.mkstemp(prefix='.payload-', dir=STATE_DIR)
                try:
                    with os.fdopen(descriptor, 'wb') as stream:
                        for block in iter(lambda: os.read(source, 1024 * 1024), b''):
                            stream.write(block)
                        after = os.fstat(source)
                        if (stream.tell() != before.st_size
                                or any(getattr(before, field) != getattr(after, field) for field in fields)):
                            raise RuntimeError('CHANGED_FILE')
                        stream.flush()
                        if os.fstat(stream.fileno()).st_uid != owner:
                            os.fchown(stream.fileno(), owner, -1)
                        os.fsync(stream.fileno())
                    os.replace(temporary, payload)
                finally:
                    Path(temporary).unlink(missing_ok=True)
            finally:
                os.close(source)
        else:
            copied = regular(payload, owner)
            if (copied.st_dev, copied.st_ino) != (original.st_dev, original.st_ino):
                raise RuntimeError('CHANGED_FILE')
        sync_directory(package)
    size, checksum = digest(payload, owner)
    manifest = {'version': 1, 'kind': kind, 'name': path.name, 'createdAt': created_at(kind, path.name),
                'bytes': size, 'sha256': checksum}
    record = package / (path.name + '.json')
    if record.exists():
        if load(record) != manifest:
            raise RuntimeError('CHANGED_PACKAGE')
    else:
        save(record, manifest)
    if {item.name for item in package.iterdir()} != {path.name, path.name + '.json'}:
        raise RuntimeError('UNEXPECTED_PACKAGE_FILE')
    return manifest


def discard(package, manifest):
    for name in [manifest['name'], manifest['name'] + '.json']:
        (package / name).unlink(missing_ok=True)
    package.rmdir()
    sync_directory(package.parent)


def pending(state, *, stage_only=False):
    result = []
    for kind in SOURCES:
        root = STATE_DIR / 'pending' / kind
        for package in root.iterdir():
            if not eligible(state, kind, package.name):
                continue
            directory(package)
            verified = STATE_DIR / 'verified' / kind / (package.name + '.json')
            if verified.exists():
                manifest = verification(kind, package.name)
                owner = directory(SOURCES[kind][0], source=True)
                payload = package / package.name
                if payload.exists() and digest(payload, owner) != (manifest['bytes'], manifest['sha256']):
                    raise RuntimeError('CHANGED_VERIFIED_FILE')
                # Resume removal if a process died after durable verification.
                if not stage_only:
                    discard(package, manifest)
                continue
            # Repair a crash between the durable hard link and manifest publish.
            manifest = stage(kind, SOURCES[kind][0] / package.name)
            result.append((manifest['createdAt'], kind, package, manifest))
    return sorted(result, key=lambda row: (row[0], row[2].name), reverse=True)


def rclone_call(command, *paths, extra=(), timeout=900):
    flags = ['--config', str(CONFIG), '--bwlimit', '1M', '--transfers', '1', '--checkers', '1',
             '--buffer-size', '8M', '--retries', '2', '--low-level-retries', '3',
             '--contimeout', '30s', '--timeout', '2m', '--stats', '0', '--log-level', 'ERROR']
    return subprocess.run([RCLONE, command, *map(str, paths), *flags, *extra],
                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          timeout=timeout, check=True,
                          env={key: value for key, value in os.environ.items() if not key.startswith('RCLONE_')})


def rclone(command, package, kind):
    flags = []
    if command == 'copy':
        flags += ['--immutable']  # A same-name conflict never overwrites cloud history.
    else:
        flags += ['--download', '--one-way']
    rclone_call(command, package, 'onedrive:database/' + kind, extra=flags)


def remote_files(kind):
    output = rclone_call('lsjson', 'onedrive:database/' + kind, extra=['--files-only'], timeout=120).stdout
    if len(output) > 4 * 1024 * 1024:
        raise RuntimeError('REMOTE_LIST_TOO_LARGE')
    rows = json.loads(output)
    if not isinstance(rows, list):
        raise RuntimeError('INVALID_REMOTE_LIST')
    files = {}
    for row in rows:
        if (not isinstance(row, dict) or row.get('IsDir') is not False
                or row.get('Path') != row.get('Name') or not isinstance(row.get('Name'), str)
                or '/' in row['Name'] or type(row.get('Size')) is not int or row['Size'] < 0):
            raise RuntimeError('INVALID_REMOTE_LIST')
        if row['Name'] in files:
            raise RuntimeError('DUPLICATE_REMOTE_FILE')
        files[row['Name']] = row['Size']
    return files


def remote_manifest(kind, record, files):
    name = record['name'] + '.json'
    if name not in files or not 0 < files[name] <= 4096:
        return False
    output = rclone_call('cat', 'onedrive:database/' + kind + '/' + name, timeout=120).stdout
    if len(output) != files[name] or len(output) > 4096:
        return False
    expected = {key: record[key] for key in ['version', 'kind', 'name', 'createdAt', 'bytes', 'sha256']}
    try:
        return json.loads(output) == expected
    except (ValueError, UnicodeDecodeError):
        return False


def cleanup_cloud(state):
    latest, listings = {}, {}
    now = time.time()
    for kind in SOURCES:
        files = snapshots(kind)
        if not files or not now - 30 * 3600 <= files[-1][0] <= now:
            return None
        _, path = files[-1]
        if not (STATE_DIR / 'verified' / kind / (path.name + '.json')).exists():
            return None
        record = verification(kind, path.name)
        owner = directory(SOURCES[kind][0], source=True)
        if digest(path, owner) != (record['bytes'], record['sha256']):
            raise RuntimeError('CHANGED_VERIFIED_FILE')
        latest[kind] = record
    for kind, record in latest.items():
        listings[kind] = remote_files(kind)
        if (listings[kind].get(record['name']) != record['bytes']
                or not remote_manifest(kind, record, listings[kind])):
            return None
    removals = []
    for kind in SOURCES:
        files = listings[kind]
        for marker in sorted((STATE_DIR / 'verified' / kind).iterdir()):
            if not marker.name.endswith('.json'):
                continue
            name = marker.name[:-5]
            stamp = created_at(kind, name)
            if (stamp is None or not eligible(state, kind, name) or stamp >= now - 7 * 86400
                    or name == latest[kind]['name']):
                continue
            record = verification(kind, name)
            if name not in files and name + '.json' not in files:
                continue
            if ((name in files and files[name] != record['bytes'])
                    or not remote_manifest(kind, record, files)):
                raise RuntimeError('CHANGED_REMOTE_BACKUP')
            # Payload first permits a retry to finish an interrupted pair via its matching sidecar.
            for file in [name, name + '.json']:
                if file not in files:
                    continue
                removals.append('onedrive:database/' + kind + '/' + file)
    for file in removals:
        rclone_call('deletefile', file, extra=['--onedrive-hard-delete=false'], timeout=120)
    return len(removals)


class UploadFailure(Exception):
    def __init__(self, phase, error):
        self.phase, self.code = phase, type(error).__name__
        self.exit_code = error.returncode if isinstance(error, subprocess.CalledProcessError) else None


def checked(phase, operation, *args):
    try:
        return operation(*args)
    except Exception as error:
        raise UploadFailure(phase, error) from None


def verify_package(kind, package, manifest):
    owner = directory(SOURCES[kind][0], source=True)
    if digest(package / manifest['name'], owner) != (manifest['bytes'], manifest['sha256']):
        raise RuntimeError('CHANGED_PACKAGE')
    if load(package / (manifest['name'] + '.json')) != manifest:
        raise RuntimeError('CHANGED_PACKAGE')


def upload(kind, package, manifest):
    checked('copy', rclone, 'copy', package, kind)
    checked('download-check', rclone, 'check', package, kind)
    checked('sha256', verify_package, kind, package, manifest)
    checked('mark', save, STATE_DIR / 'verified' / kind / (manifest['name'] + '.json'),
            {**manifest, 'verifiedAt': time.time()})
    # Only a durable successful verification permits removal of pending links.
    checked('pending-cleanup', discard, package, manifest)


def cleanup(state):
    removed = 0
    for kind, (_, lock_path, _) in SOURCES.items():
        descriptor = lock(lock_path, wait=True)
        if descriptor is None:
            continue
        try:
            files = snapshots(kind)
            owner = directory(SOURCES[kind][0], source=True)
            for stamp, path in files[:-1]:  # Always preserve each database's latest snapshot.
                if stamp < state['startedAt'] or stamp >= time.time() - 7 * 86400:
                    continue
                record = STATE_DIR / 'verified' / kind / (path.name + '.json')
                if not record.exists():
                    continue
                verified = verification(kind, path.name)
                before = regular(path, owner)
                if digest(path, owner) != (verified['bytes'], verified['sha256']):
                    raise RuntimeError('CHANGED_VERIFIED_FILE')
                after = regular(path, owner)
                if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                    raise RuntimeError('CHANGED_FILE')
                path.unlink()
                removed += 1
            sync_directory(SOURCES[kind][0])
        finally:
            os.close(descriptor)
    return removed


def run(*, stage_only=False):
    os.umask(0o077)
    directory(STATE_DIR, create=True)
    descriptor = lock(STATE_DIR / '.upload.lock')
    if descriptor is None:
        return {'status': 'already-running'}
    try:
        for kind in SOURCES:
            directory(STATE_DIR / 'pending' / kind, create=True)
            directory(STATE_DIR / 'verified' / kind, create=True)
        record = STATE_DIR / 'state.json'
        state = load(record) if record.exists() else {'version': 1, 'startedAt': time.time(), 'initial': {}}
        if (state.get('version') != 1 or type(state.get('startedAt')) not in (int, float)
                or not math.isfinite(state['startedAt']) or state['startedAt'] <= 0 or not isinstance(state.get('initial'), dict)
                or any(kind not in SOURCES or name is not None and created_at(kind, name) is None for kind, name in state['initial'].items())):
            raise RuntimeError('INVALID_STATE')
        save(record, state)
        staged = 0
        for kind, (_, lock_path, _) in SOURCES.items():
            source_lock = lock(lock_path, wait=True)
            if source_lock is None:
                raise RuntimeError('BACKUP_BUSY')
            try:
                files = snapshots(kind)
                if kind not in state['initial']:
                    state['initial'][kind] = files[-1][1].name if files else None
                    save(record, state)
                for _, path in files:
                    if eligible(state, kind, path.name) and not (STATE_DIR / 'verified' / kind / (path.name + '.json')).exists():
                        stage(kind, path)
                        staged += 1
            finally:
                os.close(source_lock)
        queue = pending(state, stage_only=stage_only)
        if stage_only:
            return {'status': 'staged', 'pending': len(queue), 'staged': staged}
        directory(CONFIG.parent)
        regular(CONFIG, os.geteuid())
        config = configparser.ConfigParser(interpolation=None)
        config.read(CONFIG)
        if (config.get('onedrive', 'type', fallback='') != 'onedrive'
                or config.get('onedrive', 'drive_type', fallback='') != 'personal'
                or not config.get('onedrive', 'token', fallback='').strip()
                or set(config.get('onedrive', 'access_scopes', fallback='').split()) != {'Files.ReadWrite', 'offline_access'}
                or config.getboolean('onedrive', 'disable_site_permission', fallback=False)
                or config.getboolean('onedrive', 'hard_delete', fallback=False)):
            raise RuntimeError('PERSONAL_ONEDRIVE_REQUIRED')
        uploaded, errors = 0, []
        selected = []
        for kind in SOURCES:
            newest = next((entry for entry in queue if entry[1] == kind), None)
            if newest:
                selected.append(newest)
        oldest = next((entry for entry in reversed(queue) if entry not in selected), None)
        if oldest:
            selected.append(oldest)
        for _, kind, package, manifest in selected:
            try:
                upload(kind, package, manifest)
                uploaded += 1
            except UploadFailure as error:
                errors.append({'kind': kind, 'stage': error.phase, 'code': error.code, 'exitCode': error.exit_code})
        remaining = len(queue) - uploaded
        cloud_removed, removed = None, 0
        if not errors and not remaining:
            try:
                cloud_removed = checked('cloud-retention', cleanup_cloud, state)
                if cloud_removed is not None:
                    removed = checked('local-retention', cleanup, state)
            except UploadFailure as error:
                errors.append({'stage': error.phase, 'code': error.code, 'exitCode': error.exit_code})
        result = {'status': 'failed' if errors else 'ok', 'uploaded': uploaded, 'failed': len(errors),
                  'pending': remaining, 'removed': removed, 'cloudRemoved': cloud_removed or 0,
                  'retention': 'complete' if cloud_removed is not None and not errors else 'deferred'}
        if errors:
            result['errors'] = errors
        return result
    finally:
        os.close(descriptor)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', action='store_true', help='queue snapshots without upload or cleanup')
    args = parser.parse_args()
    try:
        if os.geteuid() != 0:
            raise RuntimeError('ROOT_REQUIRED')
        result = run(stage_only=args.stage)
        print(json.dumps(result), flush=True)
        raise SystemExit(1 if result['status'] == 'failed' else 0)
    except Exception as error:
        # Never print rclone output, config contents, OAuth tokens or DB records.
        code = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        result = {'status': 'failed', 'code': code}
        if isinstance(error, OSError) and error.errno is not None:
            result['errno'] = error.errno
        print(json.dumps(result), flush=True)
        raise SystemExit(1)
