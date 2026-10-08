import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('backup_upload', Path(__file__).with_name('upload_backups.py'))
upload = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upload)
REAL_RCLONE = upload.rclone
REAL_RCLONE_CALL = upload.rclone_call
NOW = datetime.datetime(2026, 10, 6, 20, tzinfo=datetime.timezone.utc).timestamp()


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.sources = {}
        for kind, (_, _, pattern) in upload.SOURCES.items():
            root = self.root / kind
            root.mkdir(mode=0o700)
            self.sources[kind] = (root, root / '.backup.lock', pattern)
        self.config = self.root / 'config' / 'rclone.conf'
        self.config.parent.mkdir(mode=0o700)
        self.config.write_text('[onedrive]\ntype = onedrive\ndrive_type = personal\ntoken = synthetic-token\n'
                               'access_scopes = Files.ReadWrite offline_access\n')
        self.config.chmod(0o600)
        self.calls = []
        self.remote_calls = []
        self.remote = self.root / 'fake-remote'
        self.remote.mkdir(mode=0o700)
        self.addCleanup(patch.stopall)
        patch.object(upload, 'STATE_DIR', self.root / 'state').start()
        patch.object(upload, 'SOURCES', self.sources).start()
        patch.object(upload, 'CONFIG', self.config).start()
        patch.object(upload.time, 'time', return_value=NOW).start()
        patch.object(upload, 'rclone', side_effect=self.rclone).start()
        patch.object(upload, 'rclone_call', side_effect=self.remote_call).start()

    def file(self, kind, *, at=NOW - 10, data=b'synthetic snapshot', suffix='012345abcdef'):
        date = datetime.datetime.fromtimestamp(at, datetime.timezone.utc)
        name = (f'collector-{date:%Y-%m-%dT%H-%M-%S}.{date.microsecond // 1000:03d}Z.sqlite.gz' if kind == 'collector'
                else f'linkx-pg-v1-{date:%Y%m%dT%H%M%S%fZ}-{suffix}.dump')
        path = self.sources[kind][0] / name
        path.write_bytes(data)
        path.chmod(0o600)
        return path

    def rclone(self, command, package, kind):
        self.calls.append((command, package.name, kind))
        # Network work must never hold the producer's backup lock.
        with self.sources[kind][1].open('a') as descriptor:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        destination = self.remote / kind
        destination.mkdir(mode=0o700, exist_ok=True)
        if command == 'copy':
            for file in package.iterdir():
                shutil.copyfile(file, destination / file.name)
        else:
            for file in package.iterdir():
                self.assertEqual(file.read_bytes(), (destination / file.name).read_bytes())

    def package(self, kind, file):
        return upload.STATE_DIR / 'pending' / kind / file.name

    def marker(self, kind, file):
        return upload.STATE_DIR / 'verified' / kind / (file.name + '.json')

    def remote_call(self, command, *paths, extra=(), timeout=900):
        self.remote_calls.append((command, paths, list(extra), timeout))
        self.assertEqual(len(paths), 1)
        self.assertTrue(paths[0].startswith('onedrive:database/'))
        destination = self.remote / paths[0].removeprefix('onedrive:database/')
        if command == 'lsjson':
            self.assertEqual(list(extra), ['--files-only'])
            rows = [{'Path': path.name, 'Name': path.name, 'Size': path.stat().st_size, 'IsDir': path.is_dir()}
                    for path in destination.iterdir()]
            output = json.dumps(rows).encode()
        elif command == 'cat':
            output = destination.read_bytes()
        elif command == 'deletefile':
            self.assertEqual(list(extra), ['--onedrive-hard-delete=false'])
            destination.unlink()
            output = b''
        else:
            self.fail('unexpected remote command')
        return subprocess.CompletedProcess([command], 0, stdout=output)

    def uploaded(self, kind, path):
        manifest = upload.stage(kind, path)
        upload.upload(kind, self.package(kind, path), manifest)
        return manifest

    def retention_files(self):
        initial = {kind: self.file(kind, at=NOW - 10) for kind in upload.SOURCES}
        upload.run()
        expired = {kind: self.file(kind, at=NOW + 1) for kind in upload.SOURCES}
        for kind, path in expired.items():
            self.uploaded(kind, path)
        later = NOW + 9 * 86400
        latest = {kind: self.file(kind, at=later - 10) for kind in upload.SOURCES}
        for kind, path in latest.items():
            self.uploaded(kind, path)
        self.remote_calls.clear()
        return initial, expired, latest, later

    def test_first_stage_only_selects_latest_then_incremental_preserves_hardlinks_without_oauth(self):
        old = self.file('collector', at=NOW - 86400)
        latest = self.file('collector')
        pg = self.file('postgres')
        self.config.unlink()
        result = upload.run(stage_only=True)
        self.assertEqual(result['pending'], 2)
        self.assertEqual(self.calls, [])
        self.assertFalse(self.package('collector', old).exists())
        pending = self.package('collector', latest) / latest.name
        self.assertEqual(pending.stat().st_ino, latest.stat().st_ino)
        latest.unlink()  # Existing source retention cannot remove a queued inode.
        new = self.file('postgres', at=NOW + 1, suffix='111111111111')
        self.assertEqual(upload.run(stage_only=True)['pending'], 3)
        self.assertEqual(pending.read_bytes(), b'synthetic snapshot')
        self.assertTrue(self.package('postgres', pg).exists())
        self.assertTrue(self.package('postgres', new).exists())
        self.assertEqual(upload.load(upload.STATE_DIR / 'state.json')['startedAt'], NOW)

    def test_success_download_checks_payload_and_manifest_then_durably_marks_success(self):
        collector, pg = self.file('collector'), self.file('postgres')
        upload.run(stage_only=True)
        collector.unlink()
        result = upload.run()
        self.assertEqual(result, {'status': 'ok', 'uploaded': 2, 'failed': 0, 'pending': 0, 'removed': 0,
                                  'cloudRemoved': 0, 'retention': 'deferred'})
        self.assertEqual([call[0] for call in self.calls], ['copy', 'check', 'copy', 'check'])
        for kind, path in [('collector', collector), ('postgres', pg)]:
            marker = upload.load(self.marker(kind, path))
            self.assertEqual(marker['sha256'], hashlib.sha256(b'synthetic snapshot').hexdigest())
            self.assertEqual(marker['verifiedAt'], NOW)
            self.assertFalse(self.package(kind, path).exists())
            self.assertEqual(self.marker(kind, path).stat().st_mode & 0o777, 0o600)
        self.assertTrue(pg.exists())

    def test_copy_check_timeout_and_post_check_mutation_fail_without_verification_or_delete(self):
        for failure in ['copy', 'check', 'timeout', 'mutation']:
            with self.subTest(failure=failure):
                file = self.file('collector', at=NOW + len(self.calls) + 1)
                upload.run(stage_only=True)
                def failing(command, package, kind):
                    self.calls.append((command, package.name, kind))
                    if failure == command:
                        raise subprocess.CalledProcessError(1, ['synthetic'], stderr=b'OAUTH_SECRET')
                    if failure == 'timeout':
                        raise subprocess.TimeoutExpired(['synthetic'], 900)
                    if failure == 'mutation' and command == 'check':
                        (package / package.name).write_bytes(b'changed snapshot')
                with patch.object(upload, 'rclone', side_effect=failing):
                    result = upload.run()
                self.assertEqual(result['status'], 'failed')
                self.assertEqual(result['removed'], 0)
                self.assertTrue(file.exists())
                self.assertTrue((self.package('collector', file) / file.name).exists())
                self.assertFalse(self.marker('collector', file).exists())
                self.assertNotIn('OAUTH_SECRET', json.dumps(result))
                self.assertIn(result['errors'][0]['stage'], ['copy', 'download-check', 'sha256'])
                # Remove only the isolated damaged fixture to keep cases independent.
                shutil.rmtree(self.package('collector', file))
                file.unlink()

    def test_newest_and_oldest_packages_win_without_starving_pending_history(self):
        first = self.file('collector')
        upload.run(stage_only=True)
        middle = [self.file('collector', at=NOW + index) for index in range(1, 4)]
        result = upload.run()
        self.assertEqual(result['uploaded'], 2)
        self.assertEqual(result['pending'], 2)
        copied = [name for command, name, _ in self.calls if command == 'copy']
        self.assertEqual(copied, sorted(copied, reverse=True))
        self.assertEqual(copied[-1], first.name)
        self.assertTrue(self.package('collector', middle[0]).exists())
        self.assertTrue(self.package('collector', middle[1]).exists())

    def test_cleanup_only_post_watermark_verified_older_than_seven_days_and_preserves_latest(self):
        historical = self.file('collector', at=NOW - 86400)
        upload.run(stage_only=True)
        expired = self.file('collector', at=NOW + 1)
        unverified = self.file('collector', at=NOW + 2)
        latest = self.file('collector', at=NOW + 3)
        for path in [historical, expired, latest]:
            manifest = upload.stage('collector', path)
            upload.upload('collector', self.package('collector', path), manifest)
        with patch.object(upload.time, 'time', return_value=NOW + 9 * 86400):
            removed = upload.cleanup(upload.load(upload.STATE_DIR / 'state.json'))
        self.assertEqual(removed, 1)
        self.assertFalse(expired.exists())
        self.assertTrue(historical.exists())
        self.assertTrue(unverified.exists())
        self.assertTrue(latest.exists())

    def test_same_name_replacement_never_deletes_a_verified_source(self):
        upload.run(stage_only=True)
        changed = self.file('postgres', at=NOW + 1)
        self.file('postgres', at=NOW + 2, suffix='111111111111')
        manifest = upload.stage('postgres', changed)
        upload.upload('postgres', self.package('postgres', changed), manifest)
        changed.write_bytes(b'replaced source')
        with patch.object(upload.time, 'time', return_value=NOW + 9 * 86400):
            with self.assertRaisesRegex(RuntimeError, 'CHANGED_VERIFIED_FILE'):
                upload.cleanup(upload.load(upload.STATE_DIR / 'state.json'))
        self.assertTrue(changed.exists())

    def test_incomplete_manifest_recovers_and_interrupted_verified_cleanup_resumes(self):
        file = self.file('collector')
        upload.run(stage_only=True)
        package = self.package('collector', file)
        (package / (file.name + '.json')).unlink()
        file.unlink()
        self.assertEqual(upload.run(stage_only=True)['pending'], 1)
        manifest = upload.load(package / (file.name + '.json'))
        with patch.object(upload, 'discard', side_effect=OSError('synthetic interruption')):
            result = upload.run()
        self.assertEqual(result['status'], 'failed')
        self.assertTrue(self.marker('collector', file).exists())
        self.assertEqual(upload.run()['pending'], 0)
        self.assertFalse(package.exists())
        self.assertEqual(upload.load(self.marker('collector', file))['sha256'], manifest['sha256'])

    def test_invalid_names_links_private_permissions_and_wrong_remotes_are_rejected(self):
        bad = self.sources['collector'][0] / 'collector-2026-99-99T00-00-00.000Z.sqlite.gz'
        bad.write_bytes(b'ignore')
        bad.chmod(0o600)
        file = self.file('collector')
        link = self.file('collector', at=NOW + 1)
        link.unlink()
        link.symlink_to(file)
        self.assertEqual(upload.run(stage_only=True)['pending'], 1)
        self.assertFalse(self.package('collector', link).exists())
        self.config.write_text('[onedrive]\ntype = local\n')
        with self.assertRaisesRegex(RuntimeError, 'PERSONAL_ONEDRIVE_REQUIRED'):
            upload.run()
        self.assertEqual(self.calls, [])
        self.config.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, 'UNSAFE_FILE'):
            upload.run()
        self.assertTrue(file.exists())

    def test_overlapping_run_skips_and_source_lock_is_released_before_network(self):
        self.file('collector')
        upload.run(stage_only=True)
        with (upload.STATE_DIR / '.upload.lock').open('a') as descriptor:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(upload.run(), {'status': 'already-running'})
        self.assertEqual(self.calls, [])
        self.assertEqual(upload.run()['uploaded'], 1)

    def test_personal_token_scope_and_backend_validation_fail_before_network(self):
        file = self.file('collector')
        upload.run(stage_only=True)
        original = self.config.read_text()
        for old, new in [('type = onedrive', 'type = local'), ('drive_type = personal', 'drive_type = business'),
                         ('token = synthetic-token', 'token = '),
                         ('Files.ReadWrite offline_access', 'Files.ReadWrite offline_access Sites.Read.All'),
                         ('access_scopes =', 'disable_site_permission = true\naccess_scopes ='),
                         ('access_scopes =', 'hard_delete = true\naccess_scopes =')]:
            with self.subTest(new=new):
                self.config.write_text(original.replace(old, new))
                with self.assertRaisesRegex(RuntimeError, 'PERSONAL_ONEDRIVE_REQUIRED'):
                    upload.run()
                self.assertEqual(self.calls, [])
                self.assertTrue((self.package('collector', file) / file.name).exists())

    def test_corrupt_verified_marker_cannot_remove_pending_payload_or_escape_its_name(self):
        file = self.file('collector')
        upload.run(stage_only=True)
        package = self.package('collector', file)
        manifest = upload.load(package / (file.name + '.json'))
        upload.save(self.marker('collector', file), {**manifest, 'name': '../wrong', 'verifiedAt': NOW})
        with self.assertRaisesRegex(RuntimeError, 'INVALID_VERIFICATION'):
            upload.run()
        self.assertTrue((package / file.name).exists())
        self.assertTrue(file.exists())

    def test_cloud_retains_seven_days_including_initial_and_preserves_unowned_files_and_latest(self):
        initial, expired, latest, later = self.retention_files()
        unowned = self.file('collector', at=NOW + 2)
        for name in [unowned.name, unowned.name + '.json', 'notes.json', '../outside']:
            path = self.remote / 'collector' / name
            path.write_bytes(b'unowned')
        unowned.unlink()  # This remote name has no local verification evidence.
        with patch.object(upload.time, 'time', return_value=later):
            result = upload.run()
        self.assertEqual(result['cloudRemoved'], 8)
        self.assertEqual(result['removed'], 2)
        self.assertEqual(result['retention'], 'complete')
        for kind in upload.SOURCES:
            self.assertTrue(initial[kind].exists())  # Local pre-watermark history remains untouched.
            self.assertFalse(expired[kind].exists())
            self.assertTrue(latest[kind].exists())
            self.assertTrue((self.remote / kind / latest[kind].name).exists())
            self.assertFalse((self.remote / kind / initial[kind].name).exists())
            self.assertFalse((self.remote / kind / expired[kind].name).exists())
        self.assertTrue((self.remote / 'collector' / unowned.name).exists())
        self.assertTrue((self.remote / 'collector' / 'notes.json').exists())
        self.assertTrue((self.remote / 'outside').exists())
        deletions = [call for call in self.remote_calls if call[0] == 'deletefile']
        self.assertTrue(all(call[1][0].startswith(('onedrive:database/collector/', 'onedrive:database/postgres/'))
                            and call[2] == ['--onedrive-hard-delete=false'] for call in deletions))

    def test_exact_seven_day_boundary_and_future_snapshot_are_not_deleted(self):
        _, _, latest, later = self.retention_files()
        boundary = self.file('collector', at=later - 7 * 86400)
        self.uploaded('collector', boundary)
        with patch.object(upload.time, 'time', return_value=later):
            self.assertEqual(upload.run()['retention'], 'complete')
        self.assertTrue((self.remote / 'collector' / boundary.name).exists())
        future = self.file('collector', at=later + 1)
        self.uploaded('collector', future)
        self.remote_calls.clear()
        with patch.object(upload.time, 'time', return_value=later):
            self.assertEqual(upload.run()['retention'], 'deferred')
        self.assertEqual(self.remote_calls, [])
        self.assertTrue(latest['postgres'].exists())

    def test_latest_both_databases_must_be_recent_verified_locally_and_present_with_matching_cloud_manifest(self):
        _, expired, latest, later = self.retention_files()
        payload = self.remote / 'postgres' / latest['postgres'].name
        sidecar = self.remote / 'postgres' / (latest['postgres'].name + '.json')
        original, manifest = payload.read_bytes(), sidecar.read_bytes()
        for failure in ['missing-payload', 'missing-manifest', 'bad-json', 'changed-hash', 'wrong-size']:
            with self.subTest(failure=failure):
                self.remote_calls.clear()
                if failure == 'missing-payload':
                    payload.unlink()
                elif failure == 'missing-manifest':
                    sidecar.unlink()
                elif failure == 'bad-json':
                    sidecar.write_bytes(b'{invalid')
                elif failure == 'changed-hash':
                    changed = json.loads(manifest)
                    changed['sha256'] = '0' * 64
                    sidecar.write_text(json.dumps(changed))
                else:
                    payload.write_bytes(b'wrong size')
                with patch.object(upload.time, 'time', return_value=later):
                    result = upload.run()
                self.assertEqual(result['retention'], 'deferred')
                self.assertEqual(result['cloudRemoved'], 0)
                self.assertEqual(result['removed'], 0)
                self.assertFalse(any(call[0] == 'deletefile' for call in self.remote_calls))
                self.assertTrue(expired['collector'].exists())
                payload.write_bytes(original)
                sidecar.write_bytes(manifest)
        marker = self.marker('postgres', latest['postgres'])
        verification = marker.read_bytes()
        marker.unlink()
        self.remote_calls.clear()
        with patch.object(upload.time, 'time', return_value=later):
            self.assertIsNone(upload.cleanup_cloud(upload.load(upload.STATE_DIR / 'state.json')))
            self.assertEqual(upload.run(stage_only=True)['pending'], 1)
            self.assertEqual(self.remote_calls, [])
        marker.write_bytes(verification)
        marker.chmod(0o600)
        upload.discard(self.package('postgres', latest['postgres']),
                       upload.verification('postgres', latest['postgres'].name))
        latest['postgres'].write_bytes(b'changed locally')
        with patch.object(upload.time, 'time', return_value=later):
            result = upload.run()
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['removed'], 0)
        self.assertEqual(result['cloudRemoved'], 0)
        self.assertTrue(expired['collector'].exists())

    def test_stale_or_missing_latest_source_prevents_cloud_and_local_cleanup(self):
        _, expired, latest, later = self.retention_files()
        latest['postgres'].unlink()
        with patch.object(upload.time, 'time', return_value=later):
            result = upload.run()
        self.assertEqual(result['retention'], 'deferred')
        self.assertEqual(self.remote_calls, [])
        self.assertTrue(expired['collector'].exists())
        for path in self.sources['postgres'][0].iterdir():
            if path.name != '.backup.lock':
                path.unlink()
        with patch.object(upload.time, 'time', return_value=later):
            self.assertEqual(upload.run()['retention'], 'deferred')
        self.assertEqual(self.remote_calls, [])

    def test_freshness_thirty_hour_boundary_and_stage_mode_never_prune(self):
        _, expired, latest, later = self.retention_files()
        with patch.object(upload.time, 'time', return_value=later + 30 * 3600 - 10):
            self.assertEqual(upload.run(stage_only=True)['status'], 'staged')
        self.assertEqual(self.remote_calls, [])
        self.assertTrue(expired['collector'].exists())
        with patch.object(upload.time, 'time', return_value=later + 30 * 3600 - 9):
            self.assertEqual(upload.run()['retention'], 'deferred')
        self.assertEqual(self.remote_calls, [])
        with patch.object(upload.time, 'time', return_value=later + 30 * 3600 - 10):
            self.assertEqual(upload.run()['retention'], 'complete')
        self.assertTrue(latest['collector'].exists())

    def test_each_database_newest_then_oldest_backlog_uploads_at_most_three_and_pending_blocks_retention(self):
        _, expired, _, later = self.retention_files()
        collector = [self.file('collector', at=later + index) for index in range(1, 4)]
        postgres = self.file('postgres', at=later + 4)
        self.calls.clear()
        with patch.object(upload.time, 'time', return_value=later + 4):
            result = upload.run()
        copied = [name for command, name, _ in self.calls if command == 'copy']
        self.assertEqual(copied, [collector[2].name, postgres.name, collector[0].name])
        self.assertEqual(result['uploaded'], 3)
        self.assertEqual(result['pending'], 1)
        self.assertEqual(result['retention'], 'deferred')
        self.assertEqual(self.remote_calls, [])
        self.assertTrue(expired['collector'].exists())

    def test_interrupted_cloud_pair_removal_keeps_local_backup_and_retries_only_matching_orphan_manifest(self):
        initial, expired, latest, later = self.retention_files()
        archive = 'onedrive:database/collector/' + initial['collector'].name
        sidecar = archive + '.json'
        def interrupted(command, *paths, **kwargs):
            if command == 'deletefile' and paths[0] == sidecar:
                raise subprocess.CalledProcessError(1, ['synthetic'], stderr=b'OAUTH_SECRET')
            return self.remote_call(command, *paths, **kwargs)
        with patch.object(upload.time, 'time', return_value=later), \
                patch.object(upload, 'rclone_call', side_effect=interrupted):
            result = upload.run()
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['errors'][0]['stage'], 'cloud-retention')
        self.assertNotIn('OAUTH_SECRET', json.dumps(result))
        self.assertFalse((self.remote / 'collector' / initial['collector'].name).exists())
        self.assertTrue((self.remote / 'collector' / (initial['collector'].name + '.json')).exists())
        self.assertTrue(expired['collector'].exists())
        self.assertTrue(self.marker('collector', initial['collector']).exists())
        self.remote_calls.clear()
        with patch.object(upload.time, 'time', return_value=later):
            result = upload.run()
        self.assertEqual(result['retention'], 'complete')
        self.assertEqual(result['cloudRemoved'], 7)
        deletions = [call[1][0] for call in self.remote_calls if call[0] == 'deletefile']
        self.assertIn(sidecar, deletions)
        self.assertNotIn(archive, deletions)
        self.assertTrue(latest['postgres'].exists())

    def test_invalid_remote_listing_corrupt_owned_old_manifest_and_old_size_mismatch_fail_closed(self):
        _, expired, _, later = self.retention_files()
        sidecar = self.remote / 'collector' / (expired['collector'].name + '.json')
        original = sidecar.read_bytes()
        sidecar.write_bytes(b'invalid manifest')
        with patch.object(upload.time, 'time', return_value=later):
            result = upload.run()
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['removed'], 0)
        self.assertTrue(expired['collector'].exists())
        sidecar.write_bytes(original)
        payload = self.remote / 'collector' / expired['collector'].name
        payload.write_bytes(b'wrong size')
        with patch.object(upload.time, 'time', return_value=later):
            result = upload.run()
        self.assertEqual(result['status'], 'failed')
        self.assertTrue(payload.exists())
        self.assertTrue(expired['collector'].exists())
        payload.write_bytes(b'synthetic snapshot')
        directory = self.remote / 'collector' / 'unexpected-directory'
        directory.mkdir()
        self.remote_calls.clear()
        with patch.object(upload.time, 'time', return_value=later):
            result = upload.run()
        self.assertEqual(result['status'], 'failed')
        self.assertFalse(any(call[0] == 'deletefile' for call in self.remote_calls))
        self.assertTrue(expired['collector'].exists())

    def test_retention_rclone_arguments_override_hard_delete_and_never_recurse_or_sync(self):
        with patch.object(upload.subprocess, 'run') as run, patch.dict(os.environ, {'RCLONE_ONEDRIVE_HARD_DELETE': 'true'}):
            REAL_RCLONE_CALL('deletefile', 'onedrive:database/collector/owned.sqlite.gz',
                             extra=['--onedrive-hard-delete=false'], timeout=120)
            arguments = run.call_args.args[0]
            self.assertEqual(arguments[:3], ['/usr/local/bin/rclone', 'deletefile',
                                            'onedrive:database/collector/owned.sqlite.gz'])
            self.assertIn('--onedrive-hard-delete=false', arguments)
            self.assertNotIn('RCLONE_ONEDRIVE_HARD_DELETE', run.call_args.kwargs['env'])
            self.assertEqual(run.call_args.kwargs['timeout'], 120)
            for forbidden in ['--recursive', '--rmdirs', 'purge', 'sync', 'delete']:
                self.assertNotIn(forbidden, arguments)

    def test_exact_rclone_flags_config_and_environment_are_bounded_and_do_not_delete_cloud_files(self):
        with patch.object(upload.subprocess, 'run') as run, patch.dict(os.environ, {'RCLONE_CONFIG_BACKUP_TYPE': 'local'}), \
                patch.object(upload, 'rclone_call', REAL_RCLONE_CALL):
            for command in ['copy', 'check']:
                REAL_RCLONE(command, Path('/synthetic/package'), 'collector')
                arguments = run.call_args.args[0]
                self.assertEqual(arguments[:4], ['/usr/local/bin/rclone', command, '/synthetic/package', 'onedrive:database/collector'])
                self.assertIn(str(self.config), arguments)
                self.assertEqual(arguments[arguments.index('--bwlimit') + 1], '1M')
                self.assertEqual(run.call_args.kwargs['timeout'], 900)
                self.assertNotIn('RCLONE_CONFIG_BACKUP_TYPE', run.call_args.kwargs['env'])
                if command == 'check':
                    self.assertIn('--download', arguments)
                    self.assertIn('--one-way', arguments)
                else:
                    self.assertIn('--immutable', arguments)
                    self.assertNotIn('--ignore-times', arguments)
                self.assertNotIn('sync', arguments)
                self.assertNotIn('delete', arguments)


if __name__ == '__main__':
    unittest.main()
