#!/usr/bin/env python3
import json
import math
import os
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from decimal import Decimal, InvalidOperation

BASE = '/opt/linkx-monitor'
PUBLIC = BASE + '/public'
PRIVATE = BASE + '/private'
CONTAINERS = {
    'linkx-backend-backend-1': 'backend',
    'linkx-backend-database-1': 'database',
    'linkx-collector-collector-1': 'collector',
    'linkx-collector-caddy-1': 'caddy',
}
RANGES = (('day', 86400000, 120000), ('week', 604800000, 900000), ('month', 2592000000, 3600000))


def cpu_snapshot():
    with open('/proc/stat', encoding='ascii') as source:
        lines = source.readlines()
    values = [int(value) for value in lines[0].split()[1:9]]
    if len(values) != 8 or any(value < 0 for value in values):
        raise ValueError()
    cores = sum(line.split()[0][3:].isdigit() for line in lines if line.startswith('cpu'))
    if not 1 <= cores <= 1024:
        raise ValueError()
    return {'total': sum(values), 'idle': values[3] + values[4]}, cores


def cpu_percent(current, previous):
    if type(previous) is not dict or set(previous) != {'total', 'idle'}:
        return None
    if any(type(value) is not int or value < 0 for value in previous.values()):
        return None
    total = current['total'] - previous['total']
    idle = current['idle'] - previous['idle']
    if total <= 0 or idle < 0 or idle > total:
        return None
    return round(100 * (total - idle) / total, 2)


def memory_snapshot():
    values = {}
    with open('/proc/meminfo', encoding='ascii') as source:
        for line in source:
            key, _, value = line.partition(':')
            if key in ('MemTotal', 'MemAvailable'):
                values[key] = int(value.split()[0]) * 1024
    if not 0 <= values['MemAvailable'] <= values['MemTotal'] or values['MemTotal'] <= 0:
        raise ValueError()
    return {'totalBytes': values['MemTotal'], 'availableBytes': values['MemAvailable']}


def docker(*arguments):
    result = subprocess.run(['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock',
                             '--config', PRIVATE, *arguments], capture_output=True, text=True,
                            timeout=4, check=True, env={'PATH': '/usr/bin:/bin',
                                                      'HOME': PRIVATE, 'LC_ALL': 'C', 'GOMEMLIMIT': '24MiB'})
    if len(result.stdout.encode()) > 8192:
        raise ValueError()
    return result.stdout.splitlines()


def byte_size(value):
    units = {'B': 1, 'KB': 1000, 'MB': 1000 ** 2, 'GB': 1000 ** 3, 'TB': 1000 ** 4,
             'KiB': 1024, 'MiB': 1024 ** 2, 'GiB': 1024 ** 3, 'TiB': 1024 ** 4}
    for unit in sorted(units, key=len, reverse=True):
        if value.endswith(unit):
            try:
                number = Decimal(value[:-len(unit)])
                if number.is_finite() and number >= 0:
                    size = int(number * units[unit])
                    if size <= 9007199254740991:
                        return size
            except (InvalidOperation, ValueError, OverflowError):
                pass
            raise ValueError()
    raise ValueError()


def container_snapshot():
    names = tuple(CONTAINERS)
    columns = ('{{.Name}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'
               '|{{.State.StartedAt}}|{{.RestartCount}}')
    inspected = {}
    for row in docker('inspect', '--format', columns, *names):
        name, state, started, restarts = row.split('|')
        name = name.lstrip('/')
        if name not in CONTAINERS or name in inspected or not state.replace('_', '').isalnum():
            raise ValueError()
        inspected[name] = {'name': CONTAINERS[name], 'state': state,
                           'startedAt': None if started.startswith('0001-') else started,
                           'restarts': int(restarts)}
    usage = {}
    for row in docker('stats', '--no-stream', '--format', '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}', *names):
        name, cpu, memory = row.split('|')
        if name not in CONTAINERS or name in usage:
            raise ValueError()
        percent = None if cpu == '--' else float(cpu.removesuffix('%'))
        if percent is not None and (not math.isfinite(percent) or not 0 <= percent <= 10000):
            raise ValueError()
        used, limit = memory.split(' / ')
        usage[name] = {'cpuPercent': percent, 'memoryBytes': byte_size(used), 'memoryLimitBytes': byte_size(limit)}
    if set(inspected) != set(CONTAINERS) or set(usage) != set(CONTAINERS):
        raise ValueError()
    return [{**inspected[name], **usage[name]} for name in names]


def read_previous():
    try:
        descriptor = os.open(PRIVATE + '/state.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 512 or info.st_uid != 0:
                return None
            return json.loads(source.read(513))
    except (OSError, ValueError):
        return None


def atomic_json(directory, name, value, mode, max_bytes=16384):
    raw = json.dumps(value, ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode()
    if len(raw) > max_bytes:
        raise ValueError()
    descriptor, temporary = tempfile.mkstemp(prefix='.snapshot-', dir=directory)
    try:
        with os.fdopen(descriptor, 'wb') as target:
            os.fchmod(target.fileno(), mode)
            target.write(raw)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, directory + '/' + name)
        parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def sample(previous):
    current, cores = cpu_snapshot()
    with open('/proc/uptime', encoding='ascii') as source:
        uptime = math.floor(float(source.read(128).split()[0]))
    disk = shutil.disk_usage('/')
    value = {'schemaVersion': 1, 'sampledAt': int(time.time() * 1000), 'uptimeSeconds': uptime,
             'cpu': {'percent': cpu_percent(current, previous), 'cores': cores},
             'memory': memory_snapshot(), 'disk': {'totalBytes': disk.total, 'availableBytes': disk.free},
             'services': container_snapshot()}
    return value, current


def record_history(value):
    now = value['sampledAt']
    minute = now // 60000 * 60000
    path = PRIVATE + '/metrics.sqlite'
    if os.path.lexists(path):
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
            raise ValueError()
    deadline = time.monotonic() + 1.5
    connection = sqlite3.connect(path, timeout=0.1)
    try:
        os.chmod(path, 0o600)
        connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 2000)
        connection.execute('PRAGMA cache_size=-512')
        page_size = connection.execute('PRAGMA page_size').fetchone()[0]
        connection.execute('PRAGMA max_page_count=' + str(16777216 // page_size))
        connection.execute('''CREATE TABLE IF NOT EXISTS metrics (
            at INTEGER PRIMARY KEY, cpu_sum REAL NOT NULL, cpu_count INTEGER NOT NULL,
            samples INTEGER NOT NULL, memory_used_sum INTEGER NOT NULL, memory_total_sum INTEGER NOT NULL,
            disk_used_sum INTEGER NOT NULL, disk_total_sum INTEGER NOT NULL)''')
        previous = connection.execute('SELECT at FROM metrics ORDER BY at DESC LIMIT 1').fetchone()
        cpu = value['cpu']['percent']
        memory, disk = value['memory'], value['disk']
        with connection:
            connection.execute('''INSERT INTO metrics VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(at) DO UPDATE SET
                cpu_sum=cpu_sum+excluded.cpu_sum,cpu_count=cpu_count+excluded.cpu_count,
                samples=samples+1,memory_used_sum=memory_used_sum+excluded.memory_used_sum,
                memory_total_sum=memory_total_sum+excluded.memory_total_sum,
                disk_used_sum=disk_used_sum+excluded.disk_used_sum,disk_total_sum=disk_total_sum+excluded.disk_total_sum''',
                (minute, cpu if cpu is not None else 0, int(cpu is not None), 1,
                 memory['totalBytes'] - memory['availableBytes'], memory['totalBytes'],
                 disk['totalBytes'] - disk['availableBytes'], disk['totalBytes']))
            if not previous or previous[0] != minute:
                connection.execute('DELETE FROM metrics WHERE at<=?', (minute - 2592000000,))
        if all(os.path.isfile(PUBLIC + '/history-' + name + '.json')
               and int(os.stat(PUBLIC + '/history-' + name + '.json').st_mtime * 1000) // 60000 == now // 60000
               for name, _, _ in RANGES):
            return
        frames = []
        for name, duration, bucket in RANGES:
            start = max(0, now - duration)
            rows = connection.execute('''SELECT MAX(?,(at / ?) * ?) AS bucket,
                CASE WHEN SUM(cpu_count)>0 THEN SUM(cpu_sum)/SUM(cpu_count) ELSE NULL END,
                CAST(SUM(memory_used_sum) AS REAL)/SUM(samples),CAST(SUM(memory_total_sum) AS REAL)/SUM(samples),
                CAST(SUM(disk_used_sum) AS REAL)/SUM(samples),CAST(SUM(disk_total_sum) AS REAL)/SUM(samples)
                FROM metrics WHERE at>=? AND at<=? GROUP BY (at / ?) ORDER BY bucket DESC LIMIT 720''',
                (start, bucket, bucket, start, now, bucket)).fetchall()
            points = [{'at': row[0], 'cpuPercent': None if row[1] is None else round(row[1], 2),
                       'memoryUsedBytes': round(row[2]), 'memoryTotalBytes': round(row[3]),
                       'diskUsedBytes': round(row[4]), 'diskTotalBytes': round(row[5])} for row in reversed(rows)]
            frames.append({'schemaVersion': 1, 'range': name, 'sampledAt': now, 'from': start, 'to': now, 'points': points})
        if sum(len(json.dumps(frame, separators=(',', ':'), allow_nan=False).encode()) for frame in frames) > 524288:
            raise ValueError()
        for frame in frames:
            atomic_json(PUBLIC, 'history-' + frame['range'] + '.json', frame, 0o644, 524288)
    finally:
        connection.close()


def main():
    if len(sys.argv) != 1 or os.geteuid() != 0:
        return 1
    os.umask(0o077)
    try:
        for path, mode in ((PUBLIC, 0o755), (PRIVATE, 0o700)):
            os.makedirs(path, mode=mode, exist_ok=True)
            info = os.lstat(path)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0:
                raise ValueError()
            os.chmod(path, mode)
        value, current = sample(read_previous())
        atomic_json(PUBLIC, 'host.json', value, 0o644)
        atomic_json(PRIVATE, 'state.json', current, 0o600)
        try:
            record_history(value)
        except Exception:
            sys.stderr.write('HOST_HISTORY_UNAVAILABLE\n')
        return 0
    except Exception:
        sys.stderr.write('HOST_METRICS_UNAVAILABLE\n')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
