"""Isolated ASGI load probe. Never connects to a running server or production DB.

Run with apps/server/.venv/bin/python tools/benchmark-api.py --output /tmp/api-load.json
Measures application/SQLite concurrency, not network or production MySQL capacity.
"""

import argparse
import asyncio
import datetime as dt
import hashlib
import json
import math
import os
import platform
import sys
import tempfile
import threading
import time
from collections import Counter
from pathlib import Path

import httpx
from sqlalchemy import event, insert

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps/server"))
from mollytime_server import config, db, usage
from mollytime_server.auth import hash_refresh_token
from mollytime_server.main import create_app
from mollytime_server.management_models import (
    ParentSession,
    WatchInterval,
    WatchSession,
)
from mollytime_server.models import Family, Item, MediaFile, User
from mollytime_server.storage_snapshots import FamilyStorageSnapshot


def seed(root, count, intervals):
    # Do not inherit deployment credentials, background jobs, or an external DB.
    for key in list(os.environ):
        if key.startswith(("MOLLYTIME_", "MOLLY_")):
            del os.environ[key]
    config._settings = config.Settings(
        _env_file=None, db_url=f"sqlite:///{root / 'load.db'}", data_dir=root,
        media_dir=root / "media", media_worker_enabled=False, watch_rollup_worker_enabled=False, oss_log_bucket=None,
        storage_backend="local", tv_web_dir=root / "web", parent_web_dir=root / "web",
    )
    config._settings.media_dir.mkdir()
    db.init_db()
    engine = db.get_engine()
    with engine.begin() as con:
        for family in ("a", "b"):
            con.execute(insert(Family), {"id": family, "name": family})
            con.execute(insert(User), {"id": family, "family_id": family, "name": family, "password_hash": "unused"})
            con.execute(insert(ParentSession), {"id": hash_refresh_token(f"probe-{family}"), "user_id": family,
                                              "csrf": "probe", "expires_at": dt.datetime.now(dt.UTC) + dt.timedelta(hours=1)})
            con.execute(insert(Item), {"id": family + "-folder", "family_id": family, "type": "Series", "name": "Folder"})
            con.execute(insert(Item), [{"id": f"{family}-{i}", "family_id": family, "parent_id": family + "-folder",
                                       "type": "Episode", "name": f"Episode {i}"} for i in range(count)])
            files = []
            for i in range(count):
                path = f"{family}-{i}.mp4"
                backend = "local" if i % 2 == 0 else "oss"
                if backend == "local":
                    (config._settings.media_dir / path).write_bytes(b"x" * 1024)
                files.append({"id": f"media-{family}-{i}", "family_id": family, "item_id": f"{family}-{i}",
                              "kind": "video", "storage": backend, "path": path, "size_bytes": 1024})
            con.execute(insert(MediaFile), files)
        con.execute(insert(WatchSession), {"id": "watch", "family_id": "a", "user_id": "a", "item_id": "a-0",
                                          "item_name": "Episode 0", "purpose": "family_watch",
                                          "started_at": dt.datetime.now(dt.UTC) - dt.timedelta(days=10)})
        for start in range(0, intervals, 5000):
            con.execute(insert(WatchInterval), [{"session_id": "watch", "seq": i, "start_ms": i * 10000,
                                                 "end_ms": (i + 1) * 10000, "played_ms": 10000, "position_ms": (i + 1) * 10000}
                                                for i in range(start, min(intervals, start + 5000))])


async def run(args, root):
    seed(root, args.files, args.intervals)
    # The fixture uses bulk inserts to model pre-deployment historical data.
    # Prepare it outside timed reads, exactly as the deployment backfill does.
    from mollytime_server.watch_rollups import backfill_once, initialize
    with db.get_session_factory()() as session:
        initialize(session)
    while backfill_once():
        pass
    engine = db.get_engine()
    counters = Counter()
    lock = threading.Lock()

    @event.listens_for(engine, "before_cursor_execute")
    def query_count(*_):
        with lock:
            counters["sql"] += 1

    original = usage.measure_objects

    def measure(*args):
        with lock:
            counters["storage_rebuilds"] += 1
        return original(*args)

    usage.measure_objects = measure
    results = []
    transport = httpx.ASGITransport(app=create_app(), raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver", timeout=60,
                                headers={"Cookie": "molly_parent=probe-a", "X-CSRF-Token": "probe"}) as client:
        async def load(name, concurrency, count, request, check=None, expected=(200,)):
            counters.clear()
            semaphore = asyncio.Semaphore(concurrency)
            times, statuses, errors = [], Counter(), Counter()

            async def one(i):
                async with semaphore:
                    started = time.perf_counter()
                    response = await request(i)
                    times.append((time.perf_counter() - started) * 1000)
                    statuses[response.status_code] += 1
                    if response.status_code not in expected:
                        errors[response.text[:160]] += 1
                    if check:
                        issue = check(response)
                        if issue:
                            errors[issue] += 1

            started = time.perf_counter()
            await asyncio.gather(*(one(i) for i in range(count)))
            elapsed = time.perf_counter() - started
            times.sort()
            row = {"case": name, "concurrency": concurrency, "requests": count,
                   "rps": round(count / elapsed, 1), "p50_ms": round(times[len(times) // 2], 1),
                   "p95_ms": round(times[math.ceil(len(times) * .95) - 1], 1),
                   "max_ms": round(times[-1], 1), "status": dict(statuses), "errors": dict(errors), **dict(counters)}
            results.append(row)
            print(json.dumps(row, ensure_ascii=False), flush=True)
            return row

        def storage_check(response):
            if response.status_code != 200:
                return "unexpected status"
            if response.json()["storage"]["usedBytes"] != args.files * 1024:
                return "wrong usedBytes"

        await client.get("/api/manage/settings")
        for concurrency in args.concurrency:
            await load("settings-warm", concurrency, args.requests, lambda _: client.get("/api/manage/settings"), storage_check)
            with engine.begin() as con:
                con.execute(FamilyStorageSnapshot.__table__.delete())
            await load("settings-cold", concurrency, args.requests, lambda _: client.get("/api/manage/settings"), storage_check)
            for name, path in [
                ("resources-paged", "/api/manage/resources?parentId=a-folder&page=1&pageSize=30"),
                ("resources-unpaged", "/api/manage/resources?parentId=a-folder"),
                ("resource-stats", "/api/manage/resources/stats"),
                ("overview-history", "/api/manage/overview"),
                ("uploads-paged", "/api/manage/uploads?page=1&pageSize=30&pending=true"),
                ("family-usage", "/api/manage/usage"),
            ]:
                await load(name, concurrency, args.requests, lambda _, path=path: client.get(path))

        async def start(i):
            return await client.post("/api/manage/uploads", json={"itemId": f"a-{i}", "filename": "probe.mp4",
                                                                  "size": 100, "kind": "video", "fingerprint": f"probe-{i}"})

        config._settings.family_storage_limit_bytes = args.files * 1024 + 500
        quota = await load("quota-reservations", 16, 16, start, expected=(200, 507))
        assert quota["status"] == {200: 5, 507: 11}, quota
        usage_response = await client.get("/api/manage/settings")
        reserved = usage_response.json()["storage"]["reservedBytes"]
        assert reserved == 500, f"Quota reservation mismatch: {reserved}"
        config._settings.family_storage_limit_bytes = 0
        created = await client.post("/api/manage/uploads", json={"itemId": "b-0", "filename": "probe.mp4",
                                    "size": 100, "kind": "video", "fingerprint": "isolated"})
        assert created.status_code == 404, "Cross-family upload permitted"
        upload = (await client.get("/api/manage/uploads?pending=true&page=1&pageSize=30")).json()["items"][0]
        body = b"x" * 100
        await load("duplicate-chunks", 16, 16, lambda _: client.put(f"/api/manage/uploads/{upload['id']}/chunks?offset=0",
                   content=body, headers={"X-Chunk-SHA256": hashlib.sha256(body).hexdigest()}))
        detail = (await client.get(f"/api/manage/uploads/{upload['id']}")).json()
        assert detail["offset"] == 100
    usage.measure_objects = original
    event.remove(engine, "before_cursor_execute", query_count)
    engine.dispose()
    return {"environment": {"platform": platform.platform(), "database": "isolated SQLite WAL",
                            "transport": "in-process ASGI; no network", "families": 2,
                            "files_per_family": args.files, "watch_intervals": args.intervals}, "results": results}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--files", type=int, default=1000)
    parser.add_argument("--intervals", type=int, default=20000)
    parser.add_argument("--requests", type=int, default=64)
    parser.add_argument("--concurrency", type=int, nargs="+", default=[1, 8, 32])
    parser.add_argument("--output", type=Path, required=True)
    options = parser.parse_args()
    if options.files < 16 or options.intervals < 1 or options.requests < 1 or min(options.concurrency) < 1:
        parser.error("Need >=16 files and positive interval/request/concurrency counts")
    with tempfile.TemporaryDirectory(prefix="molly-api-load-") as directory:
        report = asyncio.run(run(options, Path(directory)))
    options.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
