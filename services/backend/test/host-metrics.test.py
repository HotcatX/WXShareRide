import importlib.util
import io
import json
import os
import pathlib
import sqlite3
import sys
import tempfile
import time
import unittest
from contextlib import closing, redirect_stderr
from unittest.mock import patch

sys.dont_write_bytecode = True
SOURCE = pathlib.Path(__file__).parents[1] / 'scripts' / 'host-metrics.py'
SPEC = importlib.util.spec_from_file_location('host_metrics', SOURCE)
metrics = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(metrics)


class HostMetricsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.public = pathlib.Path(self.directory.name, 'public')
        self.private = pathlib.Path(self.directory.name, 'private')
        self.public.mkdir()
        self.private.mkdir()
        self.addCleanup(self.directory.cleanup)
        self.public_patch = patch.object(metrics, 'PUBLIC', str(self.public))
        self.private_patch = patch.object(metrics, 'PRIVATE', str(self.private))
        self.public_patch.start()
        self.private_patch.start()
        self.addCleanup(self.public_patch.stop)
        self.addCleanup(self.private_patch.stop)
        self.now = int(time.time() * 1000) // 60000 * 60000 + 10000

    def value(self, at=None, cpu=20, used=25):
        return {'schemaVersion': 1, 'sampledAt': self.now if at is None else at, 'uptimeSeconds': 50,
                'cpu': {'percent': cpu, 'cores': 2}, 'memory': {'totalBytes': 100, 'availableBytes': 100 - used},
                'disk': {'totalBytes': 500, 'availableBytes': 400}, 'services': []}

    def frame(self, name='day'):
        return json.loads((self.public / ('history-' + name + '.json')).read_text())

    def expire_files(self):
        for path in self.public.glob('history-*.json'):
            os.utime(path, ((self.now - 120000) / 1000, (self.now - 120000) / 1000))

    def test_cpu_difference_and_bad_baseline(self):
        self.assertIsNone(metrics.cpu_percent({'total': 100, 'idle': 50}, None))
        self.assertIsNone(metrics.cpu_percent({'total': 100, 'idle': 50}, ['bad']))
        self.assertEqual(metrics.cpu_percent({'total': 200, 'idle': 130}, {'total': 100, 'idle': 50}), 20)
        self.assertIsNone(metrics.cpu_percent({'total': 1, 'idle': 0}, {'total': 100, 'idle': 50}))

    def test_one_row_per_minute_weighted_average_and_permissions(self):
        metrics.record_history(self.value(cpu=None, used=20))
        metrics.record_history(self.value(at=self.now + 10000, cpu=40, used=60))
        with closing(sqlite3.connect(self.private / 'metrics.sqlite')) as db, db:
            self.assertEqual(db.execute('SELECT COUNT(*),SUM(samples) FROM metrics').fetchone(), (1, 2))
        self.expire_files()
        metrics.record_history(self.value(at=self.now + 20000, cpu=20, used=40))
        point = self.frame()['points'][0]
        self.assertEqual(point['cpuPercent'], 30)
        self.assertEqual(point['memoryUsedBytes'], 40)
        self.assertEqual(point['memoryTotalBytes'], 100)
        self.assertEqual((self.private / 'metrics.sqlite').stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.public / 'history-day.json').stat().st_mode & 0o777, 0o644)

    def test_no_fake_points_or_zero_filled_history(self):
        metrics.record_history(self.value(cpu=None))
        for name, _, _ in metrics.RANGES:
            frame = self.frame(name)
            self.assertEqual(frame['range'], name)
            self.assertEqual(len(frame['points']), 1)
            self.assertIsNone(frame['points'][0]['cpuPercent'])
            self.assertEqual(set(frame), {'schemaVersion', 'range', 'sampledAt', 'from', 'to', 'points'})
            self.assertEqual(set(frame['points'][0]), {'at', 'cpuPercent', 'memoryUsedBytes', 'memoryTotalBytes', 'diskUsedBytes', 'diskTotalBytes'})

    def test_exports_at_most_once_per_minute_but_accumulates_samples(self):
        metrics.record_history(self.value())
        for path in self.public.glob('history-*.json'):
            os.utime(path, (self.now / 1000, self.now / 1000))
        with patch.object(metrics, 'atomic_json', wraps=metrics.atomic_json) as publish:
            metrics.record_history(self.value(at=self.now + 10000))
            self.assertEqual(publish.call_count, 0)
        with closing(sqlite3.connect(self.private / 'metrics.sqlite')) as db, db:
            self.assertEqual(db.execute('SELECT samples FROM metrics').fetchone()[0], 2)

    def test_thirty_day_retention_bounded_points_and_indexed_range(self):
        metrics.record_history(self.value())
        minute = self.now // 60000 * 60000
        with closing(sqlite3.connect(self.private / 'metrics.sqlite')) as db, db:
            db.executemany('INSERT OR REPLACE INTO metrics VALUES(?,?,?,?,?,?,?,?)',
                           ((minute - i * 60000, 20, 1, 1, 25, 100, 100, 500) for i in range(43201)))
            plan = db.execute('EXPLAIN QUERY PLAN SELECT at FROM metrics WHERE at>=? AND at<=?', (0, minute)).fetchall()
            self.assertTrue(any('SEARCH' in row[3] and 'INTEGER PRIMARY KEY' in row[3] for row in plan))
        self.expire_files()
        metrics.record_history(self.value(at=self.now + 60000))
        with closing(sqlite3.connect(self.private / 'metrics.sqlite')) as db, db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM metrics').fetchone()[0], 43200)
            self.assertGreater(db.execute('SELECT MIN(at) FROM metrics').fetchone()[0], minute + 60000 - 2592000000)
        size = 0
        for name, _, _ in metrics.RANGES:
            frame = self.frame(name)
            self.assertLessEqual(len(frame['points']), 720)
            self.assertGreater(len(frame['points']), 600)
            times = [point['at'] for point in frame['points']]
            self.assertEqual(times, sorted(set(times)))
            self.assertTrue(all(frame['from'] <= at <= frame['to'] for at in times))
            self.assertTrue(all(point['memoryUsedBytes'] <= point['memoryTotalBytes'] for point in frame['points']))
            size += (self.public / ('history-' + name + '.json')).stat().st_size
        self.assertLessEqual(size, 524288)
        self.assertLess((self.private / 'metrics.sqlite').stat().st_size, 10000000)

    def test_history_failure_keeps_current_snapshot_successful(self):
        with patch.object(metrics.os, 'geteuid', return_value=0), patch.object(metrics, 'read_previous', return_value=None), \
                patch.object(metrics, 'sample', return_value=(self.value(), {'total': 100, 'idle': 50})), \
                patch.object(metrics, 'record_history', side_effect=sqlite3.OperationalError('full')), \
                patch.object(metrics.os, 'lstat', return_value=type('Info', (), {'st_mode': 0o040755, 'st_uid': 0})()), \
                patch.object(metrics.sys, 'argv', ['host-metrics.py']), redirect_stderr(io.StringIO()) as output:
            self.assertEqual(metrics.main(), 0)
            self.assertEqual(json.loads((self.public / 'host.json').read_text())['sampledAt'], self.now)
            self.assertEqual(output.getvalue(), 'HOST_HISTORY_UNAVAILABLE\n')

    def test_history_database_rejects_symlinks(self):
        target = self.private / 'other.sqlite'
        target.write_text('preserve')
        (self.private / 'metrics.sqlite').symlink_to(target)
        with self.assertRaises(ValueError):
            metrics.record_history(self.value())
        self.assertEqual(target.read_text(), 'preserve')

    def test_atomic_publication_preserves_old_file_on_oversize_or_replace_failure(self):
        path = self.public / 'history-day.json'
        path.write_text('old')
        with self.assertRaises(ValueError):
            metrics.atomic_json(str(self.public), path.name, {'x': 'a' * 524288}, 0o644, 524288)
        with patch.object(metrics.os, 'replace', side_effect=OSError()):
            with self.assertRaises(OSError):
                metrics.atomic_json(str(self.public), path.name, {'schemaVersion': 1}, 0o644)
        self.assertEqual(path.read_text(), 'old')
        self.assertEqual(list(self.public.iterdir()), [path])

    def test_history_lock_wait_is_bounded_and_preserves_old_export(self):
        metrics.record_history(self.value())
        original = (self.public / 'history-day.json').read_bytes()
        with closing(sqlite3.connect(self.private / 'metrics.sqlite')) as lock:
            lock.execute('BEGIN EXCLUSIVE')
            started = time.monotonic()
            with self.assertRaises(sqlite3.OperationalError):
                metrics.record_history(self.value(at=self.now + 60000))
            self.assertLess(time.monotonic() - started, 0.5)
            lock.rollback()
        self.assertEqual((self.public / 'history-day.json').read_bytes(), original)

    def test_history_query_budget_aborts_without_replacing_last_valid_export(self):
        metrics.record_history(self.value())
        with closing(sqlite3.connect(self.private / 'metrics.sqlite')) as db, db:
            minute = self.now // 60000 * 60000
            db.executemany('INSERT OR REPLACE INTO metrics VALUES(?,?,?,?,?,?,?,?)',
                           ((minute - i * 60000, 20, 1, 1, 25, 100, 100, 500) for i in range(4000)))
        original = (self.public / 'history-day.json').read_bytes()
        self.expire_files()
        with patch.object(metrics.time, 'monotonic', side_effect=[0] + [2] * 100):
            with self.assertRaises(sqlite3.OperationalError):
                metrics.record_history(self.value(at=self.now + 60000))
        self.assertEqual((self.public / 'history-day.json').read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
