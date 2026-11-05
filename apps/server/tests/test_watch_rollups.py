# ruff: noqa: F811 -- shared isolated fixtures
import datetime as dt
from concurrent.futures import ThreadPoolExecutor
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException
from sqlalchemy import event, insert, select
from sqlalchemy.orm import Session
from test_management import native_token, parent  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import db
from mollytime_server.api.manage_overview import watch_summary
from mollytime_server.management_models import FamilySettings, WatchInterval, WatchSession
from mollytime_server.watch_rollups import (
    WatchContribution,
    WatchRollupState,
    backfill_once,
    initialize,
    project_batch,
    read_summary,
    source_rows,
)

NOW = dt.datetime(2026, 10, 13, 0, 0, 10, tzinfo=dt.UTC)


def session_row(key="watch", start=None):
    return WatchSession(id=key, family_id="f1", user_id="u1", item_id="e1", item_name="One",
                        started_at=(start or NOW - dt.timedelta(minutes=1)).astimezone(dt.UTC), purpose="child_watch")


def interval(seq, start, end, key="watch"):
    return WatchInterval(session_id=key, seq=seq, start_ms=start, end_ms=end,
                         played_ms=end - start, position_ms=end)


def summary(now=NOW):
    with Session(db.get_engine()) as session:
        return watch_summary(session, "f1", ZoneInfo("Asia/Shanghai"), now)


def finish_backfill():
    for _ in range(100):
        if not backfill_once(batch_size=2):
            return
    pytest.fail("backfill did not finish")


def test_out_of_order_intervals_replay_and_rollback_are_exact(parent):
    with Session(db.get_engine()) as session:
        session.add(session_row())
        session.flush()
        session.add(interval(2, 10000, 20000))
        session.commit()
        session.add(interval(0, 0, 10000))
        session.commit()
        state = session.get(WatchRollupState, "f1")
        records = session.execute(source_rows(session).where(WatchSession.id == "watch")).mappings().all()
        project_batch(session, state.active_generation, state.active_zone, records)
        session.commit()
        session.add(interval(3, 20000, 30000))
        session.flush()
        session.rollback()
    result = summary()
    assert result["favoriteVideo"]["playedMs"] == 20000
    assert result["mostPlayedVideo"]["playCount"] == 1
    assert result["last7DaysSessions"] == 1
    assert sum(row["playedMs"] for row in result["days"]) == 20000


def test_parallel_duplicate_http_reports_increment_once(parent):
    with Session(db.get_engine()) as session:
        session.add(session_row(start=dt.datetime.now(dt.UTC) - dt.timedelta(seconds=10)))
        session.commit()
    def report(_):
        return parent.post("/api/playback/sessions/watch/events", headers=native_token(), json={
            "seq": 0, "startMs": 0, "endMs": 1000, "playedMs": 1000, "positionMs": 1000,
        })
    with ThreadPoolExecutor(max_workers=8) as pool:
        responses = list(pool.map(report, range(8)))
    assert all(row.status_code == 200 for row in responses)
    assert sum(not row.json()["duplicate"] for row in responses) == 1
    result = summary(dt.datetime.now(dt.UTC))
    assert result["favoriteVideo"]["playedMs"] == 1000
    assert result["mostPlayedVideo"]["playCount"] == 1


def test_legacy_backfill_resumes_and_live_arrivals_are_not_double_counted(parent):
    with db.get_engine().begin() as connection:
        connection.execute(WatchRollupState.__table__.delete().where(WatchRollupState.family_id == "f1"))
        connection.execute(insert(WatchSession), {"id": "watch", "family_id": "f1", "user_id": "u1",
            "item_id": "e1", "item_name": "One", "purpose": "family_watch", "started_at": NOW - dt.timedelta(minutes=1)})
        connection.execute(insert(WatchInterval), [{"session_id": "watch", "seq": i, "start_ms": i * 1000,
            "end_ms": (i + 1) * 1000, "played_ms": 1000, "position_ms": (i + 1) * 1000} for i in range(5)])
    with Session(db.get_engine()) as session:
        initialize(session)
        with pytest.raises(HTTPException) as exc:
            read_summary(session, "f1", NOW)
        assert exc.value.status_code == 503
    assert backfill_once(batch_size=2)
    with Session(db.get_engine()) as session:
        session.add(interval(5, 5000, 6000))
        session.commit()
    finish_backfill()
    result = summary()
    assert result["favoriteVideo"]["playedMs"] == 6000
    assert result["mostPlayedVideo"]["playCount"] == 1
    with Session(db.get_engine()) as session:
        state = session.get(WatchRollupState, "f1")
        assert state.building_generation is None
        assert len(session.scalars(select(WatchContribution).where(WatchContribution.generation == state.active_generation)).all()) == 6
    assert not backfill_once()


def test_timezone_rebuild_serves_labeled_old_generation_until_ready(parent):
    with Session(db.get_engine()) as session:
        session.add(session_row(start=dt.datetime(2026, 10, 12, 23, 59, 50, tzinfo=ZoneInfo("Asia/Shanghai"))))
        session.flush()
        session.add(interval(0, 0, 20000))
        session.commit()
    before = summary()
    assert before["todayPlayedMs"] == 10000
    with Session(db.get_engine()) as session:
        session.add(FamilySettings(family_id="f1", timezone="UTC"))
        session.commit()
    pending = summary()
    assert pending["timezone"] == "Asia/Shanghai" and pending["summaryUpdating"]
    assert pending["todayPlayedMs"] == 10000
    finish_backfill()
    result = summary()
    assert result["timezone"] == "UTC" and not result["summaryUpdating"]
    assert result["todayPlayedMs"] == 0
    assert result["favoriteVideo"]["playedMs"] == 20000
    assert result["mostPlayedVideo"]["playCount"] == 1


def test_future_tail_advances_without_another_write_and_rounds_each_piece(parent):
    start = NOW - dt.timedelta(milliseconds=500, microseconds=500)
    with Session(db.get_engine()) as session:
        session.add(session_row(start=start))
        session.flush()
        session.add(interval(0, 0, 1001))
        session.commit()
    assert summary(start)["favoriteVideo"] is None
    assert summary()["favoriteVideo"]["playedMs"] == round(500.5)
    assert summary(NOW + dt.timedelta(seconds=1))["favoriteVideo"]["playedMs"] == 1001


def test_summary_reads_projections_without_scanning_raw_history(parent):
    with Session(db.get_engine()) as session:
        session.add(session_row())
        session.flush()
        session.add_all([interval(i, i * 10, (i + 1) * 10) for i in range(1000)])
        session.commit()
    queries = []
    def capture(_con, _cursor, statement, *_):
        queries.append(statement.lower())
    event.listen(db.get_engine(), "before_cursor_execute", capture)
    try:
        result = summary()
    finally:
        event.remove(db.get_engine(), "before_cursor_execute", capture)
    assert result["favoriteVideo"]["playedMs"] == 10000
    assert not any("watch_intervals" in query for query in queries)
    assert len(queries) <= 10


def test_resource_aggregates_preserve_per_video_rounding_and_subtitle_dedup(parent):
    from mollytime_server.models import Item, MediaFile
    with Session(db.get_engine()) as session:
        session.get(Item, "e1").runtime_ticks = 19999
        session.add(Item(id="rounding", family_id="f1", parent_id="season", type="Episode", name="Two", runtime_ticks=19999))
        session.flush()
        session.add_all([MediaFile(id=f"sub-{i}", family_id="f1", item_id="rounding", kind="subtitle",
                                  storage="oss", path=f"{i}.srt") for i in range(2)])
        session.commit()
    result = parent.get("/api/manage/resources/stats?folderId=season").json()
    assert result["videoCount"] == 2
    assert result["durationMs"] == 2  # floor(a) + floor(b), not floor(a + b)
    assert result["subtitleCount"] == 3 and result["subtitleVideoCount"] == 2


def test_parallel_sessions_update_one_family_without_lost_totals(parent):
    now = dt.datetime.now(dt.UTC)
    with Session(db.get_engine()) as session:
        session.add_all([session_row(f"parallel-{i}", now - dt.timedelta(seconds=10)) for i in range(8)])
        session.commit()
    def report(i):
        return parent.post(f"/api/playback/sessions/parallel-{i}/events", headers=native_token(), json={
            "seq": 0, "startMs": 0, "endMs": 1000, "playedMs": 1000, "positionMs": 1000,
        })
    with ThreadPoolExecutor(max_workers=8) as pool:
        responses = list(pool.map(report, range(8)))
    assert all(row.status_code == 200 for row in responses)
    result = summary(dt.datetime.now(dt.UTC))
    assert result["favoriteVideo"]["playedMs"] == 8000
    assert result["mostPlayedVideo"]["playCount"] == 8
    with Session(db.get_engine()) as session:
        other, favorite, _ = read_summary(session, "f2", now)
        assert other["todayPlayedMs"] == 0 and favorite is None


def test_failed_backfill_validation_keeps_previous_generation(parent):
    from mollytime_server.watch_rollups import WatchItemTotal, queue_rebuild
    with Session(db.get_engine()) as session:
        session.add(session_row())
        session.flush()
        session.add_all([interval(i, i * 1000, (i + 1) * 1000) for i in range(3)])
        session.commit()
        queue_rebuild(session, "f1")
        session.commit()
    assert backfill_once(batch_size=2)
    with Session(db.get_engine()) as session:
        state = session.get(WatchRollupState, "f1")
        old_generation, building = state.active_generation, state.building_generation
        session.execute(WatchItemTotal.__table__.update().where(WatchItemTotal.generation == building).values(played_ms=0))
        session.commit()
    with pytest.raises(RuntimeError, match="totals do not match"):
        backfill_once(batch_size=2)
    with Session(db.get_engine()) as session:
        assert session.get(WatchRollupState, "f1").active_generation == old_generation
        # The last batch and its cursor roll back along with failed verification.
        assert session.get(WatchRollupState, "f1").building_generation == building
        assert session.query(WatchContribution).filter_by(generation=building).count() == 2
    assert summary()["favoriteVideo"]["playedMs"] == 3000


@pytest.mark.parametrize("day,hours", [("2026-03-08", 23), ("2026-11-01", 25)])
def test_daily_projection_observes_daylight_saving_boundaries(day, hours):
    from mollytime_server.watch_rollups import day_parts
    zone = ZoneInfo("America/New_York")
    date = dt.date.fromisoformat(day)
    start = dt.datetime.combine(date, dt.time.min, zone).astimezone(dt.UTC)
    end = dt.datetime.combine(date + dt.timedelta(days=1), dt.time.min, zone).astimezone(dt.UTC)
    assert day_parts(start - dt.timedelta(seconds=1), end + dt.timedelta(seconds=1), zone) == {
        (date - dt.timedelta(days=1)).isoformat(): 1000,
        day: hours * 3600000,
        (date + dt.timedelta(days=1)).isoformat(): 1000,
    }


def test_catalog_summary_work_is_bounded_for_large_folder(parent):
    from mollytime_server.api.manage_overview import published_resource_summary
    from mollytime_server.models import Item, MediaFile
    with Session(db.get_engine()) as session:
        session.add_all([Item(id=f"large-{i}", family_id="f1", parent_id="season", type="Episode", name=str(i)) for i in range(1000)])
        session.flush()
        session.add_all([MediaFile(id=f"large-media-{i}", family_id="f1", item_id=f"large-{i}", kind="video", storage="oss", path=str(i)) for i in range(1000)])
        # Multiple video files for one episode must not multiply counts.
        session.add(MediaFile(id="duplicate-video", family_id="f1", item_id="e1", kind="video", storage="oss", path="copy"))
        session.commit()
        connection = session.connection().connection.driver_connection
        steps = 0
        def progress():
            nonlocal steps
            steps += 1000
            return 0
        connection.set_progress_handler(progress, 1000)
        try:
            result = published_resource_summary(session, "f1")
        finally:
            connection.set_progress_handler(None, 0)
        assert result == {"series": 1, "episodes": 1001, "subtitles": 1}
        # SQLite instruction count catches quadratic recursive scans without a
        # wall-clock assertion sensitive to machine load.
        assert steps < 250000


def test_background_worker_continues_past_a_failed_family(parent, monkeypatch):
    import threading

    from mollytime_server import watch_rollups
    with Session(db.get_engine()) as session:
        for family in ("f1", "f2"):
            state = session.get(WatchRollupState, family)
            state.building_generation = f"building-{family}"
            state.building_zone = "UTC"
        session.commit()
    calls = []
    reached_second = threading.Event()
    def run_batch(*, family_id):
        calls.append(family_id)
        if family_id == "f1":
            raise RuntimeError("simulated bad history")
        reached_second.set()
        return False
    monkeypatch.setattr(watch_rollups, "backfill_once", run_batch)
    stop, thread = watch_rollups.start_worker()
    try:
        assert reached_second.wait(timeout=5)
    finally:
        stop.set()
        thread.join(timeout=5)
    assert calls[:2] == ["f1", "f2"]
    assert not thread.is_alive()
