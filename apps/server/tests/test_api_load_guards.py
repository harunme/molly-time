# ruff: noqa: F811 -- shared isolated fixtures
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session
from test_management import parent  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import config, db, usage
from mollytime_server.management_models import ResourceState
from mollytime_server.models import Item, MediaFile


def test_settings_can_complete_with_only_one_database_connection(parent, monkeypatch):
    # A settings request must not hold one connection while asking the storage
    # configuration helper to borrow a second one from the same exhausted pool.
    engine = create_engine(config.get_settings().resolved_db_url(), pool_size=1,
                           max_overflow=0, pool_timeout=.1, connect_args={"check_same_thread": False})
    monkeypatch.setattr(db, "_engine", engine)
    monkeypatch.setattr(db, "_SessionLocal", None)
    try:
        for _ in range(2):  # cold and warm snapshots
            response = parent.get("/api/manage/settings")
            assert response.status_code == 200
            assert response.json()["storage"]["usedBytes"] == 18
    finally:
        engine.dispose()


def test_cold_storage_burst_rebuilds_once_without_stale_answers(parent, monkeypatch):
    original = usage.measure_objects
    calls = []
    barrier = threading.Barrier(8)

    def slow_measure(*args):
        calls.append(1)
        time.sleep(.05)
        return original(*args)

    monkeypatch.setattr(usage, "measure_objects", slow_measure)

    def fetch(_):
        barrier.wait(timeout=5)
        response = parent.get("/api/manage/settings")
        assert response.status_code == 200
        return response.json()["storage"]["usedBytes"]

    with ThreadPoolExecutor(max_workers=8) as pool:
        assert list(pool.map(fetch, range(8))) == [18] * 8
    assert len(calls) == 1
    with Session(db.get_engine()) as session:
        session.add(MediaFile(id="new-file", family_id="f1", item_id="e1", kind="video",
                              storage="oss", path="new.mp4", size_bytes=1000))
        session.commit()
    assert parent.get("/api/manage/settings").json()["storage"]["usedBytes"] == 1018
    assert len(calls) == 2


def test_episode_page_query_count_is_bounded_and_preserves_inherited_artwork(parent):
    with Session(db.get_engine()) as session:
        session.add(ResourceState(item_id="season", status="draft", ready=True))
        session.add(MediaFile(id="parent-cover", family_id="f1", item_id="season", kind="image",
                              storage="oss", path="cover.jpg", mime="image/jpeg"))
        for i in range(40):
            session.add(Item(id=f"page-{i:02}", family_id="f1", parent_id="season",
                             type="Episode", name=f"Episode {i:02}"))
        session.commit()
    counts = []
    for size in [1, 30]:
        queries = []

        def record(_con, _cursor, statement, *_, queries=queries):
            queries.append(statement)

        event.listen(db.get_engine(), "before_cursor_execute", record)
        try:
            response = parent.get(f"/api/manage/resources?parentId=season&page=1&pageSize={size}")
        finally:
            event.remove(db.get_engine(), "before_cursor_execute", record)
        assert response.status_code == 200
        rows = response.json()["items"]
        assert len(rows) == size
        for row in rows:
            assert row["hiddenByFolder"] == {"id": "season", "name": "Season"}
            assert "v=parent-cover" in row["imageUrl"]
            assert not row["shared"] and not row["hasOwnPreview"]
            assert row["files"] == []
        counts.append(len(queries))
    assert counts[1] <= counts[0] + 2
    assert counts[1] < 20
