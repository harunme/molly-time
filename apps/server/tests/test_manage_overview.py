# Imported pytest fixtures are intentionally reused as test arguments.
# ruff: noqa: F811
import datetime as dt
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from sqlalchemy import event
from sqlalchemy.orm import Session
from test_management import parent  # noqa: F401
from test_tv_playback import client  # noqa: F401

from mollytime_server import db
from mollytime_server.api import manage_overview
from mollytime_server.management_models import (
    Device,
    FamilySettings,
    ResourceState,
    UploadSession,
    WatchInterval,
    WatchSession,
)
from mollytime_server.models import Item, MediaFile, User


def test_overview_aggregates_only_the_current_family_and_real_watch_sessions(parent, monkeypatch):
    fixed = dt.datetime(2026, 10, 13, 0, 0, tzinfo=dt.UTC)
    zone = ZoneInfo("Pacific/Kiritimati")
    today = fixed.astimezone(zone).date()
    lower = dt.datetime.combine(today - dt.timedelta(days=6), dt.time.min, zone).astimezone(dt.UTC)
    upper = dt.datetime.combine(today + dt.timedelta(days=1), dt.time.min, zone).astimezone(dt.UTC)

    class Clock(dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed.astimezone(tz) if tz else fixed.replace(tzinfo=None)

    monkeypatch.setattr(manage_overview, "dt", SimpleNamespace(
        datetime=Clock, timedelta=dt.timedelta, time=dt.time, UTC=dt.UTC,
    ))
    with Session(db.get_engine()) as session:
        session.add(FamilySettings(family_id="f1", timezone=str(zone)))
        for key, state in [("draft-video", "draft"), ("archived-video", "archived")]:
            session.add(Item(id=key, family_id="f1", type="Episode", name=key, parent_id="series"))
            session.flush()
            session.add(ResourceState(item_id=key, status=state, ready=False))
        session.add(Item(id="other-folder", family_id="f2", type="Series", name="Other family"))
        session.add_all([
            Device(id="active-tv", family_id="f1", user_id="u1", name="Active", last_seen=fixed),
            Device(id="revoked-tv", family_id="f1", user_id="u1", name="Revoked", revoked=True),
            Device(id="other-tv", family_id="f2", user_id="u1", name="Other"),
        ])
        for file_id, size in [("v1", 10), ("s1", 4), ("s2", 9000)]:
            session.get(MediaFile, file_id).size_bytes = size
        for index, state in enumerate(["uploading", "processing", "failed", "ready"]):
            session.add(UploadSession(id=f"upload-{index}", family_id="f1", item_id="e1",
                filename="test.mp4", kind="video", size=100, fingerprint=str(index), status=state))
        session.add(UploadSession(id="other-upload", family_id="f2", item_id="e2",
            filename="other.mp4", kind="video", size=100, fingerprint="other"))
        session.flush()
        cases = [
            ("recent", "f1", fixed - dt.timedelta(hours=1), "family_watch", None, 1000),
            ("lower-edge", "f1", lower, "child_watch", None, 1000),
            ("too-old", "f1", lower - dt.timedelta(microseconds=1), "child_watch", None, 1000),
            ("future", "f1", upper, "family_watch", None, 1000),
            ("preview", "f1", fixed, "parent_preview", None, 1000),
            ("legacy-tv", "f1", fixed - dt.timedelta(minutes=1), "parent_preview", "active-tv", 1000),
            ("not-played", "f1", fixed, "child_watch", None, 0),
            ("other-watch", "f2", fixed, "family_watch", "other-tv", 1000),
        ]
        for key, family, started, purpose, device, played in cases:
            session.add(WatchSession(id=key, family_id=family, user_id="u1", item_id="e1" if family == "f1" else "e2",
                item_name="Story", started_at=started, purpose=purpose, device_id=device, last_seq=0))
            session.flush()
            session.add(WatchInterval(session_id=key, seq=0, start_ms=0, end_ms=played,
                played_ms=played, position_ms=played))
        session.add(WatchInterval(session_id="recent", seq=1, start_ms=1000, end_ms=2000,
            played_ms=1000, position_ms=2000))
        session.commit()
    response = parent.get("/api/manage/overview")
    assert response.status_code == 200
    data = response.json()
    assert data["media"] == {"folders": 1, "videos": 3, "published": 1, "draft": 1, "archived": 1}
    assert data["uploads"] == {"active": 2, "failed": 1, "ready": 1}
    assert data["devices"] == {"active": 1, "revoked": 1, "online": 1}
    assert data["children"] == 1 and data["storageBytes"] == 18
    watch = data["watch"]
    assert watch["last7DaysSessions"] == 3 and watch["timezone"] == str(zone)
    assert watch["todayPlayedMs"] == 3000 and watch["weekPlayedMs"] == 3000
    assert watch["weekStart"] == "2026-10-12"
    assert watch["favoriteVideo"] == {"id": "e1", "name": "One", "playedMs": 5000}
    assert watch["mostPlayedVideo"] == {"id": "e1", "name": "One", "playCount": 4}
    assert len(watch["days"]) == 365
    assert sum(day["playedMs"] for day in watch["days"]) == 5000
    with Session(db.get_engine()) as session:
        session.get(User, "u1").role = "member"
        session.commit()
    assert parent.get("/api/manage/overview").json() == data


def test_overview_splits_local_days_and_week_and_includes_resumed_old_sessions(parent, monkeypatch):
    fixed = dt.datetime(2026, 10, 13, 2, 0, tzinfo=dt.UTC)
    zone = ZoneInfo("Asia/Shanghai")

    class Clock(dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed.astimezone(tz) if tz else fixed.replace(tzinfo=None)

    monkeypatch.setattr(manage_overview, "dt", SimpleNamespace(
        datetime=Clock, timedelta=dt.timedelta, time=dt.time, UTC=dt.UTC,
    ))
    with Session(db.get_engine()) as session:
        session.add(FamilySettings(family_id="f1", timezone=str(zone)))
        session.add(Item(id="runner-up", family_id="f1", type="Episode", name="Runner up"))
        # The stale and future heartbeat timestamps must not count as online;
        # the boundary is inclusive and revoked/other-family devices are excluded.
        for key, age, revoked, family in [
            ("boundary", 90, False, "f1"), ("stale", 91, False, "f1"),
            ("future-device", -1, False, "f1"), ("revoked", 0, True, "f1"),
            ("other", 0, False, "f2"),
        ]:
            session.add(Device(id=key, family_id=family, user_id="u1", name=key,
                revoked=revoked, last_seen=fixed - dt.timedelta(seconds=age)))
        session.flush()
        cases = [
            ("midnight", dt.datetime(2026, 10, 12, 23, 59, 50, tzinfo=zone), 0, 20000, "e1"),
            ("sunday", dt.datetime(2026, 10, 11, 23, 59, 50, tzinfo=zone), 0, 20000, "e1"),
            ("year-edge", dt.datetime(2025, 10, 13, 23, 59, 50, tzinfo=zone), 0, 20000, "e1"),
            ("paused", fixed - dt.timedelta(seconds=40), 0, 10000, "e1"),
            ("clip-now", fixed - dt.timedelta(seconds=10), 0, 20000, "runner-up"),
        ]
        old = dt.datetime(2024, 1, 1, tzinfo=dt.UTC)
        resume_offset = int((fixed - dt.timedelta(seconds=30) - old).total_seconds() * 1000)
        cases.append(("resumed", old, resume_offset, resume_offset + 20000, "e1"))
        for key, started, start_ms, end_ms, item in cases:
            session.add(WatchSession(id=key, family_id="f1", user_id="u1", item_id=item,
                item_name="Recorded name", started_at=started.astimezone(dt.UTC), purpose="family_watch"))
            session.flush()
            session.add(WatchInterval(session_id=key, seq=0, start_ms=start_ms, end_ms=end_ms,
                played_ms=0 if key == "paused" else end_ms - start_ms, position_ms=0))
        session.commit()
    data = parent.get("/api/manage/overview").json()
    watch = data["watch"]
    days = {day["date"]: day["playedMs"] for day in watch["days"]}
    assert next(iter(days)) == "2025-10-14" and next(reversed(days)) == "2026-10-13"
    assert days["2025-10-14"] == 10000
    assert days["2026-10-11"] == 10000 and days["2026-10-12"] == 20000
    assert days["2026-10-13"] == watch["todayPlayedMs"] == 40000
    assert watch["weekPlayedMs"] == 60000
    assert watch["favoriteVideo"] == {"id": "e1", "name": "One", "playedMs": 80000}
    assert data["devices"] == {"active": 3, "revoked": 1, "online": 1}


def test_overview_empty_watch_history(parent):
    data = parent.get("/api/manage/overview").json()
    assert data["devices"]["online"] == 0
    assert data["watch"]["todayPlayedMs"] == data["watch"]["weekPlayedMs"] == 0
    assert data["watch"]["favoriteVideo"] is None
    assert data["watch"]["mostPlayedVideo"] is None
    assert data["watch"]["mostPlayedVideos"] == []
    assert len(data["watch"]["days"]) == 365
    assert all(day["playedMs"] == 0 for day in data["watch"]["days"])


def test_overview_query_count_stays_constant_as_media_grows(parent):
    statements = []

    def capture(_connection, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    engine = db.get_engine()
    event.listen(engine, "before_cursor_execute", capture)
    try:
        assert parent.get("/api/manage/overview").status_code == 200
        baseline = len(statements)
        with Session(engine) as session:
            session.add_all([Item(id=f"video-{index}", family_id="f1", type="Episode", name="Video", parent_id="series") for index in range(400)])
            session.commit()
        statements.clear()
        data = parent.get("/api/manage/overview").json()
        assert data["media"]["videos"] == 401
        assert len(statements) == baseline
        assert not any("SELECT items.id," in statement for statement in statements)
    finally:
        event.remove(engine, "before_cursor_execute", capture)


def test_overview_ranks_play_count_instead_of_duration(parent):
    now = dt.datetime.now(dt.UTC)
    with Session(db.get_engine()) as session:
        session.add(Item(id="frequent", family_id="f1", type="Episode", name="Frequent"))
        for index, (item_id, length) in enumerate([("e1", 60000), ("frequent", 1000), ("frequent", 1000)]):
            session.add(WatchSession(id=f"rank-{index}", family_id="f1", user_id="u1",
                item_id=item_id, item_name="Recorded", started_at=now - dt.timedelta(minutes=5),
                purpose="family_watch"))
            session.flush()
            for seq in range(2):
                session.add(WatchInterval(session_id=f"rank-{index}", seq=seq,
                    start_ms=seq * length, end_ms=(seq + 1) * length,
                    played_ms=length, position_ms=0))
        session.commit()
    watch = parent.get("/api/manage/overview").json()["watch"]
    assert watch["favoriteVideo"]["id"] == "e1"
    assert watch["mostPlayedVideo"] == {"id": "frequent", "name": "Frequent", "playCount": 2}
    assert watch["mostPlayedVideos"] == [
        {"id": "frequent", "name": "Frequent", "playCount": 2},
        {"id": "e1", "name": "One", "playCount": 1},
    ]


def test_resource_overview_counts_only_published_playable_content(parent):
    with Session(db.get_engine()) as session:
        session.add_all([
            Item(id="empty-series", family_id="f1", type="Series", name="Empty"),
            Item(id="draft-series", family_id="f1", type="Series", name="Draft only"),
            Item(id="hidden-series", family_id="f1", type="Series", name="Hidden"),
            Item(id="season-two", family_id="f1", type="Season", name="Season two", parent_id="series"),
        ])
        session.flush()
        session.add(ResourceState(item_id="hidden-series", status="draft", ready=True))
        cases = [
            ("direct", "series", "published"), ("second-season", "season-two", "published"),
            ("draft", "draft-series", "draft"), ("archived", "series", "archived"),
            ("deleted", "series", "deleted"), ("hidden", "hidden-series", "published"),
        ]
        for key, parent_id, status in cases:
            session.add(Item(id=key, family_id="f1", type="Episode", name=key, parent_id=parent_id))
            session.flush()
            session.add(ResourceState(item_id=key, status=status, ready=True))
            for kind in ["video", "subtitle"]:
                session.add(MediaFile(id=f"{key}-{kind}", family_id="f1", item_id=key,
                    kind=kind, storage="local", path=f"{key}-{kind}"))
        # Multiple video files still represent one episode, and unpublished or
        # missing video files must not inflate either the episode or series count.
        session.add(MediaFile(id="extra-video", family_id="f1", item_id="direct",
            kind="video", storage="local", path="extra.mp4"))
        session.add(Item(id="no-video", family_id="f1", type="Episode", name="No file", parent_id="empty-series"))
        session.commit()
    assert parent.get("/api/manage/overview").json()["resources"] == {
        "series": 1, "episodes": 3, "subtitles": 3,
    }
