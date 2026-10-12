"""Download pending resources, verify, and place via Layout.

This client only fetches the media URLs already recorded by the catalogue
crawler. When a video URL has expired, it refreshes the URL through the
authenticated API by re-reading the corresponding episode detail.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import re
import sqlite3
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from api import Client, PRIVATE, ROOT
from layout import Layout

STAGING = PRIVATE / 'staging'
CACHE = PRIVATE / 'cache'
AUTH_QUERY = re.compile(r'auth_key=(\d+)')


class Downloader:
    def __init__(self):
        self.client = Client()
        self.db = sqlite3.connect(PRIVATE / 'catalogue.sqlite')
        self.layout = Layout(self.db)
        STAGING.mkdir(parents=True, exist_ok=True)
        CACHE.mkdir(parents=True, exist_ok=True)
        self.policy = json.loads((ROOT / 'rate-policy.json').read_text())
        self.opener = urllib.request.build_opener()
        self.window_start = time.monotonic()
        self.window_bytes = 0
        self.completed = 0
        self.refreshed = 0

    def pause(self, byte_count: int) -> None:
        """Throttle to the policy's bytes-per-second ceiling.

        Tracks total bytes inside a sliding 1-second window. Sleeping only happens
        when the window itself exceeds the budget; chunk-instantaneous spikes do
        not trigger a sleep, so large files download at the configured rate.
        """
        self.window_bytes += byte_count
        now = time.monotonic()
        elapsed = now - self.window_start
        budget = self.policy['download_bytes_per_second']
        if elapsed >= 1:
            # Past the window boundary: subtract whatever overflowed, reset
            overflow = max(0, self.window_bytes - budget)
            self.window_start = now
            self.window_bytes = max(0, byte_count - overflow)
            return
        if self.window_bytes > budget:
            time.sleep(1 - elapsed)
            self.window_start = time.monotonic()
            self.window_bytes = 0

    def gap(self) -> None:
        time.sleep(random.uniform(*self.policy['download_gap_seconds']))
        self.completed += 1
        if self.completed and self.completed % self.policy['reads_per_batch'] == 0:
            time.sleep(random.uniform(*self.policy['batch_rest_seconds']))

    def free_space(self) -> int:
        st = os.statvfs(self.layout.root)
        return st.f_bavail * st.f_frsize

    def extension(self, url: str) -> str:
        path = url.split('?', 1)[0]
        ext = Path(path).suffix.lower()
        return ext if ext else '.bin'

    def refresh_video(self, resource_id: str, episode_id: int) -> str | None:
        """Re-read the episode detail to obtain a fresh signed video URL."""
        data = self.client.read('/app-api/player/video-diversity/get2',
                                {'id': str(episode_id), 'type': '2'})
        url = data.get('videoUrl') if isinstance(data, dict) else None
        if not isinstance(url, str) or not url.startswith(('http://', 'https://')):
            return None
        self.db.execute('UPDATE resources SET url=? WHERE id=?', (url, resource_id))
        self.db.commit()
        self.refreshed += 1
        return url

    def stream(self, url: str, target: Path, on_progress: callable | None = None) -> tuple[int, str] | int | None:
        try:
            host = (urlsplit(url).hostname or '').lower()
            if host.endswith(('aliyuncs.com', 'bbketang.com')):
                referer = 'https://www.bbketang.com/'
                ua = 'curl/8.0'
            elif host.endswith('bilivideo.com'):
                # B站 UPOS returns 403 with curl-style UA; needs browser-like UA.
                # Also throttles per-IP so we still get ~50 KB/s per stream.
                referer = ''
                ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
            else:
                referer = ''
                ua = 'curl/8.0'
            headers = {'User-Agent': ua}
            if referer:
                headers['Referer'] = referer
            req = urllib.request.Request(url, headers=headers)
            t_start = time.monotonic()
            last_tick = [t_start, 0]  # timestamp, bytes-since-last-tick
            with self.opener.open(req, timeout=60) as response:
                sha = hashlib.sha256()
                size = 0
                with target.open('wb') as f:
                    while True:
                        chunk = response.read(64 * 1024)
                        if not chunk:
                            break
                        sha.update(chunk)
                        size += len(chunk)
                        f.write(chunk)
                        self.pause(len(chunk))
                        if on_progress:
                            now = time.monotonic()
                            if now - last_tick[0] >= 0.4:
                                speed = (size - last_tick[1]) / (now - last_tick[0])
                                on_progress(size, speed)
                                last_tick = [now, size]
                if on_progress:
                    on_progress(size, 0.0)
                return size, sha.hexdigest()
        except urllib.error.HTTPError as exc:
            return exc.code
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            return None

    def episode_for(self, resource_id: str) -> tuple[str, int] | None:
        row = self.db.execute(
            "SELECT entity_type,entity_id FROM resource_links WHERE resource_id=? "
            "AND entity_type='episode' LIMIT 1", (resource_id,)).fetchone()
        return row if row else None

    def update_resource(self, resource_id: str, **fields) -> None:
        if not fields:
            return
        assignments = ','.join(f'{k}=?' for k in fields)
        values = list(fields.values()) + [resource_id]
        self.db.execute(f'UPDATE resources SET {assignments} WHERE id=?', values)
        self.db.commit()

    def emit(self, event) -> None:
        event['time'] = time.time()
        with (ROOT / 'download-events.jsonl').open('a', encoding='utf8') as f:
            f.write(json.dumps(event, ensure_ascii=False) + '\n')

    def status(self) -> dict:
        out = {
            'updated_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
            'resources': {s: n for s, n in self.db.execute(
                'SELECT state,COUNT(*) FROM resources GROUP BY state')},
            'pending_kinds': {k: n for k, n in self.db.execute(
                "SELECT kind,COUNT(*) FROM resources WHERE state='pending' GROUP BY kind")},
            'downloaded_bytes': self.db.execute(
                "SELECT COALESCE(SUM(bytes),0) FROM resources WHERE state='done'").fetchone()[0],
            'refreshed_urls': self.refreshed,
            'free_bytes': self.free_space(),
        }
        tmp = ROOT / 'download-status.json.tmp'
        tmp.write_text(json.dumps(out, ensure_ascii=False, indent=2))
        tmp.replace(ROOT / 'download-status.json')
        return out

    def print_status(self) -> None:
        print(json.dumps(self.status(), ensure_ascii=False), flush=True)

    def pick(self) -> tuple | None:
        for kind in ('cover', 'subtitle', 'video'):
            row = self.db.execute(
                "SELECT id,url FROM resources WHERE state='pending' AND kind=? "
                "ORDER BY id LIMIT 1", (kind,)).fetchone()
            if row:
                return row
        return None

    def run(self) -> None:
        self.print_status()
        while True:
            if self.free_space() < self.policy['free_space_reserve_bytes']:
                self.emit({'event': 'space_pause', 'free': self.free_space()})
                time.sleep(300)
                continue
            row = self.pick()
            if row is None:
                self.print_status()
                time.sleep(15)
                row = self.pick()
                if row is None:
                    self.print_status()
                    return
            resource_id, url = row
            ext = self.extension(url)
            staging_target = STAGING / f'{resource_id}{ext}'
            self.update_resource(resource_id, state='running', error=None)
            result = self.stream(url, staging_target)
            # Auto-retry transient transport errors twice before recording failure.
            attempts = 0
            while result is None and attempts < 2:
                attempts += 1
                time.sleep(2)
                staging_target.unlink(missing_ok=True)
                result = self.stream(url, staging_target)
            if isinstance(result, tuple):
                size, digest = result
                cache_target = CACHE / f'{resource_id}{ext}'
                os.replace(staging_target, cache_target)
                self.update_resource(resource_id, state='done', local_path=None,
                                     bytes=size, sha256=digest, error=None)
                self.layout.place(resource_id, cache_target)
                self.emit({'event': 'done', 'id': resource_id, 'kind': ext, 'bytes': size})
                self.gap()
            elif result == 403:
                link = self.episode_for(resource_id)
                if link and link[0] == 'episode':
                    try:
                        new_url = self.refresh_video(resource_id, link[1])
                    except Exception as exc:
                        self.update_resource(resource_id, state='failed',
                                             error=f'refresh: {type(exc).__name__}')
                        self.print_status()
                        continue
                    if new_url:
                        self.update_resource(resource_id, state='pending', error=None)
                        continue
                self.update_resource(resource_id, state='failed', error='403 without refresh path')
            elif result is None:
                self.update_resource(resource_id, state='failed',
                                     error=f'transport error after {attempts+1} tries')
            else:
                self.update_resource(resource_id, state='failed', error=f'HTTP {result}')
            self.print_status()


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--once', action='store_true', help='Process one resource then quit')
    p.add_argument('--refresh', action='store_true',
                   help='Refresh all video URLs that have auth_key older than 1 hour')
    args = p.parse_args()
    dl = Downloader()
    if args.once:
        row = dl.pick()
        if row:
            ext = dl.extension(row[1])
            r = dl.stream(row[1], STAGING / f'{row[0]}{ext}')
            print(json.dumps({'id': row[0], 'result': str(r)}, ensure_ascii=False))
    else:
        dl.run()