import datetime
import fcntl
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('backend_backup', Path(__file__).with_name('backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
REAL_DOCKER = backup.docker
DUMP = b'PGDMP' + b'synthetic archive fixture' * 30
OLD = 'linkx-pg-v1-20200101T010203123456Z-012345abcdef.dump'


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.calls = []
        self.validated = False
        self.addCleanup(patch.stopall)
        patch.object(backup, 'BACKUP_DIR', self.root).start()
        patch.object(backup.shutil, 'disk_usage', return_value=SimpleNamespace(free=2**30)).start()
        patch.object(backup, 'docker', side_effect=self.docker).start()

    def docker(self, arguments, *, source=None, target=None, timeout=None):
        self.calls.append(arguments)
        if arguments[0] == 'psql':
            return SimpleNamespace(stdout=b'1048576\n')
        if arguments[0] == 'pg_dump':
            target.write(DUMP)
            self.assertEqual(list(self.root.glob('linkx-pg-v1-*.dump')), self.before)
        if arguments[0] == 'pg_restore':
            # subprocess stdin consumes the OS descriptor, not Python's buffer.
            self.assertEqual(os.read(source.fileno(), len(DUMP) + 1), DUMP)
            self.assertIn('--file=/dev/null', arguments)
            self.assertNotIn('--dbname=linkx', arguments)
            self.validated = True
        return SimpleNamespace(stdout=b'')

    def existing(self, name, *, old=True):
        file = self.root / name
        file.write_bytes(b'recovery evidence')
        if old:
            stamp = datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc).timestamp()
            os.utime(file, (stamp, stamp))
        return file

    def run_backup(self):
        self.before = list(self.root.glob('linkx-pg-v1-*.dump'))
        return backup.run_backup()

    def test_success_validates_then_publishes_private_archive_and_only_rotates_owned_pattern(self):
        expired = self.existing(OLD)
        protected = [self.existing('final-before.dump'), self.existing('linkx-pg-v1-not-an-archive.dump'),
                     self.existing('linkx-pg-v1-20200101T010203123456Z-111111111111.dump', old=False)]
        link = self.root / 'linkx-pg-v1-20200101T010203123456Z-222222222222.dump'
        link.symlink_to(protected[0])
        result = self.run_backup()
        file = Path(result['path'])
        self.assertEqual(result['status'], 'ok')
        self.assertTrue(self.validated)
        self.assertEqual(file.read_bytes(), DUMP)
        self.assertEqual(result['sha256'], hashlib.sha256(DUMP).hexdigest())
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
        self.assertFalse(expired.exists())
        self.assertEqual(result['removed'], 1)
        self.assertTrue(all(file.read_bytes() == b'recovery evidence' for file in protected))
        self.assertTrue(link.is_symlink())
        self.assertFalse(list(self.root.glob('*.pending')))

    def test_dump_failure_or_unreadable_archive_never_publishes_or_rotates(self):
        previous = self.existing(OLD)
        for failing, error in [('pg_dump', subprocess.CalledProcessError(1, ['synthetic'])),
                               ('pg_restore', subprocess.CalledProcessError(1, ['synthetic'])),
                               ('pg_dump', subprocess.TimeoutExpired(['synthetic'], 900)),
                               ('pg_restore', subprocess.TimeoutExpired(['synthetic'], 900))]:
            with self.subTest(failing=failing, error=type(error).__name__):
                def command(arguments, **kwargs):
                    if arguments[0] == failing:
                        if failing == 'pg_dump':
                            kwargs['target'].write(b'partial dump')
                        raise error
                    return self.docker(arguments, **kwargs)
                with patch.object(backup, 'docker', side_effect=command):
                    with self.assertRaises(type(error)):
                        self.run_backup()
                self.assertEqual(previous.read_bytes(), b'recovery evidence')
                self.assertEqual(list(self.root.glob('linkx-pg-v1-*.dump')), [previous])
                self.assertFalse(list(self.root.glob('*.pending')))

    def test_space_guard_blocks_before_dump_and_post_dump_reserve_blocks_publication(self):
        previous = self.existing(OLD)
        for free in [[1], [2**30, 1]]:
            with self.subTest(free=free), patch.object(backup.shutil, 'disk_usage', side_effect=[SimpleNamespace(free=value) for value in free]):
                with self.assertRaisesRegex(RuntimeError, 'SPACE'):
                    self.run_backup()
                self.assertEqual(previous.read_bytes(), b'recovery evidence')
                self.assertEqual(list(self.root.glob('linkx-pg-v1-*.dump')), [previous])
                self.assertFalse(list(self.root.glob('*.pending')))

    def test_an_overlapping_run_skips_without_starting_dump(self):
        with (self.root / '.linkx-pg-backup.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.run_backup(), {'status': 'already-running'})
            self.assertEqual(self.calls, [])

    def test_publication_failure_preserves_all_previous_archives(self):
        previous = self.existing(OLD)
        with patch.object(backup.os, 'link', side_effect=FileExistsError('synthetic collision')):
            with self.assertRaises(FileExistsError):
                self.run_backup()
        self.assertEqual(previous.read_bytes(), b'recovery evidence')
        self.assertEqual(list(self.root.glob('linkx-pg-v1-*.dump')), [previous])
        self.assertFalse(list(self.root.glob('*.pending')))

    def test_symlink_backup_directory_is_rejected(self):
        link = self.root / 'linked'
        link.symlink_to(self.root, target_is_directory=True)
        with patch.object(backup, 'BACKUP_DIR', link):
            with self.assertRaisesRegex(RuntimeError, 'UNSAFE_BACKUP_DIRECTORY'):
                backup.run_backup()
        self.assertEqual(self.calls, [])

    def test_container_deadline_precedes_host_timeout_and_uses_only_local_docker(self):
        with patch.object(backup.subprocess, 'run', return_value=SimpleNamespace(stdout=b'')) as run:
            REAL_DOCKER(['pg_dump', '--no-password'], timeout=900)
            args = run.call_args.args[0]
            self.assertEqual(args[:4], ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', 'exec'])
            self.assertEqual(args[4:], [backup.CONTAINER, 'timeout', '--signal=TERM', '--kill-after=5s', '885s', 'pg_dump', '--no-password'])
            self.assertEqual(run.call_args.kwargs['timeout'], 900)
            REAL_DOCKER(['psql'], timeout=30)
            self.assertIn('15s', run.call_args.args[0])


if __name__ == '__main__':
    unittest.main()
