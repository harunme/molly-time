"""Drain a single series: fetch each episode's detail, then enqueue all linked
resources through the web worker so the UI shows them as running.

Use this to prioritise one series ahead of the global crawl. The web worker
shares the same catalogue.sqlite, so resources added here are picked up by
either the bulk downloader or the web-triggered worker.
"""
from __future__ import annotations

import argparse
import json
import random
import sqlite3
import time
import urllib.request
import urllib.error
from pathlib import Path

from api import Client, PRIVATE

CATALOG_DB = PRIVATE / 'catalogue.sqlite'
EPISODE_BATCH_LIMIT = 10
BATCH_REST = (40, 70)  # seconds; bigger than the global policy to be a polite citizen


def db():
    conn = sqlite3.connect(str(CATALOG_DB), timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def series_id_by_query(client: Client, name_substr: str) -> int | None:
    """Look up the series ID by name substring via the catalog API."""
    data = client.read('/app-api/player/video-category/page',
                       {'pageNo': '1', 'pageSize': '100'})
    cats = data.get('list', []) if isinstance(data, dict) else []
    cat_id = None
    for c in cats:
        if name_substr in (c.get('name') or ''):
            cat_id = c['id']
            break
    if cat_id is None:
        return None
    data = client.read('/app-api/player/video-info/page',
                       {'sortId': str(cat_id), 'pageNo': '1', 'pageSize': '500'})
    items = data.get('list', []) if isinstance(data, dict) else []
    for s in items:
        if name_substr in (s.get('name') or ''):
            return s['id']
    return None


def episodes_for_series(client: Client, series_id: int) -> list[int]:
    out: list[int] = []
    page = 1
    while True:
        data = client.read('/app-api/player/video-diversity/page',
                           {'videoId': str(series_id), 'pageNo': str(page), 'pageSize': '500'})
        items = data.get('list', []) if isinstance(data, dict) else []
        for item in items:
            if isinstance(item.get('id'), int):
                out.append(item['id'])
        total = data.get('total') if isinstance(data, dict) else 0
        if page * 500 >= total or not items:
            break
        page += 1
    return out


def fetch_detail(client: Client, episode_id: int) -> dict | None:
    try:
        return client.read('/app-api/player/video-diversity/get2',
                           {'id': str(episode_id), 'type': '2'})
    except Exception as exc:
        print(f'  detail {episode_id}: {type(exc).__name__}: {exc}', flush=True)
        return None


def upsert_episode(episode_id: int, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False)
    with db() as conn:
        conn.execute(
            'INSERT INTO episodes(id, series_id, body, detail) VALUES (?, ?, ?, 1) '
            'ON CONFLICT(id) DO UPDATE SET body=excluded.body, detail=1',
            (payload['id'], payload['videoId'], body),
        )
        conn.commit()


def register_resource(url: str, kind: str) -> str:
    import hashlib
    h = hashlib.sha256(url.encode()).hexdigest()
    with db() as conn:
        conn.execute(
            'INSERT OR IGNORE INTO resources(id, url, kind) VALUES (?, ?, ?)',
            (h, url, kind),
        )
        conn.commit()
    return h


def link_resource(resource_id: str, episode_id: int, field: str) -> None:
    with db() as conn:
        conn.execute(
            'INSERT OR IGNORE INTO resource_links VALUES (?, ?, ?, ?)',
            (resource_id, 'episode', episode_id, field),
        )
        conn.commit()


def drain(client: Client, series_id: int) -> int:
    eps = episodes_for_series(client, series_id)
    print(f'发现 {len(eps)} 集', flush=True)
    enqueued = 0
    for i, ep_id in enumerate(eps):
        detail = fetch_detail(client, ep_id)
        if not isinstance(detail, dict):
            continue
        upsert_episode(ep_id, detail)
        for field, kind in [('imgUrl', 'cover'), ('videoUrl', 'video'),
                            ('srtEnUrl', 'subtitle'), ('srtCnEnUrl', 'subtitle')]:
            url = detail.get(field)
            if not (isinstance(url, str) and url.startswith(('http://', 'https://'))):
                continue
            rid = register_resource(url, kind)
            link_resource(rid, ep_id, field)
            enqueued += 1
        if (i + 1) % EPISODE_BATCH_LIMIT == 0:
            rest = random.uniform(*BATCH_REST)
            print(f'  已拉 {i+1}/{len(eps)}，休息 {rest:.0f}s', flush=True)
            time.sleep(rest)
    return enqueued


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--name', required=True, help='节目名子串')
    p.add_argument('--series-id', type=int, help='直接指定 series_id')
    args = p.parse_args()

    client = Client()
    series_id = args.series_id
    if series_id is None:
        series_id = series_id_by_query(client, args.name)
        if series_id is None:
            raise SystemExit(f'没找到节目: {args.name}')
    print(f'target series_id = {series_id}', flush=True)
    n = drain(client, series_id)
    print(f'登记 {n} 个资源', flush=True)