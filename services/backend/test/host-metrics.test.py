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
                'cpu': {'percent': cpu, 'cores': 2}, 'services': []}

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
            self.assertEqual(db.execute('SELECT COUNT(*),SUM(cpu_count) FROM metrics').fetchone(), (1, 1))
        self.expire_files()
        metrics.record_history(self.value(at=self.now + 20000, cpu=20, used=40))
        point = self.frame()['points'][0]
        self.assertEqual(point['cpu']['mean'], 30)
        self.assertEqual(point['cpu']['min'], 20)
        self.assertEqual(point['cpu']['max'], 40)
        self.assertEqual(point['cpu']['peakAt'], self.now + 10000)
        self.assertIsNone(point['requests'])
        self.assertEqual((self.private / 'metrics.sqlite').stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.public / 'history-day.json').stat().st_mode & 0o777, 0o644)

    def test_no_fake_points_or_zero_filled_history(self):
        metrics.record_history(self.value(cpu=None))
        for name, _, _ in metrics.RANGES:
            frame = self.frame(name)
            self.assertEqual(frame['range'], name)
            self.assertEqual(len(frame['points']), 1)
            self.assertIsNone(frame['points'][0]['cpu'])
            self.assertEqual(set(frame), {'schemaVersion', 'range', 'sampledAt', 'from', 'to', 'bucketMs', 'points'})
            self.assertEqual(set(frame['points'][0]), {'at', 'cpu', 'requests', 'activeUsers', 'events'})

    def test_exports_at_most_once_per_minute_but_accumulates_samples(self):
        metrics.record_history(self.value())
        for path in self.public.glob('history-*.json'):
            os.utime(path, (self.now / 1000, self.now / 1000))
        with patch.object(metrics, 'atomic_json', wraps=metrics.atomic_json) as publish:
            metrics.record_history(self.value(at=self.now + 10000))
            self.assertEqual(publish.call_count, 0)
        with closing(sqlite3.connect(self.private / 'metrics.sqlite')) as db, db:
            self.assertEqual(db.execute('SELECT cpu_count FROM metrics').fetchone()[0], 2)

    def test_thirty_day_retention_bounded_points_and_indexed_range(self):
        metrics.record_history(self.value())
        minute = self.now // 60000 * 60000
        with closing(sqlite3.connect(self.private / 'metrics.sqlite')) as db, db:
            db.executemany('INSERT OR REPLACE INTO metrics VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                           ((minute - i * 60000, 100, 2, .01, 99.99, minute - i * 60000 + 12345, 2000000000000000, 2000000000000000, 2000000000000000, 9999, 10000) for i in range(43201)))
            plan = db.execute('EXPLAIN QUERY PLAN SELECT at FROM metrics WHERE at>=? AND at<=?', (0, minute)).fetchall()
            self.assertTrue(any('SEARCH' in row[3] and 'INTEGER PRIMARY KEY' in row[3] for row in plan))
        self.expire_files()
        metrics.record_history(self.value(at=self.now + 60000, cpu=99.99))
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
            self.assertTrue(all(point['cpu']['max'] == 99.99 for point in frame['points']))
            self.assertTrue(all(point['requests']['max'] == 6000000000000000 for point in frame['points'] if point['requests'] is not None))
            self.assertLessEqual((self.public / ('history-' + name + '.json')).stat().st_size, 524288)
            size += (self.public / ('history-' + name + '.json')).stat().st_size
        self.assertLessEqual(size, 1572864)
        self.assertLess((self.private / 'metrics.sqlite').stat().st_size, 10000000)

    def test_history_failure_keeps_current_snapshot_successful(self):
        with patch.object(metrics.os, 'geteuid', return_value=0), patch.object(metrics, 'read_previous', return_value=None), \
                patch.object(metrics, 'sample', return_value=(self.value(), {'total': 100, 'idle': 50})), \
                patch.object(metrics, 'read_traffic', return_value=(None, None)), \
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
            db.executemany('INSERT OR REPLACE INTO metrics VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                           ((minute - i * 60000, 20, 1, 20, 20, minute - i * 60000, 2, 3, 5, 2, 30) for i in range(4000)))
        original = (self.public / 'history-day.json').read_bytes()
        self.expire_files()
        with patch.object(metrics.time, 'monotonic', side_effect=[0] + [9] * 100):
            with self.assertRaises(sqlite3.OperationalError):
                metrics.record_history(self.value(at=self.now + 60000))
        self.assertEqual((self.public / 'history-day.json').read_bytes(), original)

    def test_completed_request_minutes_keep_peaks_missing_and_true_zero(self):
        self.now = self.now // 120000 * 120000 + 130000
        at = self.now // 60000 * 60000 - 60000
        backend = {'ok': True, 'sampledAt': self.now, 'minutes': [
            {'at': at - 60000, 'direct': 2, 'bridge': 0, 'collection': 1},
            {'at': at, 'direct': 20, 'bridge': 5, 'collection': 3}]}
        collector = {'ok': True, 'sampledAt': self.now, 'minutes': [
            {'at': at - 60000, 'collection': 2}, {'at': at, 'collection': 7}],
            'activity': [{'at': at - 60000, 'activeUsers': 0, 'events': 0}, {'at': at, 'activeUsers': 3, 'events': 100}]}
        metrics.record_history(self.value(), (backend, collector))
        point = next(point for point in self.frame()['points'] if point['requests'])
        self.assertEqual(point['requests']['min'], 5)
        self.assertEqual(point['requests']['max'], 35)
        self.assertEqual(point['requests']['mean'], 20)
        self.assertEqual(point['requests']['peakAt'], at)
        self.assertEqual(point['activeUsers']['mean'], 1.5)
        self.assertEqual(point['events']['max'], 100)
        missing = metrics.minute_traffic(None, collector, self.now)
        self.assertTrue(all(all(value is None for value in row[1:4]) for row in missing))
        collector['activity'][1]['events'] = None
        self.assertIsNone(metrics.minute_traffic(backend, collector, self.now)[1][-1])
        self.assertFalse(metrics.minute_traffic({**backend, 'sampledAt': self.now - 70000}, None, self.now))

    def test_upgrade_removes_old_resource_columns_without_business_data(self):
        with closing(sqlite3.connect(self.private / 'metrics.sqlite')) as db, db:
            db.execute('CREATE TABLE metrics(at INTEGER PRIMARY KEY,memory_used_sum INTEGER)')
            db.execute('INSERT INTO metrics VALUES(1,123)')
        metrics.record_history(self.value())
        with closing(sqlite3.connect(self.private / 'metrics.sqlite')) as db:
            columns = [row[1] for row in db.execute('PRAGMA table_info(metrics)')]
        self.assertNotIn('memory_used_sum', columns)
        self.assertEqual(self.frame()['schemaVersion'], 2)

    def test_private_traffic_accepts_actual_container_token_owner_and_bounds_failures(self):
        from types import SimpleNamespace
        token = self.private / 'token'
        token.write_text('a' * 43 + '\n')
        original_open = os.open
        def opening(path, *args):
            return original_open(str(token) if path == '/etc/linkx-collector/admin.token' else path, *args)
        class Connection:
            def __init__(self, *args, **kwargs):
                self.closed = False
            def request(self, method, path, headers):
                self.path = path
                self.asserted = headers['Authorization'] == 'Bearer ' + 'a' * 43
                if not self.asserted:
                    raise ValueError()
            def getresponse(self):
                return SimpleNamespace(status=200, read=lambda size: json.dumps({'ok': True, 'sampledAt': self.now, 'minutes': []}).encode())
            def close(self):
                self.closed = True
        Connection.now = self.now
        with patch.object(metrics.os, 'open', side_effect=opening), \
                patch.object(metrics.os, 'fstat', return_value=SimpleNamespace(st_mode=0o100600, st_uid=1000, st_size=44)), \
                patch.object(metrics.http.client, 'HTTPConnection', Connection), patch.object(metrics, 'UnixHTTP', Connection):
            backend, collector = metrics.read_traffic()
            self.assertTrue(backend['ok'] and collector['ok'])
        with patch.object(metrics.os, 'open', side_effect=opening), \
                patch.object(metrics.os, 'fstat', return_value=SimpleNamespace(st_mode=0o100644, st_uid=1000, st_size=44)):
            self.assertEqual(metrics.read_traffic(), (None, None))


if __name__ == '__main__':
    unittest.main()
