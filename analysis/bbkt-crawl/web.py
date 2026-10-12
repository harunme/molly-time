"""Local dashboard for picking BBKT resources to download.

Listens only on 127.0.0.1. Reads catalogue.sqlite directly so the panel
shares state with the bulk crawler. On-demand downloads run through a
single async worker so we never stampede the API or the CDN.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sqlite3
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from sse_starlette.sse import EventSourceResponse

from api import PRIVATE, Client
from layout import Layout
from download import Downloader, STAGING, CACHE

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / 'static'
CATALOG_DB = PRIVATE / 'catalogue.sqlite'


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(CATALOG_DB, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


class State:
    def __init__(self) -> None:
        self.subscribers: set[asyncio.Queue] = set()
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.active: dict[str, dict] = {}
        self.pending_web: set[str] = set()
        self._worker_task: asyncio.Task | None = None

    async def broadcast(self, event: dict) -> None:
        dead = []
        for sub in list(self.subscribers):
            try:
                sub.put_nowait(event)
            except asyncio.QueueFull:
                dead.append(sub)
        for d in dead:
            self.subscribers.discard(d)

    async def worker(self) -> None:
        from download import Downloader
        dl = Downloader()
        loop = asyncio.get_running_loop()
        while True:
            try:
                resource_id = await self.queue.get()
            except asyncio.CancelledError:
                return
            self.active[resource_id] = {
                'started': time.time(), 'bytes': 0, 'speed': 0.0, 'state': 'running'}
            await self.broadcast({'type': 'started', 'resource_id': resource_id,
                                  'queue_size': self.queue.qsize()})

            def progress(bytes_done: int, speed: float) -> None:
                self.active[resource_id] = {
                    'started': self.active.get(resource_id, {}).get('started', time.time()),
                    'bytes': bytes_done, 'speed': speed, 'state': 'running'}
                future = asyncio.run_coroutine_threadsafe(
                    self.broadcast({'type': 'progress', 'resource_id': resource_id,
                                     'bytes': bytes_done, 'speed': speed,
                                     'queue_size': self.queue.qsize()}),
                    loop)
                # Don't wait for the broadcast — it's fire-and-forget for UI.

            try:
                t0 = time.monotonic()
                # Patch the downloader to use our progress callback for this one call
                orig_stream = dl.stream
                def patched_stream(url, target):
                    return orig_stream(url, target, on_progress=progress)
                dl.stream = patched_stream
                try:
                    result = await asyncio.to_thread(dl.run_one, resource_id)
                finally:
                    dl.stream = orig_stream
                await self.broadcast({'type': 'finished', 'resource_id': resource_id,
                                      'result': result,
                                      'queue_size': self.queue.qsize()})
            except Exception as exc:
                await self.broadcast({'type': 'failed', 'resource_id': resource_id,
                                      'error': f'{type(exc).__name__}: {exc}'})
            finally:
                self.active.pop(resource_id, None)
                self.pending_web.discard(resource_id)


state = State()


async def events_stream(request: Request):
    queue: asyncio.Queue = asyncio.Queue(maxsize=200)
    state.subscribers.add(queue)
    try:
        while True:
            if await request.is_disconnected():
                break
            try:
                event = await asyncio.wait_for(queue.get(), timeout=15)
                yield {'event': 'message', 'data': json.dumps(event, ensure_ascii=False)}
            except asyncio.TimeoutError:
                yield {'event': 'ping', 'data': '{}'}
    finally:
        state.subscribers.discard(queue)


def overview() -> dict:
    conn = db_connect()
    try:
        cats = conn.execute('SELECT COUNT(*) FROM categories').fetchone()[0]
        series = conn.execute('SELECT COUNT(*) FROM series').fetchone()[0]
        episodes = conn.execute('SELECT COUNT(*) FROM episodes').fetchone()[0]
        pending = conn.execute("SELECT COUNT(*) FROM jobs WHERE state='pending'").fetchone()[0]
        rstate = {s: n for s, n in conn.execute(
            'SELECT state, COUNT(*) FROM resources GROUP BY state')}
        bytes_done = conn.execute(
            "SELECT COALESCE(SUM(bytes),0) FROM resources WHERE state='done'").fetchone()[0]
    finally:
        conn.close()
    return {
        'categories': cats, 'series': series, 'episodes': episodes,
        'jobs_pending': pending,
        'resources': rstate,
        'downloaded_bytes': bytes_done,
        'active': list(state.active.keys()),
        'queue_size': state.queue.qsize(),
    }


def category_tree() -> list[dict]:
    conn = db_connect()
    try:
        rows = conn.execute(r"""
            SELECT c.id, c.body, COUNT(DISTINCT s.id) AS series_n
            FROM categories c
            LEFT JOIN series s ON json_extract(s.body, '$.sortId') = c.id
            GROUP BY c.id
            ORDER BY json_extract(c.body, '$.weight'), c.id
        """).fetchall()
    finally:
        conn.close()
    out = []
    for row in rows:
        body = json.loads(row['body'])
        out.append({'id': row['id'], 'name': body.get('name', ''),
                    'weight': body.get('weight', 0), 'series': row['series_n']})
    return out


def series_for(category_id: int) -> list[dict]:
    conn = db_connect()
    try:
        rows = conn.execute(r"""
            SELECT s.id, s.body,
              (SELECT COUNT(*) FROM episodes WHERE series_id = s.id) AS episodes,
              (SELECT r.state FROM resources r
                 JOIN resource_links l ON l.resource_id = r.id
                 WHERE l.entity_type='series' AND l.entity_id = s.id AND r.kind='cover'
                 ORDER BY r.id LIMIT 1) AS cover_state
            FROM series s
            WHERE json_extract(s.body, '$.sortId') = ?
            ORDER BY s.id
        """, (category_id,)).fetchall()
    finally:
        conn.close()
    out = []
    for row in rows:
        body = json.loads(row['body'])
        out.append({'id': row['id'], 'name': body.get('name', ''),
                    'episodes': row['episodes'], 'cover_state': row['cover_state']})
    return out


def episode_for(episode_id: int) -> dict | None:
    conn = db_connect()
    try:
        ep_row = conn.execute(
            "SELECT id, series_id, body FROM episodes WHERE id=?", (episode_id,)).fetchone()
        if not ep_row:
            return None
        body = json.loads(ep_row['body'])
        series_row = conn.execute(
            "SELECT id, body FROM series WHERE id=?", (ep_row['series_id'],)).fetchone()
        series_body = json.loads(series_row['body']) if series_row else {}
        sort_id = series_body.get('sortId')
        cat_row = conn.execute(
            "SELECT body FROM categories WHERE id=?", (sort_id,)).fetchone() if sort_id else None
        cat_body = json.loads(cat_row['body']) if cat_row else {}
        resources = []
        for rid, field, rstate, local, bcount, error in conn.execute(r"""
            SELECT r.id, l.field, r.state, r.local_path, r.bytes, r.error
            FROM resource_links l JOIN resources r ON r.id = l.resource_id
            WHERE l.entity_type='episode' AND l.entity_id=?
        """, (episode_id,)):
            resources.append({
                'id': rid, 'field': field, 'state': rstate,
                'bytes': bcount, 'error': error,
            })
    finally:
        conn.close()
    return {
        'id': ep_row['id'], 'series_id': ep_row['series_id'],
        'name': body.get('name') or body.get('nameNew') or '',
        'name_new': body.get('nameNew', ''),
        'duration': body.get('duration', ''),
        'series_name': series_body.get('name', ''),
        'category_name': cat_body.get('name', ''),
        'resources': resources,
    }


def episodes_for(series_id: int) -> list[dict]:
    conn = db_connect()
    try:
        rows = conn.execute(r"""
            SELECT e.id, e.body,
              GROUP_CONCAT(r.state || ':' || l.field, ',') AS rstates
            FROM episodes e
            LEFT JOIN resource_links l ON l.entity_type='episode' AND l.entity_id=e.id
            LEFT JOIN resources r ON r.id = l.resource_id
            WHERE e.series_id = ?
            GROUP BY e.id
            ORDER BY MIN(COALESCE((SELECT position FROM episode_order
                                    WHERE episode_id = e.id), 999999)), e.id
        """, (series_id,)).fetchall()
    finally:
        conn.close()
    out = []
    for row in rows:
        body = json.loads(row['body'])
        states = defaultdict(set)
        if row['rstates']:
            for pair in row['rstates'].split(','):
                if ':' in pair:
                    s, f = pair.split(':', 1)
                    states[f].add(s)
        out.append({
            'id': row['id'],
            'name': body.get('name') or body.get('nameNew') or '',
            'name_new': body.get('nameNew', ''),
            'duration': body.get('duration', ''),
            'states': {f: sorted(s) for f, s in states.items()},
        })
    return out


def _patch_downloader():
    from download import Downloader as _D
    if hasattr(_D, 'run_one'):
        return
    def run_one(self, resource_id):
        import os
        import time
        import threading
        log = open('/Users/binwang/Working/github/molly-tv/analysis/bbkt-crawl/run-one.log', 'a')
        log.write(f'[run_one {threading.current_thread().name}] start {resource_id}\n'); log.flush()
        conn = sqlite3.connect(CATALOG_DB, timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute(
                "SELECT id, url, kind, state, attempts FROM resources WHERE id=?",
                (resource_id,)).fetchone()
            log.write(f'[run_one] row url={row["url"][:80]} kind={row["kind"]}\n'); log.flush()
            if not row:
                return {'resource_id': resource_id, 'state': 'missing'}
            if row['state'] == 'done':
                return {'resource_id': resource_id, 'state': 'already_done'}
            ext = self.extension(row['url'])
            staging = STAGING / f'{resource_id}{ext}'
            log.write(f'[run_one] about to stream to {staging}\n'); log.flush()
            t0 = time.monotonic()
            result = self.stream(row['url'], staging)
            log.write(f'[run_one] stream done in {time.monotonic()-t0:.1f}s -> type={type(result).__name__}\n'); log.flush()
            # Auto-retry transient network errors a couple of times.
            attempts = row['attempts'] or 0
            while result is None and attempts < 2:
                attempts += 1
                time.sleep(2)
                staging.unlink(missing_ok=True)
                result = self.stream(row['url'], staging)
            if isinstance(result, tuple):
                size, digest = result
                cache = CACHE / f'{resource_id}{ext}'
                os.replace(staging, cache)
                log.write(f'[run_one] downloaded {size} bytes -> {cache}\n'); log.flush()
                conn.execute(
                    "UPDATE resources SET state='done', bytes=?, sha256=?, local_path=?, error=NULL, attempts=0 WHERE id=?",
                    (size, digest, None, resource_id))
                conn.commit()
                log.write(f'[run_one] db updated, calling place\n'); log.flush()
                self.layout.place(resource_id, cache)
                log.write(f'[run_one] placed\n'); log.flush()
                return {'resource_id': resource_id, 'state': 'done', 'bytes': size}
            if result == 403:
                link = conn.execute(
                    "SELECT entity_id FROM resource_links WHERE resource_id=? AND entity_type='episode' LIMIT 1",
                    (resource_id,)).fetchone()
                if link:
                    try:
                        new_url = self.refresh_video(resource_id, link['entity_id'])
                        if new_url:
                            conn.execute(
                                "UPDATE resources SET state='pending', error=NULL WHERE id=?",
                                (resource_id,))
                            conn.commit()
                            return run_one(self, resource_id)
                    except Exception:
                        pass
            err = 'transport error' if result is None else f'HTTP {result}'
            conn.execute(
                "UPDATE resources SET state='failed', error=?, attempts=? WHERE id=?",
                (err, attempts, resource_id))
            conn.commit()
            return {'resource_id': resource_id, 'state': 'failed', 'error': err}
        finally:
            conn.close()
    _D.run_one = run_one


_patch_downloader()


@asynccontextmanager
async def lifespan(app: FastAPI):
    state._worker_task = asyncio.create_task(state.worker())
    yield
    if state._worker_task:
        state._worker_task.cancel()


app = FastAPI(title='BBKT Crawler Dashboard', lifespan=lifespan)


@app.get('/', response_class=HTMLResponse)
async def index() -> HTMLResponse:
    return HTMLResponse((STATIC / 'index.html').read_text(encoding='utf8'))


@app.get('/api/overview')
async def api_overview() -> dict:
    return overview()


@app.get('/api/categories')
async def api_categories() -> list[dict]:
    return category_tree()


@app.get('/api/series')
async def api_series(category_id: int) -> list[dict]:
    return series_for(category_id)


@app.get('/api/episodes')
async def api_episodes(series_id: int) -> list[dict]:
    return episodes_for(series_id)


@app.get('/api/episode/{episode_id}')
async def api_episode(episode_id: int) -> dict:
    ep = episode_for(episode_id)
    if not ep:
        raise HTTPException(status_code=404)
    return ep


@app.get('/api/active')
async def api_active() -> dict:
    return {
        'active': state.active,
        'queue_size': state.queue.qsize(),
        'pending_web': sorted(state.pending_web),
    }


@app.post('/api/download/{resource_id}')
async def api_download(resource_id: str) -> dict:
    conn = db_connect()
    try:
        row = conn.execute(
            "SELECT id, state, kind FROM resources WHERE id=?", (resource_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail='unknown resource')
    if row['state'] == 'done':
        return {'enqueued': False, 'state': row['state']}
    if resource_id in state.active or resource_id in state.pending_web:
        return {'enqueued': False, 'state': 'already_queued'}
    state.pending_web.add(resource_id)
    await state.queue.put(resource_id)
    await state.broadcast({'type': 'queued', 'resource_id': resource_id,
                           'kind': row['kind'], 'queue_size': state.queue.qsize()})
    return {'enqueued': True, 'state': 'pending', 'queue_size': state.queue.qsize()}


@app.get('/api/events')
async def api_events(request: Request):
    return EventSourceResponse(events_stream(request))


@app.get('/api/file/{resource_id}')
async def api_file(resource_id: str) -> Response:
    conn = db_connect()
    try:
        row = conn.execute(
            "SELECT kind, local_path, url FROM resources WHERE id=?", (resource_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail='unknown resource')
    if row['local_path']:
        return FileResponse(row['local_path'], filename=Path(row['local_path']).name)
    for ext in ('.jpg', '.png', '.mp4', '.srt', '.bin'):
        p = CACHE / f'{resource_id}{ext}'
        if p.exists():
            return FileResponse(p, filename=p.name)
    if row['kind'] == 'cover':
        import urllib.request
        req = urllib.request.Request(row['url'], headers={'User-Agent': 'Mozilla/5.0'})
        try:
            with urllib.request.build_opener().open(req, timeout=15) as resp:
                data = resp.read()
                return Response(content=data, media_type=resp.headers.get('content-type', 'image/jpeg'))
        except Exception:
            raise HTTPException(status_code=404, detail='cover fetch failed')
    raise HTTPException(status_code=404, detail='not downloaded yet')


@app.get('/api/cover/{episode_id}')
async def api_cover(episode_id: int) -> Response:
    conn = db_connect()
    try:
        row = conn.execute(r"""
            SELECT r.id, r.url, r.local_path FROM resource_links l
            JOIN resources r ON r.id = l.resource_id
            WHERE l.entity_type='episode' AND l.entity_id=? AND l.field='imgUrl'
            LIMIT 1
        """, (episode_id,)).fetchone()
        if not row:
            row = conn.execute(r"""
                SELECT r.id, r.url, r.local_path FROM resource_links l
                JOIN resources r ON r.id = l.resource_id
                WHERE l.entity_type='series' AND l.entity_id=(SELECT series_id FROM episodes WHERE id=?)
                  AND l.field='imgUrl'
                LIMIT 1
            """, (episode_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(status_code=404, detail='no cover')
    return await api_file(row['id'])


STATIC.mkdir(exist_ok=True)
app.mount('/static', StaticFiles(directory=STATIC), name='static')


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--host', default='127.0.0.1')
    p.add_argument('--port', type=int, default=8765)
    args = p.parse_args()
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, log_level='info')