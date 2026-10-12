"""Download every pending resource linked to a single series.

Used after drain_series.py has populated video URLs. Processes everything
sequentially in priority order (video → subtitle → cover) with the same
throttle as the bulk downloader, but ignores the global queue so a
small series can be finished quickly.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sqlite3
import time
import urllib.request
import urllib.error
from pathlib import Path
from urllib.parse import urlsplit

from api import PRIVATE
from download import Downloader, STAGING, CACHE

CATALOG_DB = PRIVATE / 'catalogue.sqlite'


def db():
    conn = sqlite3.connect(str(CATALOG_DB), timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def pick(series_id: int, kinds: tuple[str, ...]) -> list[str]:
    with db() as conn:
        rows = conn.execute(f'''
            SELECT r.id FROM resources r
            JOIN resource_links l ON l.resource_id = r.id
            WHERE l.entity_type='episode'
              AND l.entity_id IN (SELECT id FROM episodes WHERE series_id = ?)
              AND r.state='pending'
              AND r.kind IN ({','.join('?' * len(kinds))})
            ORDER BY CASE r.kind
                WHEN 'video' THEN 0
                WHEN 'subtitle' THEN 1
                WHEN 'cover' THEN 2
                ELSE 3 END, r.id
        ''', (series_id, *kinds)).fetchall()
    return [r['id'] for r in rows]


def patch_resource(resource_id: str, ext: str, src: Path) -> None:
    import hashlib
    size = src.stat().st_size
    sha = hashlib.sha256(src.read_bytes()).hexdigest()
    cache = CACHE / f'{resource_id}{ext}'
    os.replace(src, cache)
    with db() as conn:
        conn.execute(
            "UPDATE resources SET state='done', bytes=?, sha256=?, local_path=NULL, error=NULL, attempts=0 WHERE id=?",
            (size, sha, resource_id))
        conn.commit()


def stream(dl, url, target, on_progress=None):
    try:
        host = (urlsplit(url).hostname or '').lower()
        if host.endswith(('aliyuncs.com', 'bbketang.com')):
            referer = 'https://www.bbketang.com/'
            ua = 'curl/8.0'
        elif host.endswith('bilivideo.com'):
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
        last = [t_start, 0]
        with dl.opener.open(req, timeout=60) as resp:
            import hashlib
            sha = hashlib.sha256()
            size = 0
            with target.open('wb') as f:
                while True:
                    chunk = resp.read(64 * 1024)
                    if not chunk:
                        break
                    sha.update(chunk)
                    size += len(chunk)
                    f.write(chunk)
                    dl.pause(len(chunk))
                    if on_progress:
                        now = time.monotonic()
                        if now - last[0] >= 0.4:
                            speed = (size - last[1]) / max(now - last[0], 0.001)
                            on_progress(size, speed)
                            last = [now, size]
            return size, sha.hexdigest()
    except urllib.error.HTTPError as exc:
        return exc.code
    except (urllib.error.URLError, TimeoutError, OSError):
        return None


def refresh_video(dl, resource_id, episode_id):
    try:
        data = dl.client.read('/app-api/player/video-diversity/get2',
                              {'id': str(episode_id), 'type': '2'})
        url = data.get('videoUrl') if isinstance(data, dict) else None
        if not (isinstance(url, str) and url.startswith(('http://', 'https://'))):
            return None
        with db() as conn:
            conn.execute('UPDATE resources SET url=? WHERE id=?', (url, resource_id))
            conn.commit()
        return url
    except Exception:
        return None


def episode_for(resource_id):
    with db() as conn:
        row = conn.execute(
            "SELECT entity_id FROM resource_links WHERE resource_id=? AND entity_type='episode' LIMIT 1",
            (resource_id,)).fetchone()
    return row['entity_id'] if row else None


def main(series_id: int):
    policy = json.loads((PRIVATE.parent / 'rate-policy.json').read_text())
    dl = Downloader()
    total = 0
    done = 0
    failed = 0
    refresh_seen: dict[str, int] = {}

    while True:
        ids = pick(series_id, ('video', 'subtitle', 'cover'))
        if not ids:
            print(f'\n全部完成：done={done} failed={failed} total={total}', flush=True)
            return
        total += 1
        rid = ids[0]
        with db() as conn:
            row = conn.execute(
                'SELECT id, url, kind FROM resources WHERE id=?', (rid,)).fetchone()
        if not row:
            continue
        url = row['url']
        kind = row['kind']
        ext = '.jpg' if kind == 'cover' else ('.mp4' if kind == 'video' else '.srt')
        target = STAGING / f'{rid}{ext}'

        attempts = 0
        result = stream(dl, url, target)
        while result is None and attempts < 2:
            attempts += 1
            time.sleep(2)
            target.unlink(missing_ok=True)
            result = stream(dl, url, target)

        if isinstance(result, tuple):
            size, digest = result
            patch_resource(rid, ext, target)
            dl.layout.place(rid, CACHE / f'{rid}{ext}')
            done += 1
            print(f'  done {rid[:10]} ({kind}, {size} B)', flush=True)
            refresh_seen.pop(rid, None)
            time.sleep(random.uniform(3, 6))
            if done % 10 == 0:
                time.sleep(random.uniform(30, 60))
            continue

        if result == 403 and kind == 'video':
            ep_id = episode_for(rid)
            if ep_id and refresh_seen.get(rid, 0) < 2:
                new_url = refresh_video(dl, rid, ep_id)
                if new_url:
                    refresh_seen[rid] = refresh_seen.get(rid, 0) + 1
                    with db() as conn:
                        conn.execute(
                            "UPDATE resources SET state='pending', error=NULL WHERE id=?",
                            (rid,))
                        conn.commit()
                    continue

        err = 'transport error' if result is None else f'HTTP {result}'
        with db() as conn:
            conn.execute(
                "UPDATE resources SET state='failed', error=? WHERE id=?",
                (err, rid))
            conn.commit()
        refresh_seen.pop(rid, None)
        failed += 1
        print(f'  fail {rid[:10]} ({kind}, {err})', flush=True)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--series-id', type=int, required=True)
    args = p.parse_args()
    main(args.series_id)