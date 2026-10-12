"""Drain an entire category end-to-end:

1. Find every series whose sortId == category_id.
2. For each series: pull all episode details, register video/subtitle/cover URLs.
3. Download those resources with the same throttling as the global policy.

This is the same idea as drain_series.py + drain_one_series_download.py, but
applied to a category at a time so the user's priorities land in the right order.
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

from api import PRIVATE, Client
from download import Downloader, STAGING, CACHE
from drain_series import episodes_for_series, fetch_detail
from drain_one_series_download import stream, patch_resource, refresh_video, episode_for

CATALOG_DB = PRIVATE / 'catalogue.sqlite'


def db():
    conn = sqlite3.connect(str(CATALOG_DB), timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def series_in_category(category_id: int) -> list[tuple[int, str, int]]:
    with db() as conn:
        rows = conn.execute(r'''
            SELECT s.id, json_extract(s.body, '$.name') AS name,
              (SELECT COUNT(*) FROM episodes WHERE series_id = s.id) AS n
            FROM series s
            WHERE json_extract(s.body, '$.sortId') = ?
            ORDER BY n ASC, s.id
        ''', (category_id,)).fetchall()
    return [(r['id'], r['name'], r['n']) for r in rows]


def drain_series_full(client, series_id: int) -> int:
    eps = episodes_for_series(client, series_id)
    enqueued = 0
    for i, ep_id in enumerate(eps):
        detail = fetch_detail(client, ep_id)
        if not isinstance(detail, dict):
            continue
        from drain_series import upsert_episode, register_resource, link_resource
        upsert_episode(ep_id, detail)
        for field, kind in [('imgUrl', 'cover'), ('videoUrl', 'video'),
                            ('srtEnUrl', 'subtitle'), ('srtCnEnUrl', 'subtitle')]:
            url = detail.get(field)
            if not (isinstance(url, str) and url.startswith(('http://', 'https://'))):
                continue
            rid = register_resource(url, kind)
            link_resource(rid, ep_id, field)
            enqueued += 1
        if (i + 1) % 10 == 0:
            time.sleep(random.uniform(40, 70))
    return enqueued


def drain_one(rid: str, dl: Downloader, refresh_attempts: int = 0) -> bool:
    """Download one resource, retry on transport errors, refresh video on 403.

    refresh_attempts caps the recursion: if a refresh URL also 403s we don't
    loop forever refreshing the same episode.
    """
    with db() as conn:
        row = conn.execute(
            'SELECT id, url, kind FROM resources WHERE id=?', (rid,)).fetchone()
    if not row:
        return False
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
        print(f'  done {rid[:10]} ({kind}, {size} B)', flush=True)
        time.sleep(random.uniform(3, 6))
        return True
    if result == 403 and kind == 'video' and refresh_attempts < 2:
        ep_id = episode_for(rid)
        if ep_id:
            new_url = refresh_video(dl, rid, ep_id)
            if new_url:
                return drain_one(rid, dl, refresh_attempts + 1)
    err = 'transport error' if result is None else f'HTTP {result}'
    with db() as conn:
        conn.execute(
            "UPDATE resources SET state='failed', error=? WHERE id=?",
            (err, rid))
        conn.commit()
    print(f'  fail {rid[:10]} ({kind}, {err})', flush=True)
    return False


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


def download_series(dl: Downloader, series_id: int) -> tuple[int, int]:
    done = failed = 0
    while True:
        ids = pick(series_id, ('video', 'subtitle', 'cover'))
        if not ids:
            return done, failed
        if drain_one(ids[0], dl):
            done += 1
        else:
            failed += 1
        # Skip the rest-sleep on the very first iteration (0 % 10 == 0 was sleeping 30s for no reason)
        if done + failed > 0 and (done + failed) % 10 == 0:
            time.sleep(random.uniform(30, 60))


def main(category_id: int, do_drain: bool = True, do_download: bool = True):
    client = Client()
    dl = Downloader()
    series = series_in_category(category_id)
    print(f'category {category_id}: {len(series)} series', flush=True)
    for sid, name, n in series:
        print(f'\n=== series {sid}: {name} ({n} eps) ===', flush=True)
        if do_drain:
            n_registered = drain_series_full(client, sid)
            print(f'  drained {n_registered} resources', flush=True)
        if do_download:
            done, failed = download_series(dl, sid)
            print(f'  downloaded done={done} failed={failed}', flush=True)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--category-id', type=int, required=True)
    p.add_argument('--skip-drain', action='store_true')
    p.add_argument('--skip-download', action='store_true')
    args = p.parse_args()
    main(args.category_id, do_drain=not args.skip_drain,
         do_download=not args.skip_download)