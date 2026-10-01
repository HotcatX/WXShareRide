#!/usr/bin/env python3
import json
import http.client
import socket
import math
import os
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time

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


def docker(*arguments):
    result = subprocess.run(['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock',
                             '--config', PRIVATE, *arguments], capture_output=True, text=True,
                            timeout=4, check=True, env={'PATH': '/usr/bin:/bin',
                                                      'HOME': PRIVATE, 'LC_ALL': 'C', 'GOMEMLIMIT': '24MiB'})
    if len(result.stdout.encode()) > 8192:
        raise ValueError()
    return result.stdout.splitlines()


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
    for row in docker('stats', '--no-stream', '--format', '{{.Name}}|{{.CPUPerc}}', *names):
        name, cpu = row.split('|')
        if name not in CONTAINERS or name in usage:
            raise ValueError()
        percent = None if cpu == '--' else float(cpu.removesuffix('%'))
        if percent is not None and (not math.isfinite(percent) or not 0 <= percent <= 10000):
            raise ValueError()
        usage[name] = {'cpuPercent': percent}
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
    value = {'schemaVersion': 1, 'sampledAt': int(time.time() * 1000), 'uptimeSeconds': uptime,
             'cpu': {'percent': cpu_percent(current, previous), 'cores': cores},
             'services': container_snapshot()}
    return value, current


class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/var/lib/linkx-collector/run/admin.sock')


def read_traffic():
    try:
        descriptor = os.open('/etc/linkx-collector/admin.token', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'r', encoding='ascii') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 256 or info.st_uid not in (0, 1000) or info.st_mode & 0o077:
                return None, None
            token = source.read(257).strip()
        if not token or len(token) > 128 or any(char not in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-' for char in token):
            return None, None
    except (OSError, ValueError):
        return None, None
    results = []
    for connection, path in ((http.client.HTTPConnection('127.0.0.1', 3101, timeout=0.3), '/internal/v1/monitor'),
                             (UnixHTTP('localhost', timeout=0.3), '/v1/console/traffic')):
        try:
            connection.request('GET', path, headers={'Authorization': 'Bearer ' + token})
            response = connection.getresponse()
            raw = response.read(16385)
            if response.status != 200 or len(raw) > 16384:
                raise ValueError()
            value = json.loads(raw)
            if type(value) is not dict or value.get('ok') is not True or type(value.get('minutes')) is not list or len(value['minutes']) > 6:
                raise ValueError()
            results.append(value)
        except (OSError, ValueError, http.client.HTTPException):
            results.append(None)
        finally:
            connection.close()
    return tuple(results)


def numeric(value):
    return type(value) is int and 0 <= value <= 9007199254740991


def minute_traffic(backend, collector, now):
    end = now // 60000 * 60000
    def valid(source):
        return source if type(source) is dict and numeric(source.get('sampledAt')) and abs(source['sampledAt'] - now) <= 60000 else {}
    backend, collector = valid(backend), valid(collector)
    direct = {row['at']: row for row in backend.get('minutes', []) if type(row) is dict and all(numeric(row.get(key)) for key in ('at', 'direct', 'bridge', 'collection'))}
    incoming = {row['at']: row for row in collector.get('minutes', []) if type(row) is dict and all(numeric(row.get(key)) for key in ('at', 'collection'))}
    activity = {row['at']: row for row in collector.get('activity', []) if type(row) is dict and numeric(row.get('at'))}
    values = []
    for at in sorted(set(direct) | set(incoming) | set(activity)):
        if not end - 360000 <= at < end or at % 60000:
            continue
        left, right, user = direct.get(at), incoming.get(at), activity.get(at, {})
        counts = (left['direct'], left['bridge'], left['collection'] + right['collection']) if left and right else (None, None, None)
        if counts[0] is not None and (not all(numeric(number) for number in counts) or not numeric(sum(counts))):
            counts = (None, None, None)
        active, events = user.get('activeUsers'), user.get('events')
        values.append((at, *counts, active if numeric(active) else None, events if numeric(events) else None))
    return values


def summary(row, offset, count, peak):
    mean, minimum, maximum = row[offset:offset + 3]
    if not count or mean is None:
        return None
    return {'mean': round(mean, 3), 'min': minimum, 'max': maximum,
            'peakAt': int(peak.split(':')[1]), 'samples': count}


def record_history(value, traffic=(None, None)):
    now = value['sampledAt']
    minute = now // 60000 * 60000
    path = PRIVATE + '/metrics.sqlite'
    if os.path.lexists(path):
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
            raise ValueError()
    deadline = time.monotonic() + 8
    connection = sqlite3.connect(path, timeout=0.1)
    try:
        os.chmod(path, 0o600)
        connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 2000)
        connection.execute('PRAGMA cache_size=-512')
        page_size = connection.execute('PRAGMA page_size').fetchone()[0]
        connection.execute('PRAGMA max_page_count=' + str(16777216 // page_size))
        columns = [row[1] for row in connection.execute('PRAGMA table_info(metrics)')]
        if columns and 'memory_used_sum' in columns:
            connection.execute('DROP TABLE metrics')
        connection.execute('''CREATE TABLE IF NOT EXISTS metrics (
            at INTEGER PRIMARY KEY, cpu_sum REAL NOT NULL DEFAULT 0, cpu_count INTEGER NOT NULL DEFAULT 0,
            cpu_min REAL, cpu_max REAL, cpu_peak INTEGER,
            direct INTEGER, bridge INTEGER, collection INTEGER, active INTEGER, events INTEGER)''')
        cpu = value['cpu']['percent']
        with connection:
            connection.execute('''INSERT INTO metrics(at,cpu_sum,cpu_count,cpu_min,cpu_max,cpu_peak) VALUES(?,?,?,?,?,?)
                ON CONFLICT(at) DO UPDATE SET cpu_sum=cpu_sum+excluded.cpu_sum,cpu_count=cpu_count+excluded.cpu_count,
                cpu_min=CASE WHEN excluded.cpu_min IS NULL THEN cpu_min WHEN cpu_min IS NULL THEN excluded.cpu_min ELSE MIN(cpu_min,excluded.cpu_min) END,
                cpu_max=CASE WHEN excluded.cpu_max IS NULL THEN cpu_max WHEN cpu_max IS NULL THEN excluded.cpu_max ELSE MAX(cpu_max,excluded.cpu_max) END,
                cpu_peak=CASE WHEN excluded.cpu_max IS NOT NULL AND (cpu_max IS NULL OR excluded.cpu_max>cpu_max) THEN excluded.cpu_peak ELSE cpu_peak END''',
                (minute, cpu if cpu is not None else 0, int(cpu is not None), cpu, cpu, now if cpu is not None else None))
            for row in minute_traffic(*traffic, now):
                connection.execute('''INSERT INTO metrics(at,direct,bridge,collection,active,events) VALUES(?,?,?,?,?,?)
                    ON CONFLICT(at) DO UPDATE SET direct=COALESCE(metrics.direct,excluded.direct),bridge=COALESCE(metrics.bridge,excluded.bridge),
                    collection=COALESCE(metrics.collection,excluded.collection),active=COALESCE(metrics.active,excluded.active),events=COALESCE(metrics.events,excluded.events)''', row)
            connection.execute('DELETE FROM metrics WHERE at<=?', (minute - 2592000000,))
        if all(os.path.isfile(PUBLIC + '/history-' + name + '.json')
               and int(os.stat(PUBLIC + '/history-' + name + '.json').st_mtime * 1000) // 60000 == now // 60000
               for name, _, _ in RANGES):
            return
        for name, duration, bucket in RANGES:
            start = max(0, now - duration)
            rows = connection.execute('''SELECT MAX(?,(at / ?) * ?) AS bucket,
                SUM(cpu_sum)/NULLIF(SUM(cpu_count),0),MIN(cpu_min),MAX(cpu_max),SUM(cpu_count),
                MAX(CASE WHEN cpu_max IS NOT NULL THEN printf('%012.6f:%013d',cpu_max,cpu_peak) END),
                AVG(direct+bridge+collection),MIN(direct+bridge+collection),MAX(direct+bridge+collection),COUNT(direct+bridge+collection),
                MAX(CASE WHEN direct+bridge+collection IS NOT NULL THEN printf('%016d:%013d',direct+bridge+collection,at) END),
                AVG(CASE WHEN direct+bridge+collection IS NOT NULL THEN direct END),AVG(CASE WHEN direct+bridge+collection IS NOT NULL THEN bridge END),AVG(CASE WHEN direct+bridge+collection IS NOT NULL THEN collection END),
                AVG(active),MIN(active),MAX(active),COUNT(active),MAX(CASE WHEN active IS NOT NULL THEN printf('%016d:%013d',active,at) END),
                AVG(events),MIN(events),MAX(events),COUNT(events),MAX(CASE WHEN events IS NOT NULL THEN printf('%016d:%013d',events,at) END)
                FROM metrics WHERE at>=? AND at<=? GROUP BY (at / ?) ORDER BY bucket DESC LIMIT 720''',
                (start, bucket, bucket, start, now, bucket)).fetchall()
            points = []
            for row in reversed(rows):
                request = summary(row, 6, row[9], row[10])
                if request:
                    request.update(direct=round(row[11], 3), bridge=round(row[12], 3), collection=round(row[13], 3))
                points.append({'at': row[0], 'cpu': summary(row, 1, row[4], row[5]), 'requests': request,
                               'activeUsers': summary(row, 14, row[17], row[18]), 'events': summary(row, 19, row[22], row[23])})
            frame = {'schemaVersion': 2, 'range': name, 'sampledAt': now, 'from': start, 'to': now, 'bucketMs': bucket, 'points': points}
            atomic_json(PUBLIC, 'history-' + name + '.json', frame, 0o644, 524288)
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
            record_history(value, read_traffic())
        except Exception:
            sys.stderr.write('HOST_HISTORY_UNAVAILABLE\n')
        return 0
    except Exception:
        sys.stderr.write('HOST_METRICS_UNAVAILABLE\n')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
